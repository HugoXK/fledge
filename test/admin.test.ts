import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { formBody, makeTerminalJob, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

test('admin jobs and audit paginate at ten rows with friendly audit labels', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const admin = makeUser(store, { login: 'boss', admin: true })
    const repo = store.createRepo({
      id: 'repo_admin',
      userId: admin.id,
      owner: 'octo',
      name: 'demo',
      defaultBranch: 'main',
      tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer',
      goal: '',
      autoIterate: false,
      intervalMinutes: 1440,
    })
    for (let i = 0; i < 12; i += 1) {
      makeTerminalJob(store, { id: `job_admin_${i}`, repoId: repo.id, userId: admin.id, trigger: 'manual', goal: 'goal', callbackHash: `hash-${i}`, platformTokenHash: '', kind: i % 2 === 0 ? 'iterate' : 'review' })
      store.audit(admin.id, i % 2 === 0 ? 'token.created' : 'token.revoked', i % 2 === 0 ? 'flybot-cli' : null)
    }
    const { cookie } = sessionFor(built, admin)
    const page = await built.app.inject({ method: 'GET', url: '/admin?jobsPage=2&auditPage=2', headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /2 \/ 2 · 12/)
    assert.match(page.body, /创建 token/)
    assert.match(page.body, /撤销 token/)
    assert.match(page.body, /flybot-cli/)
    assert.match(page.body, /@boss/)
    assert.match(page.body, /每页 10 条/)
    assert.doesNotMatch(page.body, /onsubmit=|onclick=/)
  } finally {
    await built.close()
  }
})

test('rejecting a user cancels active jobs and frees the global slot', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const admin = makeUser(store, { login: 'reject-admin', admin: true, status: 'approved' })
    const target = makeUser(store, { login: 'reject-target', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_reject_target', userId: target.id, owner: 'o', name: 'rt', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.createApiToken({ id: 'tok_reject', userId: target.id, kind: 'job', name: 'job:job_reject', tokenHash: 'reject-hash', prefix: 'flg_reje', expiresAt: null })
    store.createJob({ id: 'job_reject', repoId: repo.id, userId: target.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: 'reject-hash' })
    store.updateJob('job_reject', { status: 'running' })
    assert.equal(store.countActiveJobs(), 1)
    const { cookie, csrf } = sessionFor(built, admin)
    const rejected = await built.app.inject({
      method: 'POST',
      url: `/admin/users/${target.id}/reject`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf }),
    })
    assert.equal(rejected.statusCode, 302)
    assert.equal(store.countActiveJobs(), 0)
    assert.equal(store.getJob('job_reject')?.status, 'failed')
    assert.equal(store.findApiToken('reject-hash'), undefined)
  } finally {
    await built.close()
  }
})

test('admin management is scoped and only the owner can promote admins or set unlimited', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const owner = makeUser(store, { login: 'owner', superadmin: true, status: 'approved' })
    const admin = makeUser(store, { login: 'admin-a', admin: true, status: 'approved' })
    const otherAdmin = makeUser(store, { login: 'admin-b', admin: true, status: 'approved' })
    const normal = makeUser(store, { login: 'normal-user', status: 'approved' })
    const adminSession = sessionFor(built, admin)
    const ownerSession = sessionFor(built, owner)

    const adminPage = await built.app.inject({ method: 'GET', url: '/admin', headers: { cookie: adminSession.cookie } })
    assert.equal(adminPage.statusCode, 200)
    assert.match(adminPage.body, /@admin-a/)
    assert.match(adminPage.body, /@normal-user/)
    assert.doesNotMatch(adminPage.body, /@owner/)
    assert.doesNotMatch(adminPage.body, /@admin-b/)
    assert.doesNotMatch(adminPage.body, /name="unlimited"/)
    assert.doesNotMatch(adminPage.body, /name="role"/)
    assert.doesNotMatch(adminPage.body, /\/admin\/metrics/)
    assert.match(adminPage.body, /data-confirm=/)
    assert.match(adminPage.body, /admin-control-row/)
    assert.match(adminPage.body, /admin-quota/)

    const ownerPage = await built.app.inject({ method: 'GET', url: '/admin', headers: { cookie: ownerSession.cookie } })
    assert.equal(ownerPage.statusCode, 200)
    for (const login of ['@owner', '@admin-a', '@admin-b', '@normal-user']) assert.match(ownerPage.body, new RegExp(login))
    assert.match(ownerPage.body, /name="unlimited"/)
    assert.match(ownerPage.body, /name="role"/)
    assert.match(ownerPage.body, /admin-role/)
    assert.match(ownerPage.body, /\/admin\/metrics/)

    const adminUnlimited = await built.app.inject({
      method: 'POST',
      url: `/admin/users/${normal.id}/quota`,
      headers: { cookie: adminSession.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: adminSession.csrf, quota: '1', unlimited: '1' }),
    })
    assert.equal(adminUnlimited.statusCode, 302)
    assert.match(String(adminUnlimited.headers.location), /error=/)
    assert.equal(store.userById(normal.id)?.quota_unlimited, 0)

    const ownerUnlimited = await built.app.inject({
      method: 'POST',
      url: `/admin/users/${normal.id}/quota`,
      headers: { cookie: ownerSession.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: ownerSession.csrf, quota: '1', unlimited: '1' }),
    })
    assert.equal(ownerUnlimited.statusCode, 302)
    assert.equal(store.userById(normal.id)?.quota_unlimited, 1)

    const adminRole = await built.app.inject({
      method: 'POST',
      url: `/admin/users/${normal.id}/role`,
      headers: { cookie: adminSession.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: adminSession.csrf, role: 'admin' }),
    })
    assert.equal(adminRole.statusCode, 403)
    assert.equal(store.userById(normal.id)?.role, 'user')

    const ownerRole = await built.app.inject({
      method: 'POST',
      url: `/admin/users/${normal.id}/role`,
      headers: { cookie: ownerSession.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: ownerSession.csrf, role: 'admin' }),
    })
    assert.equal(ownerRole.statusCode, 302)
    assert.equal(store.userById(normal.id)?.role, 'admin')
    assert.equal(store.userById(otherAdmin.id)?.role, 'admin')
  } finally {
    await built.close()
  }
})

test('the owner can preview the normal user UI and exit it', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const owner = makeUser(store, { login: 'preview-owner', superadmin: true, status: 'approved' })
    const repo = store.createRepo({ id: 'repo_preview', userId: owner.id, owner: 'o', name: 'preview', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const session = sessionFor(built, owner)
    const enabled = await built.app.inject({
      method: 'POST',
      url: '/admin/simulation',
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: session.csrf, enable: '1', returnTo: '/console' }),
    })
    assert.equal(enabled.statusCode, 302)
    assert.match(String(enabled.headers['set-cookie']), /fledge_preview=user/)
    const previewCookie = `${session.cookie}; fledge_preview=user`
    const repoPage = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}`, headers: { cookie: previewCookie } })
    assert.equal(repoPage.statusCode, 200)
    assert.match(repoPage.body, /正在预览用户视图/)
    assert.match(repoPage.body, /和 Chief 沟通/)
    assert.doesNotMatch(repoPage.body, new RegExp(`/repos/${repo.id}/team`))
    assert.match(repoPage.body, new RegExp(`/repos/${repo.id}/workspace`))
    const team = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/team`, headers: { cookie: previewCookie } })
    assert.equal(team.statusCode, 403)
    const workspace = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/workspace`, headers: { cookie: previewCookie } })
    assert.equal(workspace.statusCode, 200)
    const adminPage = await built.app.inject({ method: 'GET', url: '/admin', headers: { cookie: previewCookie } })
    assert.equal(adminPage.statusCode, 302)
    assert.equal(adminPage.headers.location, '/console')

    const disabled = await built.app.inject({
      method: 'POST',
      url: '/admin/simulation',
      headers: { cookie: previewCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: session.csrf, enable: '0', returnTo: '/admin' }),
    })
    assert.equal(disabled.statusCode, 302)
    assert.match(String(disabled.headers['set-cookie']), /fledge_preview=;/)
    const teamAgain = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/team`, headers: { cookie: session.cookie } })
    assert.equal(teamAgain.statusCode, 200)
  } finally {
    await built.close()
  }
})

test('the configured primary login is promoted to owner on startup', async () => {
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, adminLogin: 'primary' } })
  const store = new Store(':memory:')
  const primary = makeUser(store, { login: 'primary', admin: true, status: 'approved' })
  assert.equal(store.userById(primary.id)?.role, 'admin')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    assert.equal(store.userById(primary.id)?.role, 'superadmin')
  } finally {
    await built.close()
  }
})

test('admins can inspect a normal user read-only from a support view', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const admin = makeUser(store, { login: 'support-admin', admin: true })
    const user = makeUser(store, { login: 'support-user', status: 'approved' })
    const otherAdmin = makeUser(store, { login: 'other-admin', admin: true })
    const repo = store.createRepo({ id: 'repo_support', userId: user.id, owner: 'o', name: 'support', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: 'fix', autoIterate: false, intervalMinutes: 1440 })
    store.createJob({ id: 'job_support', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'support goal', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate' })
    store.audit(user.id, 'repo.settings', 'support detail')
    const { cookie } = sessionFor(built, admin)
    const support = await built.app.inject({ method: 'GET', url: `/admin/users/${user.id}`, headers: { cookie } })
    assert.equal(support.statusCode, 200)
    assert.match(support.body, /@support-user/)
    assert.match(support.body, /只读/)
    const job = await built.app.inject({ method: 'GET', url: '/admin/jobs/job_support', headers: { cookie } })
    assert.equal(job.statusCode, 200)
    assert.match(job.body, /job_support/)
    assert.doesNotMatch(job.body, /取消这个任务|重试这个任务|执行这个计划/)
    const hidden = await built.app.inject({ method: 'GET', url: `/admin/users/${otherAdmin.id}`, headers: { cookie } })
    assert.equal(hidden.statusCode, 404)
    const normal = makeUser(store, { login: 'normal-user', status: 'approved' })
    const normalSession = sessionFor(built, normal)
    const denied = await built.app.inject({ method: 'GET', url: `/admin/users/${user.id}`, headers: { cookie: normalSession.cookie } })
    assert.equal(denied.statusCode, 403)
  } finally {
    await built.close()
  }
})

test('admins can search and export jobs and audit within their visibility scope', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const admin = makeUser(store, { login: 'search-admin', admin: true })
    const user = makeUser(store, { login: 'search-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_search', userId: user.id, owner: 'o', name: 'search', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: 'fix', autoIterate: false, intervalMinutes: 1440 })
    store.createJob({ id: 'job_search', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'search goal', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate' })
    store.updateJob('job_search', { status: 'succeeded', finished_at: new Date().toISOString() })
    store.createJob({ id: 'job_search_triage', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'search goal triage', callbackHash: 'cb-triage', platformTokenHash: '', kind: 'triage', workType: 'triage' })
    store.updateJob('job_search_triage', { status: 'succeeded', finished_at: new Date().toISOString() })
    store.audit(user.id, 'repo.settings', 'search detail')
    const { cookie } = sessionFor(built, admin)
    const search = await built.app.inject({ method: 'GET', url: '/admin/search?q=search', headers: { cookie } })
    assert.equal(search.statusCode, 200)
    assert.match(search.body, /job_search/)
    // The route has always passed `kind` through, so the URL filtered; the form
    // did not offer the kinds that pass, so a triage row could not be picked.
    assert.match(search.body, /<option value="triage"/, 'the admin job form offers triage')
    const triageOnly = await built.app.inject({ method: 'GET', url: '/admin/search?q=search&kind=triage', headers: { cookie } })
    assert.match(triageOnly.body, /job_search_triage/, 'the admin filter applies triage')
    assert.doesNotMatch(triageOnly.body, /job_search"/, 'and leaves the iterate row out')
    const jobsCsv = await built.app.inject({ method: 'GET', url: '/admin/export/jobs.csv?q=search', headers: { cookie } })
    assert.equal(jobsCsv.statusCode, 200)
    assert.match(String(jobsCsv.headers['content-type']), /text\/csv/)
    assert.match(jobsCsv.body, /job_search/)
    const auditCsv = await built.app.inject({ method: 'GET', url: '/admin/export/audit.csv?q=search', headers: { cookie } })
    assert.equal(auditCsv.statusCode, 200)
    assert.match(auditCsv.body, /repo.settings/)
  } finally {
    await built.close()
  }
})

test('the admin job filter offers every kind and status under its console label, not the internal code', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const admin = makeUser(store, { login: 'filter-admin', admin: true })
    const repo = store.createRepo({ id: 'repo_filter', userId: admin.id, owner: 'o', name: 'filter', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: 'fix', autoIterate: false, intervalMinutes: 1440 })
    makeTerminalJob(store, { id: 'job_filter_verify', repoId: repo.id, userId: admin.id, trigger: 'manual', goal: 'verify goal', callbackHash: 'cb-v', platformTokenHash: '', kind: 'verify' })
    makeTerminalJob(store, { id: 'job_filter_iterate', repoId: repo.id, userId: admin.id, trigger: 'manual', goal: 'iterate goal', callbackHash: 'cb-i', platformTokenHash: '', kind: 'iterate' })
    const { cookie } = sessionFor(built, admin)
    const pageFor = async (locale: 'zh' | 'en'): Promise<string> => {
      const response = await built.app.inject({ method: 'GET', url: '/admin/search', headers: { cookie: `${cookie}; fledge_lang=${locale}` } })
      assert.equal(response.statusCode, 200)
      return response.body
    }
    // `scope` and `verify` are job kinds the table already badges, so the filter
    // that sits above it must offer them; the labels come from the same helper.
    const chinese = await pageFor('zh')
    assert.match(chinese, /<option value="verify"[^>]*>验证<\/option>/)
    assert.match(chinese, /<option value="scope"[^>]*>范围<\/option>/)
    assert.match(chinese, /<option value="quota_exhausted"[^>]*>额度用尽<\/option>/)
    const english = await pageFor('en')
    assert.match(english, /<option value="verify"[^>]*>Verify<\/option>/)
    assert.match(english, /<option value="quota_exhausted"[^>]*>Quota exhausted<\/option>/)
    // The value stays the code, so the option the form now offers is the filter
    // that isolates a `verify` job and leaves an `iterate` job out.
    const byKind = await built.app.inject({ method: 'GET', url: '/admin/search?kind=verify', headers: { cookie } })
    assert.equal(byKind.statusCode, 200)
    assert.match(byKind.body, /job_filter_verify/)
    assert.doesNotMatch(byKind.body, /job_filter_iterate/)
  } finally {
    await built.close()
  }
})

test('a CSV export refuses instead of silently stopping at 5000 rows', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const admin = makeUser(store, { login: 'export-cap-admin', admin: true })
    const user = makeUser(store, { login: 'export-cap-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_export_cap', userId: user.id, owner: 'o', name: 'cap', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: 'fix', autoIterate: false, intervalMinutes: 1440 })
    const { cookie } = sessionFor(built, admin)

    // Exactly at the cap the file is still served whole: header plus 5000 rows.
    store.db.exec('BEGIN')
    for (let i = 0; i < 5000; i += 1) store.audit(user.id, 'bulk.export', `row ${String(i)}`)
    store.db.exec('COMMIT')
    const auditAtCap = await built.app.inject({ method: 'GET', url: '/admin/export/audit.csv?action=bulk', headers: { cookie } })
    assert.equal(auditAtCap.statusCode, 200)
    assert.equal(auditAtCap.body.trimEnd().split('\n').length, 5001, 'one header plus every row at the cap')

    // One more matching row and the file would be short, so the route says so.
    store.audit(user.id, 'bulk.export', 'row 5000')
    const auditOverCap = await built.app.inject({ method: 'GET', url: '/admin/export/audit.csv?action=bulk', headers: { cookie } })
    assert.equal(auditOverCap.statusCode, 400)
    assert.match(auditOverCap.body, /5001/, 'the refusal names the real matched count')
    assert.match(auditOverCap.body, /5000/, 'the refusal names the cap')
    assert.doesNotMatch(String(auditOverCap.headers['content-type']), /text\/csv/, 'no truncated CSV is sent')
    const refusedAudit = store.searchAudit(null, { action: 'admin.audit_export' }, 10, 0)
    assert.match(refusedAudit[0]?.detail ?? '', /5001/, 'the refusal is audited with the real count')

    // The job export has the same contract.
    // One queued job per repo is the schema's rule, so each bulk job is settled
    // before the next one is inserted.
    const settleJob = store.db.prepare("UPDATE jobs SET status = 'succeeded' WHERE id = ?")
    store.db.exec('BEGIN')
    for (let i = 0; i < 5000; i += 1) {
      store.createJob({ id: `job_bulk_${String(i)}`, repoId: repo.id, userId: user.id, trigger: 'manual', goal: `bulk job ${String(i)}`, callbackHash: 'cb', platformTokenHash: '', kind: 'iterate' })
      settleJob.run(`job_bulk_${String(i)}`)
    }
    store.db.exec('COMMIT')
    const jobsAtCap = await built.app.inject({ method: 'GET', url: '/admin/export/jobs.csv', headers: { cookie } })
    assert.equal(jobsAtCap.statusCode, 200)
    assert.equal(jobsAtCap.body.trimEnd().split('\n').length, 5001)
    store.createJob({ id: 'job_bulk_5000', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'bulk job 5000', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate' })
    settleJob.run('job_bulk_5000')
    const jobsOverCap = await built.app.inject({ method: 'GET', url: '/admin/export/jobs.csv', headers: { cookie } })
    assert.equal(jobsOverCap.statusCode, 400)
    assert.match(jobsOverCap.body, /5001/)
  } finally {
    await built.close()
  }
})

test('an export trail ties the file to its row: filters, row count, scope and body digest', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const admin = makeUser(store, { login: 'trail-admin', admin: true })
    const user = makeUser(store, { login: 'trail-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_trail', userId: user.id, owner: 'o', name: 'trail', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: 'fix', autoIterate: false, intervalMinutes: 1440 })
    const failed = store.createJob({ id: 'job_trail_failed', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'trail goal', callbackHash: 'cb-trail', platformTokenHash: '', kind: 'iterate' })
    store.updateJob(failed.id, { status: 'failed', finished_at: new Date().toISOString() })
    const { cookie } = sessionFor(built, admin)
    const before = store.searchAudit(null, { action: 'admin.jobs_export' }, 10, 0).length

    const first = await built.app.inject({ method: 'GET', url: '/admin/export/jobs.csv?status=failed&kind=iterate', headers: { cookie } })
    assert.equal(first.statusCode, 200)
    const after = store.searchAudit(null, { action: 'admin.jobs_export' }, 10, 0)
    assert.equal(after.length, before + 1, 'exactly one trail row per export')

    const digest = createHash('sha256').update(first.body).digest('hex')
    const dataLines = first.body.split('\n').length - 1
    const visible = store.listUsers().filter((row) => row.id === admin.id || row.role === 'user').length
    const detail = after[0]?.detail ?? ''
    assert.match(detail, /filters=status=failed,kind=iterate/, 'the allow-listed filters are recorded verbatim')
    assert.match(detail, new RegExp(`(?:^|\\s)rows=${String(dataLines)}(?:\\s|$)`), 'rows counts the data lines the body carries')
    assert.match(detail, new RegExp(`(?:^|\\s)scope=users:${String(visible)}(?:\\s|$)`), 'scope records how far the read reached')
    assert.match(detail, new RegExp(`(?:^|\\s)sha256=${digest}(?:\\s|$)`), 'the digest is the sha256 of the exact body sent')

    // Two identical files share a digest; a different file does not.
    const again = await built.app.inject({ method: 'GET', url: '/admin/export/jobs.csv?status=failed&kind=iterate', headers: { cookie } })
    const againDigest = createHash('sha256').update(again.body).digest('hex')
    assert.equal(again.body, first.body, 'the same filter still produces the same bytes')
    assert.equal(againDigest, digest, 'and therefore the same digest')
    const secondRow = store.searchAudit(null, { action: 'admin.jobs_export' }, 1, 0)[0]
    assert.match(secondRow?.detail ?? '', new RegExp(`(?:^|\\s)sha256=${againDigest}(?:\\s|$)`))

    const more = store.createJob({ id: 'job_trail_failed_2', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'another goal', callbackHash: 'cb-trail-2', platformTokenHash: '', kind: 'iterate' })
    store.updateJob(more.id, { status: 'failed', finished_at: new Date().toISOString() })
    const changed = await built.app.inject({ method: 'GET', url: '/admin/export/jobs.csv?status=failed&kind=iterate', headers: { cookie } })
    assert.notEqual(changed.body, first.body, 'a different result set is a different file')
    assert.notEqual(createHash('sha256').update(changed.body).digest('hex'), digest, 'so the digest differs too')
  } finally {
    await built.close()
  }
})

test('the export trail records free text lossily and never copies an exported row', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const admin = makeUser(store, { login: 'lossy-admin', admin: true })
    const user = makeUser(store, { login: 'lossy-user', status: 'approved' })
    store.audit(user.id, 'bulk.export', 'alice@example.com secret-detail')
    const { cookie } = sessionFor(built, admin)
    const response = await built.app.inject({ method: 'GET', url: '/admin/export/audit.csv?q=alice@example.com', headers: { cookie } })
    assert.equal(response.statusCode, 200)
    assert.match(response.body, /secret-detail/, 'the file still carries what was exported')
    const row = store.searchAudit(null, { action: 'admin.audit_export' }, 1, 0)[0]
    const detail = row?.detail ?? ''
    assert.match(detail, /(?:^|\s)q=17ch#[0-9a-f]{8}(?:\s|$)/, 'free text is recorded as its length and a digest prefix')
    assert.doesNotMatch(detail, /@/, 'the trail carries no address')
    assert.doesNotMatch(detail, /alice/i, 'and no fragment of the searched value')
    assert.doesNotMatch(detail, /secret-detail/, 'and no fragment of an exported row')
  } finally {
    await built.close()
  }
})

test('the export trail records the scope it read, not one inferred later', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const admin = makeUser(store, { login: 'scope-admin', admin: true })
    const root = makeUser(store, { login: 'scope-root', superadmin: true })
    const user = makeUser(store, { login: 'scope-user', status: 'approved' })
    const other = makeUser(store, { login: 'scope-other', admin: true })
    store.audit(user.id, 'bulk.export', 'visible-row')
    store.audit(other.id, 'bulk.export', 'other-admin-only')
    const adminCookie = sessionFor(built, admin).cookie
    const rootCookie = sessionFor(built, root).cookie

    const scoped = await built.app.inject({ method: 'GET', url: '/admin/export/audit.csv?action=bulk', headers: { cookie: adminCookie } })
    assert.equal(scoped.statusCode, 200)
    assert.match(scoped.body, /visible-row/)
    assert.doesNotMatch(scoped.body, /other-admin-only/, "a normal admin's file holds no other admin's rows")
    const scopedRow = store.searchAudit(null, { action: 'admin.audit_export' }, 1, 0)[0]
    const visible = store.listUsers().filter((row) => row.id === admin.id || row.role === 'user').length
    assert.match(scopedRow?.detail ?? '', new RegExp(`(?:^|\\s)scope=users:${String(visible)}(?:\\s|$)`), 'a normal admin records the list length it used')

    const all = await built.app.inject({ method: 'GET', url: '/admin/export/audit.csv?action=bulk', headers: { cookie: rootCookie } })
    assert.equal(all.statusCode, 200)
    assert.match(all.body, /other-admin-only/, 'a super admin sees every row')
    const allRow = store.searchAudit(null, { action: 'admin.audit_export' }, 1, 0)[0]
    assert.match(allRow?.detail ?? '', /(?:^|\s)scope=all(?:\s|$)/, 'and records that the read covered the whole platform')
  } finally {
    await built.close()
  }
})

test('the search page shows the newest export for the viewer: when, rows, scope and hash prefix', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const admin = makeUser(store, { login: 'last-admin', admin: true })
    const user = makeUser(store, { login: 'last-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_last', userId: user.id, owner: 'o', name: 'last', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: 'fix', autoIterate: false, intervalMinutes: 1440 })
    const job = store.createJob({ id: 'job_last_failed', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'last goal', callbackHash: 'cb-last', platformTokenHash: '', kind: 'iterate' })
    store.updateJob(job.id, { status: 'failed', finished_at: new Date().toISOString() })
    const { cookie } = sessionFor(built, admin)
    const exported = await built.app.inject({ method: 'GET', url: '/admin/export/jobs.csv?status=failed&kind=iterate', headers: { cookie } })
    assert.equal(exported.statusCode, 200)
    const trail = store.searchAudit(null, { action: 'admin.jobs_export' }, 1, 0)[0]
    const detail = trail?.detail ?? ''
    const rows = /(?:^|\s)rows=(\d+)(?:\s|$)/.exec(detail)?.[1]
    const scope = /(?:^|\s)scope=(all|users:\d+)(?:\s|$)/.exec(detail)?.[1]
    const hash = /(?:^|\s)sha256=([0-9a-f]{8})/.exec(detail)?.[1]
    assert.ok(rows !== undefined && scope !== undefined && hash !== undefined, 'the trail row carries all three fields')

    const page = await built.app.inject({ method: 'GET', url: '/admin/search', headers: { cookie: `${cookie}; fledge_lang=en` } })
    assert.equal(page.statusCode, 200)
    const line = /<p class="fine" data-last-export>([\s\S]*?)<\/p>/.exec(page.body)?.[1] ?? ''
    assert.ok(line !== '', 'the page renders the last export')
    assert.ok(line.includes(`rows ${rows}`), `the page shows the row count (${String(rows)})`)
    assert.ok(line.includes(scope), `the page shows the scope (${String(scope)})`)
    assert.ok(line.includes(`sha256 ${hash}`), `the page shows the first 8 hex of the digest (${String(hash)})`)
  } finally {
    await built.close()
  }
})
