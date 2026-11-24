import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  pendingRequired,
  runIdFrom,
  shouldPublish,
  verdict,
} from '../scripts/lib/ci-ok-run.mjs'
import * as runModule from '../scripts/lib/ci-ok-run.mjs'

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
  // #1273 lands the rename the publisher's comment promised: the in-run
  // aggregate is `ci-ok-head`, so `ci-ok` has exactly one producer — the
  // publisher's verdict. The case is rewritten rather than deleted because it is
  // what pins the single-producer property after the rename.
  const aggregate = jobBlock(ci, HEAD_AGGREGATE_JOB)
  assert.match(aggregate, /^ {4}name: ci-ok-head$/m, 'the in-run aggregate publishes its own id, not the required context')
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

// #1273: the API can return `status: in_progress` beside a `conclusion` and a
// `completed_at` (jobs 138082842033 and 138086900960 in run 45286143428). The
// reader printed `missing` for that shape, which sends a reviewer looking for a
// job that did run. An unsettled object is `pending` — still red, and the
// publisher returns before it creates any check run.
test('an unfinished job object is pending, never missing and never a pass', () => {
  const jobs = successJobs().map((job) => ({ ...job, id: 1, completed_at: '2026-11-23T23:00:00Z' }))
  jobs[jobs.findIndex((job) => job.name === 'changelog')] = {
    id: 138082842033,
    name: 'changelog',
    status: 'in_progress',
    conclusion: 'success',
    completed_at: '2026-11-23T23:08:29Z',
  }
  const result = verdict({ jobs, eventName: 'pull_request', changes: { source: true } })
  assert.equal(result.needs.changelog?.result, 'pending', 'an unsettled object is pending, whatever conclusion it names')
  assert.equal(result.ok, false, 'pending is red: the merge gate stays fail-closed')
  assert.ok(
    result.problems.some((problem) => problem.includes('changelog') && problem.includes('pending')),
    `the problem names the context and the word pending, got ${result.problems.join('; ')}`,
  )
  assert.ok(!result.problems.some((problem) => problem.includes('missing')), 'the job exists; calling it missing sends the reader to the wrong place')
  assert.deepEqual(pendingRequired(result.needs), ['changelog'], 'the publisher sees one context it must not publish for')
})

test('a context with no job object at all is still missing, not pending', () => {
  const jobs = successJobs().filter((job) => job.name !== 'lint').map((job) => ({ ...job, id: 2, completed_at: '2026-11-23T23:00:00Z' }))
  const result = verdict({ jobs, eventName: 'pull_request', changes: { source: true } })
  assert.equal(result.needs.lint, undefined, 'an absent job stays absent from needs')
  assert.ok(
    result.problems.some((problem) => problem.includes('lint') && problem.includes('missing')),
    'absence is still the red word missing, with its own fixture so pending cannot widen to "nothing is missing"',
  )
  assert.deepEqual(pendingRequired(result.needs), [])
})

test('two settled conclusions for one context: the newest wins and both are listed', () => {
  const jobs = successJobs().map((job) => ({ ...job, id: 10, completed_at: '2026-11-24T00:00:00Z' }))
  jobs[jobs.findIndex((job) => job.name === 'changelog')] = {
    id: 501,
    name: 'changelog',
    status: 'completed',
    conclusion: 'failure',
    completed_at: '2026-11-24T00:00:10Z',
  }
  jobs.push({ id: 502, name: 'changelog', status: 'completed', conclusion: 'success', completed_at: '2026-11-24T00:00:20Z' })
  const result = verdict({ jobs, eventName: 'pull_request', changes: { source: true } })
  assert.equal(result.needs.changelog?.result, 'success', 'the newest settled conclusion is the reading')
  const payload = checkRunPayload({ headSha: 'b'.repeat(40), result, runId: 7 })
  assert.match(payload.output.summary, /502/, 'the summary records the conclusion it read')
  assert.match(payload.output.summary, /501/, 'and the one it superseded, so two conclusions can be told from none')
  assert.match(payload.output.summary, /changelog/)
  assert.match(payload.output.summary, /failure/)
  assert.match(payload.output.summary, /success/)
})

// The card asks for one fixture on one axis: absent, unsettled and settled must
// read as three different things, not as one bucket. The zero-POST half of the
// unsettled case is the CLI fixture below, because "no check run was created" is
// a fact about a request log rather than about a return value.
test('one axis separates absent, unsettled and settled', () => {
  const settled = successJobs().map((job) => ({ ...job, id: 21, completed_at: '2026-11-24T00:00:00Z' }))
  const context = 'changelog'

  const absent = verdict({ jobs: settled.filter((job) => job.name !== context), eventName: 'pull_request', changes: { source: true } })
  assert.equal(absent.needs[context], undefined, 'absent: no job object, so the key is absent')
  assert.ok(absent.problems.some((problem) => problem.includes(context) && problem.includes('missing')), 'absent reads missing and is red')
  assert.equal(absent.ok, false)

  const unsettledJobs = settled.map((job) => (job.name === context ? { ...job, status: 'in_progress', conclusion: 'success' } : job))
  const unsettled = verdict({ jobs: unsettledJobs, eventName: 'pull_request', changes: { source: true } })
  assert.equal(unsettled.needs[context]?.result, 'pending', 'unsettled reads pending')
  assert.equal(unsettled.ok, false, 'pending is still red')
  assert.deepEqual(pendingRequired(unsettled.needs), [context], 'the publisher returns before any POST')

  const settledJobs = [...settled, { id: 22, name: context, status: 'completed', conclusion: 'success', completed_at: '2026-11-24T00:00:30Z' }]
  const newest = verdict({ jobs: settledJobs, eventName: 'pull_request', changes: { source: true } })
  assert.equal(newest.needs[context]?.result, 'success', 'settled: the newest settled conclusion wins')
  assert.equal(newest.ok, true)
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

// #1117: the publisher reported "a pull request run must name exactly one base
// sha, got 0" as a red verdict after the pull request merged mid-run — the base
// was missing because the merge removed it, and nothing about the diff failed.
// The decision is driven here through the pure half; the CLI only supplies the
// lookup it makes when the payload lost its own list.
test('a pull request that merged mid-run publishes no verdict (#1117)', () => {
  const run = { conclusion: 'success', event: 'pull_request', pull_requests: [], head_sha: 'a'.repeat(40) }
  const merged = { number: 1115, merged_at: '2026-11-19T14:39:27Z', state: 'closed' }
  assert.equal(runModule.lostItsBase(run), true, 'an empty pull request list is the shape the merge leaves behind')
  assert.equal(runModule.mergedPullRequestOf(merged)?.number, 1115)
  assert.equal(runModule.skipReason(run, merged), 'pull-request-merged')
  assert.equal(runModule.shouldPublish(run, merged), false)
})

test('a lost base without a merged pull request keeps the red, so nothing is silently skipped', () => {
  const run = { conclusion: 'success', event: 'pull_request', pull_requests: [] }
  assert.equal(runModule.skipReason(run, null), null, 'no merged pull request behind the head means no skip')
  assert.equal(runModule.shouldPublish(run, { number: 7, merged_at: null, state: 'closed' }), true, 'closed without merge still has its red')
  assert.equal(runModule.shouldPublish(run, { number: 8, merged_at: '', state: 'open' }), true)
  assert.equal(runModule.mergedPullRequestOf({ number: 7, merged_at: null }), null)
  assert.equal(runModule.mergedPullRequestOf(null), null)
})

test('a run that can still be ranged is judged, even when a merged pull request is offered', () => {
  const run = { conclusion: 'success', event: 'pull_request', pull_requests: [{ base: { sha: 'b'.repeat(40) } }] }
  assert.equal(runModule.baseShas(run).length, 1)
  assert.equal(runModule.lostItsBase(run), false)
  assert.equal(runModule.shouldPublish(run, { number: 9, merged_at: '2026-11-19T14:39:27Z' }), true)
  assert.equal(runModule.shouldPublish({ conclusion: 'success', event: 'push' }, { number: 9, merged_at: '2026-11-19T14:39:27Z' }), true, 'a push run has no pull request to merge away')
})

test('the skip log names the merged pull request that removed the base', () => {
  const run = { conclusion: 'success', event: 'pull_request', pull_requests: [] }
  const merged = { number: 1115, merged_at: '2026-11-19T14:39:27Z' }
  assert.equal(
    runModule.skipDetail(run, 'pull-request-merged', merged),
    'pull request #1115 merged at 2026-11-19T14:39:27Z while the run was in flight; no merge candidate is left to judge',
  )
  assert.match(
    runModule.skipDetail(run, 'pull-request-merged', { number: 1115, mergedAt: '2026-11-19T14:39:27Z' }),
    /unknown number/,
    'a shape the API does not return is not evidence for the log either',
  )
  assert.match(runModule.skipDetail({ conclusion: 'cancelled' }, 'superseded'), /supersedes it/)
})

test('the publisher looks up the commit and logs which branch of the decision fired', () => {
  const cli = read('scripts/ci-ok-run.mjs')
  assert.match(cli, /lostItsBase\(run\)/, 'the lookup is made only for the run shape that lost its base')
  assert.match(cli, /commits\/\$\{headSha\}\/pulls/, 'the merged decision reads the head commit\'s pull requests, not reachability')
  assert.match(cli, /skipped \(/, 'a skipped run says so in the log rather than passing silently')
  assert.doesNotMatch(cli, /git\(\['merge-base'/, 'reachability is not the test: a squash merge leaves the head unreachable while merged')
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

// Shape 1 of #1273: while any required context is unsettled the publish job
// creates no `ci-ok` check run at all — not a red one, none. The assertion is
// the request log of a fake API the real CLI talks to, so the count is what the
// job actually did rather than "no run had appeared yet".
test('an unsettled required job makes the publisher create no check run at all', async () => {
  const requests: Array<{ method: string; path: string; body: string }> = []
  const headSha = 'f'.repeat(40)
  const runId = 4242
  const jobs = successJobs().map((job) => ({ ...job, id: 1, completed_at: '2026-11-24T00:00:00Z' }))
  jobs[jobs.findIndex((job) => job.name === 'changelog')] = {
    id: 77,
    name: 'changelog',
    status: 'in_progress',
    conclusion: 'success',
    completed_at: '2026-11-24T00:00:05Z',
  }
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += String(chunk)
    })
    request.on('end', () => {
      requests.push({ method: request.method ?? '', path: request.url ?? '', body })
      response.setHeader('content-type', 'application/json')
      if (request.method === 'GET' && request.url === `/repos/o/r/actions/runs/${String(runId)}`) {
        response.end(JSON.stringify({
          id: runId,
          head_sha: headSha,
          event: 'push',
          conclusion: 'success',
          html_url: `https://example.test/runs/${String(runId)}`,
          pull_requests: [],
        }))
        return
      }
      if (request.method === 'GET' && (request.url ?? '').startsWith(`/repos/o/r/actions/runs/${String(runId)}/jobs`)) {
        response.end(JSON.stringify({ jobs }))
        return
      }
      response.statusCode = 404
      response.end(JSON.stringify({ message: 'unexpected route' }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const checkout = mkdtempSync(join(tmpdir(), 'ci-ok-run-'))
  try {
    // `gateBlob()` reads the policy blob from the checkout's `base/` tree, so
    // the fixture must be a real git repository rather than a directory.
    const base = join(checkout, 'base')
    mkdirSync(join(base, 'scripts'), { recursive: true })
    writeFileSync(join(base, 'scripts', 'ci-ok.mjs'), '// the policy blob only has to exist\n')
    const git = (...args: string[]) => spawnSync('git', ['-C', base, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' })
    assert.equal(git('init', '-q').status, 0)
    assert.equal(git('add', 'scripts/ci-ok.mjs').status, 0)
    assert.equal(git('commit', '-q', '-m', 'gate').status, 0)

    const { port } = server.address() as AddressInfo
    const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/ci-ok-run.mjs', import.meta.url)), '--repo', checkout], {
      env: {
        ...process.env,
        GITHUB_TOKEN: 'fixture-token',
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_API_URL: `http://127.0.0.1:${String(port)}`,
        CI_OK_RUN_ID: String(runId),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
    assert.equal(code, 0, stderr)
    assert.match(stdout, /pending/, 'the publisher says pending in its own log, which is where a reader can see it')
    assert.match(stdout, /changelog/, 'and names the context that is still unsettled')
    assert.deepEqual(
      requests.filter((request) => request.method === 'POST'),
      [],
      'zero check-run POST: an unsettled required set publishes nothing',
    )
  } finally {
    server.close()
    rmSync(checkout, { recursive: true, force: true })
  }
})
