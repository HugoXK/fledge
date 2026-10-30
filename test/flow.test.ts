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
      json(response, 200, { id: 4242, login: 'token-user', name: 'Token User', email: 'token@example.com', avatar_url: null })
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
    assert.match(dashboard.body, /控制台/)

    const added = await built.app.inject({
      method: 'POST',
      url: '/repos',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, repo: 'octo/demo', token: 'test-token', goal: 'fix the bug', auto: '1', interval: '60' }),
    })
    assert.equal(added.statusCode, 302)
    const repo = store.listRepos(user.id)[0]
    assert.ok(repo)
    assert.equal(repo.owner, 'octo')
    assert.equal(repo.name, 'demo')
    assert.equal(repo.auto_iterate, 1)

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

    const tokenLogin = await built.app.inject({
      method: 'POST',
      url: '/auth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ token: 'test-token' }),
    })
    assert.equal(tokenLogin.statusCode, 302)
    assert.equal(tokenLogin.headers.location, '/pending')
    const tokenUser = store.userByLogin('token-user')
    assert.ok(tokenUser)
    assert.equal(tokenUser.status, 'pending')
    assert.equal(mailer.messages.some((message) => message.to === config.mail.adminEmail && /权限申请/.test(message.subject)), true)

    const admin = makeUser(store, { login: 'boss', admin: true })
    const adminSession = sessionFor(built, admin)
    const adminPage = await built.app.inject({ method: 'GET', url: '/admin', headers: { cookie: adminSession.cookie } })
    assert.equal(adminPage.statusCode, 200)
    assert.match(adminPage.body, /审批与额度/)
  } finally {
    await built.close()
    await github.close()
  }
})
