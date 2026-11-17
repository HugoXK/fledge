import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import type { RepoRow, UserRow } from '../src/db.js'
import { repoPage } from '../src/views/pages.js'
import { makeUser, testConfig } from './helpers.js'

// #794: two numbers on the review trend were not the numbers they claimed.
// `medianPrOpenToReviewMs` joined every succeeded review job to its work item,
// so a PR reviewed three times contributed three samples and the "first
// decision" latency was really the median of every decision. And an override was
// audited as a bare sentence with no way to name the decision it overturned.
// These cases read the same stored rows the page reads: `jobs`, `work_items` and
// `audit_log`.

const DAY = 86_400_000
const now = Date.now()

function ago(days: number): string {
  return new Date(now - days * DAY).toISOString()
}

const TIP_A = 'a'.repeat(40)
const TIP_B = 'b'.repeat(40)

interface Seeded {
  store: Store
  user: UserRow
  repo: RepoRow
}

function seed(prefix: string): Seeded {
  const store = new Store(':memory:')
  const user = makeUser(store, { login: `${prefix}-owner`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_${prefix}`, userId: user.id, owner: 'acme', name: prefix, defaultBranch: 'main', tokenEnc: 'v1:test',
    goal: 'keep the build green', autoIterate: false, intervalMinutes: 1440,
  })
  return { store, user, repo }
}

function seedWorkItem(
  store: Store,
  user: UserRow,
  repo: RepoRow,
  input: { id: string; prNumber: number; openedDaysAgo: number; mergedDaysAgo?: number; state: string },
): void {
  store.createWorkItem({
    id: input.id,
    repoId: repo.id,
    userId: user.id,
    title: `pull request ${input.prNumber}`,
    prUrl: `https://github.com/acme/${repo.name}/pull/${input.prNumber}`,
    state: input.state,
    prState: input.mergedDaysAgo === undefined ? 'open' : 'merged',
    ...(input.mergedDaysAgo === undefined ? {} : { mergedAt: ago(input.mergedDaysAgo) }),
  })
  store.run('UPDATE work_items SET created_at = ? WHERE id = ?', ago(input.openedDaysAgo), input.id)
}

function seedReview(
  store: Store,
  user: UserRow,
  repo: RepoRow,
  input: { id: string; finishedDaysAgo: number; score: number; model: string; workItemId?: string },
): void {
  store.createJob({
    id: input.id,
    repoId: repo.id,
    userId: user.id,
    trigger: 'review',
    goal: 'review the open pull requests',
    callbackHash: `hash_${input.id}`,
    platformTokenHash: `token_${input.id}`,
    kind: 'review',
    workItemId: input.workItemId ?? null,
    createdAt: ago(input.finishedDaysAgo + 1),
  })
  store.updateJob(input.id, {
    status: 'succeeded',
    finished_at: ago(input.finishedDaysAgo),
    review_score: input.score,
    model_json: JSON.stringify({ model: { id: `provider:${input.model}`, label: input.model }, attempts: [] }),
  })
}

function page(seeded: Seeded): string {
  const week = seeded.store.reviewTrend(seeded.repo.id, ago(7))
  const month = seeded.store.reviewTrend(seeded.repo.id, ago(30))
  return repoPage({
    config: testConfig(),
    locale: 'en',
    viewer: { user: seeded.user, csrfToken: 'csrf' },
    repo: seeded.repo,
    jobs: [],
    reviewTrend: { week, month },
  })
}

test('the trend takes one first-decision sample per work item, and says so', () => {
  const seeded = seed('first-decision')
  const { store, user, repo } = seeded
  try {
    // item_a: opened ten days ago, reviewed once one day ago -> 9 days.
    // item_b: opened eight days ago, reviewed three times (7, 6, 5 days ago);
    //         the first decision is the 1-day one, not 2 and 3 as well.
    // item_c: opened six days ago, reviewed once one day ago -> 5 days.
    seedWorkItem(store, user, repo, { id: 'item_a', prNumber: 1, openedDaysAgo: 10, state: 'changes_requested' })
    seedWorkItem(store, user, repo, { id: 'item_b', prNumber: 2, openedDaysAgo: 8, mergedDaysAgo: 4, state: 'merged' })
    seedWorkItem(store, user, repo, { id: 'item_c', prNumber: 3, openedDaysAgo: 6, state: 'approved' })
    seedReview(store, user, repo, { id: 'job_ra', finishedDaysAgo: 1, score: 50, model: 'model-a', workItemId: 'item_a' })
    seedReview(store, user, repo, { id: 'job_rb1', finishedDaysAgo: 7, score: 40, model: 'model-b', workItemId: 'item_b' })
    seedReview(store, user, repo, { id: 'job_rb2', finishedDaysAgo: 6, score: 55, model: 'model-b', workItemId: 'item_b' })
    seedReview(store, user, repo, { id: 'job_rb3', finishedDaysAgo: 5, score: 60, model: 'model-b', workItemId: 'item_b' })
    seedReview(store, user, repo, { id: 'job_rc', finishedDaysAgo: 1, score: 91, model: 'model-a', workItemId: 'item_c' })

    const week = store.reviewTrend(repo.id, ago(7))
    assert.equal(week.reviews, 5, 'five reviews are still five reviews')
    assert.equal(week.medianPrOpenToReviewMs, 5 * DAY, 'samples are 9, 1 (item_b first) and 5 days; the median is 5')
    assert.notEqual(week.medianPrOpenToReviewMs, 3 * DAY, 'counting every review of item_b would move the median to 3 days')

    const html = page(seeded)
    assert.match(html, /PR→first decision/, 'the column says which latency it is')
  } finally {
    seeded.store.close()
  }
})

test('the override rate counts a merge past a recorded blocking decision', () => {
  const seeded = seed('override-rate')
  const { store, user, repo } = seeded
  try {
    seedWorkItem(store, user, repo, { id: 'item_a', prNumber: 1, openedDaysAgo: 10, state: 'changes_requested' })
    seedWorkItem(store, user, repo, { id: 'item_b', prNumber: 2, openedDaysAgo: 8, mergedDaysAgo: 4, state: 'merged' })
    seedWorkItem(store, user, repo, { id: 'item_c', prNumber: 3, openedDaysAgo: 6, state: 'approved' })
    seedReview(store, user, repo, { id: 'job_ra', finishedDaysAgo: 2, score: 50, model: 'model-a', workItemId: 'item_a' })
    seedReview(store, user, repo, { id: 'job_rb', finishedDaysAgo: 5, score: 60, model: 'model-b', workItemId: 'item_b' })
    seedReview(store, user, repo, { id: 'job_rc', finishedDaysAgo: 1, score: 91, model: 'model-a', workItemId: 'item_c' })
    // The decision row is the record both the trend and an override read. It
    // names the review that made the decision, its score, its model and the tip
    // that review covered.
    store.audit(user.id, 'work_item.review_outcome', `item_a: changes_requested score=50 review=job_ra tip=${TIP_A} model=model-a`)
    store.audit(user.id, 'work_item.review_outcome', `item_b: changes_requested score=60 review=job_rb tip=${TIP_B} model=model-b`)
    store.audit(user.id, 'work_item.review_outcome', 'item_c: approved score=91 review=job_rc tip=- model=model-a')
    // The merge that went past item_b's blocking decision, audited against the
    // iterate job it merged.
    store.createJob({
      id: 'job_fix_b', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'fix it', callbackHash: 'hash_fix_b',
      platformTokenHash: '', kind: 'iterate', workItemId: 'item_b', createdAt: ago(4),
    })
    store.updateJob('job_fix_b', {
      status: 'succeeded', finished_at: ago(4), pr_url: 'https://github.com/acme/override-rate/pull/2', branch: 'fledge/fix-b',
    })
    store.audit(user.id, 'job.merge_review_override', `job_fix_b: review job_rb score=60 tip=${TIP_B} model=model-b reason=review 60 < 80`)

    const week = store.reviewTrend(repo.id, ago(7))
    assert.equal(week.blockingDecisions, 2, 'two recorded changes_requested decisions in the window')
    assert.equal(week.overrides, 1, 'one merge went past a recorded blocking decision')
    assert.equal(week.overrideRate, 50, 'one override over two blocking decisions is 50%, not 100% and not 0')
    assert.equal(week.overrideDetails.length, 1)
    assert.equal(week.overrideDetails[0]?.reviewJobId, 'job_rb')
    assert.equal(week.overrideDetails[0]?.score, 60)
    assert.equal(week.overrideDetails[0]?.model, 'model-b')
    assert.equal(week.overrideDetails[0]?.tip, TIP_B)

    const html = page(seeded)
    assert.match(html, /data-trend-override/)
    assert.match(html, /job_rb/, 'the trend row names the review job the override overturned')
    assert.match(html, /model-b/, 'and the model that made the decision')
    assert.match(html, new RegExp(TIP_B.slice(0, 12)), 'and the tip it covered')
    assert.match(html, /50% \(1\/2\)/, 'the override rate names its own denominator')
  } finally {
    seeded.store.close()
  }
})

test('an override with no recorded blocking decision stays out of the rate', () => {
  const seeded = seed('override-nothing')
  const { store, user, repo } = seeded
  try {
    seedWorkItem(store, user, repo, { id: 'item_a', prNumber: 1, openedDaysAgo: 10, state: 'changes_requested' })
    seedWorkItem(store, user, repo, { id: 'item_b', prNumber: 2, openedDaysAgo: 8, mergedDaysAgo: 4, state: 'merged' })
    seedReview(store, user, repo, { id: 'job_ra', finishedDaysAgo: 2, score: 50, model: 'model-a', workItemId: 'item_a' })
    seedReview(store, user, repo, { id: 'job_rb', finishedDaysAgo: 5, score: 72, model: 'model-b', workItemId: 'item_b' })
    store.audit(user.id, 'work_item.review_outcome', `item_a: changes_requested score=50 review=job_ra tip=${TIP_A} model=model-a`)
    // item_b's recorded outcome is `approved`: a threshold-only block is derived
    // at merge time and has no decision row, so it is audited on the job page but
    // is not part of the trend's denominator.
    store.audit(user.id, 'work_item.review_outcome', `item_b: approved score=72 review=job_rb tip=${TIP_B} model=model-b`)
    store.createJob({
      id: 'job_fix_b', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'fix it', callbackHash: 'hash_fix_b',
      platformTokenHash: '', kind: 'iterate', workItemId: 'item_b', createdAt: ago(4),
    })
    store.updateJob('job_fix_b', {
      status: 'succeeded', finished_at: ago(4), pr_url: 'https://github.com/acme/override-nothing/pull/2', branch: 'fledge/fix-b',
    })
    store.audit(user.id, 'job.merge_review_override', `job_fix_b: review job_rb score=72 tip=${TIP_B} model=model-b reason=review 72 < 80`)

    const week = store.reviewTrend(repo.id, ago(7))
    assert.equal(week.blockingDecisions, 1)
    assert.equal(week.overrides, 0, 'no recorded blocking decision was overturned')
    assert.equal(week.overrideRate, 0, 'the denominator is the recorded decision, not the derived block')
  } finally {
    seeded.store.close()
  }
})

test('an empty window shows — for the override rate, never 0', () => {
  const seeded = seed('override-empty')
  try {
    const week = seeded.store.reviewTrend(seeded.repo.id, ago(7))
    assert.equal(week.blockingDecisions, 0)
    assert.equal(week.overrides, 0)
    assert.equal(week.overrideRate, null, 'no blocking decision means the rate is unknown, not zero')
    assert.deepEqual(week.overrideDetails, [])

    const html = page(seeded)
    assert.match(html, /data-trend-empty="week"/)
    assert.doesNotMatch(html, /data-trend-override-rate="week"[^<]*>0%/)
  } finally {
    seeded.store.close()
  }
})
