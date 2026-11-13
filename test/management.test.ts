import test from 'node:test'
import assert from 'node:assert/strict'
import { Store, type JobRow, type RepoRow } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import { buildApp } from '../src/app.js'
import { managementActor, type ActorContext } from '../src/management/actor.js'
import { ManagementService, type CommandEnvelope } from '../src/management/service.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #540, smallest slice: one ManagementService, one command (`task.cancel`), a
// persisted receipt and a revision fence. The job cancel form is the adapter, so
// every case below is reachable from the page a person actually uses.

function harness(): { store: Store; jobs: Jobs; service: ManagementService; user: RepoRow['user_id']; repo: RepoRow } {
  const config = testConfig()
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' as const } } }, new MemoryMailer())
  const user = makeUser(store, { login: 'management-user', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_management',
    userId: user.id,
    owner: 'o',
    name: 'r',
    defaultBranch: 'main',
    tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey),
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  return { store, jobs, service: new ManagementService(store, jobs), user: user.id, repo }
}

function queuedJob(store: Store, userId: string, repoId: string, id = 'job_management'): JobRow {
  return store.createJob({ id, repoId, userId, trigger: 'manual', goal: 'g', callbackHash: `cb-${id}`, platformTokenHash: '' })
}

function envelope(overrides: Partial<CommandEnvelope> = {}): CommandEnvelope {
  return {
    operation: 'task.cancel',
    target: { projectId: 'repo_management', jobId: 'job_management' },
    arguments: {},
    expectedRevision: 1,
    idempotencyKey: 'key-1',
    ...overrides,
  }
}

function actorFor(actor: ActorContext, store: Store, repo: RepoRow): ActorContext {
  return managementActor({ userId: actor.principalId, repo, channel: 'web', requestId: actor.requestId })
}

test('the same key and arguments return the same receipt and cancel the job once', async () => {
  const h = harness()
  try {
    queuedJob(h.store, h.user, h.repo.id)
    const actor = managementActor({ userId: h.user, repo: h.repo, channel: 'web', requestId: 'req-1' })
    const first = await h.service.run(actor, envelope())
    assert.equal(first.ok, true)
    if (!first.ok) return
    assert.equal(first.receipt.status, 'succeeded')
    assert.equal(first.receipt.operation, 'task.cancel')
    assert.equal(h.store.getJob('job_management')?.status, 'cancelled')

    const replay = await h.service.run(actor, envelope())
    assert.equal(replay.ok, true)
    if (!replay.ok) return
    assert.equal(replay.receipt.id, first.receipt.id, 'the same key returns the same receipt')
    assert.equal(replay.replayed, true)
    const cancels = h.store.listAudit(50).filter((row) => row.action === 'job.cancelled')
    assert.equal(cancels.length, 1, 'a replay must not cancel a second time')
    const receipts = h.store.listAudit(50).filter((row) => row.action === 'management.command')
    assert.equal(receipts.length, 1, 'one receipt, one audit row')
  } finally {
    h.store.close()
  }
})

test('the same key with different arguments is refused as idempotency_conflict', async () => {
  const h = harness()
  try {
    queuedJob(h.store, h.user, h.repo.id)
    const actor = managementActor({ userId: h.user, repo: h.repo, channel: 'web', requestId: 'req-2' })
    const first = await h.service.run(actor, envelope())
    assert.equal(first.ok, true)
    const second = await h.service.run(actor, envelope({ arguments: { reason: 'a different instruction' } }))
    assert.equal(second.ok, false)
    if (second.ok) return
    assert.equal(second.code, 'idempotency_conflict')
    assert.equal(h.store.getJob('job_management')?.status, 'cancelled')
    const receipts = h.store.listAudit(50).filter((row) => row.action === 'management.command')
    assert.equal(receipts.length, 1, 'the conflicting call writes no receipt')
  } finally {
    h.store.close()
  }
})

test('a stale expected revision is refused and writes nothing', async () => {
  const h = harness()
  try {
    queuedJob(h.store, h.user, h.repo.id)
    const actor = managementActor({ userId: h.user, repo: h.repo, channel: 'web', requestId: 'req-3' })
    // Someone else moved the job on after this page was rendered.
    h.store.bumpRevision('job', 'job_management')
    const stale = await h.service.run(actor, envelope({ expectedRevision: 1 }))
    assert.equal(stale.ok, false)
    if (stale.ok) return
    assert.equal(stale.code, 'management_revision_conflict')
    assert.equal(h.store.getJob('job_management')?.status, 'queued', 'the job is untouched')
    assert.equal(h.store.listCommandReceipts(50).length, 0)
    const receipts = h.store.listAudit(50).filter((row) => row.action === 'management.command')
    assert.equal(receipts.length, 0, 'a revision conflict writes no receipt')
  } finally {
    h.store.close()
  }
})

test('a command whose authorization was revoked after acceptance fails before the business write', async () => {
  const h = harness()
  try {
    queuedJob(h.store, h.user, h.repo.id)
    const actor = managementActor({ userId: h.user, repo: h.repo, channel: 'web', requestId: 'req-4' })
    const begun = h.service.begin(actor, envelope({ idempotencyKey: 'key-revoked' }))
    assert.equal(begun.ok, true)
    if (!begun.ok) return
    assert.equal(begun.receipt.status, 'accepted')
    // The repository changes hands between acceptance and execution.
    const other = makeUser(h.store, { login: 'management-other', status: 'approved' })
    h.store.run('UPDATE repos SET user_id = ? WHERE id = ?', other.id, h.repo.id)
    const done = await h.service.complete(begun.receipt.id)
    assert.equal(done.ok, false)
    if (done.ok) return
    assert.equal(done.code, 'authorization_revoked')
    assert.equal(h.store.getJob('job_management')?.status, 'queued', 'no business write after the loss')
    assert.equal(h.store.commandReceipt(begun.receipt.id)?.status, 'failed')
  } finally {
    h.store.close()
  }
})

test('a client-supplied actor, tenant or capability is rejected, never the execution identity', async () => {
  const h = harness()
  try {
    queuedJob(h.store, h.user, h.repo.id)
    const actor = managementActor({ userId: h.user, repo: h.repo, channel: 'web', requestId: 'req-5' })
    for (const injected of [{ actor: { principalId: 'someone-else' } }, { tenant_id: 'other-tenant' }, { capabilities: ['job.cancel', 'repo.delete'] }]) {
      const result = await h.service.run(actor, envelope({ idempotencyKey: `key-inject-${Object.keys(injected)[0]}`, arguments: injected }))
      assert.equal(result.ok, false, `an argument named ${Object.keys(injected)[0]} must be refused`)
      if (result.ok) return
      assert.equal(result.code, 'actor_not_allowed')
    }
    assert.equal(h.store.getJob('job_management')?.status, 'queued', 'nothing ran under a supplied identity')
  } finally {
    h.store.close()
  }
})

test('an operation outside the closed catalog is refused', async () => {
  const h = harness()
  try {
    queuedJob(h.store, h.user, h.repo.id)
    const actor = managementActor({ userId: h.user, repo: h.repo, channel: 'web', requestId: 'req-6' })
    const result = await h.service.run(actor, envelope({ operation: 'sql.exec', idempotencyKey: 'key-unknown' }))
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'unknown_operation')
    assert.equal(h.store.getJob('job_management')?.status, 'queued')
  } finally {
    h.store.close()
  }
})

// The form route is only an adapter: the page hands over the revision and the
// key, and the receipt decides what the redirect says. A double submit must not
// cancel twice, and a stale page must not cancel at all.
test('the cancel form is an adapter: a replay cancels once and a stale page cancels nothing', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: { name: 'capture', async run() { return { status: 'running' as const } } }, startScheduler: false })
  try {
    const user = makeUser(store, { login: 'form-user', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_form',
      userId: user.id,
      owner: 'o',
      name: 'form',
      defaultBranch: 'main',
      tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey),
      permission: 'admin',
      repoRole: 'maintainer',
      goal: '',
      autoIterate: false,
      intervalMinutes: 1440,
    })
    const job = store.createJob({ id: 'job_form', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb-form', platformTokenHash: '' })
    const session = sessionFor(built, user)
    const headers = { 'content-type': 'application/x-www-form-urlencoded', cookie: session.cookie }

    const page = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/jobs/${job.id}`, headers: { cookie: session.cookie } })
    assert.equal(page.statusCode, 200)
    const revision = Number(/name="expected_revision" value="(\d+)"/.exec(page.body)?.[1] ?? '0')
    const key = /name="idempotency_key" value="([^"]+)"/.exec(page.body)?.[1] ?? ''
    assert.ok(revision >= 1, 'the page carries the revision it rendered')
    assert.notEqual(key, '', 'the page carries an idempotency key')

    const body = formBody({ csrf: session.csrf, expected_revision: revision, idempotency_key: key })
    const first = await built.app.inject({ method: 'POST', url: `/repos/${repo.id}/jobs/${job.id}/cancel`, headers, payload: body })
    assert.equal(first.statusCode, 302)
    assert.match(String(first.headers.location), /notice=/)
    assert.equal(store.getJob(job.id)?.status, 'cancelled')

    const replay = await built.app.inject({ method: 'POST', url: `/repos/${repo.id}/jobs/${job.id}/cancel`, headers, payload: body })
    assert.equal(replay.statusCode, 302)
    assert.match(String(replay.headers.location), /notice=/)
    assert.equal(store.listAudit(50).filter((row) => row.action === 'job.cancelled').length, 1)

    // A page that is one revision old: the same form, a stale number, writes nothing.
    const second = store.createJob({ id: 'job_form_2', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g2', callbackHash: 'cb-form-2', platformTokenHash: '' })
    const stale = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/jobs/${second.id}/cancel`,
      headers,
      payload: formBody({ csrf: session.csrf, expected_revision: 99, idempotency_key: 'stale-key' }),
    })
    assert.equal(stale.statusCode, 302)
    assert.match(String(stale.headers.location), /error=/)
    assert.equal(store.getJob(second.id)?.status, 'queued', 'a stale page leaves the job alone')
  } finally {
    await built.close()
  }
})
