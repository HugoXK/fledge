import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { appReposPage } from '../src/views/pages.js'
import { MockRunner } from '../src/jobs/mock.js'
import { json, makeUser, MemoryMailer, sessionFor, startFakeServer, testConfig } from './helpers.js'

// #1102: a repository listing that failed was drawn as a fact about the
// installation — the page said the installation grants nothing and offered no
// way out. The picker now has three states, and each one is pinned below: not
// read (`repos` undefined, so the page says the read failed, keeps GitHub's
// reason and offers the same URL again), read and empty (the sentence stays and
// gains the manage-installation link), and read with rows.

const HEADING = { zh: '选择要接入的仓库', en: 'Choose repositories' } as const

function pickerSection(html: string, locale: 'zh' | 'en'): string {
  const start = html.indexOf(`<h2>${HEADING[locale]}</h2>`)
  assert.notEqual(start, -1, `${locale}: the picker is rendered`)
  const end = html.indexOf('</section>', start)
  assert.notEqual(end, -1, `${locale}: the picker section closes`)
  return html.slice(start, end)
}

function appKeyPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-picker-failure-'))
  const path = join(dir, 'app.pem')
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  writeFileSync(path, privateKey)
  return path
}

test('a repository listing that failed says so, keeps the reason and offers a retry', () => {
  const config = testConfig({ githubApp: { ...testConfig().githubApp, id: '1', slug: 'fledge' } })
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'picker-failure-user', status: 'approved' })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    for (const locale of ['zh', 'en'] as const) {
      const html = appReposPage({
        config,
        locale,
        viewer,
        installations: [{ installation_id: 1, account_login: 'acme', account_type: 'User' }],
        installationId: 1,
        repos: undefined,
        error: 'Bad credentials',
      })
      const picker = pickerSection(html, locale)
      assert.doesNotMatch(
        picker,
        /没有可访问的仓库|no accessible repositories/,
        `${locale}: a failed read must not be reported as an empty installation`,
      )
      assert.match(
        picker,
        /href="\/repos\/new\?installation=1"/,
        `${locale}: the failure offers the same picker URL again`,
      )
      assert.match(picker, locale === 'zh' ? /重试/ : /Retry/, `${locale}: the retry is labelled`)
      assert.match(picker, /Bad credentials/, `${locale}: the card keeps the reason GitHub gave`)
    }
  } finally {
    store.close()
  }
})

test('a genuinely empty installation keeps its sentence and gains the manage link', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'picker-empty-user', status: 'approved' })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const config = testConfig({ githubApp: { ...testConfig().githubApp, id: '1', slug: 'fledge' } })
    for (const locale of ['zh', 'en'] as const) {
      const html = appReposPage({
        config,
        locale,
        viewer,
        installations: [{ installation_id: 1, account_login: 'acme', account_type: 'User' }],
        installationId: 1,
        repos: [],
      })
      const picker = pickerSection(html, locale)
      assert.match(
        picker,
        locale === 'zh' ? /这个安装没有可访问的仓库。/ : /This installation has no accessible repositories\./,
        `${locale}: an installation that really grants nothing keeps the sentence`,
      )
      assert.match(
        picker,
        /href="https:\/\/github\.com\/apps\/fledge\/installations\/new"/,
        `${locale}: the empty installation points at the App's installation settings`,
      )
    }
    // Without an App slug there is no manage URL, so the picker renders no link
    // rather than a dead one.
    const noSlug = testConfig({ githubApp: { ...testConfig().githubApp, id: '1', slug: '' } })
    const bare = pickerSection(appReposPage({
      config: noSlug,
      locale: 'zh',
      viewer,
      installations: [{ installation_id: 1, account_login: 'acme', account_type: 'User' }],
      installationId: 1,
      repos: [],
    }), 'zh')
    assert.equal(bare.includes('github.com/apps'), false, 'zh: no App slug, no manage link')
  } finally {
    store.close()
  }
})

test('the route renders a failed listing as a failure, not as an empty installation', async () => {
  const github = await startFakeServer((request, response) => {
    const url = new URL(String(request.url), 'http://127.0.0.1')
    if (url.pathname === '/rate_limit') return json(response, 200, { resources: {} })
    if (/^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) {
      return json(response, 201, { token: 'ghs_picker_failure_stub', expires_at: new Date(Date.now() + 3_600_000).toISOString() })
    }
    if (url.pathname === '/installation/repositories') return json(response, 401, { message: 'Bad credentials' })
    json(response, 404, { message: 'not found' })
  })
  const base = testConfig()
  const config = testConfig({
    github: { ...base.github, apiBase: github.url },
    githubApp: { id: '78', slug: 'fledge', privateKeyPath: appKeyPath(), webhookSecret: 'secret', useUserToken: false },
  })
  config.flybot.instanceImage = ''
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'picker-failure-route-user', status: 'approved' })
    store.saveInstallation({ installationId: 881, userId: user.id, accountLogin: 'acme', accountType: 'User' })
    const { cookie } = sessionFor(built, user)
    const page = await built.app.inject({ method: 'GET', url: '/repos/new?installation=881', headers: { cookie } })
    assert.equal(page.statusCode, 200)
    const picker = pickerSection(page.body, 'zh')
    assert.doesNotMatch(picker, /没有可访问的仓库/, 'the route does not report a failed read as an empty installation')
    assert.match(picker, /href="\/repos\/new\?installation=881"/, 'the route offers the same page again')
    assert.match(picker, /重试/, 'the route labels the retry')
    assert.match(picker, /Bad credentials/, "the route keeps GitHub's reason")
  } finally {
    await built.app.close()
    store.close()
    await github.close()
  }
})
