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

test('verified evidence decides ready or blocked', () => {
  const ok = { ok: true, checkedAt: '2026-01-01T00:00:00.000Z', sha: 'abc', prState: 'open', draft: false, mergeableState: 'clean', checks: { total: 1, green: 1, failing: [], pending: [] }, combinedStatus: 'success', reviews: { changesRequested: false, approvals: 0 }, reasons: [] }
  assert.equal(mergeReadiness({ ...base, verification_json: JSON.stringify(ok) }).state, 'ready')
  assert.equal(parseVerification(JSON.stringify(ok))?.ok, true)
  assert.equal(parsePathGuard(null), null)
  const blocked = { ...ok, ok: false, reasons: ['Failing checks: ci'] }
  assert.equal(mergeReadiness({ ...base, verification_json: JSON.stringify(blocked) }).state, 'blocked')
})

test('claimed test evidence must agree with the check runs', () => {
  const green = [{ name: 'test (22)', status: 'completed', conclusion: 'success' }]
  assert.equal(evaluateTestEvidence(true, green).state, 'verified')
  assert.equal(evaluateTestEvidence(true, [{ name: 'test (22)', status: 'completed', conclusion: 'failure' }]).state, 'contradicted')
  assert.equal(evaluateTestEvidence(true, [{ name: 'lint', status: 'completed', conclusion: 'success' }]).state, 'unverified')
  assert.equal(evaluateTestEvidence(false, green).state, 'unverified')
  assert.equal(evaluateTestEvidence(true, []).state, 'contradicted')
})

// #134: a check that never produced a test result is not evidence. `skipped` and
// `neutral` are completions without a verdict, so they belong to neither the
// green nor the failing list, and the state is unverified rather than
// contradicted. The name pattern is anchored and plural-aware, so a dependency
// job called `latest-deps` is not mistaken for a test job, while `tests (22)`,
// `unit-tests` and `specs` stay green.
const check = (name: string, conclusion: string): { name: string; status: string; conclusion: string } => ({ name, status: 'completed', conclusion })

test('a skipped or neutral test check is not evidence', () => {
  for (const conclusion of ['skipped', 'neutral']) {
    const evidence = evaluateTestEvidence(true, [check('test (22)', conclusion)])
    assert.equal(evidence.state, 'unverified', `${conclusion} is not a test result`)
    assert.deepEqual(evidence.greenChecks, [])
    assert.deepEqual(evidence.failingChecks, [])
  }
})

test('a completion that is neither green nor ignored still contradicts', () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', 'stale']) {
    const evidence = evaluateTestEvidence(true, [check('test (22)', conclusion)])
    assert.equal(evidence.state, 'contradicted', `${conclusion} is a failing test check`)
    assert.deepEqual(evidence.failingChecks, ['test (22)'])
  }
})

test('the test check pattern is anchored and plural-aware', () => {
  const verified = ['test (22)', 'tests (22)', 'unit-tests', 'spec', 'specs', 'pytest', 'jest', 'vitest', 'mocha', 'cargo test', 'go test']
  for (const name of verified) {
    const evidence = evaluateTestEvidence(true, [check(name, 'success')])
    assert.equal(evidence.state, 'verified', `${name} is a test job`)
    assert.deepEqual(evidence.greenChecks, [name])
  }
  for (const name of ['latest-deps', 'contest', 'attestation', 'lint', 'build']) {
    const evidence = evaluateTestEvidence(true, [check(name, 'success')])
    assert.equal(evidence.state, 'unverified', `${name} is not a test job`)
    assert.deepEqual(evidence.greenChecks, [])
  }
})
