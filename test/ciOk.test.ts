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

test('a skipped conditional job passes only when its change flag is false', async () => {
  const required = await requiredJobs()
  const needs = allSuccess(required)
  needs['lint'] = { result: 'skipped' }
  const skippedForDocs = await runCiOk(needs, {
    GITHUB_EVENT_NAME: 'pull_request',
    CHANGES: JSON.stringify({ source: 'false' }),
  })
  assert.equal(skippedForDocs.code, 0, `a docs-only diff may skip lint: ${skippedForDocs.stderr}`)

  const sourceChanged = await runCiOk(needs, {
    GITHUB_EVENT_NAME: 'pull_request',
    CHANGES: JSON.stringify({ source: 'true' }),
  })
  assert.equal(sourceChanged.code, 1, 'a skipped lint on a source change must fail')

  const noClassifier = await runCiOk(needs, { GITHUB_EVENT_NAME: 'pull_request' })
  assert.equal(noClassifier.code, 1, 'a missing classifier output must fail closed')
})

// The suite reads `docs/`, `public/`, `deploy/` and `.github/` — 60 of the 184
// files under `test/` — so a docs-only, asset-only, deploy-only or workflow-only
// diff can still turn it red. Accepting its skip was the defect: `ci-ok` went
// green over a red suite, and for `docs/` (T0) and `public/` (T1) no verdict
// reads the tip either.
test('the suite and the coverage floor are never skippable, whatever the classifier says', async () => {
  const required = await requiredJobs()
  for (const job of ['test', 'coverage']) {
    for (const changes of [{ source: 'false' }, { source: 'false', docsOnly: 'true' }, { frontend: 'false' }, {}]) {
      const needs = allSuccess(required)
      needs[job] = { result: 'skipped' }
      const result = await runCiOk(needs, {
        GITHUB_EVENT_NAME: 'pull_request',
        CHANGES: JSON.stringify(changes),
      })
      assert.equal(result.code, 1, `a skipped ${job} must fail on pull_request with ${JSON.stringify(changes)}`)
      assert.match(result.stderr, new RegExp(job))
    }
  }
})

test('a skipped conditional job fails on a push even when the flag is false', async () => {
  const required = await requiredJobs()
  const needs = allSuccess(required)
  needs['visual'] = { result: 'skipped' }
  const result = await runCiOk(needs, {
    GITHUB_EVENT_NAME: 'push',
    CHANGES: JSON.stringify({ frontend: 'false' }),
  })
  assert.equal(result.code, 1, 'a push verifies the whole tree; conditional skips are pull-request only')
})

// #1103: the matrix gained its own flag, so `ci-ok` must be bound to that flag
// and not to the page flag. Widening the trigger without moving this binding
// would let a diff report `visual: true`, skip the job and still pass: the
// output would say "this gate applies" while nothing measured the change.
test('a visual job skipped while the matrix changed fails the gate', async () => {
  const required = await requiredJobs()
  assert.ok(required.includes('visual'), 'visual stays a required job; this change moves its trigger, not its rank')

  const needs = allSuccess(required)
  needs['visual'] = { result: 'skipped' }

  const matrixChanged = await runCiOk(needs, {
    GITHUB_EVENT_NAME: 'pull_request',
    CHANGES: JSON.stringify({ visual: 'true', frontend: 'false' }),
  })
  assert.equal(matrixChanged.code, 1, 'the flag says the gate applies, so a skipped leg is red even with frontend false')
  assert.match(matrixChanged.stderr, /visual/)

  const notApplicable = await runCiOk(needs, {
    GITHUB_EVENT_NAME: 'pull_request',
    CHANGES: JSON.stringify({ visual: 'false', frontend: 'false' }),
  })
  assert.equal(notApplicable.code, 0, `a diff the matrix cannot read may skip it: ${notApplicable.stderr}`)
})

test('every conditional job is wired to the change classifier', async () => {
  const module = (await import('../scripts/ci-ok.mjs')) as { SKIP_WHEN?: Record<string, string> }
  assert.ok(module.SKIP_WHEN !== undefined, 'scripts/ci-ok.mjs must export SKIP_WHEN')
  const workflow = readFileSync(workflowPath, 'utf8')
  assert.match(workflow, /^  changes:$/m, 'ci.yml must declare the changes job')
  // The two jobs that read every tree are unconditional: assert the shape that
  // makes a docs-only diff still produce a runnable suite, not just the absence
  // of an entry in the map.
  for (const job of ['test', 'coverage']) {
    assert.equal(Object.hasOwn(module.SKIP_WHEN, job), false, `${job} must not be conditional`)
    const start = workflow.indexOf(`\n  ${job}:`)
    assert.ok(start !== -1, `ci.yml must declare ${job}`)
    const rest = workflow.slice(start + 1)
    const next = rest.search(/\n  [a-z][a-z0-9-]*:\n/)
    const block = next === -1 ? rest : rest.slice(0, next)
    assert.doesNotMatch(block, /if: needs\.changes\.outputs\./, `${job} must not carry a change-classifier condition`)
    assert.doesNotMatch(block, /needs: changes/, `${job} must not wait on the classifier`)
  }
  for (const [job, flag] of Object.entries(module.SKIP_WHEN)) {
    const start = workflow.indexOf(`\n  ${job}:`)
    assert.ok(start !== -1, `ci.yml must declare the conditional job ${job}`)
    const rest = workflow.slice(start + 1)
    const next = rest.search(/\n  [a-z][a-z0-9-]*:\n/)
    const block = next === -1 ? rest : rest.slice(0, next)
    assert.match(block, new RegExp(`if: needs\\.changes\\.outputs\\.${flag} == 'true'`), `${job} must read the ${flag} flag`)
    assert.match(block, /needs: (?:\[changes, build\]|changes)/, `${job} must depend on changes`)
  }
})

test('the workflow runs the script and no longer accepts a skipped job inline', () => {
  const workflow = readFileSync(workflowPath, 'utf8')
  // #640: the aggregate runs from the base branch tree, never from the pull
  // request it judges.
  assert.match(workflow, /node base\/scripts\/ci-ok\.mjs/, 'ci-ok must call the base branch copy of scripts/ci-ok.mjs')
  assert.doesNotMatch(workflow, /value\.result !== "skipped"/, 'the inline predicate that treated skipped as a pass must be gone')
})

test('ci runs nightly and can be dispatched by hand, and only a pull request cancels in place', () => {
  const workflow = readFileSync(workflowPath, 'utf8')
  assert.match(workflow, /^  workflow_dispatch:$/m, 'a branch with no pull request needs a manual trigger')
  assert.match(workflow, /^  schedule:$/m, 'a nightly run catches a dependency or runner change before a PR does')
  assert.match(workflow, /cron: '[^']+'/, 'the schedule needs a cron expression')
  assert.match(
    workflow,
    /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/,
    'a run on main is the record of a commit and must not be cancelled by a later one',
  )
})

test('the needs list in ci.yml and the required list in the script agree', async () => {
  const required = await requiredJobs()
  const workflow = readFileSync(workflowPath, 'utf8')
  const start = workflow.indexOf('\n  ci-ok-head:')
  assert.ok(start !== -1, 'ci.yml must declare the ci-ok-head job')
  const match = /needs:\s*\[([^\]]*)\]/.exec(workflow.slice(start))
  assert.ok(match !== null, 'the ci-ok job must declare needs as an inline list so it can be read here')
  const listed = match[1]!.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
  // `dependency-review` is a job of ci.yml after this change, so it is inside
  // `needs`; GitHub cannot express a cross-workflow dependency.
  assert.deepEqual([...listed].sort(), [...required].sort(), 'a job in needs without a required entry (or the reverse) is the drift this test exists for')
})

// #973: `mock/` is generated from the views and the stylesheet, and no
// pull-request job read it, so a stale snapshot merged green and only the
// nightly release drive noticed hours later. This pins the whole gate, because
// its three halves can drift apart: the required list, the aggregate's needs,
// and the job's own step. One without the others reports green or never runs.
test('the UI mock snapshot is a required pull-request job', async () => {
  const required = await requiredJobs()
  assert.ok(
    required.includes('mock-check'),
    'scripts/ci-ok.mjs REQUIRED_JOBS must name mock-check; a job the aggregate does not require can fail without failing the merge gate',
  )

  const workflow = readFileSync(workflowPath, 'utf8')
  const needsOf = (job: string): string[] => {
    const start = workflow.indexOf(`\n  ${job}:`)
    assert.ok(start !== -1, `ci.yml must declare the ${job} job`)
    const match = /needs:\s*\[([^\]]*)\]/.exec(workflow.slice(start))
    assert.ok(match !== null, `the ${job} job must declare needs as an inline list so it can be read here`)
    return match[1]!.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
  }
  assert.ok(needsOf('ci-ok-head').includes('mock-check'), 'ci-ok-head must wait on mock-check, or the required context never sees it')
  assert.ok(needsOf('main-health').includes('mock-check'), 'main-health mirrors ci-ok so the tracker can name the job that failed')

  const jobStart = workflow.indexOf('\n  mock-check:')
  assert.ok(jobStart !== -1, 'ci.yml must declare the mock-check job')
  const job = workflow.slice(jobStart + 1)
  const nextJob = job.search(/\n  [a-z][a-z0-9-]*:\n/)
  const block = nextJob === -1 ? job : job.slice(0, nextJob)
  assert.match(block, /^    needs: changes$/m, 'the job depends on the classifier like every other job')
  assert.match(block, /^    permissions:\n      contents: read$/m, 'the job only reads the tree')
  assert.match(block, /run: \|\n(?:.*\n)*?\s+npm run mock:check$|run: npm run mock:check$/m, 'the job has to run the snapshot check, not a lookalike')

  const { SKIPPABLE_ON } = (await import('../scripts/ci-ok.mjs')) as { SKIPPABLE_ON: Record<string, string[]> }
  assert.equal(SKIPPABLE_ON['mock-check'], undefined, 'any diff can stale the snapshot, so this job is never skippable')
})
