import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { Approvals } from '../src/users/approval.js'
import { MockRunner } from '../src/jobs/mock.js'
import { formBody, json, makeUser, sessionFor, startFakeServer, testConfig, MemoryMailer } from './helpers.js'

test('browser flow: session, repo add, manual run, approval link', async () => {
  const github = await startFakeServer((request, response) => {
    if (request.url === '/user') {
      const repoUser = String(request.headers.authorization ?? '').includes('repo-token')
      const login = repoUser ? 'octo-user' : 'token-user'
      json(response, 200, { id: repoUser ? 4343 : 4242, login, name: login, email: repoUser ? 'octo-user@example.com' : 'token@example.com', avatar_url: null })
      return
    }
    if (request.url === '/repos/octo/demo') {
      json(response, 200, {
        name: 'demo',
        full_name: 'octo/demo',
        default_branch: 'main',
        private: false,
        html_url: 'https://github.com/octo/demo',
        owner: { login: 'octo' },
        permissions: { push: true },
      })
      return
    }
    if (request.url === '/repos/octo-user/demo') {
      json(response, 200, {
        name: 'demo',
        full_name: 'octo-user/demo',
        default_branch: 'main',
        private: false,
        html_url: 'https://github.com/octo-user/demo',
        fork: true,
        parent: { full_name: 'octo/demo' },
        owner: { login: 'octo-user' },
        permissions: { admin: true, push: true },
      })
      return
    }
    response.writeHead(404)
    response.end()
  })
  const config = testConfig({ github: { ...testConfig().github, apiBase: github.url }, devLogin: { login: 'dev', admin: true } })
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  const built = await buildApp({ config, store, mailer, runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'octo-user', status: 'approved' })
    const { csrf, cookie } = sessionFor(built, user)

    const devLogin = await built.app.inject({ method: 'GET', url: '/auth/dev' })
    assert.equal(devLogin.statusCode, 302)
    assert.match(String(devLogin.headers['set-cookie'] ?? ''), /fledge_session=/)

    const dashboard = await built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie } })
    assert.equal(dashboard.statusCode, 200)
    assert.match(dashboard.body, /仓库/)

    const added = await built.app.inject({
      method: 'POST',
      url: '/repos',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, repo: 'octo/demo', token: 'repo-token', goal: 'fix the bug', auto: '1', interval: '120' }),
    })
    assert.equal(added.statusCode, 302)
    const repo = store.listRepos(user.id)[0]
    assert.ok(repo)
    assert.equal(repo.owner, 'octo')
    assert.equal(repo.name, 'demo')
    assert.equal(repo.auto_iterate, 1)
    assert.equal(repo.interval_minutes, 120)
    assert.equal(repo.is_fork, 1)
    assert.equal(repo.fork_owner, 'octo-user')
    assert.equal(repo.fork_name, 'demo')
    assert.equal(repo.permission, 'write')
    assert.equal(repo.can_review, 1)
    assert.equal(repo.reviewer_enabled, 0)

    const noCsrf = await built.app.inject({
      method: 'POST',
      url: '/repos',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ repo: 'octo/demo', token: 'x' }),
    })
    assert.equal(noCsrf.statusCode, 403)

    const run = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/run`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf }),
    })
    assert.equal(run.statusCode, 302)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const job = store.listJobsForRepo(repo.id)[0]
    assert.ok(job)
    assert.equal(job.status, 'succeeded')

    const page = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}`, headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /octo\/demo/)

    const anonymous = await built.app.inject({ method: 'GET', url: '/dashboard' })
    assert.equal(anonymous.statusCode, 401)

    const pending = makeUser(store, { login: 'pending-user', status: 'pending' })
    const approvals = new Approvals(store, config, mailer)
    const sent = await approvals.request(pending)
    assert.equal(sent.sent, true)
    assert.equal(mailer.messages[0]?.to, config.mail.adminEmail)
    assert.match(mailer.messages[0]?.subject ?? '', /权限申请/)
    const token = sent.approveUrl?.split('/approve/')[1]
    assert.ok(token)
    const confirm = await built.app.inject({ method: 'GET', url: `/approve/${token}` })
    assert.equal(confirm.statusCode, 200)
    assert.match(confirm.body, /批准/)
    const applied = await built.app.inject({ method: 'POST', url: `/approve/${token}` })
    assert.equal(applied.statusCode, 200)
    assert.equal(store.userById(pending.id)?.status, 'approved')
    const reused = await built.app.inject({ method: 'GET', url: `/approve/${token}` })
    assert.equal(reused.statusCode, 404)

    const mailsBeforeLogin = mailer.messages.length
    const tokenLogin = await built.app.inject({
      method: 'POST',
      url: '/auth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ token: 'test-token' }),
    })
    assert.equal(tokenLogin.statusCode, 302)
    assert.equal(tokenLogin.headers.location, '/apply')
    const setCookies = tokenLogin.headers['set-cookie']
    const tokenCookie = (Array.isArray(setCookies) ? setCookies : [setCookies])
      .map((line) => String(line).split(';')[0])
      .join('; ')
    const tokenCsrf = /(?:^|; )fledge_csrf=([^;]+)/.exec(tokenCookie)?.[1]
    assert.ok(tokenCsrf)
    const tokenUser = store.userByLogin('token-user')
    assert.ok(tokenUser)
    assert.equal(tokenUser.status, 'onboarding')
    assert.equal(mailer.messages.length, mailsBeforeLogin)

    const applyPage = await built.app.inject({ method: 'GET', url: '/apply', headers: { cookie: tokenCookie } })
    assert.equal(applyPage.statusCode, 200)
    assert.match(applyPage.body, /免责声明/)
    assert.match(applyPage.body, /信息安全承诺/)

    const mailsBefore = mailer.messages.length
    const applicationSubmitted = await built.app.inject({
      method: 'POST',
      url: '/apply',
      headers: { cookie: tokenCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: tokenCsrf, signature: 'token-user', disclaimer: '1', security: '1' }),
    })
    assert.equal(applicationSubmitted.statusCode, 302)
    assert.equal(applicationSubmitted.headers.location, '/apply/status?notice=%E7%94%B3%E8%AF%B7%E5%B7%B2%E6%8F%90%E4%BA%A4%EF%BC%8C%E6%AD%A3%E5%9C%A8%E6%8E%92%E9%98%9F%E3%80%82')
    const submitted = store.userById(tokenUser.id)
    assert.ok(submitted)
    assert.equal(submitted.status, 'pending')
    assert.equal(submitted.disclaimer_name, 'token-user')
    assert.notEqual(submitted.application_submitted_at, null)
    assert.equal(mailer.messages.length, mailsBefore + 2)
    assert.equal(mailer.messages.some((message) => message.to === 'token@example.com' && /申请已收到/.test(message.subject)), true)
    assert.equal(mailer.messages.some((message) => message.to === config.mail.adminEmail && /权限申请/.test(message.subject)), true)

    const statusPage = await built.app.inject({ method: 'GET', url: '/apply/status', headers: { cookie: tokenCookie } })
    assert.equal(statusPage.statusCode, 200)
    assert.match(statusPage.body, /排队/)

    const application = await built.app.inject({ method: 'GET', url: '/api/application', headers: { cookie: tokenCookie } })
    assert.equal(application.statusCode, 200)
    const applicationBody = application.json() as { status: string; position: number; pending: number }
    assert.equal(applicationBody.status, 'pending')
    assert.equal(applicationBody.position, 1)
    assert.equal(applicationBody.pending, 1)

    const duplicate = await built.app.inject({
      method: 'POST',
      url: '/apply',
      headers: { cookie: tokenCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: tokenCsrf, signature: 'token-user', disclaimer: '1', security: '1' }),
    })
    assert.equal(duplicate.statusCode, 302)
    assert.equal(duplicate.headers.location, '/apply/status')
    assert.equal(mailer.messages.length, mailsBefore + 2)
    assert.equal(mailer.messages.some((message) => message.to === 'token@example.com' && /申请已收到/.test(message.subject)), true)
    assert.equal(mailer.messages.some((message) => message.to === config.mail.adminEmail && /权限申请/.test(message.subject)), true)

    const beforeApprovalConsole = await built.app.inject({ method: 'GET', url: '/console', headers: { cookie: tokenCookie } })
    assert.equal(beforeApprovalConsole.statusCode, 403)
    const beforeApprovalAdmin = await built.app.inject({ method: 'GET', url: '/admin', headers: { cookie: tokenCookie } })
    assert.equal(beforeApprovalAdmin.statusCode, 403)

    const admin = makeUser(store, { login: 'boss', admin: true })
    const adminSession = sessionFor(built, admin)
    const adminPage = await built.app.inject({ method: 'GET', url: '/admin', headers: { cookie: adminSession.cookie } })
    assert.equal(adminPage.statusCode, 200)
    assert.match(adminPage.body, /审批与额度/)
    assert.match(adminPage.body, /#1/)

    const quotaUpdated = await built.app.inject({
      method: 'POST',
      url: `/admin/users/${tokenUser.id}/quota`,
      headers: { cookie: adminSession.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: adminSession.csrf, quota: '5' }),
    })
    assert.equal(quotaUpdated.statusCode, 302)
    assert.equal(store.userById(tokenUser.id)?.quota_cny, 5)

    const quotaWithoutCsrf = await built.app.inject({
      method: 'POST',
      url: `/admin/users/${tokenUser.id}/quota`,
      headers: { cookie: adminSession.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ quota: '2' }),
    })
    assert.equal(quotaWithoutCsrf.statusCode, 403)
    assert.equal(store.userById(tokenUser.id)?.quota_cny, 5)

    const approved = await built.app.inject({
      method: 'POST',
      url: `/admin/users/${tokenUser.id}/approve`,
      headers: { cookie: adminSession.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: adminSession.csrf }),
    })
    assert.equal(approved.statusCode, 302)
    assert.equal(store.userById(tokenUser.id)?.status, 'approved')
    const statusAfter = await built.app.inject({ method: 'GET', url: '/apply/status', headers: { cookie: tokenCookie } })
    assert.equal(statusAfter.statusCode, 302)
    assert.equal(statusAfter.headers.location, '/dashboard')
    const userDashboard = await built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie: tokenCookie } })
    assert.equal(userDashboard.statusCode, 200)
    const consolePage = await built.app.inject({ method: 'GET', url: '/console', headers: { cookie: tokenCookie } })
    assert.equal(consolePage.statusCode, 200)
    assert.match(consolePage.body, /工作区/)
    assert.match(consolePage.body, /最近任务/)
    assert.doesNotMatch(consolePage.body, /暂未开放|flybot\.hugoxk\.online/)
  } finally {
    await built.close()
    await github.close()
  }
})
