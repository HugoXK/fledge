import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import type { RepoRow, UserRow } from '../src/db.js'
import { repoPage } from '../src/views/pages.js'
import { makeUser, testConfig } from './helpers.js'

// #361: the review trend is a page a person reads, so the failure this pins is a
// number that looks confident without a sample behind it. Every case below seeds
// rows the repository already stores (`jobs`, `work_items`, `audit_log`) and then
// renders the real repo page. The two windows share one seed, so a difference
// between them is the window and not a second fixture.

const DAY = 86_400_000
const now = Date.now()

function ago(days: number): string {
  return new Date(now - days * DAY).toISOString()
}

interface Seeded {
  store: Store
  user: UserRow
  repo: RepoRow
}

function makeRepo(store: Store, user: UserRow, name: string): RepoRow {
  return store.createRepo({
    id: `repo_${name}`,
    userId: user.id,
    owner: 'acme',
    name,
    defaultBranch: 'main',
    tokenEnc: 'v1:test',
    goal: 'keep the build green',
    autoIterate: false,
    intervalMinutes: 1440,
  })
}

interface ReviewSeed {
  id: string
  repo: RepoRow
  user: UserRow
  finishedDaysAgo: number
  score: number
  model: string
  workItemId?: string
}

function seedReview(store: Store, seed: ReviewSeed): void {
  store.createJob({
    id: seed.id,
    repoId: seed.repo.id,
    userId: seed.user.id,
    trigger: 'review',
    goal: 'review the open pull requests',
    callbackHash: `hash_${seed.id}`,
    platformTokenHash: `token_${seed.id}`,
    kind: 'review',
    workItemId: seed.workItemId ?? null,
    createdAt: ago(seed.finishedDaysAgo + 1),
  })
  store.updateJob(seed.id, {
    status: 'succeeded',
    finished_at: ago(seed.finishedDaysAgo),
    review_score: seed.score,
    model_json: JSON.stringify({ model: { id: `provider:${seed.model}`, label: seed.model }, attempts: [] }),
  })
}

function seedWorkItem(store: Store, user: UserRow, repo: RepoRow, input: { id: string; prNumber: number; openedDaysAgo: number; mergedDaysAgo?: number; state: string }): void {
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
  // The page asks when the PR was opened, so the fixture pins the row's own
  // creation time rather than using "now" for every item.
  store.run('UPDATE work_items SET created_at = ? WHERE id = ?', ago(input.openedDaysAgo), input.id)
}

function seed(prefix: string): Seeded {
  const store = new Store(':memory:')
  const user = makeUser(store, { login: `${prefix}-owner`, status: 'approved' })
  const repo = makeRepo(store, user, prefix)
  return { store, user, repo }
}

function trend(store: Store, repo: RepoRow, days: number): ReturnType<Store['reviewTrend']> {
  return store.reviewTrend(repo.id, ago(days))
}

function page(input: Seeded): string {
  return repoPage({
    config: testConfig(),
    locale: 'en',
    viewer: { user: input.user, csrfToken: 'csrf' },
    repo: input.repo,
    jobs: [],
    reviewTrend: { week: trend(input.store, input.repo, 7), month: trend(input.store, input.repo, 30) },
  })
}

test('the two windows read one seed, and the rate and averages are the stored rows', () => {
  const seeded = seed('trend')
  const { store, user, repo } = seeded
  try {
    // Two pull requests opened before their review, one merged: the median is
    // read from those rows rather than guessed from the job's own timestamps.
    seedWorkItem(store, user, repo, { id: 'item_a', prNumber: 1, openedDaysAgo: 10, mergedDaysAgo: 3, state: 'approved' })
    seedWorkItem(store, user, repo, { id: 'item_b', prNumber: 2, openedDaysAgo: 8, state: 'changes_requested' })
    seedReview(store, { id: 'review_a', repo, user, finishedDaysAgo: 2, score: 80, model: 'model-a', workItemId: 'item_a' })
    seedReview(store, { id: 'review_b', repo, user, finishedDaysAgo: 4, score: 60, model: 'model-b', workItemId: 'item_b' })
    seedReview(store, { id: 'review_c', repo, user, finishedDaysAgo: 20, score: 90, model: 'model-a' })
    // The outcome of a review is durable only in this audit row; the work item's
    // current state moves on with the next fix.
    store.audit(user.id, 'work_item.review_outcome', 'item_a: approved score=80')
    store.audit(user.id, 'work_item.review_outcome', 'item_b: changes_requested score=60')

    const week = trend(store, repo, 7)
    assert.equal(week.reviews, 2)
    assert.equal(week.averageScore, 70)
    assert.equal(week.outcomes, 2)
    assert.equal(week.changesRequested, 1)
    assert.equal(week.changesRequestedRate, 50)
    assert.equal(week.medianPrOpenToReviewMs, 6 * DAY)
    assert.equal(week.medianPrOpenToMergeMs, 7 * DAY)
    assert.deepEqual(week.models, [
      { label: 'model-a', reviews: 1 },
      { label: 'model-b', reviews: 1 },
    ])
    assert.equal(week.smallSample, true)

    const month = trend(store, repo, 30)
    assert.equal(month.reviews, 3, 'the third review is inside 30 days and outside 7')
    assert.equal(month.averageScore, 76.7)
    assert.equal(month.medianPrOpenToReviewMs, 6 * DAY)
    assert.deepEqual(month.models, [
      { label: 'model-a', reviews: 2 },
      { label: 'model-b', reviews: 1 },
    ])

    const html = page(seeded)
    assert.match(html, /id="review-trend"/)
    assert.match(html, /data-trend-window="week"/)
    assert.match(html, /data-trend-window="month"/)
    assert.match(html, /50% \(1\/2\)/, 'the rate names its own denominator')
    assert.match(html, /6\.0d/, 'median PR to review')
    assert.match(html, /7\.0d/, 'median PR to merge')
    assert.match(html, /model-a ×2/, 'the 30-day window names the model that ran twice')
    assert.match(html, /data-trend-small-sample="1"/, 'two reviews are labelled a small sample')
    assert.doesNotMatch(html, /NaN/)
  } finally {
    seeded.store.close()
  }
})

test('an empty window is —, never 0 and never NaN', () => {
  const seeded = seed('empty')
  try {
    const week = trend(seeded.store, seeded.repo, 7)
    assert.equal(week.reviews, 0)
    assert.equal(week.averageScore, null)
    assert.equal(week.outcomes, 0)
    assert.equal(week.changesRequestedRate, null, 'a rate with no outcome behind it is unknown, not 0%')
    assert.equal(week.medianPrOpenToReviewMs, null)
    assert.equal(week.medianPrOpenToMergeMs, null)
    assert.deepEqual(week.models, [])

    const html = page(seeded)
    assert.match(html, /data-trend-empty="week"/)
    assert.match(html, /data-trend-empty="month"/)
    assert.match(html, /shows — rather than 0/)
    assert.doesNotMatch(html, /NaN/)
    assert.doesNotMatch(html, />0%/, 'an empty window must not print a confident zero')
    assert.doesNotMatch(html, /0% \(\d+\/\d+\)/)
  } finally {
    seeded.store.close()
  }
})

test('one review is labelled small-sample and its number is still shown', () => {
  const seeded = seed('single')
  try {
    seedReview(seeded.store, { id: 'review_only', repo: seeded.repo, user: seeded.user, finishedDaysAgo: 1, score: 91, model: 'model-solo' })

    const week = trend(seeded.store, seeded.repo, 7)
    assert.equal(week.reviews, 1)
    assert.equal(week.averageScore, 91)
    assert.equal(week.smallSample, true)

    const html = page(seeded)
    assert.match(html, /Small sample n=1/)
    assert.match(html, /91/, 'the honest answer is the number plus the label, not a hidden number')
    assert.doesNotMatch(html, /NaN/)
  } finally {
    seeded.store.close()
  }
})

test('another user\'s repository is never counted in this repository\'s trend', () => {
  const mine = seed('mine')
  const other = seed('other')
  try {
    seedWorkItem(mine.store, mine.user, mine.repo, { id: 'mine_item', prNumber: 1, openedDaysAgo: 5, state: 'approved' })
    seedReview(mine.store, { id: 'mine_review', repo: mine.repo, user: mine.user, finishedDaysAgo: 1, score: 88, model: 'model-mine', workItemId: 'mine_item' })
    mine.store.audit(mine.user.id, 'work_item.review_outcome', 'mine_item: approved score=88')

    seedWorkItem(other.store, other.user, other.repo, { id: 'other_item', prNumber: 9, openedDaysAgo: 3, state: 'approved' })
    seedReview(other.store, { id: 'other_review', repo: other.repo, user: other.user, finishedDaysAgo: 1, score: 12, model: 'model-other', workItemId: 'other_item' })
    other.store.audit(other.user.id, 'work_item.review_outcome', 'other_item: changes_requested score=12')

    const mineWeek = trend(mine.store, mine.repo, 7)
    assert.equal(mineWeek.reviews, 1)
    assert.equal(mineWeek.averageScore, 88)
    assert.equal(mineWeek.changesRequested, 0)
    assert.deepEqual(mineWeek.models, [{ label: 'model-mine', reviews: 1 }])

    const otherWeek = trend(other.store, other.repo, 7)
    assert.equal(otherWeek.reviews, 1)
    assert.equal(otherWeek.averageScore, 12)
    assert.equal(otherWeek.changesRequestedRate, 100)

    const html = page(mine)
    assert.match(html, /model-mine/)
    assert.doesNotMatch(html, /model-other/, "another repository's model must not appear")
    assert.doesNotMatch(html, /12%|88%|100%/, 'no other-repository rate leaks into this page')
  } finally {
    mine.store.close()
    other.store.close()
  }
})
