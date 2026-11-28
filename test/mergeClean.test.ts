import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyMergeCandidate, latestRun, planMergeClean } from '../scripts/lib/merge-clean.mjs'
import type {
  MergeCandidateCheckRun,
  MergeCandidateEntry,
  MergeCandidatePullRequest,
} from '../scripts/lib/merge-clean.mjs'

const HEAD = 'a'.repeat(40)
const MOVED = 'b'.repeat(40)
const REQUIRED = ['ci-ok', 'review-gate', 'pr-lint']
const DEFAULT = 'main'

function pullRequest(overrides: Partial<MergeCandidatePullRequest> = {}): MergeCandidatePullRequest {
  return {
    number: 1314,
    state: 'open',
    draft: false,
    head: { ref: 'feature/1314', sha: HEAD, repo: { full_name: 'HugoXK/fledge' } },
    base: { ref: DEFAULT, repo: { full_name: 'HugoXK/fledge' } },
    ...overrides,
  }
}

function green(at = '2026-11-28T00:00:00Z'): MergeCandidateCheckRun[] {
  return REQUIRED.map((name) => ({
    name,
    status: 'completed',
    conclusion: 'success',
    started_at: at,
    completed_at: at,
  }))
}

function classify(overrides: MergeCandidateEntry = {}, prOverrides: Partial<MergeCandidatePullRequest> = {}) {
  return classifyMergeCandidate({
    pr: pullRequest(prOverrides),
    tier: 'T0',
    checks: green(),
    defaultBranch: DEFAULT,
    ...overrides,
  })
}

test('a green T0 pull request is enqueued', () => {
  const decision = classify()
  assert.equal(decision.action, 'enqueue')
  assert.equal(decision.reason, '')
  assert.equal(decision.tier, 'T0')
  assert.equal(decision.number, 1314)
  assert.equal(decision.head, HEAD)
})

test('a green T1 pull request is enqueued', () => {
  const decision = classify({ tier: 'T1' }, { number: 1272 })
  assert.equal(decision.action, 'enqueue')
  assert.equal(decision.tier, 'T1')
})

test('a T2 pull request is never merged by this path, even with green checks', () => {
  const decision = classify({ tier: 'T2' })
  assert.equal(decision.action, 'skip')
  assert.equal(decision.reason, 'tierT2')
})

test('a T3 pull request is never merged by this path', () => {
  const decision = classify({ tier: 'T3' })
  assert.equal(decision.action, 'skip')
  assert.equal(decision.reason, 'tierT3')
})

test('a hold label blocks the merge', () => {
  const [decision] = planMergeClean({
    entries: [{ pr: pullRequest(), tier: 'T1', checks: green(), labels: ['hold', 'review:approved'] }],
    defaultBranch: DEFAULT,
  }).decisions
  assert.ok(decision)
  assert.equal(decision.action, 'skip')
  assert.equal(decision.reason, 'hold')
})

test('a state:hold label blocks the merge too', () => {
  const [decision] = planMergeClean({
    entries: [{ pr: pullRequest(), tier: 'T1', checks: green(), labels: ['state:hold'] }],
    defaultBranch: DEFAULT,
  }).decisions
  assert.ok(decision)
  assert.equal(decision.action, 'skip')
  assert.equal(decision.reason, 'hold')
})

test('a review:changes label blocks the merge', () => {
  const [decision] = planMergeClean({
    entries: [{ pr: pullRequest(), tier: 'T1', checks: green(), labels: ['review:changes'] }],
    defaultBranch: DEFAULT,
  }).decisions
  assert.ok(decision)
  assert.equal(decision.action, 'skip')
  assert.equal(decision.reason, 'changes')
})

test('a CHANGES_REQUESTED review blocks the merge even without the label', () => {
  const decision = classify({ changesRequested: true })
  assert.equal(decision.action, 'skip')
  assert.equal(decision.reason, 'changes')
})

test('a fork head is skipped: the head repository must be the base repository', () => {
  const decision = classify({}, { head: { ref: 'feature/1314', sha: HEAD, repo: { full_name: 'attacker/fork' } } })
  assert.equal(decision.action, 'skip')
  assert.equal(decision.reason, 'fork')
})

test('a base other than the default branch is skipped', () => {
  const decision = classify({}, { base: { ref: 'release/0.5', repo: { full_name: 'HugoXK/fledge' } } })
  assert.equal(decision.action, 'skip')
  assert.equal(decision.reason, 'base')
})

test('a truncated file list is skipped instead of under-tiering', () => {
  const decision = classify({ filesTruncated: true })
  assert.equal(decision.action, 'skip')
  assert.equal(decision.reason, 'files-truncated')
})

test('a head that moved while the checks were read is skipped', () => {
  const decision = classify({ observedHead: MOVED })
  assert.equal(decision.action, 'skip')
  assert.equal(decision.reason, 'head-moved')
})

test('a draft is skipped before any tier is read', () => {
  const decision = classify({}, { draft: true })
  assert.equal(decision.reason, 'draft')
})

test('an already queued pull request is never queued twice', () => {
  const decision = classify({}, { auto_merge: { merge_method: 'squash' } })
  assert.equal(decision.reason, 'queued')
})

test('a missing required check is not evidence that it will turn green', () => {
  const decision = classify({ checks: green().slice(0, 2) })
  assert.equal(decision.action, 'skip')
  assert.equal(decision.reason, 'checks')
})

test('a failing required check blocks the merge', () => {
  const checks = green()
  checks[2] = { name: 'pr-lint', status: 'completed', conclusion: 'failure', started_at: '2026-11-28T00:00:00Z' }
  const decision = classify({ checks })
  assert.equal(decision.action, 'skip')
  assert.equal(decision.reason, 'checks')
})

test('a newer non-completed run of a required check blocks an older green', () => {
  const checks: MergeCandidateCheckRun[] = [
    ...green('2026-11-27T00:00:00Z'),
    { name: 'ci-ok', status: 'in_progress', conclusion: null, started_at: '2026-11-28T01:00:00Z' },
  ]
  assert.equal(latestRun(checks, 'ci-ok')?.status, 'in_progress')
  const decision = classify({ checks })
  assert.equal(decision.action, 'skip')
  assert.equal(decision.reason, 'checks')
})
