import test from 'node:test'
import assert from 'node:assert/strict'
import { retryDecision } from '../src/lib/retry.js'

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
