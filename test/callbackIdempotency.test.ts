import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import type { RepoRow } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import { prOrigin } from '../src/jobs/prUrl.js'
import type { Runner, RunnerContext } from '../src/jobs/runner.js'
import { encryptSecret, sha256Hex } from '../src/lib/secrets.js'
import { addMinutes } from '../src/lib/time.js'
import { json, makeUser, MemoryMailer, startFakeServer, testConfig } from './helpers.js'

// The origin every payload in the merging cases names. The fake API base is
// loopback, so the fixture repo records this origin and the pin below proves it.
const PR_ORIGIN = 'https://github.com'

interface FakeGithub {
  url: string
  merges: string[]
  comments: string[]
  pendingComments: () => number
  close: () => Promise<void>
}

// A green, open PR on o/r; `delayMs` keeps the merge call in flight so a replay
// arrives while the first delivery is still inside its side effects.
// `commentDelayMs` does the same for the automation comment, so a case can close
// its harness while the comment is still in flight.
async function fakeGithub(options: { delayMs?: number; commentDelayMs?: number } = {}): Promise<FakeGithub> {
  const merges: string[] = []
  const comments: string[] = []
  const delay = options.delayMs ?? 0
  const commentDelay = options.commentDelayMs ?? 0
  let pendingComments = 0
  const server = await startFakeServer((request, response) => {
    const method = request.method ?? 'GET'
    const url = request.url ?? ''
    if (method === 'GET' && url === '/repos/o/r/pulls/1') {
      json(response, 200, {
        number: 1,
        html_url: 'https://github.com/o/r/pull/1',
        title: 'fix',
        state: 'open',
        head: { ref: 'fledge/job', sha: 'shaa' },
        base: { ref: 'main' },
        mergeable: true,
        mergeable_state: 'clean',
        draft: false,
        merged: false,
      })
      return
    }
    if (method === 'GET' && url === '/repos/o/r/commits/shaa/check-runs?per_page=100') {
      json(response, 200, { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] })
      return
    }
    if (method === 'GET' && url === '/repos/o/r/commits/shaa/status') {
      json(response, 200, { state: 'success', statuses: [] })
      return
    }
    if (method === 'GET' && url === '/repos/o/r/pulls/1/reviews?per_page=100') {
      json(response, 200, [])
      return
    }
    if (method === 'GET' && url === '/repos/o/r/branches/main/protection') {
      json(response, 200, { required_status_checks: { contexts: ['ci'] }, required_pull_request_reviews: { required_approving_review_count: 0 } })
      return
    }
    if (method === 'PUT' && url === '/repos/o/r/pulls/1/merge') {
      merges.push(url)
      const answer = (): void => { json(response, 200, { merged: true, sha: 'mergedsha' }) }
      if (delay > 0) setTimeout(answer, delay)
      else answer()
      return
    }
    if (method === 'POST' && url === '/repos/o/r/issues/1/comments') {
      comments.push(url)
      pendingComments += 1
      const answer = (): void => {
        try {
          json(response, 200, {})
        } catch {
          // The case already closed the socket; the pending count still clears.
        } finally {
          pendingComments -= 1
        }
      }
      if (commentDelay > 0) setTimeout(answer, commentDelay)
      else answer()
      return
    }
    json(response, 404, { message: 'Not Found' })
  }, { abortOnClose: true })
  return { url: server.url, merges, comments, pendingComments: () => pendingComments, close: server.close }
}

interface Harness {
  store: Store
  jobs: Jobs
  repo: RepoRow
  merges: string[]
  close: () => Promise<void>
}

async function harness(options: { delayMs?: number; commentDelayMs?: number; runner?: Runner } = {}): Promise<Harness> {
  const github = await fakeGithub({ delayMs: options.delayMs, commentDelayMs: options.commentDelayMs })
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: github.url } })
  const store = new Store(':memory:')
  const runner: Runner = options.runner ?? { name: 'noop', async run() { return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  const user = makeUser(store, { login: 'callback-user', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_callback',
    userId: user.id,
    owner: 'o',
    name: 'r',
    // The payloads below name https://github.com/o/r/pull/1, so the repo has to
    // record that origin; the fake API base is loopback and prOrigin() would
    // otherwise expect 127.0.0.1 and refuse every merge.
    upstreamHtmlUrl: PR_ORIGIN,
    defaultBranch: 'main',
    tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey),
    permission: 'admin',
    repoRole: 'maintainer',
    autoMerge: true,
    roleCheckedAt: new Date().toISOString(),
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  // The payloads below name https://github.com/o/r/pull/1. If either the
  // recorded origin or the API base moves, the four merge assertions stop
  // meaning what they say, so fail here with the reason instead.
  assert.equal(prOrigin(repo, config.github.apiBase), PR_ORIGIN)
  return {
    store,
    jobs,
    repo,
    merges: github.merges,
    close: async () => {
      // The callback answers before its side effect finishes, so closing here
      // first turns a teardown race into a misleading `automation comment
      // failed` warning whenever a case exits early. Let the pending comment
      // settle before the fake API (and the store it reports into) goes away.
      await waitFor(() => github.pendingComments() === 0, 'the pending automation comment')
      store.close()
      await github.close()
    },
  }
}

function runningJob(store: Store, repo: RepoRow, id: string, secret: string, startedAt = new Date().toISOString()): string {
  store.createJob({
    id,
    repoId: repo.id,
    userId: repo.user_id,
    trigger: 'manual',
    goal: 'g',
    callbackHash: sha256Hex(secret),
    platformTokenHash: '',
    kind: 'iterate',
    baseBranch: 'main',
  })
  store.updateJob(id, { status: 'running', started_at: startedAt, branch: 'fledge/job' })
  return id
}

function count(store: Store, sql: string): number {
  return Number(store.get<{ n: number }>(sql)?.n ?? 0)
}

function jobEvents(store: Store, kind: string): number {
  return count(store, `SELECT COUNT(*) AS n FROM job_events WHERE kind = '${kind}'`)
}

function waitFor(check: () => boolean, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      if (check()) return resolve()
      if (Date.now() - started > 5000) return reject(new Error(`timed out waiting for ${what}`))
      setTimeout(tick, 10)
    }
    tick()
  })
}

// Keep the suite's own automation-comment lines so a case can assert on them,
// while every line still reaches the reporter: the runner writes through the
// same stream, so swallowing output here would hide the test results.
function watchAutomationComments(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const stdoutWrite = process.stdout.write.bind(process.stdout)
  const stderrWrite = process.stderr.write.bind(process.stderr)
  const forward = (original: typeof process.stdout.write): typeof process.stdout.write => ((...args: Parameters<typeof process.stdout.write>) => {
    const text = String(args[0])
    if (text.includes('automation comment')) lines.push(text)
    return original(...args)
  }) as typeof process.stdout.write
  process.stdout.write = forward(stdoutWrite)
  process.stderr.write = forward(stderrWrite)
  return {
    lines,
    restore: () => {
      process.stdout.write = stdoutWrite as typeof process.stdout.write
      process.stderr.write = stderrWrite
    },
  }
}

test('replaying the same terminal callback answers 200 duplicate and writes nothing twice', async () => {
  const h = await harness()
  try {
    const secret = 'replay-secret'
    const id = runningJob(h.store, h.repo, 'job_replay', secret)
    const payload = { status: 'succeeded' as const, prUrl: `${PR_ORIGIN}/o/r/pull/1`, summary: 'done' }

    const first = await h.jobs.handleCallback(id, secret, payload)
    assert.equal(first.ok, true, first.error ?? 'no error')
    assert.equal(first.duplicate, undefined)
    const auditAfterFirst = count(h.store, 'SELECT COUNT(*) AS n FROM audit_log')
    const notifyAfterFirst = count(h.store, 'SELECT COUNT(*) AS n FROM notifications')

    const second = await h.jobs.handleCallback(id, secret, payload)
    assert.equal(second.ok, true, second.error ?? 'no error')
    assert.equal(second.duplicate, true, 'a replay is a no-op, not a 409')
    assert.equal(jobEvents(h.store, 'job.succeeded'), 1)
    assert.equal(count(h.store, 'SELECT COUNT(*) AS n FROM audit_log'), auditAfterFirst, 'a replay adds no audit row')
    assert.equal(count(h.store, 'SELECT COUNT(*) AS n FROM notifications'), notifyAfterFirst, 'a replay sends no second notification')
    assert.equal(h.merges.length, 1, 'the merge happens once')
  } finally {
    await h.close()
  }
})

test('ten concurrent copies of one terminal callback finalise the job and merge once', async () => {
  const h = await harness({ delayMs: 50 })
  try {
    const secret = 'concurrent-secret'
    const id = runningJob(h.store, h.repo, 'job_concurrent', secret)
    const payload = { status: 'succeeded' as const, prUrl: `${PR_ORIGIN}/o/r/pull/1`, summary: 'done' }
    const results = await Promise.all(Array.from({ length: 10 }, () => h.jobs.handleCallback(id, secret, payload)))
    assert.equal(results.filter((entry) => entry.ok).length, 10, 'every delivery gets a final answer')
    assert.equal(results.filter((entry) => entry.duplicate === true).length, 9, 'nine deliveries see the winner result')
    assert.equal(jobEvents(h.store, 'job.succeeded'), 1)
    assert.equal(h.merges.length, 1)
    assert.equal(h.store.getJob(id)?.status, 'succeeded')
  } finally {
    await h.close()
  }
})

test('a replay that arrives while the merge is in flight does not merge a second time', async () => {
  const h = await harness({ delayMs: 300 })
  try {
    const secret = 'slow-merge-secret'
    const id = runningJob(h.store, h.repo, 'job_slow_merge', secret)
    const payload = { status: 'succeeded' as const, prUrl: `${PR_ORIGIN}/o/r/pull/1`, summary: 'done' }
    const first = h.jobs.handleCallback(id, secret, payload)
    await waitFor(() => h.store.getJob(id)?.status === 'succeeded', 'the first delivery to claim the row')
    const replay = await h.jobs.handleCallback(id, secret, payload)
    assert.equal(replay.ok, true)
    assert.equal(replay.duplicate, true)
    await first
    assert.equal(h.merges.length, 1, 'one merge for one result')
  } finally {
    await h.close()
  }
})

test('a contradicting terminal report is rejected without touching the recorded result', async () => {
  const h = await harness()
  try {
    const secret = 'conflict-secret'
    const id = runningJob(h.store, h.repo, 'job_conflict', secret)
    await h.jobs.handleCallback(id, secret, { status: 'succeeded', prUrl: `${PR_ORIGIN}/o/r/pull/1`, summary: 'done' })
    const before = h.store.getJob(id)!
    const conflict = await h.jobs.handleCallback(id, secret, { status: 'failed', error: 'late failure' })
    assert.equal(conflict.ok, false)
    assert.equal(conflict.status, 409)
    const after = h.store.getJob(id)!
    assert.equal(after.status, 'succeeded')
    assert.equal(after.error, before.error)
    assert.equal(h.merges.length, 1, 'the conflict merges nothing')
    assert.equal(jobEvents(h.store, 'job.failed'), 0)
  } finally {
    await h.close()
  }
})

test('a terminal job keeps answering 409 for a credential read', async () => {
  const h = await harness()
  try {
    const secret = 'credential-secret'
    const id = runningJob(h.store, h.repo, 'job_credential', secret)
    await h.jobs.handleCallback(id, secret, { status: 'succeeded', prUrl: 'https://github.com/o/r/pull/1', summary: 'done' })
    const credential = await h.jobs.credential(id, secret)
    assert.equal(credential.ok, false)
    assert.equal(credential.status, 409)
  } finally {
    await h.close()
  }
})

test('a queued job rejects a running heartbeat and keeps its timestamps', async () => {
  const h = await harness()
  try {
    const secret = 'queued-heartbeat-secret'
    h.store.createJob({
      id: 'job_queued_heartbeat',
      repoId: h.repo.id,
      userId: h.repo.user_id,
      trigger: 'manual',
      goal: 'g',
      callbackHash: sha256Hex(secret),
      platformTokenHash: '',
      kind: 'iterate',
      baseBranch: 'main',
    })
    const before = h.store.getJob('job_queued_heartbeat')!
    const result = await h.jobs.handleCallback('job_queued_heartbeat', secret, { status: 'running', summary: 'alive' })
    assert.equal(result.ok, false, 'a job with no dispatched worker may not be promoted by a heartbeat')
    assert.equal(result.status, 409)
    const after = h.store.getJob('job_queued_heartbeat')!
    assert.equal(after.status, 'queued')
    assert.equal(after.started_at, before.started_at)
    assert.equal(after.last_callback_at, before.last_callback_at, 'a rejected heartbeat does not refresh the stall window')
  } finally {
    await h.close()
  }
})

test('an invalid payload leaves the heartbeat timestamp alone', async () => {
  const h = await harness()
  try {
    const secret = 'invalid-payload-secret'
    const id = runningJob(h.store, h.repo, 'job_invalid', secret, addMinutes(-5))
    const before = h.store.getJob(id)!
    const result = await h.jobs.handleCallback(id, secret, { status: 'running', branch: 'bad..branch' })
    assert.equal(result.ok, false)
    assert.equal(result.status, 400)
    assert.equal(h.store.getJob(id)?.last_callback_at, before.last_callback_at, 'a 400 may not refresh the stall window')
  } finally {
    await h.close()
  }
})

test('heartbeats move the stall window but never the hard timeout', async () => {
  const h = await harness()
  try {
    const secret = 'hard-timeout-secret'
    // Started 91 minutes ago: past the 90 minute hard timeout whatever it reports.
    const startedAt = addMinutes(-91)
    const id = runningJob(h.store, h.repo, 'job_hard_timeout', secret, startedAt)
    const heartbeat = await h.jobs.handleCallback(id, secret, { status: 'running', summary: 'alive' })
    assert.equal(heartbeat.ok, true)
    assert.equal(h.store.getJob(id)?.started_at, startedAt, 'a heartbeat may not rewrite the start time')
    assert.notEqual(h.store.getJob(id)?.last_callback_at, null)

    const stallBefore = addMinutes(-testConfig().runner.stallMinutes)
    assert.equal(h.store.stalledRunningJobs(stallBefore).some((job) => job.id === id), false, 'the heartbeat suppresses the stall sweep')
    const timeoutBefore = addMinutes(-testConfig().runner.timeoutMinutes)
    assert.equal(h.store.staleRunningJobs(timeoutBefore).some((job) => job.id === id), true, 'the hard timeout still sweeps it')

    const late = await h.jobs.handleCallback(id, secret, { status: 'succeeded', prUrl: 'https://github.com/o/r/pull/1', summary: 'done' })
    assert.equal(late.ok, false)
    assert.equal(late.status, 409)
    assert.equal(h.store.getJob(id)?.status, 'running', 'a late success does not rewrite a timed-out run')
    assert.equal(h.merges.length, 0)
  } finally {
    await h.close()
  }
})

test('a heartbeat during dispatch is accepted because the row is already running', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  let context: RunnerContext | undefined
  const runner: Runner = {
    name: 'slow-dispatch',
    async run(input) {
      context = input
      await gate
      return { status: 'running' }
    },
  }
  const h = await harness({ runner })
  try {
    const pending = h.jobs.enqueue(h.repo, 'manual')
    await waitFor(() => h.store.listJobsForRepo(h.repo.id, 1)[0]?.status === 'running', 'the job to be marked running before dispatch returns')
    const job = h.store.listJobsForRepo(h.repo.id, 1)[0]!
    const startedAt = job.started_at
    assert.ok(startedAt !== null, 'dispatch records the start time before the runner is called')
    assert.ok(context !== undefined, 'the runner is already dispatching')
    const heartbeat = await h.jobs.handleCallback(job.id, context!.callback.secret, { status: 'running', summary: 'first heartbeat' })
    assert.equal(heartbeat.ok, true, heartbeat.error ?? 'no error')
    assert.equal(h.store.getJob(job.id)?.started_at, startedAt, 'the heartbeat does not move the start time')
    release()
    await pending
    assert.equal(h.store.getJob(job.id)?.status, 'running')
  } finally {
    release()
    await h.close()
  }
})

// The teardown used to close the fake API while the automation comment was still
// in flight, so a case that exited early — because an assertion threw — logged a
// second, unrelated `automation comment failed … fetch failed` warning. The
// warning belongs to the teardown, not to the behaviour under test.
test('closing with the automation comment in flight logs no failure', async () => {
  const watcher = watchAutomationComments()
  const h = await harness({ commentDelayMs: 100 })
  try {
    const secret = 'comment-in-flight-secret'
    const id = runningJob(h.store, h.repo, 'job_comment_in_flight', secret)
    const payload = { status: 'succeeded' as const, prUrl: `${PR_ORIGIN}/o/r/pull/1`, summary: 'done' }
    const result = await h.jobs.handleCallback(id, secret, payload)
    assert.equal(result.ok, true, result.error ?? 'no error')
  } finally {
    // Whether this case passed or threw, the teardown releases the comment
    // before the fake API goes away.
    await h.close()
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    watcher.restore()
  }
  const failed = watcher.lines.filter((line) => line.includes('automation comment failed'))
  assert.deepEqual(failed, [], `the teardown logged a misleading failure:\n${watcher.lines.join('')}`)
  assert.equal(watcher.lines.filter((line) => line.includes('automation comment posted')).length, 1, 'the comment settled instead of failing')
})
