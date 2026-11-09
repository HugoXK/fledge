import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { json, startFakeServer } from './helpers.js'

const execFileAsync = promisify(execFile)
const gateScript = fileURLToPath(new URL('../scripts/review-gate.mjs', import.meta.url))
const repairScript = fileURLToPath(new URL('../scripts/gate-repair.mjs', import.meta.url))
const workflowPath = fileURLToPath(new URL('../.github/workflows/review-gate.yml', import.meta.url))
const workflow = readFileSync(workflowPath, 'utf8')

const SHA = '0123456789abcdef0123456789abcdef01234567'
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98'

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

async function runScript(script: string, args: string[], env: Record<string, string>): Promise<RunResult> {
  try {
    const result = await execFileAsync(process.execPath, [script, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' })
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

const PASS_BODY = `Verdict: PASS at ${SHA}\nWritten-by: HugoXK-bot\nPosted-by: HugoXK-bot\n\nRan:\n- \`npm run check\` — pass\n\nNot run: Docker image\n`
const REJECT_BODY = `Verdict: REQUEST_CHANGES at ${SHA}\nWritten-by: HugoXK-bot\nPosted-by: HugoXK-bot\n\nRan:\n- \`npm run check\` — fail\n\nNot run: Docker image\n`

interface FakeState {
  files: Array<string | { filename: string; patch?: string }>
  title: string
  branch: string
  comments: Array<Record<string, unknown>>
  reviews: Array<Record<string, unknown>>
  checkRuns: Array<Record<string, unknown>>
  runs: Array<Record<string, unknown>>
  jobs: Record<string, Array<Record<string, unknown>>>
  sha: string
  posts: string[]
  failPaths: string[]
}

function initialState(): FakeState {
  return {
    files: ['src/app.ts'],
    title: 'feat: something',
    branch: 'dev2/something',
    comments: [],
    reviews: [],
    checkRuns: [],
    runs: [],
    jobs: {},
    sha: SHA,
    posts: [],
    failPaths: [],
  }
}

async function withFakeGitHub(state: FakeState, body: (env: Record<string, string>, state: FakeState) => Promise<void>): Promise<void> {
  const policy = JSON.stringify({ writers: ['HugoXK', 'HugoXK-bot'], requiredPass: 'HugoXK-bot', selfReview: ['HugoXK-bot'] })
  const server = await startFakeServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    if (state.failPaths.includes(path)) {
      json(response, 500, { message: 'boom' })
      return
    }
    if (path === '/repos/o/r/pulls/7') {
      json(response, 200, { number: 7, title: state.title, head: { sha: state.sha, ref: state.branch }, user: { login: 'HugoXK' }, labels: [] })
      return
    }
    if (path === '/repos/o/r/pulls/7/files') {
      json(response, 200, state.files.map((file) => (typeof file === 'string' ? { filename: file } : file)))
      return
    }
    if (path === '/repos/o/r/pulls/7/reviews') {
      json(response, 200, state.reviews)
      return
    }
    if (path === '/repos/o/r/issues/7/comments') {
      json(response, 200, state.comments)
      return
    }
    if (path === '/repos/o/r/contents/.github/agent/review-policy.json') {
      json(response, 200, { encoding: 'base64', content: Buffer.from(policy, 'utf8').toString('base64') })
      return
    }
    if (path === `/repos/o/r/commits/${state.sha}/check-runs`) {
      const filter = url.searchParams.get('filter')
      let checks = state.checkRuns
      if (filter === 'latest') {
        // The fake lists checks oldest first, like the API does; `filter=latest`
        // returns only the newest check run of each name.
        const latest = new Map<string, Record<string, unknown>>()
        for (const check of checks) latest.set(String(check.name), check)
        checks = [...latest.values()]
      }
      const name = url.searchParams.get('check_name')
      if (name !== null) checks = checks.filter((check) => check.name === name)
      json(response, 200, { total_count: checks.length, check_runs: checks })
      return
    }
    if (path === '/repos/o/r/actions/runs') {
      json(response, 200, { total_count: state.runs.length, workflow_runs: state.runs })
      return
    }
    const jobs = /^\/repos\/o\/r\/actions\/runs\/(\d+)\/jobs$/.exec(path)
    if (jobs !== null) {
      json(response, 200, { total_count: (state.jobs[jobs[1]!] ?? []).length, jobs: state.jobs[jobs[1]!] ?? [] })
      return
    }
    const rerun = /^\/repos\/o\/r\/actions\/runs\/(\d+)\/rerun$/.exec(path)
    if (rerun !== null) {
      state.posts.push(rerun[1]!)
      response.writeHead(202)
      response.end()
      return
    }
    json(response, 404, { message: `unexpected ${request.method} ${path}` })
  })
  const dir = mkdtempSync(join(tmpdir(), 'fledge-gate-'))
  const eventPath = join(dir, 'event.json')
  writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 7 } }))
  try {
    await body({ GITHUB_TOKEN: 'test-token', GITHUB_REPOSITORY: 'o/r', GITHUB_API_URL: server.url, GITHUB_EVENT_PATH: eventPath, GITHUB_RUN_ID: '900' }, state)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await server.close()
  }
}

// --- the gate still maps a tip to the same conclusion ------------------------

test('the gate passes a T0 tip with no verdict, because no PASS is required', async () => {
  const state = initialState()
  state.files = ['docs/deploy.md']
  await withFakeGitHub(state, async (env) => {
    const result = await runScript(gateScript, ['--pr', '7'], env)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /review-gate: PASS/)
  })
})

test('the gate fails a T2 tip with no verdict and records that a verdict is what is missing', async () => {
  const state = initialState()
  await withFakeGitHub(state, async (env) => {
    const result = await runScript(gateScript, ['--pr', '7'], env)
    assert.equal(result.code, 1)
    assert.match(result.stderr, /no conclusion at /)
  })
})

test('the gate passes a T2 tip that carries a valid PASS at the tip', async () => {
  const state = initialState()
  state.reviews = [{ body: PASS_BODY, state: 'APPROVED', submitted_at: '2026-11-09T07:00:00Z', user: { login: 'HugoXK-bot' }, author_association: 'COLLABORATOR' }]
  await withFakeGitHub(state, async (env) => {
    const result = await runScript(gateScript, ['--pr', '7'], env)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /PASS/)
  })
})

test('the gate fails a T2 tip whose newest verdict is a rejection', async () => {
  const state = initialState()
  state.comments = [{ body: REJECT_BODY, created_at: '2026-11-09T07:00:00Z', user: { login: 'HugoXK-bot' }, author_association: 'COLLABORATOR' }]
  await withFakeGitHub(state, async (env) => {
    const result = await runScript(gateScript, ['--pr', '7'], env)
    assert.equal(result.code, 1)
    assert.match(result.stderr, /newest conclusion is REQUEST_CHANGES/)
  })
})

test('the gate fails a verdict written for a different SHA', async () => {
  const state = initialState()
  state.comments = [{
    body: `Verdict: PASS at ${OTHER_SHA}\nWritten-by: HugoXK-bot\nPosted-by: HugoXK-bot\n\nRan:\n- \`npm run check\` — pass\n\nNot run: Docker\n`,
    created_at: '2026-11-09T07:00:00Z',
    user: { login: 'HugoXK-bot' },
    author_association: 'COLLABORATOR',
  }]
  await withFakeGitHub(state, async (env) => {
    const result = await runScript(gateScript, ['--pr', '7'], env)
    assert.equal(result.code, 1)
    assert.match(result.stderr, /newest conclusion is for /)
  })
})

test('a merge_group run resolves the pull request from head_ref and still decides', async () => {
  const state = initialState()
  state.files = ['src/app.ts']
  await withFakeGitHub(state, async (env) => {
    const dir = mkdtempSync(join(tmpdir(), 'fledge-gate-mg-'))
    const eventPath = join(dir, 'merge-group.json')
    writeFileSync(eventPath, JSON.stringify({ merge_group: { head_ref: 'refs/heads/gh-readonly-queue/main/pr-7-abc', base_ref: 'refs/heads/main', base_sha: SHA } }))
    try {
      const result = await runScript(gateScript, [], { ...env, GITHUB_EVENT_PATH: eventPath })
      assert.equal(result.code, 1, 'a T2 merge-group tip without a verdict must stay red')
      assert.match(result.stderr, /no conclusion at /)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// --- the repair plan: one action, no loop -----------------------------------

const greenRun = (id: number, attempt = 1) => ({ name: 'Review gate', path: '.github/workflows/review-gate.yml', id, status: 'completed', run_attempt: attempt, conclusion: 'success', created_at: new Date(Date.UTC(2026, 10, 9, 7, 0, id)).toISOString() })
const redRun = (id: number, attempt = 1) => ({ name: 'Review gate', path: '.github/workflows/review-gate.yml', id, status: 'completed', run_attempt: attempt, conclusion: 'failure', created_at: new Date(Date.UTC(2026, 10, 9, 6, 0, id)).toISOString() })
const failedGateJob = [{ name: 'review-gate', conclusion: 'failure' }, { name: 'pr-lint', conclusion: 'success' }]

test('a rejection with no red at the SHA re-runs the newest first-attempt run', async () => {
  const { repairPlan } = await import('../scripts/lib/gate-repair.mjs')
  const plan = repairPlan({
    expected: 'failure',
    checkRuns: [{ name: 'review-gate', status: 'completed', conclusion: 'success' }],
    runs: [greenRun(1), greenRun(2)],
    jobsFor: () => [],
    currentRunId: '900',
  })
  assert.deepEqual(plan, { action: 'rerun', ids: [2], reason: plan.reason })
})

test('a rejection that is already red does nothing', async () => {
  const { repairPlan } = await import('../scripts/lib/gate-repair.mjs')
  const plan = repairPlan({
    expected: 'failure',
    checkRuns: [{ name: 'review-gate', status: 'completed', conclusion: 'failure' }],
    runs: [greenRun(1)],
    jobsFor: () => [],
    currentRunId: '900',
  })
  assert.equal(plan.action, 'none')
  assert.deepEqual(plan.ids, [])
})

test('a PASS re-runs the failed run whose own gate job failed, and never the current run', async () => {
  const { repairPlan } = await import('../scripts/lib/gate-repair.mjs')
  const state = {
    expected: 'success' as const,
    checkRuns: [{ name: 'review-gate', status: 'completed', conclusion: 'failure' }],
    runs: [redRun(1), redRun(2), redRun(900)],
    jobsFor: (id: number | string) => (id === 900 ? [] : failedGateJob),
    currentRunId: '900',
  }
  const plan = repairPlan(state)
  assert.equal(plan.action, 'rerun')
  assert.deepEqual([...plan.ids].sort((a, b) => Number(a) - Number(b)), [1, 2])
})

test('a failed run whose gate job passed is not re-run, and a red that cannot be repainted blocks', async () => {
  const { repairPlan } = await import('../scripts/lib/gate-repair.mjs')
  const notOurFailure = repairPlan({
    expected: 'success',
    checkRuns: [{ name: 'review-gate', status: 'completed', conclusion: 'success' }],
    runs: [redRun(1)],
    jobsFor: () => [{ name: 'review-gate', conclusion: 'success' }, { name: 'pr-lint', conclusion: 'failure' }],
    currentRunId: '900',
  })
  assert.equal(notOurFailure.action, 'none')

  const exhausted = repairPlan({
    expected: 'success',
    checkRuns: [{ name: 'review-gate', status: 'completed', conclusion: 'failure' }],
    runs: [redRun(1, 2)],
    jobsFor: () => failedGateJob,
    currentRunId: '900',
  })
  assert.equal(exhausted.action, 'blocked')
})

test('the second identical trigger finds nothing on its first attempt and makes no write', async () => {
  const { repairPlan } = await import('../scripts/lib/gate-repair.mjs')
  const plan = repairPlan({
    expected: 'failure',
    checkRuns: [{ name: 'review-gate', status: 'completed', conclusion: 'failure' }],
    runs: [greenRun(1, 2), greenRun(2, 2)],
    jobsFor: () => [],
    currentRunId: '900',
  })
  assert.equal(plan.action, 'none')
})

test('a run that is still executing is never a re-run target', async () => {
  const { repairPlan } = await import('../scripts/lib/gate-repair.mjs')
  // A 409 on the re-run would exit 1 while the in-flight run may still publish
  // its own conclusion, so only a completed run may be chosen.
  const inFlight = { name: 'Review gate', path: '.github/workflows/review-gate.yml', id: 999, status: 'in_progress', run_attempt: 1, conclusion: null, created_at: '2026-11-09T08:00:00Z' }
  const completed = { ...greenRun(998), created_at: '2026-11-09T07:00:00Z' }

  const withCompleted = repairPlan({
    expected: 'failure',
    checkRuns: [{ name: 'review-gate', status: 'completed', conclusion: 'success' }],
    runs: [completed, inFlight],
    jobsFor: () => [],
    currentRunId: '900',
  })
  assert.deepEqual(withCompleted, { action: 'rerun', ids: [998], reason: withCompleted.reason }, 'the oldest completed run repaints; the in-flight run is skipped')

  const onlyInFlight = repairPlan({
    expected: 'failure',
    checkRuns: [{ name: 'review-gate', status: 'completed', conclusion: 'success' }],
    runs: [inFlight],
    jobsFor: () => [],
    currentRunId: '900',
  })
  assert.equal(onlyInFlight.action, 'blocked')
  assert.deepEqual(onlyInFlight.ids, [], 'no rerun may be posted for a run that has not completed')
})

// --- the repair CLI over a fake API -----------------------------------------

test('a PASS repaints the stale failed run exactly once', async () => {
  const state = initialState()
  state.reviews = [{ body: PASS_BODY, state: 'APPROVED', submitted_at: '2026-11-09T07:00:00Z', user: { login: 'HugoXK-bot' }, author_association: 'COLLABORATOR' }]
  state.checkRuns = [{ name: 'review-gate', status: 'completed', conclusion: 'failure' }]
  state.runs = [redRun(11)]
  state.jobs = { 11: failedGateJob }
  await withFakeGitHub(state, async (env) => {
    const first = await runScript(repairScript, ['--pr', '7'], env)
    assert.equal(first.code, 0, first.stderr)
    assert.deepEqual(state.posts, ['11'], 'the stale failed run must be re-run once')
  })
})

test('the same PASS again makes no second re-run request', async () => {
  const state = initialState()
  state.reviews = [{ body: PASS_BODY, state: 'APPROVED', submitted_at: '2026-11-09T07:00:00Z', user: { login: 'HugoXK-bot' }, author_association: 'COLLABORATOR' }]
  // The re-run landed: the run is attempt 2 and its check is green.
  state.checkRuns = [{ name: 'review-gate', status: 'completed', conclusion: 'success' }]
  state.runs = [{ ...redRun(11), run_attempt: 2, conclusion: 'success' }]
  state.jobs = { 11: failedGateJob }
  await withFakeGitHub(state, async (env) => {
    const result = await runScript(repairScript, ['--pr', '7'], env)
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(state.posts, [], 'a repeated identical verdict must not issue a second re-run')
    assert.match(result.stdout, /nothing to do/)
  })
})

test('a comment verdict on a green tip repaints it, and then stops', async () => {
  const state = initialState()
  state.comments = [{ body: REJECT_BODY, created_at: '2026-11-09T07:00:00Z', user: { login: 'HugoXK-bot' }, author_association: 'COLLABORATOR' }]
  state.checkRuns = [{ name: 'review-gate', status: 'completed', conclusion: 'success' }]
  state.runs = [greenRun(21)]
  await withFakeGitHub(state, async (env) => {
    const first = await runScript(repairScript, ['--pr', '7'], env)
    assert.equal(first.code, 0, first.stderr)
    assert.deepEqual(state.posts, ['21'], 'the rejection must repaint the run that is green at the tip')
  })
})

// Four workflows publish runs at one SHA, and on a real tip `Dependency review`
// is often the newest of them. Only the `Review gate` run paints `review-gate`.
const fourRunsAtOneSha = () => [
  { id: 42585100279, name: 'CI', path: '.github/workflows/ci.yml', status: 'completed', run_attempt: 1, conclusion: 'success', created_at: '2026-11-09T06:58:00Z' },
  { id: 42585100386, name: 'Review gate', path: '.github/workflows/review-gate.yml', status: 'completed', run_attempt: 1, conclusion: 'success', created_at: '2026-11-09T07:00:00Z' },
  { id: 42585100423, name: 'CodeQL', path: '.github/workflows/codeql.yml', status: 'completed', run_attempt: 1, conclusion: 'success', created_at: '2026-11-09T07:01:00Z' },
  { id: 42585100599, name: 'Dependency review', path: '.github/workflows/dependency-review.yml', status: 'completed', run_attempt: 1, conclusion: 'success', created_at: '2026-11-09T07:02:00Z' },
]

test('a rejection re-runs the newest Review gate run, never a newer run of another workflow', async () => {
  const state = initialState()
  state.comments = [{ body: REJECT_BODY, created_at: '2026-11-09T07:00:00Z', user: { login: 'HugoXK-bot' }, author_association: 'COLLABORATOR' }]
  state.checkRuns = [{ id: 1, name: 'review-gate', status: 'completed', conclusion: 'success' }]
  state.runs = fourRunsAtOneSha()
  await withFakeGitHub(state, async (env) => {
    const result = await runScript(repairScript, ['--pr', '7'], env)
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(state.posts, ['42585100386'], 'only a Review gate run can repaint review-gate')
  })
})

test('a rejection is not hidden by the failure an earlier re-run superseded', async () => {
  const state = initialState()
  state.comments = [{ body: REJECT_BODY, created_at: '2026-11-09T07:00:00Z', user: { login: 'HugoXK-bot' }, author_association: 'COLLABORATOR' }]
  // The re-run landed: its success is the newest check; the pre-re-run failure
  // is still returned by `filter=all` and is history, not a standing red.
  state.checkRuns = [
    { id: 129052914671, name: 'review-gate', status: 'completed', conclusion: 'failure', started_at: '2026-11-09T06:00:00Z' },
    { id: 129123972768, name: 'review-gate', status: 'completed', conclusion: 'success', started_at: '2026-11-09T07:00:00Z' },
  ]
  state.runs = [greenRun(42585100386)]
  await withFakeGitHub(state, async (env) => {
    const result = await runScript(repairScript, ['--pr', '7'], env)
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(state.posts, ['42585100386'], 'the tip is green right now, so the rejection must repaint it')
  })
})

test('a PASS is not blocked by a failure its re-run already superseded', async () => {
  const state = initialState()
  state.reviews = [{ body: PASS_BODY, state: 'APPROVED', submitted_at: '2026-11-09T07:00:00Z', user: { login: 'HugoXK-bot' }, author_association: 'COLLABORATOR' }]
  state.checkRuns = [
    { id: 129052914671, name: 'review-gate', status: 'completed', conclusion: 'failure', started_at: '2026-11-09T06:00:00Z' },
    { id: 129123972768, name: 'review-gate', status: 'completed', conclusion: 'success', started_at: '2026-11-09T07:00:00Z' },
  ]
  state.runs = [{ ...greenRun(42585100386, 2) }]
  await withFakeGitHub(state, async (env) => {
    const result = await runScript(repairScript, ['--pr', '7'], env)
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(state.posts, [], 'a green newest check needs no re-run')
    assert.match(result.stdout, /nothing to do/)
  })
})

test('a gate that cannot decide re-runs nothing', async () => {
  const state = initialState()
  // The gate cannot read the verdicts at all: re-running any run would only
  // reproduce that, so the repair step must leave the SHA alone.
  state.failPaths = ['/repos/o/r/issues/7/comments']
  state.checkRuns = [{ name: 'review-gate', status: 'completed', conclusion: 'success' }]
  state.runs = [greenRun(1)]
  await withFakeGitHub(state, async (env) => {
    const result = await runScript(repairScript, ['--pr', '7'], env)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /gate-repair: skipped/)
    assert.deepEqual(state.posts, [], 'a gate that could not decide must not trigger a re-run')
  })
})

test('a SHA whose runs are all on attempt 2 fails loudly instead of looping', async () => {
  const state = initialState()
  state.reviews = [{ body: PASS_BODY, state: 'APPROVED', submitted_at: '2026-11-09T07:00:00Z', user: { login: 'HugoXK-bot' }, author_association: 'COLLABORATOR' }]
  state.checkRuns = [{ name: 'review-gate', status: 'completed', conclusion: 'failure' }]
  state.runs = [{ ...redRun(31, 2) }]
  state.jobs = { 31: failedGateJob }
  await withFakeGitHub(state, async (env) => {
    const result = await runScript(repairScript, ['--pr', '7'], env)
    assert.equal(result.code, 1)
    assert.match(result.stderr, new RegExp(SHA))
    assert.deepEqual(state.posts, [])
  })
})

// --- the workflow itself ----------------------------------------------------

function sections(text: string): Map<string, string> {
  const out = new Map<string, string>()
  const jobsText = text.slice(text.indexOf('\njobs:') + 1)
  const matches = [...jobsText.matchAll(/^ {2}([a-z0-9-]+):$/gm)]
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i]!.index ?? 0
    const end = i + 1 < matches.length ? matches[i + 1]!.index ?? jobsText.length : jobsText.length
    out.set(matches[i]![1]!, jobsText.slice(start, end))
  }
  return out
}

test('the workflow keeps the three merge events and adds only issue_comment', () => {
  const onBlock = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\njobs:'))
  for (const trigger of ['pull_request:', 'pull_request_review:', 'merge_group:', 'issue_comment:']) {
    assert.ok(onBlock.includes(trigger), `on: must keep ${trigger}`)
  }
  assert.doesNotMatch(workflow, /pull_request_target/, 'pull_request_target must never be used')
})

test('exactly one job is named review-gate and the comment path is a different job', () => {
  const byName = [...workflow.matchAll(/^ {4}name: (.+)$/gm)].map((match) => match[1]!.trim())
  assert.equal(byName.filter((name) => name === 'review-gate').length, 1)
  const jobs = sections(workflow)
  assert.ok(jobs.has('review-gate'))
  assert.ok(jobs.has('review-gate-comment'))
  assert.match(jobs.get('review-gate-comment')!, /issue_comment/)
  assert.match(jobs.get('review-gate-comment')!, /github\.event\.issue\.pull_request/)
  // The match must use the first non-empty line and the same shapes and case
  // handling as parseConclusion, or a heading-form verdict never repaints.
  assert.match(jobs.get('review-gate-comment')!, /awk 'NF \{ print; exit \}'/)
  assert.match(jobs.get('review-gate-comment')!, /grep -qiE/)
  assert.match(jobs.get('review-gate-comment')!, /##\[\[:space:\]\]\*Review/)
  assert.match(jobs.get('review-gate-comment')!, /Verdict:\[\[:space:\]\]\+\(PASS\|INC\|REQUEST_CHANGES\)/)
  assert.match(jobs.get('review-gate-comment')!, /github\.event\.issue\.number/)
})

test('the comment path only starts for a verdict an owner, member or collaborator posted', () => {
  // A workflow `if:` cannot be behaviour-tested from node:test, so this locks the
  // shape instead: the event test comes first, so on `pull_request_review` and
  // `merge_group` the association test is never reached, and a stranger's
  // `issue_comment` cannot start the actions: write job.
  const comment = sections(workflow).get('review-gate-comment')!
  const ifLine = comment.split('\n').find((line) => /^\s+if: /.test(line))
  assert.ok(ifLine, 'the comment job must keep an if: guard')
  const eventTest = `github.event_name == 'issue_comment'`
  const prTest = 'github.event.issue.pull_request != null'
  const association = `contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association)`
  assert.ok(ifLine.includes(eventTest), 'the guard must test the event first')
  assert.ok(ifLine.includes(prTest), 'the comment path stays limited to pull requests')
  assert.ok(ifLine.includes(association), 'a stranger comment must not start the actions: write job')
  assert.ok(
    ifLine.indexOf(eventTest) < ifLine.indexOf(association),
    'the association must be tested only after the event is issue_comment',
  )
  // The guard belongs to the comment path only: the workflow still serves the
  // other two events that publish `review-gate`.
  for (const trigger of ['pull_request_review:', 'merge_group:']) {
    assert.ok(workflow.includes(trigger), `the workflow must keep ${trigger}`)
  }
})

test('the workflow keeps a top-level least-privilege permissions block', () => {
  const block = workflow.slice(workflow.indexOf('\npermissions:'), workflow.indexOf('\njobs:'))
  assert.match(block, /contents: read/)
  assert.match(block, /pull-requests: read/)
  assert.match(block, /issues: read/)
  assert.doesNotMatch(block, /actions: write|write-all/, 'the default must stay read-only')
})

test('the review-gate job is never skipped on an event that publishes it for a pull request', () => {
  const gate = sections(workflow).get('review-gate')!
  assert.match(gate, /if: github\.event_name != 'issue_comment'/)
})

test('every checkout in this workflow is pinned to a base ref, never the pull request head', () => {
  const lines = workflow.split('\n')
  let checked = 0
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i]!.includes('uses: actions/checkout@')) continue
    checked += 1
    const indent = lines[i]!.search(/\S/)
    const block = [lines[i]!]
    for (let j = i + 1; j < lines.length; j += 1) {
      const lineIndent = lines[j]!.search(/\S/)
      if (lines[j]!.trim() !== '' && lineIndent <= indent) break
      block.push(lines[j]!)
    }
    const text = block.join('\n')
    assert.match(text, /ref: \$\{\{/, `checkout at line ${i + 1} must pin a ref`)
    assert.match(text, /base\.sha|base_sha|default_branch/, `checkout at line ${i + 1} must pin the base side`)
    assert.doesNotMatch(text, /pull_request\.head/, `checkout at line ${i + 1} must not check out the head`)
  }
  assert.ok(checked >= 4, `expected at least four checkouts, found ${checked}`)
})

test('actions: write is granted only to the two jobs that re-run a workflow run', () => {
  for (const [name, body] of sections(workflow)) {
    if (name === 'review-gate-repair' || name === 'review-gate-comment') assert.match(body, /actions: write/, `${name} needs actions: write`)
    else assert.doesNotMatch(body, /actions: write/, `${name} must not hold actions: write`)
  }
})

// --- the mechanical daily release, and why the exemption has to be earned ----

// The shape `node scripts/changelog.mjs release` plus the version bump produce:
// content in CHANGELOG.md and changelog.d/, and nothing but the version fields
// and the image tag elsewhere.
const RELEASE_FILES = [
  { filename: 'CHANGELOG.md', patch: '@@ -1,2 +1,3 @@\n # Changelog\n+\n+## 0.3.0\n' },
  { filename: 'changelog.d/80-daily-release-drive.added.md', patch: '@@ -1 +0,0 @@\n-a fragment\n' },
  { filename: 'package.json', patch: '@@ -2,3 +2,3 @@\n-  "version": "0.2.4",\n+  "version": "0.3.0",\n' },
  { filename: 'package-lock.json', patch: '@@ -1,4 +1,4 @@\n-  "version": "0.2.4",\n+  "version": "0.3.0",\n' },
  { filename: 'docker-compose.yml', patch: '@@ -3,3 +3,3 @@\n-    image: ghcr.io/hugoxk/fledge:v0.2.4\n+    image: ghcr.io/hugoxk/fledge:v0.3.0\n' },
]

test('the gate passes a mechanical release PR with no verdict, because the diff is the release shape', async () => {
  const state = initialState()
  state.files = RELEASE_FILES
  state.title = 'release: v0.3.0'
  state.branch = 'release/v0.3.0'
  await withFakeGitHub(state, async (env) => {
    const result = await runScript(gateScript, ['--pr', '7'], env)
    assert.equal(result.code, 0, `a mechanical release PR must not need a PASS: ${result.stderr}`)
    assert.match(result.stdout, /T0 at /)
  })
})

test('the same five files without the release identity stay T3 and need a PASS', async () => {
  const state = initialState()
  state.files = RELEASE_FILES
  state.title = 'feat: rename a thing'
  state.branch = 'dev2/rename'
  await withFakeGitHub(state, async (env) => {
    const result = await runScript(gateScript, ['--pr', '7'], env)
    assert.equal(result.code, 1, 'the file set alone must never be exempt')
    assert.match(result.stderr, /no conclusion at /)
  })
})

test('a release title on a non-release branch also stays T3', async () => {
  const state = initialState()
  state.files = RELEASE_FILES
  state.title = 'release: v0.3.0'
  state.branch = 'dev2/80-release-driver'
  await withFakeGitHub(state, async (env) => {
    const result = await runScript(gateScript, ['--pr', '7'], env)
    assert.equal(result.code, 1)
    assert.match(result.stderr, /no conclusion at /)
  })
})

test('a release identity that carries a dependency change stays T3', async () => {
  const state = initialState()
  state.files = [
    ...RELEASE_FILES.filter((file) => file.filename !== 'package.json'),
    {
      filename: 'package.json',
      patch: '@@ -2,4 +2,5 @@\n-  "version": "0.2.4",\n+  "version": "0.3.0",\n+  "dependencies": { "fastify": "^5.12.7" },\n',
    },
  ]
  state.title = 'release: v0.3.0'
  state.branch = 'release/v0.3.0'
  await withFakeGitHub(state, async (env) => {
    const result = await runScript(gateScript, ['--pr', '7'], env)
    assert.equal(result.code, 1, 'a self-declared identity must not exempt a dependency change')
    assert.match(result.stderr, /no conclusion at /)
  })
})

test('a release identity whose package.json patch the API omitted stays T3', async () => {
  const state = initialState()
  state.files = [
    ...RELEASE_FILES.filter((file) => file.filename !== 'package.json'),
    { filename: 'package.json' },
  ]
  state.title = 'release: v0.3.0'
  state.branch = 'release/v0.3.0'
  await withFakeGitHub(state, async (env) => {
    const result = await runScript(gateScript, ['--pr', '7'], env)
    assert.equal(result.code, 1, 'an unjudgeable diff fails closed')
    assert.match(result.stderr, /no conclusion at /)
  })
})
