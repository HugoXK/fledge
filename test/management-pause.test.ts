import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import { buildApp, type BuiltApp } from '../src/app.js'
import { parseManagementService } from '../src/management/mode.js'
import { ManagementService } from '../src/management/service.js'
import { managementActor } from '../src/management/actor.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #540 slice 2: the pause form is an adapter over the same contract as cancel.
// The switch decides how far the adapter goes — `off` is today's route, `shadow`
// reserves and records the command but keeps today's execution, `on` runs it
// through the service. The last case is the reviewer's note: a receipt left
// `accepted` must not answer with "the cancel failed".

type Mode = 'off' | 'shadow' | 'on'

interface Fixture {
  built: BuiltApp
  user: ReturnType<typeof makeUser>
  repoId: string
  jobId: string
  close: () => Promise<void>
}

async function fixture(mode: Mode): Promise<Fixture> {
  const config = { ...testConfig(), managementService: mode }
  const store = new Store(':memory:')
  const built = await buildApp({
    config,
    store,
    mailer: new MemoryMailer(),
    runner: { name: 'capture', async run() { return { status: 'running' as const } } },
    startScheduler: false,
  })
  const user = makeUser(store, { login: `pause-${mode}`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_pause_${mode}`,
    userId: user.id,
    owner: 'o',
    name: 'pause',
    defaultBranch: 'main',
    tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey),
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  const job = store.createJob({ id: `job_pause_${mode}`, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: `cb-${mode}`, platformTokenHash: '' })
  return { built, user, repoId: repo.id, jobId: job.id, close: async () => { await built.close() } }
}

// The page renders several forms; the assertions below are about the pause one.
function formFor(html: string, action: string): string {
  const start = html.indexOf(`action="${action}"`)
  assert.notEqual(start, -1, `the page renders a form posting to ${action}`)
  const from = html.lastIndexOf('<form', start)
  const end = html.indexOf('</form>', start)
  return html.slice(from, end)
}

function pauseAction(f: Fixture): string {
  return `/repos/${f.repoId}/jobs/${f.jobId}/pause`
}

async function pausePost(f: Fixture, payload: Record<string, string>): Promise<{ statusCode: number; location: string }> {
  const session = sessionFor(f.built, f.user)
  const response = await f.built.app.inject({
    method: 'POST',
    url: pauseAction(f),
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: session.cookie },
    payload: formBody({ csrf: session.csrf, ...payload }),
  })
  return { statusCode: response.statusCode, location: String(response.headers.location) }
}

test('the pause form carries the revision it rendered and a fresh key', async () => {
  const f = await fixture('on')
  try {
    const session = sessionFor(f.built, f.user)
    const page = await f.built.app.inject({ method: 'GET', url: `/repos/${f.repoId}/jobs/${f.jobId}`, headers: { cookie: session.cookie } })
    assert.equal(page.statusCode, 200)
    const pauseForm = formFor(page.body, pauseAction(f))
    const revision = /name="expected_revision" value="(\d+)"/.exec(pauseForm)?.[1] ?? ''
    const key = /name="idempotency_key" value="([^"]+)"/.exec(pauseForm)?.[1] ?? ''
    assert.ok(Number(revision) >= 1, 'the pause form carries the revision the page rendered')
    assert.notEqual(key, '', 'the pause form carries an idempotency key')
  } finally {
    await f.close()
  }
})

test('off keeps today: a stale submit pauses the job and writes no receipt', async () => {
  const f = await fixture('off')
  try {
    const response = await pausePost(f, { expected_revision: '99', idempotency_key: 'off-stale' })
    assert.equal(response.statusCode, 302)
    assert.match(response.location, /notice=/)
    assert.equal(f.built.store.getJob(f.jobId)?.status, 'paused', 'off is the route that existed before this slice')
    assert.equal(f.built.store.listAudit(50).filter((row) => row.action === 'management.command').length, 0, 'off writes no receipt')
  } finally {
    await f.close()
  }
})

test('on refuses a stale pause and leaves the job alone', async () => {
  const f = await fixture('on')
  try {
    const response = await pausePost(f, { expected_revision: '99', idempotency_key: 'on-stale' })
    assert.equal(response.statusCode, 302)
    assert.match(response.location, /error=/)
    assert.match(response.location, /code=management_revision_conflict/)
    assert.equal(f.built.store.getJob(f.jobId)?.status, 'queued', 'a page that is out of date pauses nothing')
    assert.equal(f.built.store.listAudit(50).filter((row) => row.action === 'job.paused').length, 0)
  } finally {
    await f.close()
  }
})

test('on replays a double submit: one receipt, one pause', async () => {
  const f = await fixture('on')
  try {
    const first = await pausePost(f, { expected_revision: '1', idempotency_key: 'on-key' })
    assert.equal(first.statusCode, 302)
    assert.match(first.location, /notice=/)
    assert.equal(f.built.store.getJob(f.jobId)?.status, 'paused')

    const replay = await pausePost(f, { expected_revision: '1', idempotency_key: 'on-key' })
    assert.equal(replay.statusCode, 302)
    assert.match(replay.location, /notice=/)
    assert.equal(f.built.store.listAudit(50).filter((row) => row.action === 'job.paused').length, 1, 'the replay must not pause a second time')
    assert.equal(f.built.store.listAudit(50).filter((row) => row.action === 'management.command').length, 1, 'one command, one audit row')
  } finally {
    await f.close()
  }
})

test('shadow keeps today and records what the contract would have refused', async () => {
  const f = await fixture('shadow')
  try {
    // The job finished after the page was rendered: the contract refuses, and
    // today's route refuses too — same sentence, and the receipt records why.
    f.built.store.updateJob(f.jobId, { status: 'succeeded', finished_at: new Date().toISOString() })
    const response = await pausePost(f, { expected_revision: '1', idempotency_key: 'shadow-finished' })
    assert.equal(response.statusCode, 302)
    assert.match(response.location, /error=/, 'shadow keeps the route a person already knows')
    const receipts = f.built.store.listCommandReceipts(50).filter((row) => row.operation === 'task.pause')
    assert.equal(receipts.length, 1, 'shadow still records the command it would have run')
    const receipt = receipts[0]
    assert.notEqual(receipt, undefined)
    if (receipt === undefined) return
    assert.equal(receipt.status, 'failed')
    assert.equal(receipt.error_code, 'job_not_pausable')
    assert.equal(f.built.store.listAudit(50).filter((row) => row.action === 'job.paused').length, 0)
  } finally {
    await f.close()
  }
})

test('an in-progress receipt says it is still processing, never "the cancel failed"', async () => {
  const f = await fixture('off')
  try {
    // A crash between `begin` and `complete` leaves the receipt `accepted`; the
    // page is resubmitted with the same key and must not claim the cancel failed.
    const service = new ManagementService(f.built.store, f.built.jobs)
    const repo = f.built.store.getRepo(f.repoId)
    assert.notEqual(repo, undefined)
    if (repo === undefined) return
    const begun = service.begin(managementActor({ userId: f.user.id, repo, channel: 'web', requestId: 'req-in-progress' }), {
      operation: 'task.cancel',
      target: { projectId: f.repoId, jobId: f.jobId },
      arguments: {},
      expectedRevision: 1,
      idempotencyKey: 'in-progress-key',
    })
    assert.equal(begun.ok, true)

    const session = sessionFor(f.built, f.user)
    const response = await f.built.app.inject({
      method: 'POST',
      url: `/repos/${f.repoId}/jobs/${f.jobId}/cancel`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: session.cookie },
      payload: formBody({ csrf: session.csrf, expected_revision: 1, idempotency_key: 'in-progress-key' }),
    })
    assert.equal(response.statusCode, 302)
    const location = String(response.headers.location)
    assert.doesNotMatch(location, /notice=/, 'nothing was cancelled, so nothing may say it was')
    assert.match(location, /code=command_in_progress/)
    assert.match(decodeURIComponent(location), /还在处理中/, 'the person is told the action is still running')
    assert.doesNotMatch(decodeURIComponent(location), /取消失败/, 'and not that the cancel failed')
  } finally {
    await f.close()
  }
})

test('the mode parser defaults to off and never guesses', () => {
  assert.equal(parseManagementService(''), 'off')
  assert.equal(parseManagementService('off'), 'off')
  assert.equal(parseManagementService('shadow'), 'shadow')
  assert.equal(parseManagementService('on'), 'on')
  assert.equal(parseManagementService(' ON '), 'on')
  assert.equal(parseManagementService('enabled'), 'off', 'an unknown value is today, never a guess')
})

test('a pause commits the job and its receipt together, or neither lands', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' as const } } }, new MemoryMailer())
  const user = makeUser(store, { login: 'atomic-pause', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_atomic',
    userId: user.id,
    owner: 'o',
    name: 'atomic',
    defaultBranch: 'main',
    tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey),
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  const job = store.createJob({ id: 'job_atomic', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb-atomic', platformTokenHash: '' })
  const service = new ManagementService(store, jobs)
  const actor = managementActor({ userId: user.id, repo, channel: 'web', requestId: 'req-atomic' })

  // The receipt write is the last statement of the command transaction, so a
  // failure there is the crash the reviewer measured on the cancel path: with the
  // effect committed first, the job would stay paused while the receipt said
  // `accepted`. Here the effect must roll back with it.
  const original = store.updateCommandReceipt.bind(store)
  store.updateCommandReceipt = ((id: string, patch: Parameters<typeof original>[1]) => {
    if (patch.status === 'succeeded') throw new Error('the commit failed')
    return original(id, patch)
  }) as typeof store.updateCommandReceipt

  await assert.rejects(() => service.run(actor, {
    operation: 'task.pause',
    target: { projectId: repo.id, jobId: job.id },
    arguments: {},
    expectedRevision: 1,
    idempotencyKey: 'atomic-key',
  }))

  assert.equal(store.getJob(job.id)?.status, 'queued', 'the pause rolled back with the receipt')
  const receipts = store.listCommandReceipts(50).filter((row) => row.operation === 'task.pause')
  assert.equal(receipts.length, 1)
  const receipt = receipts[0]
  assert.notEqual(receipt, undefined)
  if (receipt === undefined) return
  assert.equal(receipt.status, 'accepted', 'the receipt says what is true: nothing landed')
  assert.equal(store.revisionOf('job', job.id), 1, 'and the revision did not move')
})
