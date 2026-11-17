import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import { jobPage } from '../src/views/pages.js'
import { sha256Hex } from '../src/lib/secrets.js'
import { REVIEW_INSTRUCTION_MAX } from '../src/lib/followUpInstruction.js'
import { MemoryMailer, makeUser, testConfig } from './helpers.js'

// #794: the review callback parses its `followUps` field by field, so the
// reviewer's `instruction` was accepted by nobody and dropped before the goal
// was built — the carrier (#251) and the page read-back already existed, and the
// line was empty for every review-driven follow-up. These cases pin the missing
// half: a callback's instruction reaches the goal, the page reads it back, and a
// review without one produces exactly the goal it produced before.

const RUNNER = { name: 'capture', async run() { return { status: 'running' as const } } }

function repoFor(store: Store, id: string): ReturnType<Store['createRepo']> {
  const user = makeUser(store, { login: `packet-${id}`, status: 'approved' })
  return store.createRepo({
    id, userId: user.id, owner: 'o', name: id, defaultBranch: 'main', tokenEnc: 'x',
    permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
  })
}

function reviewJob(store: Store, repo: ReturnType<Store['createRepo']>, id: string, secret: string): void {
  store.createJob({
    id, repoId: repo.id, userId: repo.user_id, trigger: 'schedule', goal: 'review the pull request',
    callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'review', baseBranch: 'main',
  })
  store.updateJob(id, { status: 'running', branch: 'fledge/callback', started_at: new Date().toISOString() })
}

// `enqueue` appends a carry-over block to every goal; it is not the instruction's
// business, so the comparisons below read the directives the follow-up wrote.
function directives(goal: string): string {
  return goal.split('\n\n[Carry-over')[0] ?? goal
}

function goalWithoutInstruction(prUrl: string, branch: string): string {
  return [
    `Follow-up on the existing pull request ${prUrl} (branch ${branch}).`,
    'Reason: review requested changes.',
    'Continue on the same branch and update the existing PR. Do not open a second PR or create a new issue.',
    'Make the smallest correct fix, add or adjust tests, run the relevant checks, and callback with the branch and PR URL.',
  ].join('\n')
}

test('a review callback carries the reviewer’s words into the follow-up goal and the page', async () => {
  const store = new Store(':memory:')
  const jobs = new Jobs(store, testConfig(), RUNNER, new MemoryMailer())
  const secret = 'packet-callback-secret'
  const prUrl = 'https://github.com/o/packet-callback/pull/7'
  const words = 'the retry loop swallows the error; surface it and add a test for the second attempt'
  try {
    const repo = repoFor(store, 'packet-callback')
    reviewJob(store, repo, 'job_packet_callback', secret)
    const result = await jobs.handleCallback('job_packet_callback', secret, {
      status: 'succeeded',
      reviewScore: 55,
      followUps: [{ prUrl, branch: 'fledge/packet-callback', headSha: 'ccc', reason: 'review requested changes', instruction: words }],
    })
    assert.equal(result.ok, true, result.error ?? 'no error')

    const fix = store.listJobsPageForUser(repo.user_id, 50, 0).find((job) => job.trigger === 'followup')
    assert.ok(fix !== undefined, 'the review follow-up starts its fix')
    assert.ok(fix.goal.includes(`Reviewer asked: ${words}`), `the goal carries the reviewer’s words verbatim; got:\n${fix.goal}`)
    assert.equal(
      directives(fix.goal),
      [
        `Follow-up on the existing pull request ${prUrl} (branch fledge/packet-callback).`,
        'Reason: review requested changes.',
        `Reviewer asked: ${words}`,
        'Continue on the same branch and update the existing PR. Do not open a second PR or create a new issue.',
        'Make the smallest correct fix, add or adjust tests, run the relevant checks, and callback with the branch and PR URL.',
      ].join('\n'),
      'the carried line sits between the reason and the standing directives, not after them',
    )

    const html = jobPage({
      config: testConfig(),
      locale: 'en',
      viewer: { user: store.userById(repo.user_id)!, csrfToken: 'csrf' },
      repo,
      job: fix,
    })
    assert.match(html, /data-reviewer-instruction/)
    assert.match(html, new RegExp(words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 40)))
  } finally {
    store.close()
  }
})

test('a review with no body produces exactly the goal it produced before', async () => {
  const store = new Store(':memory:')
  const jobs = new Jobs(store, testConfig(), RUNNER, new MemoryMailer())
  const secret = 'packet-callback-empty'
  const prUrl = 'https://github.com/o/packet-empty/pull/8'
  try {
    const repo = repoFor(store, 'packet-empty')
    reviewJob(store, repo, 'job_packet_empty', secret)
    const result = await jobs.handleCallback('job_packet_empty', secret, {
      status: 'succeeded',
      reviewScore: 62,
      followUps: [{ prUrl, branch: 'fledge/packet-empty', headSha: 'ddd', reason: 'review requested changes' }],
    })
    assert.equal(result.ok, true, result.error ?? 'no error')
    const fix = store.listJobsPageForUser(repo.user_id, 50, 0).find((job) => job.trigger === 'followup')
    assert.ok(fix !== undefined)
    assert.equal(directives(fix.goal), goalWithoutInstruction(prUrl, 'fledge/packet-empty'), 'no instruction, no extra line')
    const html = jobPage({
      config: testConfig(),
      locale: 'en',
      viewer: { user: store.userById(repo.user_id)!, csrfToken: 'csrf' },
      repo,
      job: fix,
    })
    assert.doesNotMatch(html, /data-reviewer-instruction/)
    assert.doesNotMatch(html, /Reviewer asked:/)
  } finally {
    store.close()
  }
})

test('a callback instruction is bounded by the carrier’s own limit', async () => {
  const store = new Store(':memory:')
  const jobs = new Jobs(store, testConfig(), RUNNER, new MemoryMailer())
  const secret = 'packet-callback-long'
  const prUrl = 'https://github.com/o/packet-long/pull/9'
  try {
    const repo = repoFor(store, 'packet-long')
    reviewJob(store, repo, 'job_packet_long', secret)
    const result = await jobs.handleCallback('job_packet_long', secret, {
      status: 'succeeded',
      reviewScore: 40,
      followUps: [{ prUrl, branch: 'fledge/packet-long', headSha: 'eee', instruction: 'x'.repeat(REVIEW_INSTRUCTION_MAX + 500) }],
    })
    assert.equal(result.ok, true, result.error ?? 'no error')
    const fix = store.listJobsPageForUser(repo.user_id, 50, 0).find((job) => job.trigger === 'followup')
    assert.ok(fix !== undefined)
    const line = directives(fix.goal).split('\n').find((entry) => entry.startsWith('Reviewer asked: '))
    assert.ok(line !== undefined, 'the bounded instruction still reaches the goal')
    assert.ok(line.length <= 'Reviewer asked: '.length + REVIEW_INSTRUCTION_MAX, 'the line stops at the carrier’s bound')
    assert.ok(line.endsWith('…'), 'a clipped instruction ends in an ellipsis, not a silent cut')
  } finally {
    store.close()
  }
})
