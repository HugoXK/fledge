import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'
import { dashboardPage } from '../src/views/pages.js'
import { quotaMoney } from '../src/views/layout.js'

test('healthz reports the package version', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const response = await built.app.inject({ method: 'GET', url: '/healthz' })
    const body = response.json() as { version: string }
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    assert.equal(body.version, pkg.version)
  } finally {
    await built.close()
  }
})

test('small quota changes are visible below one yuan', () => {
  assert.equal(quotaMoney(0.0001), '¥0.0001')
  assert.equal(quotaMoney(0.5), '¥0.5000')
  assert.equal(quotaMoney(1.234), '¥1.23')
})

test('unlimited quota is shown instead of a finite balance', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'unlimited-ui', status: 'approved' })
    store.setUserQuotaUnlimited(user.id, true)
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const en = dashboardPage({ config, locale: 'en', viewer, repos: [], jobs: [], notifications: [] })
    assert.match(en, /Unlimited/)
    assert.match(en, /usage is still recorded|platform quota is unlimited/)
    const zh = dashboardPage({ config, locale: 'zh', viewer, repos: [], jobs: [], notifications: [] })
    assert.match(zh, /不限额/)
  } finally {
    store.close()
  }
})

test('the workspace stays focused and the UI switches language', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'language-user', status: 'approved' })
    const { cookie } = sessionFor(built, user)

    const zh = await built.app.inject({ method: 'GET', url: '/console', headers: { cookie } })
    assert.equal(zh.statusCode, 200)
    assert.match(zh.body, /工作区/)
    assert.match(zh.body, /最近任务/)
    assert.match(zh.body, /data-lang-btn="en"/)
    assert.match(zh.body, /data-locale="zh"/)
    assert.doesNotMatch(zh.body, /暂未开放|生态|独立服务|flybot\.hugoxk\.online|sciencediscovery\.hugoxk\.online/)

    const appJs = await built.app.inject({ method: 'GET', url: '/assets/app.js' })
    assert.equal(appJs.statusCode, 200)
    assert.match(appJs.body, /hugoxk-lang/)

    const switched = await built.app.inject({ method: 'GET', url: '/lang/en?next=%2Fconsole', headers: { cookie } })
    assert.equal(switched.statusCode, 302)
    assert.equal(switched.headers.location, '/console')
    assert.match(String(switched.headers['set-cookie']), /fledge_lang=en/)

    const en = await built.app.inject({ method: 'GET', url: '/console', headers: { cookie: `${cookie}; fledge_lang=en` } })
    assert.equal(en.statusCode, 200)
    assert.match(en.body, /<html lang="en" data-locale="en">/)
    assert.match(en.body, /Workspace/)
    assert.match(en.body, /Recent jobs/)
    assert.match(en.body, /Sign out/)
    assert.doesNotMatch(en.body, /服务/)

    const bad = await built.app.inject({ method: 'GET', url: '/lang/fr' })
    assert.equal(bad.statusCode, 404)

    const unsafe = await built.app.inject({ method: 'GET', url: '/lang/en?next=%2F%2Fevil.example' })
    assert.equal(unsafe.statusCode, 302)
    assert.equal(unsafe.headers.location, '/')
  } finally {
    await built.close()
  }
})

test('the anonymous landing page follows the saved language', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const zh = await built.app.inject({ method: 'GET', url: '/' })
    assert.match(zh.body, /让仓库自己长大/)
    const en = await built.app.inject({ method: 'GET', url: '/', headers: { cookie: 'fledge_lang=en' } })
    assert.match(en.body, /Let your repositories grow/)
    assert.match(en.body, /Sign in with GitHub/)
  } finally {
    await built.close()
  }
})
