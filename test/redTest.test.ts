import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyRedRun, failureSignature, redTestEvidence } from '../src/lib/redTest.js'

const BASE_SHA = '7f712dfb7ec2668d154023c35909527b4c610592'

function run(output: string, overrides: Partial<Parameters<typeof classifyRedRun>[0]> = {}) {
  return { command: 'npx tsx --test test/thing.test.ts', baseSha: BASE_SHA, exitCode: 1, output, ...overrides }
}

// #367: only a genuine test failure counts as "the intended reason". These five
// cases are the ruling, one assertion each, so a classifier that widens to
// "anything non-zero" reds here.

test('an assertion failure is the intended reason', () => {
  const classified = classifyRedRun(
    run(['not ok 1 - the owner may run the schedule now', '  error: |', "    AssertionError [ERR_ASSERTION]: expected 302 to be 200", '  # tests 1', '  # pass 0', '  # fail 1'].join('\n')),
  )
  assert.equal(classified, 'assertion')
})

test('an escaped error thrown by the test body is the intended reason', () => {
  const classified = classifyRedRun(
    run(['✖ runs the schedule (12.4ms)', '  Error: the run never started', '    at TestContext.<anonymous> (test/thing.test.ts:9:11)'].join('\n')),
  )
  assert.equal(classified, 'assertion')
})

test('a compile or type error is never the intended reason', () => {
  const classified = classifyRedRun(
    run(['src/lib/thing.ts(4,7): error TS2322: Type string is not assignable to type number.', 'Process completed with exit code 2.'].join('\n'), { exitCode: 2 }),
  )
  assert.equal(classified, 'compile')
})

test('a missing module is never the intended reason', () => {
  const classified = classifyRedRun(
    run(["Error: Cannot find module '../src/lib/redTest.js' imported from /w/test/thing.test.ts", '  code: ERR_MODULE_NOT_FOUND'].join('\n')),
  )
  assert.equal(classified, 'compile')
})

test('an environment or network failure is never the intended reason', () => {
  const classified = classifyRedRun(
    run(['Error: connect ECONNREFUSED 127.0.0.1:5432', '    at TCPConnectWrap.afterConnect'].join('\n')),
  )
  assert.equal(classified, 'environment')
})

test('a timeout is never the intended reason', () => {
  assert.equal(classifyRedRun(run('', { timedOut: true })), 'timeout')
  assert.equal(classifyRedRun(run(['test timed out after 5000ms'].join('\n'))), 'timeout')
})

test('a skipped test is never the intended reason', () => {
  assert.equal(classifyRedRun(run('  # skipped 1', { skipped: true })), 'skipped')
  assert.equal(classifyRedRun(run(['not ok 1 - a test that never ran', '  # SKIP because the fixture is missing'].join('\n'))), 'skipped')
})

test('a base run that passed is not red at all', () => {
  assert.equal(classifyRedRun(run(['# tests 1', '# pass 1', '# fail 0'].join('\n'), { exitCode: 0 })), 'passed')
})

test('an unexplained non-zero exit stays unverified instead of counting as red', () => {
  assert.equal(classifyRedRun(run('Process completed with exit code 1.')), 'other')
})

test('the failure signature is the first failure line, not the whole output', () => {
  const output = [
    'not ok 1 - the owner may run the schedule now',
    '  error: |',
    '    AssertionError [ERR_ASSERTION]: expected 302 to be 200',
  ].join('\n')
  assert.equal(failureSignature(run(output)), 'not ok 1 - the owner may run the schedule now')
  assert.equal(failureSignature(run('', { timedOut: true })), 'timed out')
})

test('the evidence record keeps the command, the base sha and the output digest', () => {
  const evidence = redTestEvidence(
    run(['not ok 1 - a test', '  AssertionError: nope'].join('\n')),
  )
  assert.equal(evidence.state, 'verified')
  assert.equal(evidence.command, 'npx tsx --test test/thing.test.ts')
  assert.equal(evidence.baseSha, BASE_SHA)
  assert.equal(evidence.exitCode, 1)
  assert.equal(evidence.failureClass, 'assertion')
  assert.match(evidence.outputSha256, /^[0-9a-f]{64}$/)
  assert.equal(evidence.signature, 'not ok 1 - a test')
})

test('a run that failed for any other reason is unverified, never verified', () => {
  const compile = redTestEvidence(run('src/a.ts(1,1): error TS1005: expected ;'))
  assert.equal(compile.state, 'unverified')
  const passed = redTestEvidence(run('# pass 1', { exitCode: 0 }))
  assert.equal(passed.state, 'unverified')
})
