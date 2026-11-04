import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

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
      store.createJob({ id: `job_admin_${i}`, repoId: repo.id, userId: admin.id, trigger: 'manual', goal: 'goal', callbackHash: `hash-${i}`, platformTokenHash: '', kind: i % 2 === 0 ? 'iterate' : 'review' })
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
    assert.doesNotMatch(repoPage.body, new RegExp(`/repos/${repo.id}/workspace`))
    const team = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/team`, headers: { cookie: previewCookie } })
    assert.equal(team.statusCode, 403)
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
    store.audit(user.id, 'repo.settings', 'search detail')
    const { cookie } = sessionFor(built, admin)
    const search = await built.app.inject({ method: 'GET', url: '/admin/search?q=search', headers: { cookie } })
    assert.equal(search.statusCode, 200)
    assert.match(search.body, /job_search/)
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
