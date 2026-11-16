import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { sha256Hex } from '../src/lib/secrets.js'
import type { InstanceManager } from '../src/flybot/instances.js'
import { flashOf, formBody, makeTerminalJob, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #691: a superadmin can preview and then confirm deletion of one account. The
// preview is read-only; the confirm needs CSRF, the exact login and a fresh
// GitHub confirmation, and it reuses #690's `purgeUserRows(id)` transaction after
// cancelling jobs, stopping instances and revoking tokens. A failure mid-way
// records which step failed and the same confirm can be re-run.

class FakeInstances {
  removed: string[] = []
  failure: string | null = null
  constructor(private readonly store: Store) {}

  async remove(repoId: string): Promise<void> {
    if (this.failure !== null) throw new Error(this.failure)
    this.removed.push(repoId)
    this.store.deleteRepoInstance(repoId)
  }

  async clearJobToken(): Promise<void> {}
}

async function build() {
  const config = testConfig()
  const store = new Store(':memory:')
  const instances = new FakeInstances(store)
  const built = await buildApp({
    config,
    store,
    mailer: new MemoryMailer(),
    runner: new MockRunner(),
    startScheduler: false,
    instances: instances as unknown as InstanceManager,
  })
  return { built, store, instances, config }
}

function seedTarget(
  store: Store,
  options: { login?: string; withActiveJob?: boolean } = {},
): { user: ReturnType<typeof makeUser>; repo: { id: string }; jobId: string } {
  const user = makeUser(store, { login: options.login ?? 'victim', status: 'approved' })
  const repo = store.createRepo({
    id: `repo_${user.id}`,
    userId: user.id,
    owner: 'octo',
    name: 'owned',
    defaultBranch: 'main',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  const done = makeTerminalJob(store, {
    id: `job_done_${user.id}`,
    repoId: repo.id,
    userId: user.id,
    trigger: 'manual',
    goal: 'g',
    callbackHash: 'cb',
    platformTokenHash: '',
  })
  if (options.withActiveJob !== false) {
    store.createJob({
      id: `job_live_${user.id}`,
      repoId: repo.id,
      userId: user.id,
      trigger: 'manual',
      goal: 'g',
      callbackHash: 'cb2',
      platformTokenHash: '',
    })
  }
  store.run(
    `INSERT INTO repo_instances (repo_id, user_id, container, network, data_dir, bridge_script, dsh_port, bridge_port, model_port, model_bind, image, status, created_at, updated_at)
     VALUES (?, ?, 'c', 'n', '/data/x', 'b', 1, 2, 3, '127.0.0.1', 'img', 'running', ?, ?)`,
    repo.id,
    user.id,
    new Date().toISOString(),
    new Date().toISOString(),
  )
  store.createApiToken({ id: `tok_${user.id}`, userId: user.id, kind: 'job', name: 'job:x', tokenHash: 'hash-x', prefix: 'flg_x', expiresAt: null })
  store.saveInstallation({ installationId: 42, userId: user.id, accountLogin: user.login, accountType: 'User' })
  store.recordUsage(user.id, done.id, 0.25, null, repo.id, { currency: 'CNY' })
  store.recordUsage(user.id, done.id, 0.5, null, repo.id, { currency: 'USD', known: false })
  return { user: store.userById(user.id)!, repo, jobId: done.id }
}

function clearRecentAuth(store: Store, raw: string): void {
  store.db.exec(`UPDATE sessions SET recent_auth_at = NULL WHERE id_hash = '${sha256Hex(raw)}'`)
}

function confirmPayload(csrf: string, login: string): string {
  return formBody({ csrf, confirmLogin: login })
}

test('only a superadmin may preview or confirm an account deletion', async () => {
  const { built, store } = await build()
  try {
    const victim = seedTarget(store).user
    for (const viewer of [makeUser(store, { login: 'plain', status: 'approved' }), makeUser(store, { login: 'admin-only', admin: true, status: 'approved' })]) {
      const { cookie, csrf } = sessionFor(built, viewer)
      const preview = await built.app.inject({ method: 'GET', url: `/admin/users/${victim.id}/delete`, headers: { cookie } })
      assert.equal(preview.statusCode, 403, `${viewer.login} must not preview a deletion`)
      const confirm = await built.app.inject({
        method: 'POST',
        url: `/admin/users/${victim.id}/delete`,
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: confirmPayload(csrf, victim.login),
      })
      assert.equal(confirm.statusCode, 403, `${viewer.login} must not confirm a deletion`)
    }
    assert.notEqual(store.userById(victim.id), undefined, 'a refused deletion must leave the account')
  } finally {
    await built.close()
  }
})

test('the preview is read-only and names what the confirm will remove', async () => {
  const { built, store, instances } = await build()
  try {
    const boss = makeUser(store, { login: 'root', superadmin: true, status: 'approved' })
    const { user: victim, repo } = seedTarget(store)
    sessionFor(built, victim) // a session row that the purge must take too
    const { cookie } = sessionFor(built, boss)
    const before = store.listAudit(100).length
    const page = await built.app.inject({ method: 'GET', url: `/admin/users/${victim.id}/delete`, headers: { cookie: `${cookie}; fledge_lang=en` } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /Delete account/)
    assert.match(page.body, /name="confirmLogin"/, 'the form must ask for the exact login')
    assert.match(page.body, /repositor/i)
    assert.match(page.body, /instances?/i)
    assert.match(page.body, /API tokens?/i)
    assert.match(page.body, /backup/i, 'the copy must warn about the backup window')
    assert.match(page.body, /victim/, 'the page must name the account')
    assert.equal(store.listAudit(100).length, before, 'preview must write nothing, not even an audit row')
    assert.notEqual(store.userById(victim.id), undefined)
    assert.notEqual(store.getRepo(repo.id), undefined)
    assert.deepEqual(instances.removed, [])
  } finally {
    await built.close()
  }
})

test('a stale session is refused with nothing deleted and no teardown', async () => {
  const { built, store, instances } = await build()
  try {
    const boss = makeUser(store, { login: 'root', superadmin: true, status: 'approved' })
    const { user: victim, repo } = seedTarget(store)
    const { raw, cookie, csrf } = sessionFor(built, boss)
    clearRecentAuth(store, raw)
    const refused = await built.app.inject({
      method: 'POST',
      url: `/admin/users/${victim.id}/delete`,
      headers: { cookie, referer: `http://127.0.0.1:9999/admin/users/${victim.id}/delete`, 'content-type': 'application/x-www-form-urlencoded' },
      payload: confirmPayload(csrf, victim.login),
    })
    assert.equal(refused.statusCode, 302)
    assert.match(String(refused.headers.location), /^\/auth\/github\/reauthorize\?next=/)
    const audit = store.listAudit(50).find((row) => row.action === 'recent_auth_required')
    assert.ok(audit !== undefined, 'the refusal must be audited')
    assert.match(String(audit.detail), /admin\.user\.delete/)
    assert.notEqual(store.userById(victim.id), undefined, 'a refused deletion must leave the account')
    assert.notEqual(store.getRepo(repo.id), undefined)
    assert.deepEqual(instances.removed, [], 'a refused deletion must not stop instances')
    assert.equal(store.listAudit(50).some((row) => row.action === 'admin.user.deleted'), false)
  } finally {
    await built.close()
  }
})

test('a fresh re-authentication does not turn an admin into a superadmin', async () => {
  const { built, store } = await build()
  try {
    const admin = makeUser(store, { login: 'admin-fresh', admin: true, status: 'approved' })
    const { user: victim } = seedTarget(store)
    const { cookie, csrf } = sessionFor(built, admin) // sessions start with a fresh confirmation
    const refused = await built.app.inject({
      method: 'POST',
      url: `/admin/users/${victim.id}/delete`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: confirmPayload(csrf, victim.login),
    })
    assert.equal(refused.statusCode, 403)
    assert.notEqual(store.userById(victim.id), undefined)
  } finally {
    await built.close()
  }
})

test('a wrong login or a self-deletion is rejected without changes', async () => {
  const { built, store, instances } = await build()
  try {
    const boss = makeUser(store, { login: 'root', superadmin: true, status: 'approved' })
    const { user: victim } = seedTarget(store)
    const bossSession = sessionFor(built, boss)
    const wrong = await built.app.inject({
      method: 'POST',
      url: `/admin/users/${victim.id}/delete`,
      headers: { cookie: bossSession.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: confirmPayload(bossSession.csrf, 'not-the-login'),
    })
    assert.equal(wrong.statusCode, 302)
    assert.match(String(flashOf(wrong)?.error?.text ?? ''), /GitHub/, 'the refusal must say the login is wrong')
    assert.notEqual(store.userById(victim.id), undefined)
    assert.deepEqual(instances.removed, [])
    const self = await built.app.inject({
      method: 'POST',
      url: `/admin/users/${boss.id}/delete`,
      headers: { cookie: bossSession.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: confirmPayload(bossSession.csrf, boss.login),
    })
    assert.equal(self.statusCode, 403)
    assert.notEqual(store.userById(boss.id), undefined)
  } finally {
    await built.close()
  }
})

test('confirm removes the account, its rows and its external resources, and records the spend without PII', async () => {
  const { built, store, instances } = await build()
  try {
    const boss = makeUser(store, { login: 'root', superadmin: true, status: 'approved' })
    const { user: victim, repo } = seedTarget(store)
    sessionFor(built, victim)
    const { cookie, csrf } = sessionFor(built, boss)
    const done = await built.app.inject({
      method: 'POST',
      url: `/admin/users/${victim.id}/delete`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: confirmPayload(csrf, victim.login),
    })
    assert.equal(done.statusCode, 302)
    assert.match(decodeURIComponent(String(done.headers.location)), /admin/)
    assert.equal(store.userById(victim.id), undefined, 'the account row must be gone')
    assert.equal(store.listRepos(victim.id).length, 0, 'its repositories must be gone')
    assert.equal(store.listJobsPageForUser(victim.id, 100, 0).length, 0, 'its jobs must be gone')
    assert.equal(store.listSessions(victim.id).length, 0, 'its sessions must be gone')
    assert.equal(store.listApiTokens(victim.id).length, 0, 'its tokens must be gone')
    assert.equal(store.listInstallations(victim.id).length, 0, 'its installation row must be gone')
    assert.deepEqual(instances.removed, [repo.id], 'the external instance must be torn down')
    assert.equal(store.listRepoInstances().filter((row) => row.user_id === victim.id).length, 0)

    const retention = store.listAudit(200).find((row) => row.action === 'admin.user.deleted')
    assert.ok(retention !== undefined, 'one retention row must be written')
    assert.equal(retention.user_id, null, 'the retention row must survive the account')
    const detail = String(retention.detail ?? '')
    const parsed = JSON.parse(detail) as { reason: string; operator: string; rows: Record<string, number>; spend: { buckets: Array<{ currency: string; amount: number; requests: number }>; unknownRequests: number } }
    assert.equal(parsed.reason, 'admin.deleted')
    assert.equal(parsed.operator, 'superadmin')
    assert.ok((parsed.rows.repos ?? 0) >= 1, 'the row counts must name the blast radius')
    const cny = parsed.spend.buckets.find((bucket) => bucket.currency === 'CNY')
    assert.ok(cny !== undefined, 'the spend must keep the CNY bucket')
    assert.equal(cny.amount, 0.25)
    assert.equal(cny.requests, 1)
    assert.equal(parsed.spend.unknownRequests, 1, 'the unpriced call count must survive')
    for (const secret of [victim.login, victim.id, '@example.com', 'hash-x', 'flg_x']) {
      assert.equal(detail.includes(secret), false, `the retention row must not carry ${secret}`)
    }
    const page = await built.app.inject({ method: 'GET', url: '/admin', headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.doesNotMatch(page.body, new RegExp(victim.login))
  } finally {
    await built.close()
  }
})

test('a failure mid-teardown is audited by step, the account stays visible, and the same confirm converges', async () => {
  const { built, store, instances } = await build()
  try {
    const boss = makeUser(store, { login: 'root', superadmin: true, status: 'approved' })
    const { user: victim, repo } = seedTarget(store)
    const { cookie, csrf } = sessionFor(built, boss)
    instances.failure = 'docker rm failed for /home/xuke/private/container'
    const failed = await built.app.inject({
      method: 'POST',
      url: `/admin/users/${victim.id}/delete`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: confirmPayload(csrf, victim.login),
    })
    assert.equal(failed.statusCode, 302)
    assert.match(String(flashOf(failed)?.error?.text ?? ''), /stop_instances|failed/i, 'the refusal must name the failed step')
    assert.notEqual(store.userById(victim.id), undefined, 'the account must stay visible after a failed teardown')
    const audit = store.listAudit(200).find((row) => row.action === 'admin.user.delete_failed')
    assert.ok(audit !== undefined, 'the failed step must be audited')
    const detail = String(audit.detail ?? '')
    assert.match(detail, /instances/, 'the audit row must name the failed step')
    for (const secret of [victim.login, '@example.com', 'hash-x', '/home/xuke/private']) {
      assert.equal(detail.includes(secret), false, `the failure row must not carry ${secret}`)
    }
    instances.failure = null
    const retried = await built.app.inject({
      method: 'POST',
      url: `/admin/users/${victim.id}/delete`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: confirmPayload(csrf, victim.login),
    })
    assert.equal(retried.statusCode, 302)
    assert.equal(store.userById(victim.id), undefined, 'the retried confirm must converge')
    assert.deepEqual(instances.removed, [repo.id])
  } finally {
    await built.close()
  }
})
