import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import { MemoryMailer, makeUser, testConfig } from './helpers.js'
import { DEFAULT_MAX_REVISIONS, classifyReviewAuthor, decideRevision, parseMaxRevisions, revisionCounterKey } from '../src/lib/revisionBudget.js'

// #637: a review that requests changes may start a fix, but a review bot that
// keeps reviewing its own loop must not spend budget without a bound. The rule
// is a pure function; the counter lives beside the follow-up that starts the
// work, because that is the only place a fix job is created.

function repoFor(store: Store, id: string): ReturnType<Store['createRepo']> {
  const user = makeUser(store, { login: `budget-${id}`, status: 'approved' })
  return store.createRepo({
    id, userId: user.id, owner: 'o', name: id, defaultBranch: 'main', tokenEnc: 'x',
    permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
  })
}

function finish(store: Store, jobId: string | undefined): void {
  if (jobId === undefined) return
  store.updateJob(jobId, { status: 'succeeded', finished_at: new Date().toISOString() })
}

const RUNNER = { name: 'capture', async run() { return { status: 'running' as const } } }

test('a human request is never counted and is never refused by the budget', async () => {
  const store = new Store(':memory:')
  const jobs = new Jobs(store, testConfig(), RUNNER, new MemoryMailer())
  try {
    const repo = repoFor(store, 'repo_humans')
    for (const reason of ['one', 'two', 'three', 'four']) {
      const result = await jobs.followUp(repo, {
        prUrl: 'https://github.com/o/humans/pull/1', branch: 'fledge/humans', reason, headSha: 'aaa',
        reviewAuthor: 'human',
      })
      assert.equal(result.ok, true, `human request ${reason} must start a fix`)
      finish(store, result.job?.id)
    }
  } finally {
    store.close()
  }
})

test('a third-party review bot causes at most one fix per pull request', async () => {
  const store = new Store(':memory:')
  const jobs = new Jobs(store, testConfig(), RUNNER, new MemoryMailer())
  try {
    const repo = repoFor(store, 'repo_other_bot')
    const first = await jobs.followUp(repo, {
      prUrl: 'https://github.com/o/bot/pull/2', branch: 'fledge/bot', reason: 'review requested changes', headSha: 'bbb',
      reviewAuthor: 'bot',
    })
    assert.equal(first.ok, true)
    finish(store, first.job?.id)
    const second = await jobs.followUp(repo, {
      prUrl: 'https://github.com/o/bot/pull/2', branch: 'fledge/bot', reason: 'lint bot requested changes', headSha: 'bbb',
      reviewAuthor: 'bot',
    })
    assert.equal(second.ok, false, 'a second bot review must not start a second fix')
    assert.equal(second.code, 'REVISION_BUDGET')
  } finally {
    store.close()
  }
})

test('the platform reviewer stops at its configured limit and resets for a new head', async () => {
  const store = new Store(':memory:')
  const jobs = new Jobs(store, testConfig(), RUNNER, new MemoryMailer())
  const prUrl = 'https://github.com/o/self/pull/3'
  try {
    const repo = repoFor(store, 'repo_self_review')
    for (const reason of ['first', 'second', 'third']) {
      const result = await jobs.followUp(repo, { prUrl, branch: 'fledge/self', reason, headSha: 'ccc', reviewAuthor: 'reviewer' })
      assert.equal(result.ok, true, `${reason} review must start a fix inside the budget`)
      finish(store, result.job?.id)
    }
    const over = await jobs.followUp(repo, { prUrl, branch: 'fledge/self', reason: 'fourth', headSha: 'ccc', reviewAuthor: 'reviewer' })
    assert.equal(over.ok, false, 'the fourth review at the same head must be refused')
    assert.equal(over.code, 'REVISION_BUDGET')
    const newHead = await jobs.followUp(repo, { prUrl, branch: 'fledge/self', reason: 'new head', headSha: 'ddd', reviewAuthor: 'reviewer' })
    assert.equal(newHead.ok, true, 'a new head resets the budget')
  } finally {
    store.close()
  }
})

test('a repository can lower its own revision limit', async () => {
  const store = new Store(':memory:')
  const jobs = new Jobs(store, testConfig(), RUNNER, new MemoryMailer())
  const prUrl = 'https://github.com/o/limit/pull/4'
  try {
    const repo = repoFor(store, 'repo_limit')
    store.setSetting(`repo:${repo.id}:max_revisions`, '1')
    const first = await jobs.followUp(repo, { prUrl, branch: 'fledge/limit', reason: 'one', headSha: 'eee', reviewAuthor: 'reviewer' })
    assert.equal(first.ok, true)
    finish(store, first.job?.id)
    const second = await jobs.followUp(repo, { prUrl, branch: 'fledge/limit', reason: 'two', headSha: 'eee', reviewAuthor: 'reviewer' })
    assert.equal(second.ok, false)
    assert.equal(second.code, 'REVISION_BUDGET')
  } finally {
    store.close()
  }
})

test('the existing fingerprint dedupe still refuses before the budget counts', async () => {
  const store = new Store(':memory:')
  const jobs = new Jobs(store, testConfig(), RUNNER, new MemoryMailer())
  const prUrl = 'https://github.com/o/dedupe/pull/5'
  try {
    const repo = repoFor(store, 'repo_dedupe')
    const first = await jobs.followUp(repo, { prUrl, branch: 'fledge/dedupe', reason: 'same words', headSha: 'fff', reviewAuthor: 'reviewer' })
    assert.equal(first.ok, true)
    finish(store, first.job?.id)
    const duplicate = await jobs.followUp(repo, { prUrl, branch: 'fledge/dedupe', reason: 'same words', headSha: 'fff', reviewAuthor: 'reviewer' })
    assert.equal(duplicate.ok, false)
    assert.equal(duplicate.code, 'DUPLICATE_FOLLOWUP', 'the inner guard answers first and does not spend budget')
  } finally {
    store.close()
  }
})

test('the review author is classified by identity, not by how it behaves', () => {
  assert.equal(classifyReviewAuthor('alice', 'User', 'fledge[bot]'), 'human', 'a person is a person')
  assert.equal(classifyReviewAuthor('dependabot[bot]', 'Bot', 'fledge[bot]'), 'bot', 'an App bot login is a third party')
  assert.equal(classifyReviewAuthor('lint-bot', 'Bot', 'fledge[bot]'), 'bot', 'a review payload can say Bot without the login suffix')
  assert.equal(classifyReviewAuthor('fledge[bot]', 'Bot', 'fledge[bot]'), 'reviewer', 'the platform reviewer is recognised before it is called a third party')
  assert.equal(classifyReviewAuthor('Fledge[bot]', 'Bot', 'fledge[bot]'), 'reviewer', 'the login compare is case-insensitive')
})

test('the rule refuses exactly at the ceiling and never counts a person', () => {
  assert.deepEqual(decideRevision({ author: 'human', used: 99, limit: 1 }), { allow: true, counted: false, used: 99 })
  assert.deepEqual(decideRevision({ author: 'bot', used: 0, limit: 3 }), { allow: true, counted: true, used: 1 })
  assert.equal(decideRevision({ author: 'bot', used: 1, limit: 3 }).allow, false)
  assert.equal(decideRevision({ author: 'reviewer', used: 2, limit: 3 }).allow, true)
  assert.equal(decideRevision({ author: 'reviewer', used: 3, limit: 3 }).allow, false)
  // A limit that is not a positive integer falls back to the default instead of
  // disabling the budget.
  assert.equal(parseMaxRevisions('0'), DEFAULT_MAX_REVISIONS)
  assert.equal(parseMaxRevisions('nonsense'), DEFAULT_MAX_REVISIONS)
  assert.equal(parseMaxRevisions('1'), 1)
})

test('the bot counter is per pull request and the reviewer counter is per head', () => {
  const pr = 'https://github.com/o/r/pull/6'
  assert.equal(
    revisionCounterKey('bot', 'repo_x', pr, 'aaa'),
    revisionCounterKey('bot', 'repo_x', pr, 'bbb'),
    'a third-party bot has one fix for the whole pull request, whichever head it reviewed',
  )
  assert.notEqual(
    revisionCounterKey('reviewer', 'repo_x', pr, 'aaa'),
    revisionCounterKey('reviewer', 'repo_x', pr, 'bbb'),
    'the platform reviewer resets when the head it reviewed moves',
  )
})
