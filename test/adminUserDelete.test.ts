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
    // #841: the teardown never calls GitHub, so the preview must not claim the
    // installation is removed. The row names Fledge's own record, and one
    // sentence says the GitHub App installation survives and where it is revoked.
    assert.match(page.body, /GitHub installation records/, 'the row must name Fledge\'s own record')
    assert.doesNotMatch(page.body, /GitHub installations/, 'the row must not promise to remove the GitHub install')
    assert.match(page.body, /does not uninstall the GitHub App/, 'the preview must say the GitHub side survives')
    assert.match(page.body, /Installed GitHub Apps/, 'the preview must name where the operator removes it')
    const zhPreview = await built.app.inject({ method: 'GET', url: `/admin/users/${victim.id}/delete`, headers: { cookie: `${cookie}; fledge_lang=zh` } })
    assert.equal(zhPreview.statusCode, 200)
    assert.match(zhPreview.body, /GitHub 安装记录/, 'the zh row must name Fledge\'s own record')
    assert.match(zhPreview.body, /不会卸载 GitHub App/, 'the zh preview must say the GitHub side survives')
    assert.match(zhPreview.body, /Installed GitHub Apps/, 'the zh preview must name where the operator removes it')
    assert.equal(store.listAudit(100).length, before, 'preview must write nothing, not even an audit row')
    for (const lang of ['en', 'zh']) {
      const support = await built.app.inject({ method: 'GET', url: `/admin/users/${victim.id}`, headers: { cookie: `${cookie}; fledge_lang=${lang}` } })
      assert.equal(support.statusCode, 200)
      assert.match(support.body, /does not uninstall the GitHub App|不会卸载 GitHub App/, `the support view (${lang}) must not promise the GitHub-side removal`)
      assert.match(support.body, /Installed GitHub Apps/, `the support view (${lang}) must name where the operator removes it`)
    }
    const bare = makeUser(store, { login: 'bare', status: 'approved' })
    const barePreview = await built.app.inject({ method: 'GET', url: `/admin/users/${bare.id}/delete`, headers: { cookie: `${cookie}; fledge_lang=en` } })
    assert.equal(barePreview.statusCode, 200)
    assert.match(barePreview.body, /installation records/, 'the empty-state sentence must match the new row label')
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

// #846: `error_reports` and `feedback_triage` point at the account with
// `ON DELETE SET NULL`, so neither the cascade nor a purge that only relied on it
// could reach them. The delete preview counts them and the purge takes them, so
// the retention row says what actually went.
function seedFeedbackSurvivors(store: Store, userId: string, login: string): { feedbackId: string; ref: string } {
  const feedback = store.createFeedback({ id: 'fb_846', userId, kind: 'feedback', message: 'the console broke', page: '/console' })
  const report = store.createErrorReport({
    ref: 'err_846',
    user_id: userId,
    user_login: login,
    method: 'GET',
    path: '/console',
    status_code: 500,
    error_name: 'Error',
    error_message: 'boom',
    error_stack: 'at handler',
    build_version: '0.0.0',
    build_commit: 'c',
  })
  store.createFeedbackTriage({ ref: 'err_846', userId, userLogin: login, kind: 'error', publishConsent: false })
  store.addFeedbackEvent('err_846', 'new')
  return { feedbackId: feedback.id, ref: report.ref }
}

test('the delete preview counts the error reports and triage rows the cascade cannot reach', async () => {
  const { built, store } = await build()
  try {
    const boss = makeUser(store, { login: 'root', superadmin: true, status: 'approved' })
    const { user: victim } = seedTarget(store)
    seedFeedbackSurvivors(store, victim.id, victim.login)
    const { cookie } = sessionFor(built, boss)
    const preview = await built.app.inject({ method: 'GET', url: `/admin/users/${victim.id}/delete`, headers: { cookie: `${cookie}; fledge_lang=en` } })
    assert.equal(preview.statusCode, 200)
    assert.match(preview.body, /Error reports<\/td><td data-label="Count"><strong>1<\/strong>/, 'the preview must count the seeded error report')
    assert.match(preview.body, /Feedback triage records<\/td><td data-label="Count"><strong>1<\/strong>/, 'the preview must count the seeded triage row')
  } finally {
    await built.close()
  }
})

test('the purge takes the error reports and triage rows the cascade cannot reach', async () => {
  const { built, store } = await build()
  try {
    const boss = makeUser(store, { login: 'root', superadmin: true, status: 'approved' })
    const { user: victim } = seedTarget(store)
    const seeded = seedFeedbackSurvivors(store, victim.id, victim.login)
    const { cookie, csrf } = sessionFor(built, boss)
    const done = await built.app.inject({
      method: 'POST',
      url: `/admin/users/${victim.id}/delete`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: confirmPayload(csrf, victim.login),
    })
    assert.equal(done.statusCode, 302)
    assert.equal(store.errorReportByRef(seeded.ref), undefined, 'the error report outlived the account')
    assert.equal(store.feedbackTriageByRef(seeded.ref), undefined, 'the triage row outlived the account')
    assert.equal(store.listFeedbackEvents(seeded.ref).length, 0, 'the triage events must go with the triage row')
    assert.equal(store.feedbackById(seeded.feedbackId), undefined, 'the cascade on feedback must keep working')

    const retention = store.listAudit(200).find((row) => row.action === 'admin.user.deleted')
    assert.ok(retention !== undefined, 'one retention row must be written')
    const parsed = JSON.parse(String(retention.detail ?? '')) as { rows: Record<string, number> }
    assert.equal(parsed.rows.error_reports, 1, 'the retention row must count the error report it removed')
    assert.equal(parsed.rows.feedback_triage, 1, 'the retention row must count the triage row it removed')
    const left = store.all<{ n: number }>('SELECT COUNT(*) AS n FROM error_reports WHERE user_login = ?', victim.login)
    assert.equal(Number(left[0]?.n ?? 0), 0, 'a row still names the deleted login')
    const triageLeft = store.all<{ n: number }>('SELECT COUNT(*) AS n FROM feedback_triage WHERE user_login = ?', victim.login)
    assert.equal(Number(triageLeft[0]?.n ?? 0), 0, 'a triage row still names the deleted login')
  } finally {
    await built.close()
  }
})
