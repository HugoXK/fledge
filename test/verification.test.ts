import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeReadiness, parsePathGuard, parseVerification } from '../src/lib/verification.js'

const base = { pr_url: 'https://github.com/o/r/pull/1', path_guard_json: null, verification_json: null, status: 'succeeded' as const, pr_state: 'open' }

test('merge readiness is unknown until verification exists', () => {
  assert.equal(mergeReadiness(base).state, 'unknown')
})

test('path guard violations block merge readiness', () => {
  const guard = { ok: false, checkedAt: '2026-01-01T00:00:00.000Z', allow: ['src/'], deny: [], files: ['.github/x'], violations: [{ file: '.github/x', reason: 'not_allowed' as const }] }
  const readiness = mergeReadiness({ ...base, path_guard_json: JSON.stringify(guard) })
  assert.equal(readiness.state, 'blocked')
  assert.match(readiness.reasons[0] ?? '', /\.github\/x/)
})

test('verified evidence decides ready or blocked', () => {
  const ok = { ok: true, checkedAt: '2026-01-01T00:00:00.000Z', sha: 'abc', prState: 'open', draft: false, mergeableState: 'clean', checks: { total: 1, green: 1, failing: [], pending: [] }, combinedStatus: 'success', reviews: { changesRequested: false, approvals: 0 }, reasons: [] }
  assert.equal(mergeReadiness({ ...base, verification_json: JSON.stringify(ok) }).state, 'ready')
  assert.equal(parseVerification(JSON.stringify(ok))?.ok, true)
  assert.equal(parsePathGuard(null), null)
  const blocked = { ...ok, ok: false, reasons: ['Failing checks: ci'] }
  assert.equal(mergeReadiness({ ...base, verification_json: JSON.stringify(blocked) }).state, 'blocked')
})
