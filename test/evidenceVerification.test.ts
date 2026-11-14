import test from 'node:test'
import assert from 'node:assert/strict'
import { categoryWithVerifiedEvidence, verifyCitedEvidence } from '../src/actions/evidence.js'

const OUTPUT = [
  '2026-11-14T12:34:56.1234567Z Running tests',
  '2026-11-14T12:34:57.0000000Z AssertionError: expected 1 to equal 2',
  '2026-11-14T12:34:57.0000000Z   at test/foo.test.ts:10:3',
  '[12:34:58] Error: connect ECONNREFUSED 127.0.0.1:443',
].join('\n')

test('an exact cited line is verified and appears in the excerpt', () => {
  const result = verifyCitedEvidence(['Running tests'], OUTPUT)
  assert.deepEqual(result.verified, ['Running tests'])
  assert.deepEqual(result.unverified, [])
  assert.equal(result.allVerified, true)
  assert.match(result.excerpt, /Running tests/)
})

test('whitespace is ignored when comparing a cited line', () => {
  const result = verifyCitedEvidence(['  AssertionError:   expected 1 to equal 2  '], OUTPUT)
  assert.equal(result.allVerified, true)
  assert.match(result.excerpt, /AssertionError: expected 1 to equal 2/)
})

test('a log timestamp prefix is ignored when comparing a cited line', () => {
  const iso = verifyCitedEvidence(['AssertionError: expected 1 to equal 2'], OUTPUT)
  assert.equal(iso.allVerified, true)
  const bracketed = verifyCitedEvidence(['Error: connect ECONNREFUSED 127.0.0.1:443'], OUTPUT)
  assert.equal(bracketed.allVerified, true)
})

test('a line the step did not print is unverified and stays out of the excerpt', () => {
  const result = verifyCitedEvidence(['Running tests', 'Error: no such handler'], OUTPUT)
  assert.deepEqual(result.verified, ['Running tests'])
  assert.deepEqual(result.unverified, ['Error: no such handler'])
  assert.equal(result.allVerified, false)
  assert.match(result.excerpt, /Running tests/)
  assert.doesNotMatch(result.excerpt, /no such handler/)
})

test('an empty citation list cannot be verified', () => {
  const result = verifyCitedEvidence([], OUTPUT)
  assert.equal(result.allVerified, false)
  assert.equal(result.excerpt, '')
})

test('the verified excerpt is bounded', () => {
  const long = Array.from({ length: 50 }, (_, index) => `2026-11-14T12:34:56Z line ${index} ${'x'.repeat(20)}`).join('\n')
  const cited = Array.from({ length: 50 }, (_, index) => `line ${index} ${'x'.repeat(20)}`)
  const result = verifyCitedEvidence(cited, long, 120)
  assert.ok(result.excerpt.length <= 120, `excerpt was ${result.excerpt.length} characters`)
})

test('an unverified classification downgrades to unknown, a verified one keeps its category', () => {
  const verified = verifyCitedEvidence(['AssertionError: expected 1 to equal 2'], OUTPUT)
  const unverified = verifyCitedEvidence(['Error: no such handler'], OUTPUT)
  assert.equal(categoryWithVerifiedEvidence('external', verified), 'external')
  assert.equal(categoryWithVerifiedEvidence('code', verified), 'code')
  assert.equal(categoryWithVerifiedEvidence('external', unverified), 'unknown')
  assert.equal(categoryWithVerifiedEvidence('code', unverified), 'unknown')
  assert.equal(categoryWithVerifiedEvidence('unknown', verified), 'unknown')
})
