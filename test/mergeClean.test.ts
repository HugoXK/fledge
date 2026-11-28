import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyMergeCandidate, latestConclusion, planMergeClean } from '../scripts/lib/merge-clean.mjs'
import type {
  MergeCandidateCheckRun,
  MergeCandidatePullRequest,
} from '../scripts/lib/merge-clean.mjs'

const HEAD = 'a'.repeat(40)
const MOVED = 'b'.repeat(40)
const REQUIRED = ['ci-ok', 'review-gate', 'pr-lint']

function pullRequest(overrides: Partial<MergeCandidatePullRequest> = {}): MergeCandidatePullRequest {
  return {
    number: 1314,
    state: 'open',
    draft: false,
    head: { ref: 'feature/1314', sha: HEAD },
    base: { repo: { full_name: 'HugoXK/fledge' } },
    ...overrides,
  }
}

function green(): MergeCandidateCheckRun[] {
  return REQUIRED.map((name) => ({
    name,
    status: 'completed',
    conclusion: 'success',
    completed_at: '2026-11-28T00:00:00Z',
  }))
}

test('a green T0 pull request is enqueued', () => {
  const decision = classifyMergeCandidate({ pr: pullRequest(), tier: 'T0', checks: green() })
  assert.equal(decision.action, 'enqueue')
  assert.equal(decision.reason, '')
  assert.equal(decision.tier, 'T0')
  assert.equal(decision.number, 1314)
  assert.equal(decision.head, HEAD)
})

test('a green T1 pull request is enqueued', () => {
  const decision = classifyMergeCandidate({ pr: pullRequest({ number: 1272 }), tier: 'T1', checks: green() })
  assert.equal(decision.action, 'enqueue')
  assert.equal(decision.tier, 'T1')
})

test('a T2 pull request is never merged by this path, even with green checks', () => {
  const decision = classifyMergeCandidate({ pr: pullRequest(), tier: 'T2', checks: green() })
  assert.equal(decision.action, 'skip')
  assert.equal(decision.reason, 'tierT2')
})

test('a T3 pull request is never merged by this path', () => {
  const decision = classifyMergeCandidate({ pr: pullRequest(), tier: 'T3', checks: green() })
  assert.equal(decision.action, 'skip')
  assert.equal(decision.reason, 'tierT3')
})

test('a hold label blocks the merge', () => {
  const plan = planMergeClean({
    entries: [{ pr: pullRequest(), tier: 'T1', checks: green(), labels: ['hold', 'review:approved'] }],
  })
  const [decision] = plan.decisions
  assert.ok(decision)
  assert.equal(decision.action, 'skip')
  assert.equal(decision.reason, 'hold')
  assert.deepEqual(plan.candidates, [])
})

test('a head that moved while the checks were read is skipped', () => {
  const decision = classifyMergeCandidate({
    pr: pullRequest(),
    tier: 'T0',
    checks: green(),
    observedHead: MOVED,
  })
  assert.equal(decision.action, 'skip')
  assert.equal(decision.reason, 'head-moved')
})

test('a draft is skipped before any tier is read', () => {
  const decision = classifyMergeCandidate({ pr: pullRequest({ draft: true }), tier: 'T0', checks: green() })
  assert.equal(decision.reason, 'draft')
})

test('an already queued pull request is never queued twice', () => {
  const decision = classifyMergeCandidate({ pr: pullRequest({ auto_merge: { merge_method: 'squash' } }), tier: 'T1', checks: green() })
  assert.equal(decision.reason, 'queued')
})

test('a missing required check is not evidence that it will turn green', () => {
  const decision = classifyMergeCandidate({ pr: pullRequest(), tier: 'T0', checks: green().slice(0, 2) })
  assert.equal(decision.action, 'skip')
  assert.equal(decision.reason, 'checks')
})

test('a failing required check blocks the merge', () => {
  const checks = green()
  checks[2] = { name: 'pr-lint', status: 'completed', conclusion: 'failure', completed_at: '2026-11-28T00:00:00Z' }
  const decision = classifyMergeCandidate({ pr: pullRequest(), tier: 'T1', checks })
  assert.equal(decision.action, 'skip')
  assert.equal(decision.reason, 'checks')
})

test('the newest check run for a name is the one that decides', () => {
  const checks: MergeCandidateCheckRun[] = [
    { name: 'ci-ok', status: 'completed', conclusion: 'failure', completed_at: '2026-11-27T00:00:00Z' },
    { name: 'ci-ok', status: 'completed', conclusion: 'success', completed_at: '2026-11-28T00:00:00Z' },
  ]
  assert.equal(latestConclusion(checks, 'ci-ok')?.conclusion, 'success')
})
