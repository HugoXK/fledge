import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// #1312 containment: the coverage step still pipes into `tee`, so a failed
// suite's exit status is lost. The job appends one step that reads the TAP
// report `tee` kept and fails when the suite recorded a failure. This test pins
// the step, its place after the coverage step, and its exit status on real
// report shapes. It is a containment spine, not the root fix: the pipe is
// still there, so the check is only as good as the report it reads.

const CI = readFileSync(fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url)), 'utf8')
const JOB = 'coverage'
const MEASURE = 'Measure and enforce the coverage floor'
const FAILURE_STEP = 'Fail when the suite reported a failure'

function jobBlock(workflow: string, job: string): string {
  const start = workflow.indexOf(`\n  ${job}:`)
  assert.notEqual(start, -1, `ci.yml must declare the ${job} job`)
  const rest = workflow.slice(start + 1)
  const end = rest.search(/\n  [A-Za-z0-9_-]+:/)
  return end === -1 ? rest : rest.slice(0, end)
}

function stepHeader(job: string, name: string): number {
  return job.indexOf(`      - name: ${name}`)
}

// The step's block scalar, dedented by its ten-space indentation, so the test
// executes exactly the shell the workflow will run.
function appendedScript(job: string): string {
  const header = stepHeader(job, FAILURE_STEP)
  assert.notEqual(header, -1, `the ${JOB} job must append "${FAILURE_STEP}"`)
  const lines = job.slice(header).split('\n')
  const runAt = lines.findIndex((line) => line === '        run: |')
  assert.notEqual(runAt, -1, 'the appended step must carry a block run:')
  const block: string[] = []
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() !== '' && !line.startsWith('          ')) break
    block.push(line.replace(/^          /, ''))
  }
  return block.join('\n')
}

function runStep(script: string, report: string | null): number | null {
  const dir = mkdtempSync(join(tmpdir(), 'coverage-failure-step-'))
  try {
    if (report !== null) writeFileSync(join(dir, 'coverage.txt'), report)
    const result = spawnSync('bash', ['-e', '-c', script], { cwd: dir, encoding: 'utf8' })
    return result.status
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the coverage job appends the failure step after the coverage step', () => {
  const job = jobBlock(CI, JOB)
  const measure = stepHeader(job, MEASURE)
  const failure = stepHeader(job, FAILURE_STEP)
  assert.notEqual(measure, -1, 'the coverage step must exist')
  assert.ok(failure > measure, 'the failure step must come after the coverage step')
  // #1335 appended one last step, the dispatch mode guard (#1335). The failure
  // step still owns the containment decision: a failing step stops the job, so
  // nothing after it can mask this one, and the guard is the only later step.
  const laterSteps = job
    .slice(failure)
    .split('\n')
    .filter((line) => line.startsWith('      - '))
  assert.deepEqual(laterSteps.slice(1), ['      - name: Name the coverage mode and refuse a dispatched run'])
})

test('a recorded suite failure fails the step', () => {
  const script = appendedScript(jobBlock(CI, JOB))
  for (const report of [
    'TAP version 13\nnot ok 1 - a test\n# fail 1\n',
    'TAP version 13\nok 1 - a test\n# fail 1\n',
    'TAP version 13\n# fail 12\n',
  ]) {
    assert.notEqual(runStep(script, report), 0, `a report with a failure must fail: ${JSON.stringify(report)}`)
  }
})

test('a green report passes the step', () => {
  const script = appendedScript(jobBlock(CI, JOB))
  for (const report of [
    'TAP version 13\nok 1 - a test\n# fail 0\n',
    'TAP version 13\nok 1 - a test\n',
  ]) {
    assert.equal(runStep(script, report), 0, `a green report must pass: ${JSON.stringify(report)}`)
  }
})

test('a missing report fails closed', () => {
  const script = appendedScript(jobBlock(CI, JOB))
  assert.notEqual(runStep(script, null), 0, 'a missing coverage.txt must not pass')
})
