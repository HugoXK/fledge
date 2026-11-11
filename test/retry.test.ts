import test from 'node:test'
import assert from 'node:assert/strict'
import { retryDecision, reviewRetryDecision } from '../src/lib/retry.js'

test('transient failures retry with bounded exponential backoff', () => {
  assert.deepEqual(retryDecision('bridge', 0), { retry: true, delayMs: 60_000, reason: 'bridge is transient' })
  assert.equal(retryDecision('model', 1).delayMs, 120_000)
  assert.equal(retryDecision('timeout', 2).retry, false)
})

test('permanent failures never auto-retry', () => {
  for (const kind of ['quota', 'credential', 'stage_evidence', 'workflow', 'review', 'unknown'] as const) {
    assert.equal(retryDecision(kind, 0).retry, false, kind)
  }
})

test('a review job gets one automatic retry on a transient failure', () => {
  for (const kind of ['bridge', 'model', 'timeout', 'stalled'] as const) {
    const decision = reviewRetryDecision(kind, 0)
    assert.equal(decision.retry, true, kind)
    assert.equal(decision.delayMs, 60_000)
    assert.ok(decision.delayMs <= 30 * 60_000)
  }
  // One retry is the bound: the next failure is manual again.
  assert.deepEqual(reviewRetryDecision('bridge', 1), { retry: false, delayMs: 0, reason: 'review retry limit 1 reached' })
})

test('a review job does not retry a permanent or GitHub-side failure', () => {
  // github is transient for an iterate job but not for a review: the pull request
  // may have moved, so the human stays in the loop.
  for (const kind of ['github', 'quota', 'credential', 'review', 'unknown'] as const) {
    assert.equal(reviewRetryDecision(kind, 0).retry, false, kind)
  }
  assert.equal(reviewRetryDecision(undefined, 0).retry, false)
})
