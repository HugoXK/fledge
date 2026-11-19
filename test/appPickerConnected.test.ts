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
import { flashOf, formBody, json, makeUser, MemoryMailer, sessionFor, startFakeServer, testConfig } from './helpers.js'

// #1099: the picker offered a repository the workspace already had as if it were
// new, and a submission that added nothing blamed App permissions for it. The
// page can only tell the two apart if the route hands it the connected set, so
// the tests below pin both the view's marking and the route's sentence.

function appKeyPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-picker-key-'))
  const path = join(dir, 'app.pem')
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  writeFileSync(path, privateKey)
  return path
}

test('the picker marks a repository the workspace already has', () => {
  const config = testConfig({ githubApp: { ...testConfig().githubApp, id: '1', slug: 'fledge' } })
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'picker-connected-user', status: 'approved' })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    for (const locale of ['zh', 'en'] as const) {
      const html = appReposPage({
        config,
        locale,
        viewer,
        installations: [{ installation_id: 1, account_login: 'acme', account_type: 'User' }],
        installationId: 1,
        repos: [
          { fullName: 'acme/one', owner: 'acme', name: 'one', private: false, defaultBranch: 'main' },
          { fullName: 'acme/two', owner: 'acme', name: 'two', private: false, defaultBranch: 'main' },
        ],
        connected: new Map([['acme/one', 'repo_one']]),
      })
      const rows = html.split('<tr>')
      const connectedRow = rows.find((row) => row.includes('acme/one'))
      const freshRow = rows.find((row) => row.includes('acme/two'))
      assert.notEqual(connectedRow, undefined, `${locale}: the already-connected repository is listed`)
      assert.notEqual(freshRow, undefined, `${locale}: the fresh repository is listed`)
      assert.match(connectedRow!, /disabled/, `${locale}: a connected repository cannot be submitted again`)
      assert.match(connectedRow!, locale === 'zh' ? /已接入/ : /Already connected/, `${locale}: the row says it is already connected`)
      assert.match(connectedRow!, /href="\/repos\/repo_one"/, `${locale}: the row links the workspace it belongs to`)
      assert.doesNotMatch(freshRow!, /disabled/, `${locale}: a fresh repository stays selectable`)
      assert.doesNotMatch(freshRow!, locale === 'zh' ? /已接入/ : /Already connected/, `${locale}: a fresh repository is not marked`)
    }
  } finally {
    store.close()
  }
})

test('the picker route marks a connected repository and the refusal names the connection', async () => {
  const repos = ['one', 'two'].map((name) => ({
    full_name: `acme/${name}`, name, private: false, default_branch: 'main', owner: { login: 'acme' },
  }))
  const github = await startFakeServer((request, response) => {
    const url = new URL(String(request.url), 'http://127.0.0.1')
    if (url.pathname === '/rate_limit') return json(response, 200, { resources: {} })
    if (/^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) {
      return json(response, 201, { token: 'ghs_picker_stub', expires_at: new Date(Date.now() + 3_600_000).toISOString() })
    }
    if (url.pathname === '/installation/repositories') return json(response, 200, { total_count: repos.length, repositories: repos })
    json(response, 404, { message: 'not found' })
  })
  const base = testConfig()
  const config = testConfig({
    github: { ...base.github, apiBase: github.url },
    githubApp: { id: '77', slug: 'fledge', privateKeyPath: appKeyPath(), webhookSecret: 'secret', useUserToken: false },
  })
  config.flybot.instanceImage = ''
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'picker-route-user', status: 'approved' })
    store.saveInstallation({ installationId: 880, userId: user.id, accountLogin: 'acme', accountType: 'User' })
    const existing = store.createRepo({
      id: 'repo_connected_one', userId: user.id, owner: 'acme', name: 'one', defaultBranch: 'main',
      tokenEnc: '', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
    })
    const { cookie, csrf } = sessionFor(built, user)

    const page = await built.app.inject({ method: 'GET', url: '/repos/new?installation=880', headers: { cookie } })
    assert.equal(page.statusCode, 200)
    const connectedRow = page.body.split('<tr>').find((row) => row.includes('acme/one'))
    assert.notEqual(connectedRow, undefined)
    assert.match(connectedRow!, /disabled/, 'the route hands the view the connected set')
    assert.match(connectedRow!, /已接入/)
    assert.match(connectedRow!, new RegExp(`href="/repos/${existing.id}"`))

    // Only an already-connected repository selected: the refusal has to say that,
    // not blame App permissions, and the page above it must link the repository.
    const refused = await built.app.inject({
      method: 'POST',
      url: '/repos/app',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, installation: '880', repo: 'acme/one' }),
    })
    assert.equal(refused.statusCode, 302)
    const refusal = flashOf(refused)?.error?.text ?? ''
    assert.match(refusal, /已经接入/, 'the refusal names the connection instead of App permissions')
    assert.doesNotMatch(refusal, /App 权限/, 'the permission half stays for a real failure')
    const back = await built.app.inject({ method: 'GET', url: String(refused.headers.location), headers: { cookie } })
    assert.equal(back.statusCode, 200)
    assert.match(back.body, new RegExp(`href="/repos/${existing.id}"`), 'the page links the repository the refusal found')

    // A selection the App cannot see is a real failure and keeps the permission half.
    const missing = await built.app.inject({
      method: 'POST',
      url: '/repos/app',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, installation: '880', repo: 'acme/gone' }),
    })
    assert.equal(missing.statusCode, 302)
    assert.match(flashOf(missing)?.error?.text ?? '', /App 权限/, 'a repository the App cannot see still blames App permissions')
  } finally {
    await built.app.close()
    store.close()
    await github.close()
  }
})
