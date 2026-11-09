import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

// `ci-ok` is the required check that gates every merge. Before this change it
// was an inline `node -e` that accepted `skipped` as a pass
// (`value.result !== "success" && value.result !== "skipped"`), so a required
// job that GitHub never ran — a condition, an outage, a filtered matrix leg —
// reported green. These tests pin the two halves: the script fails on a
// skipped, failed or missing required job, and the workflow calls the script.

const execFileAsync = promisify(execFile)
const ciOkScript = fileURLToPath(new URL('../scripts/ci-ok.mjs', import.meta.url))
const workflowPath = fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url))

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

async function runCiOk(needs: Record<string, { result: string }>, env: Record<string, string> = {}): Promise<RunResult> {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-ci-ok-'))
  const needsPath = join(dir, 'needs.json')
  writeFileSync(needsPath, JSON.stringify(needs, null, 2))
  try {
    const result = await execFileAsync(process.execPath, [ciOkScript, '--needs', needsPath], { encoding: 'utf8', env: { ...process.env, ...env } })
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function allSuccess(names: string[]): Record<string, { result: string }> {
  return Object.fromEntries(names.map((name) => [name, { result: 'success' }]))
}

async function requiredJobs(): Promise<string[]> {
  const module = (await import('../scripts/ci-ok.mjs')) as { REQUIRED_JOBS?: string[] }
  assert.ok(Array.isArray(module.REQUIRED_JOBS) && module.REQUIRED_JOBS.length > 0, 'scripts/ci-ok.mjs must export REQUIRED_JOBS')
  return module.REQUIRED_JOBS
}

test('every required job succeeding is the only passing shape', async () => {
  const required = await requiredJobs()
  const result = await runCiOk(allSuccess(required))
  assert.equal(result.code, 0, `all-success must pass, got ${String(result.code)}: ${result.stderr}`)
  for (const name of required) assert.match(result.stdout, new RegExp(`\\b${name}\\b: success`))
})

test('a skipped required job fails the gate', async () => {
  const required = await requiredJobs()
  const needs = allSuccess(required)
  needs[required[0]!] = { result: 'skipped' }
  const result = await runCiOk(needs)
  assert.equal(result.code, 1, 'a skipped required job must exit 1; this is the P0 defect the issue reports')
  assert.match(result.stderr, new RegExp(required[0]!))
  assert.match(result.stderr, /did not succeed|skipped/)
})

test('a required job missing from needs fails the gate', async () => {
  const required = await requiredJobs()
  const needs = allSuccess(required)
  const removed = required[required.length - 1]!
  delete needs[removed]
  const result = await runCiOk(needs)
  assert.equal(result.code, 1, 'a required job absent from needs must exit 1, not be defaulted to success')
  assert.match(result.stderr, new RegExp(removed))
  assert.match(result.stderr, /missing/)
})

test('a cancelled, timed_out or neutral result fails the gate', async () => {
  const required = await requiredJobs()
  for (const result of ['cancelled', 'timed_out', 'neutral', 'failure']) {
    const needs = allSuccess(required)
    needs[required[0]!] = { result }
    const run = await runCiOk(needs)
    assert.equal(run.code, 1, `${result} must fail the gate`)
  }
})

test('a job in needs that the gate does not require is reported, not failed', async () => {
  const required = await requiredJobs()
  const needs = allSuccess(required)
  needs.optional_extra = { result: 'skipped' }
  const result = await runCiOk(needs)
  assert.equal(result.code, 0, `an unrequired entry must not fail the gate: ${result.stderr}`)
})

test('dependency-review may be skipped on a push, but a pull request must run it', async () => {
  const required = await requiredJobs()
  const needs = allSuccess(required)
  needs['dependency-review'] = { result: 'skipped' }
  const pushed = await runCiOk(needs, { GITHUB_EVENT_NAME: 'push' })
  assert.equal(pushed.code, 0, `a push has no pull request diff to review: ${pushed.stderr}`)
  const pulled = await runCiOk(needs, { GITHUB_EVENT_NAME: 'pull_request' })
  assert.equal(pulled.code, 1, 'a skipped dependency-review on a pull request is an ungated dependency change')
  assert.match(pulled.stderr, /dependency-review/)
})

test('the workflow runs the script and no longer accepts a skipped job inline', () => {
  const workflow = readFileSync(workflowPath, 'utf8')
  assert.match(workflow, /node scripts\/ci-ok\.mjs/, 'ci-ok must call scripts/ci-ok.mjs')
  assert.doesNotMatch(workflow, /value\.result !== "skipped"/, 'the inline predicate that treated skipped as a pass must be gone')
})

test('the needs list in ci.yml and the required list in the script agree', async () => {
  const required = await requiredJobs()
  const workflow = readFileSync(workflowPath, 'utf8')
  const start = workflow.indexOf('\n  ci-ok:')
  assert.ok(start !== -1, 'ci.yml must declare the ci-ok job')
  const match = /needs:\s*\[([^\]]*)\]/.exec(workflow.slice(start))
  assert.ok(match !== null, 'the ci-ok job must declare needs as an inline list so it can be read here')
  const listed = match[1]!.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
  // `dependency-review` is a job of ci.yml after this change, so it is inside
  // `needs`; GitHub cannot express a cross-workflow dependency.
  assert.deepEqual([...listed].sort(), [...required].sort(), 'a job in needs without a required entry (or the reverse) is the drift this test exists for')
})
