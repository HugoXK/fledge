import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import type { JobRow } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import { buildApp, type BuiltApp } from '../src/app.js'
import { ManagementService } from '../src/management/service.js'
import { managementActor } from '../src/management/actor.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #540 slice 2 (rest): `task.create`, `task.resume` and `task.retry` are commands
// like `task.cancel` and `task.pause`. The red half is measured at `0ca49ff0`:
// the console forms carry no revision and no key, the same key submitted twice is
// not replayed, a stale revision still writes, and none of the three operations
// exists in the catalog.

interface Fixture {
  built: BuiltApp
  user: ReturnType<typeof makeUser>
  repoId: string
  close: () => Promise<void>
}

let fixtureSeq = 0

async function fixture(options: { repoRole?: string } = {}): Promise<Fixture> {
  fixtureSeq += 1
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({
    config,
    store,
    mailer: new MemoryMailer(),
    runner: { name: 'capture', async run() { return { status: 'running' as const } } },
    startScheduler: false,
  })
  const user = makeUser(store, { login: `task-create-${fixtureSeq}`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_task_${fixtureSeq}`,
    userId: user.id,
    owner: 'o',
    name: `task-${fixtureSeq}`,
    defaultBranch: 'main',
    tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey),
    permission: 'admin',
    repoRole: options.repoRole ?? 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  return { built, user, repoId: repo.id, close: async () => { await built.close() } }
}

function jobIn(f: Fixture, status: 'failed' | 'paused', id: string): JobRow {
  const job = f.built.store.createJob({
    id,
    repoId: f.repoId,
    userId: f.user.id,
    trigger: 'manual',
    goal: 'g',
    callbackHash: `cb-${id}`,
    platformTokenHash: '',
  })
  f.built.store.updateJob(job.id, { status, finished_at: status === 'failed' ? new Date().toISOString() : null })
  return f.built.store.getJob(id) as JobRow
}

// The page renders several forms; the assertions below are about one of them.
function formFor(html: string, action: string): string {
  const start = html.indexOf(`action="${action}"`)
  assert.notEqual(start, -1, `the page renders a form posting to ${action}`)
  const from = html.lastIndexOf('<form', start)
  const end = html.indexOf('</form>', start)
  return html.slice(from, end)
}

function hiddenValue(form: string, name: string): string | null {
  const marker = `name="${name}" value="`
  const at = form.indexOf(marker)
  if (at === -1) return null
  const start = at + marker.length
  const end = form.indexOf('"', start)
  return end === -1 ? null : form.slice(start, end)
}

async function page(f: Fixture, url: string): Promise<string> {
  const session = sessionFor(f.built, f.user)
  const response = await f.built.app.inject({ method: 'GET', url, headers: { cookie: session.cookie } })
  assert.equal(response.statusCode, 200, `GET ${url} answered 200`)
  return response.body
}

async function post(f: Fixture, url: string, payload: Record<string, string>): Promise<{ statusCode: number; location: string }> {
  const session = sessionFor(f.built, f.user)
  const response = await f.built.app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: session.cookie },
    payload: formBody({ csrf: session.csrf, ...payload }),
  })
  return { statusCode: response.statusCode, location: String(response.headers.location) }
}

function jobCount(f: Fixture): number {
  return f.built.store.listJobsForRepo(f.repoId, 100).length
}

test('the console create forms carry the revision they rendered and a fresh key', async () => {
  const f = await fixture()
  try {
    const html = await page(f, `/repos/${f.repoId}`)
    for (const action of ['run', 'plan', 'triage']) {
      const form = formFor(html, `/repos/${f.repoId}/${action}`)
      assert.equal(hiddenValue(form, 'expected_revision'), '1', `the ${action} form carries the project revision`)
      const key = hiddenValue(form, 'idempotency_key')
      assert.notEqual(key, null, `the ${action} form carries an idempotency key`)
      assert.ok(key!.startsWith('cmd_'), `the ${action} key is a command key: ${key}`)
    }
  } finally {
    await f.close()
  }
})

test('the job page retry and resume forms carry the revision and the key', async () => {
  const f = await fixture()
  try {
    const failed = jobIn(f, 'failed', 'job_task_failed_fields')
    const failedPage = await page(f, `/repos/${f.repoId}/jobs/${failed.id}`)
    const retry = formFor(failedPage, `/repos/${f.repoId}/jobs/${failed.id}/retry`)
    assert.equal(hiddenValue(retry, 'expected_revision'), '1', 'the retry form carries the job revision')
    assert.ok((hiddenValue(retry, 'idempotency_key') ?? '').startsWith('cmd_'), 'the retry form carries a command key')

    const paused = jobIn(f, 'paused', 'job_task_paused_fields')
    const pausedPage = await page(f, `/repos/${f.repoId}/jobs/${paused.id}`)
    const resume = formFor(pausedPage, `/repos/${f.repoId}/jobs/${paused.id}/resume`)
    assert.equal(hiddenValue(resume, 'expected_revision'), '1', 'the resume form carries the job revision')
    assert.ok((hiddenValue(resume, 'idempotency_key') ?? '').startsWith('cmd_'), 'the resume form carries a command key')
  } finally {
    await f.close()
  }
})

test('submitting the same retry twice queues one job and answers the same job', async () => {
  const f = await fixture()
  try {
    const job = jobIn(f, 'failed', 'job_task_retry')
    const payload = { expected_revision: '1', idempotency_key: 'cmd_retry_once' }
    const first = await post(f, `/repos/${f.repoId}/jobs/${job.id}/retry`, payload)
    assert.ok(first.location.includes('notice='), `the first retry answers with a notice: ${first.location}`)
    assert.equal(jobCount(f), 2, 'the retry queued exactly one job')
    const second = await post(f, `/repos/${f.repoId}/jobs/${job.id}/retry`, payload)
    assert.ok(second.location.includes('notice='), `the second retry replays the receipt, not a refusal: ${second.location}`)
    assert.equal(second.location, first.location, 'the same job is named')
    assert.equal(jobCount(f), 2, 'the second submit queued nothing')
  } finally {
    await f.close()
  }
})

test('a stale revision on retry is refused and queues nothing', async () => {
  const f = await fixture()
  try {
    const job = jobIn(f, 'failed', 'job_task_retry_stale')
    const outcome = await post(f, `/repos/${f.repoId}/jobs/${job.id}/retry`, { expected_revision: '9', idempotency_key: 'cmd_retry_stale' })
    assert.ok(outcome.location.includes('code=management_revision_conflict'), `the stale retry is a conflict: ${outcome.location}`)
    assert.equal(jobCount(f), 1, 'nothing was queued')
  } finally {
    await f.close()
  }
})

test('submitting the same resume twice names one new job', async () => {
  const f = await fixture()
  try {
    const job = jobIn(f, 'paused', 'job_task_resume')
    const payload = { expected_revision: '1', idempotency_key: 'cmd_resume_once' }
    const first = await post(f, `/repos/${f.repoId}/jobs/${job.id}/resume`, payload)
    assert.ok(first.location.includes('notice='), `the first resume answers with a notice: ${first.location}`)
    assert.equal(jobCount(f), 2, 'the resume queued exactly one job')
    const second = await post(f, `/repos/${f.repoId}/jobs/${job.id}/resume`, payload)
    assert.ok(second.location.includes('notice='), `the second resume replays the receipt: ${second.location}`)
    assert.equal(second.location, first.location, 'the same new job is named')
    assert.equal(jobCount(f), 2, 'the second submit queued nothing')
  } finally {
    await f.close()
  }
})

test('a stale revision on resume is refused and queues nothing', async () => {
  const f = await fixture()
  try {
    const job = jobIn(f, 'paused', 'job_task_resume_stale')
    const outcome = await post(f, `/repos/${f.repoId}/jobs/${job.id}/resume`, { expected_revision: '9', idempotency_key: 'cmd_resume_stale' })
    assert.ok(outcome.location.includes('code=management_revision_conflict'), `the stale resume is a conflict: ${outcome.location}`)
    assert.equal(jobCount(f), 1, 'nothing was queued')
  } finally {
    await f.close()
  }
})

test('submitting the same create twice queues one job and records one receipt', async () => {
  const f = await fixture()
  try {
    const payload = { expected_revision: '1', idempotency_key: 'cmd_create_once' }
    const first = await post(f, `/repos/${f.repoId}/run`, payload)
    assert.ok(first.location.includes('notice='), `the first create answers with a notice: ${first.location}`)
    assert.equal(jobCount(f), 1, 'the create queued one job')
    const second = await post(f, `/repos/${f.repoId}/run`, payload)
    assert.ok(second.location.includes('notice='), `the second create replays the receipt: ${second.location}`)
    assert.equal(jobCount(f), 1, 'the second submit queued nothing')
    const receipts = f.built.store.listCommandReceipts(50).filter((row) => row.operation === 'task.create')
    assert.equal(receipts.length, 1, 'one receipt for one create')
    assert.equal(receipts[0]?.status, 'succeeded')
  } finally {
    await f.close()
  }
})

test('a stale revision on create is refused and queues nothing', async () => {
  const f = await fixture()
  try {
    const outcome = await post(f, `/repos/${f.repoId}/run`, { expected_revision: '9', idempotency_key: 'cmd_create_stale' })
    assert.ok(outcome.location.includes('code=management_revision_conflict'), `the stale create is a conflict: ${outcome.location}`)
    assert.equal(jobCount(f), 0, 'nothing was queued')
  } finally {
    await f.close()
  }
})

test('a create refusal is recorded with its code so the banner can translate it', async () => {
  const f = await fixture()
  try {
    f.built.store.updateRepo(f.repoId, { enabled: 0 })
    const outcome = await post(f, `/repos/${f.repoId}/run`, { expected_revision: '1', idempotency_key: 'cmd_create_refused' })
    assert.ok(outcome.location.includes('REPO_DISABLED'), `the banner value names the refusal code: ${outcome.location}`)
    const receipts = f.built.store.listCommandReceipts(50).filter((row) => row.operation === 'task.create')
    assert.equal(receipts.length, 1)
    assert.equal(receipts[0]?.status, 'failed')
    assert.equal(receipts[0]?.error_code, 'REPO_DISABLED')
  } finally {
    await f.close()
  }
})

test('the catalog closes over the three new commands', async () => {
  const { operationNames } = await import('../src/management/catalog.js')
  assert.deepEqual(operationNames().sort(), ['task.cancel', 'task.create', 'task.pause', 'task.resume', 'task.retry'])
})

test('a caller cannot put an identity field into a create command', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const user = makeUser(store, { login: 'task-actor', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_task_actor', userId: user.id, owner: 'o', name: 'actor', defaultBranch: 'main',
    tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer',
    goal: '', autoIterate: false, intervalMinutes: 1440,
  })
  const jobs = new Jobs(store, config, { name: 'capture', async run() { return { status: 'running' as const } } }, new MemoryMailer())
  const management = new ManagementService(store, jobs)
  try {
    const actor = managementActor({ userId: user.id, repo, channel: 'web', requestId: 'r1' })
    const begun = management.begin(actor, {
      operation: 'task.create',
      target: { projectId: repo.id },
      arguments: { kind: 'iterate', user_id: user.id },
      expectedRevision: 1,
      idempotencyKey: 'cmd_actor',
    })
    assert.equal(begun.ok, false)
    if (!begun.ok) assert.equal(begun.code, 'actor_not_allowed')
  } finally {
    store.close()
  }
})
