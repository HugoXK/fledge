import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { revertMatchOf, summariseDeliveries } from '../src/lib/deliveryOutcome.js'
import { RETENTION_CLASSES, retentionDefaultWindows } from '../scripts/lib/retention.mjs'
import { makeUser } from './helpers.js'

// #371: Fledge records that a pull request merged, then forgets it. These cases
// pin the ledger the card asks for: one row per merged pull request, a revert
// counted once, follow-up links and post-merge failures counted once each, a
// windowed summary where a missing number is `—` and never a confident zero, and
// a retention class that deletes the row in the same run as the job it describes.

const MERGE_A = 'a'.repeat(40)
const MERGE_B = 'b'.repeat(40)
const REVERT_A = 'c'.repeat(40)

function receiver(store: Store, tag: string): { repoId: string; userId: string } {
  const user = makeUser(store, { login: `delivery-${tag}`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_delivery_${tag}`, userId: user.id, owner: 'o', name: `delivery-${tag}`, defaultBranch: 'main',
    tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
  })
  return { repoId: repo.id, userId: user.id }
}

function job(store: Store, repoId: string, userId: string, id: string, cost: number | null, finishedAt = new Date().toISOString()): void {
  store.createJob({
    id, repoId, userId, trigger: 'manual', goal: 'fix the adder', callbackHash: `cb-${id}`, platformTokenHash: '',
    kind: 'implement', baseBranch: 'main',
  })
  store.updateJob(id, { status: 'succeeded', finished_at: finishedAt, ...(cost === null ? {} : { cost_usd: cost }) })
}

test('a merged pull request becomes one outcome row and a replay adds nothing', () => {
  const store = new Store(':memory:')
  try {
    const { repoId, userId } = receiver(store, 'row')
    job(store, repoId, userId, 'job_delivery_row', 1.5)
    const input = {
      repoId, jobId: 'job_delivery_row', prUrl: 'https://github.com/o/delivery-row/pull/1', mergeCommit: MERGE_A,
      mergedAt: '2026-11-18T10:00:00.000Z', title: 'fix the adder carry', costUsd: 1.5, model: 'v4.1', playbook: 'implement',
    }
    store.recordDeliveryOutcome(input)
    store.recordDeliveryOutcome(input)
    const rows = store.listDeliveryOutcomes(repoId, '2026-11-01T00:00:00.000Z')
    assert.equal(rows.length, 1, 'one row per merged pull request, not one per delivery of the event')
    assert.equal(rows[0]?.merge_commit, MERGE_A)
    assert.equal(rows[0]?.pr_url, input.prUrl)
    assert.equal(rows[0]?.reverted_at, null, 'a fresh merge is not a revert')
    assert.equal(rows[0]?.revert_commit, null)
    assert.equal(rows[0]?.cost_usd, 1.5)
    assert.equal(rows[0]?.follow_up_json, '[]', 'no link yet is an empty list, not a made-up count')
  } finally {
    store.close()
  }
})

test('a revert is recorded once even when the scan sees it twice', () => {
  const store = new Store(':memory:')
  try {
    const { repoId, userId } = receiver(store, 'revert')
    job(store, repoId, userId, 'job_delivery_revert', 2)
    store.recordDeliveryOutcome({
      repoId, jobId: 'job_delivery_revert', prUrl: 'https://github.com/o/delivery-revert/pull/2', mergeCommit: MERGE_A,
      mergedAt: '2026-11-10T10:00:00.000Z', title: 'fix the adder carry', costUsd: 2, model: 'v4.1', playbook: 'implement',
    })
    const first = store.markDeliveryReverted({ repoId, mergeCommit: MERGE_A, revertCommit: REVERT_A, revertedAt: '2026-11-12T10:00:00.000Z' })
    const second = store.markDeliveryReverted({ repoId, mergeCommit: MERGE_A, revertCommit: REVERT_A, revertedAt: '2026-11-13T10:00:00.000Z' })
    assert.equal(first, true)
    assert.equal(second, false, 'the second sighting changes nothing')
    const row = store.listDeliveryOutcomes(repoId, '2026-11-01T00:00:00.000Z')[0]
    assert.equal(row?.reverted_at, '2026-11-12T10:00:00.000Z', 'the first sighting keeps its own instant')
    assert.equal(row?.revert_commit, REVERT_A)
    assert.equal(summariseDeliveries(store.listDeliveryOutcomes(repoId, '2026-11-01T00:00:00.000Z')).reverted, 1)
  } finally {
    store.close()
  }
})

test('a follow-up link and a post-merge failure are counted once per fact', () => {
  const store = new Store(':memory:')
  try {
    const { repoId, userId } = receiver(store, 'facts')
    job(store, repoId, userId, 'job_delivery_facts', 3)
    store.recordDeliveryOutcome({
      repoId, jobId: 'job_delivery_facts', prUrl: 'https://github.com/o/delivery-facts/pull/3', mergeCommit: MERGE_A,
      mergedAt: '2026-11-10T10:00:00.000Z', title: 'fix the adder carry', costUsd: 3, model: 'v4.1', playbook: 'implement',
    })
    const link = 'https://github.com/o/delivery-facts/issues/9'
    assert.equal(store.linkDeliveryFollowUp(repoId, MERGE_A, link), true)
    assert.equal(store.linkDeliveryFollowUp(repoId, MERGE_A, link), false, 'a comment on the same issue does not count twice')
    assert.equal(store.recordPostMergeFailure(repoId, MERGE_A, '2026-11-15T09:00:00.000Z'), true)
    assert.equal(store.recordPostMergeFailure(repoId, MERGE_A, '2026-11-16T09:00:00.000Z'), true, 'a second failing run is a second fact')
    const summary = summariseDeliveries(store.listDeliveryOutcomes(repoId, '2026-11-01T00:00:00.000Z'))
    assert.equal(summary.merged, 1)
    assert.equal(summary.withFollowUp, 1)
    assert.equal(summary.postMergeFailures, 2)
  } finally {
    store.close()
  }
})

test('the commit matcher reads a revert and leaves an ordinary commit alone', () => {
  assert.equal(revertMatchOf(`Revert "fix the adder carry"\n\nThis reverts commit ${MERGE_A}.`), MERGE_A)
  assert.equal(revertMatchOf('Revert "fix the adder carry"'), null, 'a title alone names no commit to match')
  assert.equal(revertMatchOf('fix the adder carry\n\nThis fixes a bug.'), null)
  assert.equal(revertMatchOf(''), null)
})

test('the windowed summary prints a missing number as null, never zero', () => {
  const rows = [
    {
      pr_url: 'https://github.com/o/r/pull/1', merge_commit: MERGE_A, merged_at: '2026-11-18T10:00:00.000Z', reverted_at: null,
      cost_usd: 2, follow_up_json: '[]', post_merge_failures: 0, model: 'v4.1', playbook: 'implement',
    },
    {
      pr_url: 'https://github.com/o/r/pull/2', merge_commit: MERGE_B, merged_at: '2026-11-17T10:00:00.000Z', reverted_at: '2026-11-18T10:00:00.000Z',
      cost_usd: null, follow_up_json: '["https://github.com/o/r/issues/2"]', post_merge_failures: 1, model: null, playbook: null,
    },
  ] as never
  const summary = summariseDeliveries(rows)
  assert.equal(summary.merged, 2)
  assert.equal(summary.reverted, 1)
  assert.equal(summary.kept, 1)
  assert.equal(summary.withFollowUp, 1)
  assert.equal(summary.postMergeFailures, 1)
  assert.equal(summary.costUsd, 2, 'a missing cost is left out of the sum rather than counted as zero')
  assert.equal(summary.costPerKeptChange, 2)
  assert.equal(summariseDeliveries([{ ...rows[1], reverted_at: null }] as never).costPerKeptChange, null, 'a cost that is not known is null')
})

test('the retention class deletes the outcome row in the run that deletes the job', () => {
  const store = new Store(':memory:')
  try {
    const { repoId, userId } = receiver(store, 'retention')
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString()
    job(store, repoId, userId, 'job_delivery_old', 1, old)
    store.recordDeliveryOutcome({
      repoId, jobId: 'job_delivery_old', prUrl: 'https://github.com/o/delivery-retention/pull/4', mergeCommit: MERGE_A,
      mergedAt: old, title: 'fix the adder carry', costUsd: 1, model: 'v4.1', playbook: 'implement',
    })
    const cls = RETENTION_CLASSES.find((entry: { id: string }) => entry.id === 'deliveryOutcomes')
    assert.ok(cls !== undefined, 'the ledger names its retention class')
    assert.equal(cls.table, 'delivery_outcomes')
    assert.equal(cls.defaultDays, 365, 'the ledger and the jobs it describes share one window')
    const windows = { ...retentionDefaultWindows(), jobs: 0, deliveryOutcomes: 0 }
    store.pruneOldData(windows)
    assert.equal(store.getJob('job_delivery_old'), undefined, 'the job row is gone')
    assert.equal(store.listDeliveryOutcomes(repoId, '2000-01-01T00:00:00.000Z').length, 0, 'and its outcome row with it')
  } finally {
    store.close()
  }
})
