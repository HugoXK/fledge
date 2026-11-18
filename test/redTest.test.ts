import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { classifyRedTestRun, redTestEvidence, type RedTestRun } from '../src/lib/redTest.js'

// #367: "a red test" is a claim about the base tree, and a test can fail there for
// reasons the fix does not address. The classifier reads the base run's own output
// and decides whether the failure is the intended one: an assertion, or an error
// thrown from the test body, counts; a compile/type error, a missing module, an
// environment or network error, a timeout and a skipped test do not, and a run
// that passes at the base is not red at all. Everything that is not a genuine
// failure is `unverified`, never a pass.

const ASSERTION = [
  'TAP version 13',
  'not ok 12 - a bare Range: line does not open a run section',
  '  ---',
  "  error: 'expected [] to equal [Range:]'",
  '  code: ERR_ASSERTION',
  '  ...',
  '# tests 23',
  '# pass 22',
  '# fail 1',
].join('\n')

const THROWN = [
  'not ok 4 - saving twice is idempotent',
  '  ---',
  '  error: |',
  '    TypeError: cannot read properties of undefined (reading id)',
  '        at Context.<anonymous> (test/changeStory.test.ts:181:12)',
  '  ...',
  '# fail 1',
].join('\n')

const COMPILE = ['src/app.ts(41,9): error TS2345: Argument of type \'string\' is not assignable to parameter of type \'number\'.', 'tsc exited 2'].join('\n')
const MISSING = ["Error: Cannot find module './changeStory.js'", '    at node:internal/modules/esm/resolve:1:1'].join('\n')
const ENVIRONMENT = ['Error: connect ECONNREFUSED 127.0.0.1:9999', '    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1:1)'].join('\n')

function run(patch: Partial<RedTestRun> = {}): RedTestRun {
  return { command: 'npx tsx --test test/changeStory.test.ts', baseSha: 'a'.repeat(40), exitCode: 1, output: ASSERTION, ...patch }
}

test('an assertion failure at the base is the intended red', () => {
  const verdict = classifyRedTestRun(run())
  assert.equal(verdict.verdict, 'red')
  assert.equal(verdict.signature, 'assertion')
})

test('an error thrown from the test body is red too', () => {
  const verdict = classifyRedTestRun(run({ output: THROWN }))
  assert.equal(verdict.verdict, 'red')
  assert.equal(verdict.signature, 'thrown')
})

test('a compile or type error at the base is unverified, never red', () => {
  const verdict = classifyRedTestRun(run({ output: COMPILE }))
  assert.equal(verdict.verdict, 'unverified')
  assert.equal(verdict.signature, 'compile')
})

test('a missing module at the base is unverified, never red', () => {
  const verdict = classifyRedTestRun(run({ output: MISSING }))
  assert.equal(verdict.verdict, 'unverified')
  assert.equal(verdict.signature, 'missing-module')
})

test('an environment or network failure at the base is unverified, never red', () => {
  const verdict = classifyRedTestRun(run({ output: ENVIRONMENT }))
  assert.equal(verdict.verdict, 'unverified')
  assert.equal(verdict.signature, 'environment')
})

test('a timeout and a skipped test are unverified, never red', () => {
  assert.equal(classifyRedTestRun(run({ timedOut: true })).signature, 'timeout')
  assert.equal(classifyRedTestRun(run({ timedOut: true })).verdict, 'unverified')
  assert.equal(classifyRedTestRun(run({ skipped: true })).signature, 'skipped')
  assert.equal(classifyRedTestRun(run({ skipped: true })).verdict, 'unverified')
})

test('a test that passes at the base is not red', () => {
  const verdict = classifyRedTestRun(run({ exitCode: 0, output: '# pass 23\n# fail 0' }))
  assert.equal(verdict.verdict, 'passed')
})

test('the evidence record carries the base run and the sha256 of its output', () => {
  const evidence = redTestEvidence(run())
  assert.equal(evidence.command, 'npx tsx --test test/changeStory.test.ts')
  assert.equal(evidence.baseSha, 'a'.repeat(40))
  assert.equal(evidence.exitCode, 1)
  assert.equal(evidence.verdict, 'red')
  assert.equal(evidence.signature, 'assertion')
  assert.match(evidence.outputSha256, /^[0-9a-f]{64}$/)
  assert.equal(evidence.outputSha256, createHash('sha256').update(ASSERTION).digest('hex'))
  assert.equal(evidence.flaky, false)
})

test('two base runs that disagree are flaky and never PASS', () => {
  const evidence = redTestEvidence(run(), run({ exitCode: 0, output: '# pass 23\n# fail 0' }))
  assert.equal(evidence.flaky, true)
  assert.equal(evidence.verdict, 'unverified')
})
