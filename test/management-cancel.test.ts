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

// #666: the failure path #616 left behind. A failed postmortem write must leave a
// durable trace instead of only a process log line, and a throwing after-commit
// callback must not turn a cancel that already landed into an error.
test('a failed postmortem write leaves a durable trace, not only a log line', async () => {
  const f = await fixture('postmortem-failure')
  const captured = captureLog()
  try {
    const store = f.built.store
    const original = store.createPostmortemForJob.bind(store)
    store.createPostmortemForJob = (() => {
      throw new Error('database is locked')
    }) as typeof store.createPostmortemForJob

    const response = await cancelPost(f, { expected_revision: '1', idempotency_key: 'cancel-postmortem-failure' })
    assert.equal(response.statusCode, 302)
    assert.equal(store.getJob(f.jobId)?.status, 'cancelled', 'the cancel landed even though the postmortem did not')
    assert.equal(store.getPostmortemForJob(f.jobId), undefined, 'the row really is missing, which is why the trace has to exist')

    const traces = store.listJobEvents(f.jobId, 200).filter((row) => row.kind === 'job.postmortem_failed')
    assert.equal(traces.length, 1, 'one durable row records the loss, so an operator can find and repair it')
    assert.match(traces[0]?.meta ?? '', /job_cancel_postmortem-failure/, 'the trace names the job')
    assert.match(traces[0]?.meta ?? '', /Error/, 'the trace names the error class')

    assert.equal(captured.lines.filter((row) => row.msg === 'postmortem write failed').length, 1, 'the log line stays')
    store.createPostmortemForJob = original
  } finally {
    captured.restore()
    await f.close()
  }
})

test('a throwing after-commit callback cannot turn a landed cancel into an error', async () => {
  const f = await fixture('callback-throw')
  try {
    const store = f.built.store
    const jobs = f.built.jobs
    const original = jobs.prepareCancel.bind(jobs)
    ;(jobs as unknown as { prepareCancel: typeof jobs.prepareCancel }).prepareCancel = async (jobId: string, reason: string) => {
      const prepared = await original(jobId, reason)
      return { ...prepared, afterCommit: () => { throw new Error('callback exploded') } }
    }

    const response = await cancelPost(f, { expected_revision: '1', idempotency_key: 'cancel-callback-throw' })
    assert.equal(response.statusCode, 302, 'the committed command still reports success')
    assert.equal(store.getJob(f.jobId)?.status, 'cancelled', 'the cancel landed before the callback threw')

    const traces = store.listAudit(200).filter((row) => row.action === 'management.command.after_commit_failed')
    assert.equal(traces.length, 1, 'the escaped failure is durable, not only a log line')
    assert.match(traces[0]?.detail ?? '', /callback exploded/, 'the trace names the error class')
  } finally {
    await f.close()
  }
})

// The management path is not the only caller: `cancelJob` runs the same
// after-commit write for callers that are not commands, so the guard has to
// hold there as well instead of only behind the receipt.
test('the direct cancel path guards its own after-commit write', async () => {
  const f = await fixture('direct-cancel')
  try {
    const store = f.built.store
    const jobs = f.built.jobs as unknown as { notePostmortem: (jobId: string) => void }
    const original = jobs.notePostmortem
    jobs.notePostmortem = () => { throw new Error('trace write failed') }

    const result = await f.built.jobs.cancelJob(f.jobId, 'stop it')
    assert.equal(result.ok, true, 'the landed cancel keeps reporting success')
    assert.equal(store.getJob(f.jobId)?.status, 'cancelled', 'the cancel landed before the write threw')

    const traces = store.listJobEvents(f.jobId, 200).filter((row) => row.kind === 'job.after_commit_failed')
    assert.equal(traces.length, 1, 'the escaped failure is durable on the job timeline')
    assert.match(traces[0]?.meta ?? '', /job_cancel_direct-cancel/, 'the trace names the job')
    assert.match(traces[0]?.meta ?? '', /Error/, 'the trace names the error class')

    jobs.notePostmortem = original
  } finally {
    await f.close()
  }
})
