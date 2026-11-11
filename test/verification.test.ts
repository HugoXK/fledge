import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateTestEvidence, mergeReadiness, parsePathGuard, parseVerification } from '../src/lib/verification.js'

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

const okVerification = { ok: true, checkedAt: '2026-01-01T00:00:00.000Z', sha: 'abc', prState: 'open', draft: false, mergeableState: 'clean', checks: { total: 1, green: 1, failing: [], pending: [] }, combinedStatus: 'success', reviews: { changesRequested: false, approvals: 0 }, reasons: [] }
const okGuard = { ok: true, checkedAt: '2026-01-01T00:00:00.000Z', allow: ['src/'], deny: [], files: ['src/a.ts'], violations: [] }

test('verified evidence decides blocked, and evidence alone is not ready', () => {
  assert.equal(parseVerification(JSON.stringify(okVerification))?.ok, true)
  assert.equal(parsePathGuard(null), null)
  const blocked = { ...okVerification, ok: false, reasons: ['Failing checks: ci'] }
  assert.equal(mergeReadiness({ ...base, verification_json: JSON.stringify(blocked) }).state, 'blocked')
})

test('readiness needs both halves of the evidence', () => {
  const guardOnly = mergeReadiness({ ...base, path_guard_json: JSON.stringify(okGuard) })
  assert.equal(guardOnly.state, 'unknown', 'a path guard without an evidence check is not a merge verdict')
  assert.match(guardOnly.reasons.join(' '), /evidence/i, 'the reason names the missing evidence verification')

  const verificationOnly = mergeReadiness({ ...base, verification_json: JSON.stringify(okVerification) })
  assert.equal(verificationOnly.state, 'unknown', 'evidence without a path guard is not a merge verdict')
  assert.match(verificationOnly.reasons.join(' '), /path guard/i, 'the reason names the missing path guard')

  const both = mergeReadiness({ ...base, path_guard_json: JSON.stringify(okGuard), verification_json: JSON.stringify(okVerification) })
  assert.equal(both.state, 'ready', 'both halves present and passing is ready')
  assert.deepEqual(both.reasons, [])
})

test('claimed test evidence must agree with the check runs', () => {
  const green = [{ name: 'test (22)', status: 'completed', conclusion: 'success' }]
  assert.equal(evaluateTestEvidence(true, green).state, 'verified')
  assert.equal(evaluateTestEvidence(true, [{ name: 'test (22)', status: 'completed', conclusion: 'failure' }]).state, 'contradicted')
  assert.equal(evaluateTestEvidence(true, [{ name: 'lint', status: 'completed', conclusion: 'success' }]).state, 'unverified')
  assert.equal(evaluateTestEvidence(false, green).state, 'unverified')
  assert.equal(evaluateTestEvidence(true, []).state, 'contradicted')
})
