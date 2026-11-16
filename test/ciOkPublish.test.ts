import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { REQUIRED_JOBS } from '../scripts/ci-ok.mjs'
import {
  CHECK_CONCLUSIONS,
  CHECK_STATUS,
  HEAD_AGGREGATE_JOB,
  REQUIRED_CHECK,
  checkRunPayload,
  jobKey,
  needsFromJobs,
  runIdFrom,
  shouldPublish,
  verdict,
} from '../scripts/lib/ci-ok-run.mjs'

// #855: the aggregate that gates a merge used to be a job inside `ci.yml`, and
// GitHub takes a `pull_request` workflow file from the pull request's own tree.
// A head could rewrite the aggregate's `run:` line to `exit 0` and produce a
// green verdict about itself. These tests pin both halves of the fix: the
// verdict is published by a `workflow_run` workflow (always the default
// branch's file), and the head's own job results — including a stubbed
// aggregate reporting success — cannot be evidence for it.

const read = (path: string): string => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')
const publish = read('.github/workflows/ci-ok-publish.yml')
const ci = read('.github/workflows/ci.yml')

function jobBlock(text: string, id: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line === `  ${id}:`)
  assert.notEqual(start, -1, `the workflow has no ${id} job`)
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [a-z][a-z0-9-]*:$/.test(lines[index]!)) {
      end = index
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

// The job names the checks API reports, read from the workflow that declares
// them, so a renamed job fails here instead of silently becoming a missing
// required check at merge time.
function declaredNames(text: string): string[] {
  const names: string[] = []
  for (const line of text.split('\n')) {
    const match = /^ {4}name: (.+)$/.exec(line)
    if (match !== null) names.push(match[1]!.trim())
  }
  return names
}

function displayName(required: string): string {
  return required === 'test' ? 'test (24)' : required
}

function successJobs(): Array<{ name: string; status: string; conclusion: string }> {
  return REQUIRED_JOBS.map((name) => ({ name: displayName(name), status: 'completed', conclusion: 'success' }))
}

test('the verdict is published by a workflow_run workflow, never by the pull request file', () => {
  assert.match(publish, /^on:$/m, 'the trigger must be a mapping')
  assert.match(publish, /workflow_run:/, 'the verdict must be triggered by a finished run, so its file comes from the default branch')
  assert.match(publish, /workflows: \[CI\]/, 'it must watch the CI workflow')
  assert.match(publish, /types: \[completed\]/, 'a verdict is published for a finished run')
  assert.match(publish, /checks: write/, 'publishing a check run needs checks: write')
  assert.match(publish, /actions: read/, 'reading the finished run and its jobs needs actions: read')
  assert.match(publish, /node base\/scripts\/ci-ok-run\.mjs/, 'the evaluator runs from the default-branch checkout')
  assert.doesNotMatch(publish, /node scripts\/ci-ok-run\.mjs/, 'the head copy of the evaluator must never run')
  assert.match(publish, /path: base/, 'the default branch is checked out beside the data under test')
  assert.match(publish, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/, 'the evaluator checkout names the default branch')
  assert.match(publish, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/, 'the data checkout is the head the finished run judged')
  assert.match(publish, /cancel-in-progress: false/, 'a cancelled publisher would leave the older verdict standing')
})

test('the required context gains a default-branch producer, and the head aggregate cannot retire it', () => {
  assert.equal(REQUIRED_CHECK, 'ci-ok')
  assert.equal(HEAD_AGGREGATE_JOB, 'ci-ok-head')
  // The in-run aggregate keeps the required name while the publisher is being
  // installed: GitHub loads a `workflow_run` file from the default branch, so on
  // the pull request that adds it there would otherwise be no `ci-ok` at all and
  // the change could never merge. Two producers of one context are safe here
  // because every check run at the head sha counts (#175): the publisher's red
  // cannot be retired by the head's green. The follow-up renames this job to
  // `ci-ok-head`, leaving exactly one producer.
  const aggregate = jobBlock(ci, 'ci-ok')
  assert.match(aggregate, /^ {4}name: ci-ok$/m, 'the in-run aggregate publishes the required context until the publisher is on the default branch')
  assert.match(aggregate, /node base\/scripts\/ci-ok\.mjs/, 'the in-run aggregate still evaluates the base tree')
  const publishers = declaredNames(publish)
  assert.ok(publishers.includes('publish ci-ok'), 'the workflow publishes a job named for its check')
})

test('every required job name is one the workflow declares, so a rename cannot pass unnoticed', () => {
  const declared = declaredNames(ci)
  for (const name of REQUIRED_JOBS) {
    if (name === 'test') {
      assert.ok(declared.some((entry) => entry.startsWith('test (')), 'the matrix leg must still be named test (<node>)')
      continue
    }
    assert.ok(declared.includes(name), `ci.yml declares no job named ${name}; rename it here and the publisher treats it as missing`)
  }
})

test('a stubbed head aggregate reporting success cannot turn a broken required job green', () => {
  const jobs = successJobs()
  jobs.push({ name: HEAD_AGGREGATE_JOB, status: 'completed', conclusion: 'success' })
  jobs.push({ name: 'ci-ok', status: 'completed', conclusion: 'success' })
  jobs[jobs.findIndex((job) => job.name === 'lint')] = { name: 'lint', status: 'completed', conclusion: 'failure' }

  const result = verdict({ jobs, eventName: 'pull_request', changes: { source: true } })
  assert.equal(result.ok, false, 'the head aggregate is evidence about nothing and must not be read')
  assert.ok(
    result.problems.some((problem) => problem.includes('lint')),
    `the failure must name the broken job, got ${result.problems.join('; ')}`,
  )
  assert.equal(jobKey(HEAD_AGGREGATE_JOB), null, 'the head aggregate is not a required job')
  assert.equal(jobKey('ci-ok'), null, 'a head that keeps the old name still reports nothing')
})

test('deleting or renaming a required job in the head is red, because the base list decides', () => {
  const removed = successJobs().filter((job) => job.name !== 'lint')
  assert.equal(verdict({ jobs: removed, eventName: 'pull_request', changes: { source: true } }).ok, false)

  const renamed = successJobs().map((job) => (job.name === 'lint' ? { ...job, name: 'Lint' } : job))
  const result = verdict({ jobs: renamed, eventName: 'pull_request', changes: { source: true } })
  assert.equal(result.ok, false)
  assert.ok(result.problems.some((problem) => problem.includes('lint') && problem.includes('missing')))
})

test('a matrix leg reports under the needs key, and the worse leg wins', () => {
  assert.equal(jobKey('test (24)'), 'test')
  assert.equal(needsFromJobs([{ name: 'test (24)', status: 'completed', conclusion: 'failure' }]).test?.result, 'failure')
  const both = needsFromJobs([
    { name: 'test (22)', status: 'completed', conclusion: 'success' },
    { name: 'test (24)', status: 'completed', conclusion: 'failure' },
  ])
  assert.equal(both.test?.result, 'failure', 'one green leg must not hide a red one')
})

test('an unfinished job is missing, never a pass', () => {
  const needs = needsFromJobs([{ name: 'lint', status: 'in_progress', conclusion: null }])
  assert.equal(needs.lint?.result, 'missing')
  assert.equal(verdict({ jobs: [{ name: 'lint', status: 'in_progress', conclusion: null }], eventName: 'pull_request', changes: { source: true } }).ok, false)
})

test('a skipped conditional job passes only when the base classifier says the category is absent', () => {
  const jobs = successJobs()
  jobs[jobs.findIndex((job) => job.name === 'lint')] = { name: 'lint', status: 'completed', conclusion: 'skipped' }
  assert.equal(verdict({ jobs, eventName: 'pull_request', changes: { source: false } }).ok, true, 'a docs-only diff may skip lint')
  assert.equal(verdict({ jobs, eventName: 'pull_request', changes: { source: true } }).ok, false, 'a skipped lint over a source diff is ungated code')
  assert.equal(verdict({ jobs, eventName: 'pull_request', changes: {} }).ok, false, 'an unreadable classifier must fail closed')
})

test('a cancelled run publishes nothing, because the run that replaced it owns the verdict', () => {
  assert.equal(shouldPublish({ conclusion: 'cancelled' }), false)
  assert.equal(shouldPublish({ conclusion: 'failure' }), true)
  assert.equal(shouldPublish(null), false)
})

test('the published check run carries the required context and the failing job names', () => {
  const jobs = successJobs()
  jobs[jobs.findIndex((job) => job.name === 'lint')] = { name: 'lint', status: 'completed', conclusion: 'failure' }
  const red = verdict({ jobs, eventName: 'pull_request', changes: { source: true } })
  const payload = checkRunPayload({ headSha: 'b'.repeat(40), result: red, runId: 7, runUrl: 'https://example.test/run/7' })
  assert.equal(payload.name, 'ci-ok', 'the payload must publish the context branch protection enforces')
  assert.equal(payload.head_sha, 'b'.repeat(40))
  assert.equal(payload.status, 'completed')
  assert.equal(payload.conclusion, 'failure')
  assert.match(payload.output.summary, /lint/, 'the summary must name the job that failed')
  assert.match(payload.output.summary, /run\/7/, 'the summary must name the run it judged')

  const green = checkRunPayload({ headSha: 'c'.repeat(40), result: verdict({ jobs: successJobs(), eventName: 'pull_request', changes: { source: true } }), runId: 8 })
  assert.equal(green.conclusion, 'success')
  assert.match(green.output.title, /every required job passed/)
})

// CodeQL alert 140 (`js/file-access-to-http`) at `scripts/ci-ok-run.mjs`: the
// event payload was read with `readFileSync` and its run id became part of the
// outbound request. The fix removes the file read rather than teaching the
// analyser to look away, so these tests pin both halves: the workflow hands over
// an integer, and the script has no file source left.
test('the trigger names the run as an integer, and the publisher reads no file', () => {
  assert.match(publish, /CI_OK_RUN_ID: \$\{\{ github\.event\.workflow_run\.id \}\}/, 'the run to judge arrives as the workflow run id')
  assert.doesNotMatch(publish, /GITHUB_EVENT_PATH/, 'no event file is handed to the publisher')
  const cli = read('scripts/ci-ok-run.mjs')
  assert.doesNotMatch(cli, /readFileSync/, 'the publisher reads no file, so file bytes cannot reach the check-run request')
  assert.doesNotMatch(cli, /GITHUB_EVENT_PATH/, 'the event payload is not a source at all')
})

test('the run id is a validated integer before it can enter a request path', () => {
  assert.equal(runIdFrom({ args: ['--run', '42'] }), 42)
  assert.equal(runIdFrom({ args: [], env: { CI_OK_RUN_ID: '1234' } }), 1234)
  assert.equal(runIdFrom({ args: ['--run', '7'], env: { CI_OK_RUN_ID: '8' } }), 7, 'the argument wins over the environment')
  for (const bad of ['', ' 7', '7 ', '12abc', '-1', '1e3', '0', '007', '9007199254740993']) {
    assert.throws(() => runIdFrom({ env: { CI_OK_RUN_ID: bad } }), /run id/, `${JSON.stringify(bad)} must be refused`)
  }
  assert.throws(() => runIdFrom({ args: ['--run'] }), /run id/)
  assert.throws(() => runIdFrom({}), /run id/)
})

test('the published body carries only whitelisted enums and a validated head', () => {
  const red = verdict({ jobs: successJobs().map((job) => (job.name === 'lint' ? { ...job, conclusion: 'failure' } : job)), eventName: 'pull_request', changes: { source: true } })
  assert.equal(CHECK_STATUS, 'completed')
  assert.deepEqual(Object.values(CHECK_CONCLUSIONS), ['success', 'failure'])
  const payload = checkRunPayload({ headSha: 'd'.repeat(40), result: red, runId: 9 })
  assert.equal(payload.status, CHECK_STATUS, 'the status is the module literal, not a value a run reported')
  assert.equal(payload.conclusion, CHECK_CONCLUSIONS.fail)
  const green = checkRunPayload({ headSha: 'e'.repeat(40), result: verdict({ jobs: successJobs(), eventName: 'pull_request', changes: { source: true } }), runId: 10 })
  assert.equal(green.conclusion, CHECK_CONCLUSIONS.pass)

  assert.throws(() => checkRunPayload({ headSha: 'not-a-sha', result: red, runId: 9 }), /hex/)
  assert.throws(() => checkRunPayload({ headSha: 'D'.repeat(40), result: red, runId: 9 }), /hex/, 'an uppercase sha is not the form the API returns')
  assert.throws(() => checkRunPayload({ headSha: 'd'.repeat(40), result: red, runId: 0 }), /positive integer/)
  assert.throws(() => checkRunPayload({ headSha: 'd'.repeat(40), result: red, runId: 1.5 }), /positive integer/)

  const odd = checkRunPayload({ headSha: 'f'.repeat(40), result: red, runId: 11, runUrl: 'javascript:alert(1)' })
  assert.doesNotMatch(odd.output.summary, /javascript:/, 'a URL that is not plain https is not quoted')
})
