import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { buildApp, type BuiltApp } from '../src/app.js'
import { ManagementService } from '../src/management/service.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #616: the web cancel runs `task.cancel` through the management service, whose
// receipt transaction called the postmortem write that opens a transaction of
// its own. A nested BEGIN throws, `notePostmortem` swallows it as a warning, and
// the row was silently lost — the cancel looked fine while the postmortem, and
// the recurrence escalation that reads it, were missing. These cases pin the row
// to the cancel path and keep the transaction boundary where it is.

interface Fixture {
  built: BuiltApp
  user: ReturnType<typeof makeUser>
  repoId: string
  jobId: string
  close: () => Promise<void>
}

async function fixture(id: string): Promise<Fixture> {
  const config = { ...testConfig(), managementService: 'on' as const }
  const store = new Store(':memory:')
  const built = await buildApp({
    config,
    store,
    mailer: new MemoryMailer(),
    runner: { name: 'capture', async run() { return { status: 'running' as const } } },
    startScheduler: false,
  })
  const user = makeUser(store, { login: `cancel-${id}`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_cancel_${id}`,
    userId: user.id,
    owner: 'o',
    name: 'cancel',
    defaultBranch: 'main',
    tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey),
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  const job = store.createJob({ id: `job_cancel_${id}`, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: `cb-${id}`, platformTokenHash: '' })
  return { built, user, repoId: repo.id, jobId: job.id, close: async () => { await built.close() } }
}

async function cancelPost(f: Fixture, payload: Record<string, string>): Promise<{ statusCode: number; location: string }> {
  const session = sessionFor(f.built, f.user)
  const response = await f.built.app.inject({
    method: 'POST',
    url: `/repos/${f.repoId}/jobs/${f.jobId}/cancel`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: session.cookie },
    payload: formBody({ csrf: session.csrf, ...payload }),
  })
  return { statusCode: response.statusCode, location: String(response.headers.location) }
}

// The warning `notePostmortem` writes is the only trace of the loss, so a case
// that says "the row is there" has to read the same stream the service writes.
// Every chunk is passed through: node:test reports on stdout.
function captureLog(): { lines: Array<Record<string, unknown>>; restore: () => void } {
  const lines: Array<Record<string, unknown>> = []
  const stdout = process.stdout.write
  const stderr = process.stderr.write
  const tap = (write: typeof process.stdout.write): typeof process.stdout.write => ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    for (const line of text.split('\n')) {
      if (!line.startsWith('{"ts":"')) continue
      try {
        lines.push(JSON.parse(line) as Record<string, unknown>)
      } catch {}
    }
    return (write as unknown as (value: string | Uint8Array, ...args: unknown[]) => boolean)(chunk, ...rest)
  }) as unknown as typeof process.stdout.write
  process.stdout.write = tap(stdout.bind(process.stdout))
  process.stderr.write = tap(stderr.bind(process.stderr))
  return {
    lines,
    restore: () => {
      process.stdout.write = stdout
      process.stderr.write = stderr
    },
  }
}

test('a web cancel writes the postmortem row and logs no failure', async () => {
  const f = await fixture('row')
  const captured = captureLog()
  try {
    const response = await cancelPost(f, { expected_revision: '1', idempotency_key: 'cancel-row' })
    assert.equal(response.statusCode, 302)
    assert.match(response.location, /notice=/)
    assert.equal(f.built.store.getJob(f.jobId)?.status, 'cancelled')

    const postmortem = f.built.store.getPostmortemForJob(f.jobId)
    assert.notEqual(postmortem, undefined, 'a cancelled job keeps its one postmortem row')
    assert.equal(postmortem?.outcome, 'cancelled')

    const failures = captured.lines.filter((row) => row.msg === 'postmortem write failed')
    assert.deepEqual(failures, [], 'the postmortem write must not fail on the cancel path')
  } finally {
    captured.restore()
    await f.close()
  }
})

test('a cancelled recurrence still escalates on its second crossing', async () => {
  const f = await fixture('recurrence')
  const captured = captureLog()
  try {
    const first = await cancelPost(f, { expected_revision: '1', idempotency_key: 'cancel-recurrence-1' })
    assert.equal(first.statusCode, 302)

    const second = f.built.store.createJob({ id: 'job_cancel_recurrence_2', repoId: f.repoId, userId: f.user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb-recurrence-2', platformTokenHash: '' })
    const again = await cancelPost({ ...f, jobId: second.id }, { expected_revision: '1', idempotency_key: 'cancel-recurrence-2' })
    assert.equal(again.statusCode, 302)
    assert.notEqual(f.built.store.getPostmortemForJob(second.id), undefined, 'the second cancel writes its own row')
    assert.equal(f.built.store.listAudit(200).filter((row) => row.action === 'postmortem.recurrence_escalated').length, 1, 'the recurrence reached its threshold')
  } finally {
    captured.restore()
    await f.close()
  }
})

test('a cancel whose receipt cannot commit leaves no postmortem behind', async () => {
  const f = await fixture('rollback')
  try {
    const store = f.built.store
    const original = store.updateCommandReceipt.bind(store)
    store.updateCommandReceipt = ((id: string, patch: Parameters<typeof original>[1]) => {
      if (patch.status === 'succeeded') throw new Error('the commit failed')
      return original(id, patch)
    }) as typeof store.updateCommandReceipt

    const service = new ManagementService(store, f.built.jobs)
    const repo = store.getRepo(f.repoId)
    assert.notEqual(repo, undefined)
    if (repo === undefined) return
    const { managementActor } = await import('../src/management/actor.js')
    await assert.rejects(() => service.run(managementActor({ userId: f.user.id, repo, channel: 'web', requestId: 'req-rollback' }), {
      operation: 'task.cancel',
      target: { projectId: f.repoId, jobId: f.jobId },
      arguments: {},
      expectedRevision: 1,
      idempotencyKey: 'cancel-rollback',
    }))

    assert.equal(store.getJob(f.jobId)?.status, 'queued', 'the cancel rolled back with its receipt')
    assert.equal(store.getPostmortemForJob(f.jobId), undefined, 'the after-commit write never ran for a transaction that failed')
  } finally {
    await f.close()
  }
})

// #666: the postmortem write runs after the receipt committed, so its failure
// cannot fail the command — but it also must not be invisible. A log line is not
// a record: `src/lib/log.ts` writes to stdout and nowhere else, so the loss has
// to land in the database. This is the same choke point both cancel paths pass
// through, so one write covers the web form and `/fledge cancel`.
test('a cancel whose postmortem write fails still succeeds and leaves a durable trace', async () => {
  const f = await fixture('postmortem-failure')
  const captured = captureLog()
  try {
    const store = f.built.store
    store.createPostmortemForJob = (() => {
      throw new Error('postmortem insert failed')
    }) as typeof store.createPostmortemForJob

    const response = await cancelPost(f, { expected_revision: '1', idempotency_key: 'cancel-postmortem-failure' })
    assert.equal(response.statusCode, 302, 'a landed cancel is not reported as an error')
    assert.match(response.location, /notice=/)
    assert.equal(store.getJob(f.jobId)?.status, 'cancelled')
    assert.equal(store.getPostmortemForJob(f.jobId), undefined, 'the failed write left no row; that is the loss being recorded')

    const trace = store.listAudit(200).filter((row) => row.action === 'postmortem.write_failed')
    assert.equal(trace.length, 1, 'the loss is retrievable from the database, not only from a log line')
    assert.match(String(trace[0]?.detail), new RegExp(f.jobId), 'the trace names the job')
    assert.match(String(trace[0]?.detail), /postmortem insert failed/, 'the trace names the error')
    assert.equal(trace[0]?.user_id, f.user.id, 'the trace belongs to the user whose job lost its postmortem')
  } finally {
    captured.restore()
    await f.close()
  }
})

test('the /fledge cancel path records the same trace when the postmortem write fails', async () => {
  const f = await fixture('postmortem-failure-fledge')
  try {
    const store = f.built.store
    store.createPostmortemForJob = (() => {
      throw new Error('postmortem insert failed')
    }) as typeof store.createPostmortemForJob

    const result = await f.built.jobs.cancelJob(f.jobId, 'stop')
    assert.equal(result.ok, true, 'the cancel already landed, so it is not an error')
    assert.equal(store.getJob(f.jobId)?.status, 'cancelled')

    const trace = store.listAudit(200).filter((row) => row.action === 'postmortem.write_failed')
    assert.equal(trace.length, 1, 'the second call site passes through the same choke point')
    assert.match(String(trace[0]?.detail), /postmortem insert failed/)
  } finally {
    await f.close()
  }
})

// #666, second half: the callback runs after `COMMIT`, so it cannot decide
// whether the command succeeded. Today's only callback catches its own errors,
// which is why the unguarded call is invisible; the contract has to hold for the
// next one too. A throwing callback is planted on the prepared stop so the real
// web route and the real receipt transaction carry it.
async function cancelWithThrowingCallback(f: Fixture): Promise<void> {
  const jobs = f.built.jobs
  const original = jobs.prepareCancel.bind(jobs)
  jobs.prepareCancel = async (jobId: string, reason: string) => {
    const prepared = await original(jobId, reason)
    if (!prepared.ok) return prepared
    return { ...prepared, afterCommit: () => { throw new Error('post-commit callback exploded') } }
  }
}

test('an after-commit callback that throws cannot turn a landed cancel into an error', async () => {
  const f = await fixture('after-commit-throw')
  const captured = captureLog()
  try {
    await cancelWithThrowingCallback(f)

    const response = await cancelPost(f, { expected_revision: '1', idempotency_key: 'cancel-after-commit-throw' })
    assert.equal(response.statusCode, 302, 'the commit returned, so the command reports success')
    assert.match(response.location, /notice=/)
    assert.equal(f.built.store.getJob(f.jobId)?.status, 'cancelled')

    const trace = f.built.store.listAudit(200).filter((row) => row.action === 'management.after_commit_failed')
    assert.equal(trace.length, 1, 'the throwing callback leaves a durable record instead of a 500')
    assert.match(String(trace[0]?.detail), new RegExp(f.jobId), 'the record names the job the command moved')
    assert.match(String(trace[0]?.detail), /Error: post-commit callback exploded/, 'the record names the error class and its message')
  } finally {
    captured.restore()
    await f.close()
  }
})

test('the /fledge cancel path also survives a throwing after-commit callback', async () => {
  const f = await fixture('after-commit-throw-fledge')
  const captured = captureLog()
  try {
    const jobs = f.built.jobs
    const internal = jobs as unknown as { prepareStop: (jobId: string, reason: string, status: 'cancelled') => ReturnType<typeof jobs.prepareCancel> }
    const original = internal.prepareStop.bind(jobs)
    internal.prepareStop = async (jobId, reason, status) => {
      const prepared = await original(jobId, reason, status)
      if (!prepared.ok) return prepared
      return { ...prepared, afterCommit: () => { throw new Error('post-commit callback exploded') } }
    }

    const result = await jobs.cancelJob(f.jobId, 'stop')
    assert.equal(result.ok, true, 'the landed cancel is reported as a success, not a throw')
    assert.equal(f.built.store.getJob(f.jobId)?.status, 'cancelled')

    const trace = f.built.store.listAudit(200).filter((row) => row.action === 'job.after_commit_failed')
    assert.equal(trace.length, 1, 'the second call site records the throw too')
    assert.match(String(trace[0]?.detail), new RegExp(f.jobId))
    assert.match(String(trace[0]?.detail), /Error: post-commit callback exploded/)
  } finally {
    captured.restore()
    await f.close()
  }
})

// #666's second half: both call sites of the after-commit callback run outside
// the receipt transaction, so a callback that throws must not turn a landed
// cancel into a 500 — but it must be findable too, under the path that owned it.
function failAfterCommit(f: Fixture): void {
  const jobs = f.built.jobs as unknown as { notePostmortem: (jobId: string) => void }
  jobs.notePostmortem = () => {
    throw new Error('after-commit boom')
  }
}

test('a throwing after-commit callback does not fail the web cancel and leaves a trace', async () => {
  const f = await fixture('after-commit-web')
  try {
    failAfterCommit(f)
    const response = await cancelPost(f, { expected_revision: '1', idempotency_key: 'cancel-after-commit-web' })
    assert.equal(response.statusCode, 302, 'the landed cancel is not reported as an error')
    assert.match(response.location, /notice=/)
    assert.equal(f.built.store.getJob(f.jobId)?.status, 'cancelled')

    const trace = f.built.store.listAudit(200).filter((row) => row.action === 'management.after_commit_failed')
    assert.equal(trace.length, 1, 'the management path records the callback failure')
    assert.match(String(trace[0]?.detail), new RegExp(f.jobId), 'the trace names the job the command moved')
    assert.match(String(trace[0]?.detail), /after-commit boom/)
  } finally {
    await f.close()
  }
})

test('a throwing after-commit callback does not fail /fledge cancel and leaves a trace', async () => {
  const f = await fixture('after-commit-fledge')
  try {
    failAfterCommit(f)
    const result = await f.built.jobs.cancelJob(f.jobId, 'stop')
    assert.equal(result.ok, true, 'the cancel already landed, so it is not an error')
    assert.equal(f.built.store.getJob(f.jobId)?.status, 'cancelled')

    const trace = f.built.store.listAudit(200).filter((row) => row.action === 'job.after_commit_failed')
    assert.equal(trace.length, 1, 'the direct path records the callback failure')
    assert.match(String(trace[0]?.detail), /after-commit boom/)
  } finally {
    await f.close()
  }
})
