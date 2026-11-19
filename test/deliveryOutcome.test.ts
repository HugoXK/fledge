import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { followUpLinks, revertMatchOf, summariseDeliveries, type DeliveryOutcomeRow } from '../src/lib/deliveryOutcome.js'
import { RETENTION_CLASSES, retentionDefaultWindows } from '../scripts/lib/retention.mjs'
import { Jobs } from '../src/jobs/service.js'
import { MockRunner } from '../src/jobs/mock.js'
import { GithubClient } from '../src/repos/github.js'
import { quotaMoney } from '../src/views/layout.js'
import { repoPage } from '../src/views/pages.js'
import { json, makeUser, MemoryMailer, startFakeServer, testConfig } from './helpers.js'

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
  const rows: DeliveryOutcomeRow[] = [
    {
      id: 'delivery_1', repo_id: 'repo', job_id: 'job', title: 'fix the adder', model: 'v4.1', playbook: 'implement',
      pr_url: 'https://github.com/o/r/pull/1', merge_commit: MERGE_A, merged_at: '2026-11-18T10:00:00.000Z', reverted_at: null,
      revert_commit: null, cost_usd: 2, follow_up_json: '[]', post_merge_failures: 0,
    },
    {
      id: 'delivery_2', repo_id: 'repo', job_id: null, title: 'fix the carry', model: null, playbook: null,
      pr_url: 'https://github.com/o/r/pull/2', merge_commit: MERGE_B, merged_at: '2026-11-17T10:00:00.000Z', reverted_at: '2026-11-18T10:00:00.000Z',
      revert_commit: 'c'.repeat(40), cost_usd: null, follow_up_json: '["https://github.com/o/r/issues/2"]', post_merge_failures: 1,
    },
  ]
  const summary = summariseDeliveries(rows)
  assert.equal(summary.merged, 2)
  assert.equal(summary.reverted, 1)
  assert.equal(summary.kept, 1)
  assert.equal(summary.withFollowUp, 1)
  assert.equal(summary.postMergeFailures, 1)
  assert.equal(summary.costUsd, 2, 'a missing cost is left out of the sum rather than counted as zero')
  assert.equal(summary.costPerKeptChange, 2)
  assert.equal(summariseDeliveries([{ ...rows[1]!, reverted_at: null }]).costPerKeptChange, null, 'a cost that is not known is null')
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
    const windows = { ...retentionDefaultWindows(), jobs: 1, deliveryOutcomes: 1 }
    store.pruneOldData(windows)
    assert.equal(store.getJob('job_delivery_old'), undefined, 'the job row is gone')
    assert.equal(store.listDeliveryOutcomes(repoId, '2000-01-01T00:00:00.000Z').length, 0, 'and its outcome row with it')
  } finally {
    store.close()
  }
})

function rowFor(repoId: string, id: string, patch: Partial<DeliveryOutcomeRow> = {}): DeliveryOutcomeRow {
  return {
    id, repo_id: repoId, job_id: null, title: `delivered ${id}`, model: 'v4.1', playbook: 'implement',
    pr_url: `https://github.com/o/delivery-page/pull/${id}`, merge_commit: MERGE_A, merged_at: '2026-11-18T10:00:00.000Z',
    reverted_at: null, revert_commit: null, cost_usd: 1, follow_up_json: '[]', post_merge_failures: 0,
    ...patch,
  }
}

test('the repo page prints what happened after each merge, and — where a fact is missing', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'delivery-page', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_delivery_page', userId: user.id, owner: 'o', name: 'delivery-page', defaultBranch: 'main',
      tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
    })
    const rows: DeliveryOutcomeRow[] = [
      rowFor(repo.id, 'one', {
        title: 'fix the adder carry', merge_commit: MERGE_A, reverted_at: '2026-11-18T12:00:00.000Z', revert_commit: REVERT_A,
        cost_usd: 3, follow_up_json: '["https://github.com/o/delivery-page/issues/1","https://github.com/o/delivery-page/issues/2"]',
        post_merge_failures: 2,
      }),
      rowFor(repo.id, 'two', { title: 'fix the carry', merge_commit: MERGE_B, model: null, playbook: null, cost_usd: null }),
    ]
    const page = repoPage({ config, locale: 'en', viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' }, repo, jobs: [], deliveryOutcomes: rows })
    assert.match(page, /id="delivery-outcomes" data-delivery-outcomes="2"/)
    assert.match(page, /data-delivery-merged="2" data-delivery-reverted="1"/)
    assert.match(page, /data-delivery-revert-rate="50%"/)
    assert.match(page, /data-delivery-follow-up-rate="50%"/)
    assert.match(page, new RegExp(`data-delivery-cost-per-kept="${quotaMoney(3 * config.quota.usdCny).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`))
    // The row that recorded everything counts a revert, two follow-ups, two failures and its cost.
    assert.match(page, /data-delivery-row="aaaaaaaaaaaa"/)
    assert.match(page, /<code>cccccccccccc<\/code>/)
    assert.match(page, /<td data-label="Follow-ups">2<\/td>/)
    assert.match(page, /<td data-label="Post-merge failures">2<\/td>/)
    // The row that recorded nothing prints — for every fact it never had, model and role included.
    assert.match(page, /<td data-label="Reverted">—<\/td>/)
    assert.match(page, /<td data-label="Follow-ups">—<\/td>/)
    assert.match(page, /<td data-label="Post-merge failures">—<\/td>/)
    assert.match(page, /<td data-label="Cost">—<\/td>/)
    assert.match(page, /<td data-label="Model \/ role"><small class="muted">—<\/small><\/td>/)
  } finally {
    store.close()
  }
})

test('one delivery is a hint, not a rate, and an empty ledger says so in words', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'delivery-page-one', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_delivery_page_one', userId: user.id, owner: 'o', name: 'delivery-page-one', defaultBranch: 'main',
      tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
    })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const one = repoPage({ config, locale: 'en', viewer, repo, jobs: [], deliveryOutcomes: [rowFor(repo.id, 'only')] })
    assert.match(one, /data-delivery-merged="1" data-delivery-reverted="0"/)
    assert.match(one, /Too few deliveries to be a rate, shown as a hint only/)
    const none = repoPage({ config, locale: 'en', viewer, repo, jobs: [], deliveryOutcomes: [] })
    assert.match(none, /data-delivery-outcomes="0"/)
    assert.match(none, /No delivery has merged in this repository yet/)
    assert.doesNotMatch(none, /data-delivery-merged=/)
  } finally {
    store.close()
  }
})

test('a merge copies the producing job cost and model, and a merge with no job carries neither', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const { repoId, userId } = receiver(store, 'copy')
    job(store, repoId, userId, 'job_delivery_copy', 1.5)
    store.updateJob('job_delivery_copy', { provider_model: 'deepseek/v4.1', work_type: 'implement' })
    const jobs = new Jobs(store, config, new MockRunner(), new MemoryMailer())
    jobs.recordMergedDelivery({
      repoId, jobId: 'job_delivery_copy', prUrl: 'https://github.com/o/delivery-copy/pull/1',
      mergeCommit: MERGE_A, mergedAt: '2026-11-18T10:00:00.000Z', title: 'fix the adder carry',
    })
    const row = store.getDeliveryOutcomeByMerge(repoId, MERGE_A)!
    assert.equal(row.cost_usd, 1.5)
    assert.equal(row.model, 'deepseek/v4.1', 'the window can be read per model without a join')
    assert.equal(row.playbook, 'implement')
    jobs.recordMergedDelivery({
      repoId, jobId: null, prUrl: 'https://github.com/o/delivery-copy/pull/2',
      mergeCommit: MERGE_B, mergedAt: '2026-11-18T11:00:00.000Z', title: 'a human merge',
    })
    const human = store.getDeliveryOutcomeByMerge(repoId, MERGE_B)!
    assert.equal(human.job_id, null)
    assert.equal(human.cost_usd, null, 'no job means no cost to copy, and the card prints —')
    assert.equal(human.model, null)
    assert.equal(human.playbook, null)
  } finally {
    store.close()
  }
})

test('the commit read returns one page and drops an entry it cannot name', async () => {
  const seen: string[] = []
  const github = await startFakeServer((request, response) => {
    seen.push(request.url ?? '')
    if ((request.url ?? '').startsWith('/repos/o/recent/commits')) {
      return json(response, 200, [
        { sha: MERGE_A, commit: { message: `fix the adder\n\nThis reverts commit ${MERGE_B}.` } },
        { sha: MERGE_B },
        { commit: { message: 'no sha to name' } },
      ])
    }
    return json(response, 200, { message: 'not a list' })
  })
  try {
    const client = new GithubClient('token', github.url)
    const commits = await client.listRecentCommits('o', 'recent', 'main')
    assert.deepEqual(commits, [{ sha: MERGE_A, message: `fix the adder\n\nThis reverts commit ${MERGE_B}.` }])
    assert.match(seen[0] ?? '', /^\/repos\/o\/recent\/commits\?sha=main&per_page=50$/)
    assert.deepEqual(await client.listRecentCommits('o', 'other', 'main'), [], 'a response that is not a list is no history, not a guess')
  } finally {
    await github.close()
  }
})

test('a follow-up list that cannot be parsed is no link, never a thrown page', () => {
  assert.deepEqual(followUpLinks({ follow_up_json: 'not json' }), [])
  assert.deepEqual(followUpLinks({ follow_up_json: '{"a":1}' }), [], 'an object is not a list of links')
  assert.deepEqual(followUpLinks({ follow_up_json: '["https://github.com/o/r/issues/1",2]' }), ['https://github.com/o/r/issues/1'])
})
