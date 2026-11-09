import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp, safeLocalPath } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { randomToken, sha256Hex } from '../src/lib/secrets.js'
import { addMinutes } from '../src/lib/time.js'
import { MemoryMailer, json, makeUser, readBody, sessionFor, startFakeServer, testConfig } from './helpers.js'

const PAGES = ['/apply', '/apply/status', '/dashboard', '/console', '/settings', '/admin', '/pending']

async function withApp(run: (built: Awaited<ReturnType<typeof buildApp>>) => Promise<void>): Promise<void> {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    await run(built)
  } finally {
    await built.close()
  }
}

function nextOf(response: { headers: Record<string, unknown> }): string {
  const location = String(response.headers['location'] ?? '')
  return new URL(location, 'http://fledge.local').searchParams.get('next') ?? ''
}

test('token login is disabled once OAuth is configured', async () => {
  const config = testConfig({ allowTokenLoginOnly: false })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const response = await built.app.inject({ method: 'POST', url: '/auth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'token=abc' })
    assert.equal(response.statusCode, 403)
    assert.match(String(response.headers['content-type']), /text\/html/)
    assert.match(response.body, /OAuth 已启用/)
  } finally {
    await built.close()
  }
})

test('an unauthenticated GET of a protected page signs in and returns to the same page', async () => {
  await withApp(async (built) => {
    for (const page of PAGES) {
      const response = await built.app.inject({ method: 'GET', url: page })
      assert.equal(response.statusCode, 302, `${page} answered ${response.statusCode} instead of signing in`)
      const location = String(response.headers['location'] ?? '')
      assert.ok(location.startsWith('/auth/github?next='), `${page} redirected to ${location}`)
      assert.equal(nextOf(response), page)
      assert.equal(response.body.includes('出错了'), false, `${page} still rendered the error page`)
    }
  })
})

test('the sign-in target keeps the query string and is always a local path', async () => {
  await withApp(async (built) => {
    const response = await built.app.inject({ method: 'GET', url: '/dashboard?window=30' })
    assert.equal(response.statusCode, 302)
    const next = nextOf(response)
    assert.equal(next, '/dashboard?window=30')
    assert.ok(next.startsWith('/') && !next.startsWith('//'), `next ${next} is not a local path`)
  })
})

test('safeLocalPath keeps a local path and refuses an off-site one', () => {
  assert.equal(safeLocalPath('//evil.example', '/dashboard'), '/dashboard')
  assert.equal(safeLocalPath('https://evil.example', '/dashboard'), '/dashboard')
  assert.equal(safeLocalPath(undefined, '/dashboard'), '/dashboard')
  assert.equal(safeLocalPath('/apply/status?notice=x', '/dashboard'), '/apply/status?notice=x')
})

test('a machine client and a form post still get 401 instead of a redirect', async () => {
  await withApp(async (built) => {
    const api = await built.app.inject({ method: 'GET', url: '/api/application' })
    assert.equal(api.statusCode, 401)
    assert.match(String(api.headers['content-type']), /application\/json/)
    assert.equal((api.json() as { error: { type: string } }).error.type, 'AUTH_REQUIRED')

    const form = await built.app.inject({ method: 'POST', url: '/apply', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'signature=x' })
    assert.equal(form.statusCode, 401)
    assert.equal(form.headers['location'], undefined)
  })
})

test('an approved user still lands on the dashboard from /apply', async () => {
  await withApp(async (built) => {
    const user = makeUser(built.store, { status: 'approved' })
    const session = sessionFor(built, user)
    const response = await built.app.inject({ method: 'GET', url: '/apply', headers: { cookie: session.cookie } })
    assert.equal(response.statusCode, 302)
    assert.equal(response.headers['location'], '/dashboard')
  })
})

// The route and the landing page are two call sites of one rule:
// tokenLoginEnabled = !oauthConfigured || allowTokenLoginOnly. When the page
// renders from `oauthConfigured` alone, "OAuth configured + fallback kept"
// hides a login route that still answers.
test('route behaviour and landing-page visibility agree for every token-login combination', async () => {
  const github = await startFakeServer((request, response) => {
    if (request.url === '/user') {
      json(response, 200, { id: 4242, login: 'token-user', name: 'Token User', email: 'token@example.com', avatar_url: null })
      return
    }
    response.writeHead(404)
    response.end()
  })
  try {
    const combinations = [
      { label: 'OAuth configured, fallback kept', oauth: true, allow: true, visible: true, status: 302 },
      { label: 'OAuth configured, fallback off', oauth: true, allow: false, visible: false, status: 403 },
      { label: 'no OAuth, fallback off', oauth: false, allow: false, visible: true, status: 302 },
    ]
    for (const combination of combinations) {
      const config = testConfig({
        allowTokenLoginOnly: combination.allow,
        github: {
          ...testConfig().github,
          apiBase: github.url,
          clientId: combination.oauth ? 'client' : '',
          clientSecret: combination.oauth ? 'secret' : '',
        },
      })
      const store = new Store(':memory:')
      const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
      try {
        const page = await built.app.inject({ method: 'GET', url: '/' })
        assert.equal(page.statusCode, 200, combination.label)
        const formVisible = page.body.includes('id="token-login"')
        assert.equal(formVisible, combination.visible, `${combination.label}: the landing page displayed the token form ${String(formVisible)}`)

        const posted = await built.app.inject({
          method: 'POST',
          url: '/auth/token',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          payload: 'token=test-token',
        })
        assert.equal(posted.statusCode, combination.status, `${combination.label}: POST /auth/token answered ${String(posted.statusCode)}`)
        assert.equal(formVisible, posted.statusCode !== 403, `${combination.label}: the page and the route disagree about token login`)
      } finally {
        await built.close()
      }
    }
  } finally {
    await github.close()
  }
})

test('the OAuth callback lands an approved user on the dashboard, a pending user on the status page, and refuses a reused state', async () => {
  const store = new Store(':memory:')
  const approvedUser = makeUser(store, { login: 'approved-user', status: 'approved' })
  const pendingUser = makeUser(store, { login: 'pending-user', status: 'pending' })
  const github = await startFakeServer(async (request, response) => {
    if (request.method === 'POST' && request.url === '/login/oauth/access_token') {
      const body = JSON.parse((await readBody(request)).toString('utf8')) as { code?: string }
      json(response, 200, { access_token: `token-${body.code ?? ''}`, token_type: 'bearer', scope: 'read:user' })
      return
    }
    if (request.url === '/user') {
      const login = String(request.headers.authorization ?? '').replace(/^Bearer token-/, '')
      const user = login === approvedUser.login ? approvedUser : pendingUser
      json(response, 200, { id: user.github_id, login: user.login, name: user.login, email: `${user.login}@example.com`, avatar_url: null })
      return
    }
    response.writeHead(404)
    response.end()
  })
  const state = randomToken(32)
  try {
    const config = testConfig({
      github: { ...testConfig().github, apiBase: github.url, oauthTokenUrl: `${github.url}/login/oauth/access_token` },
    })
    const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
    try {
      store.createOAuthState(sha256Hex(state), addMinutes(20), null)
      const approved = await built.app.inject({ method: 'GET', url: `/auth/github/callback?code=approved-user&state=${state}` })
      assert.equal(approved.statusCode, 302, approved.body.slice(0, 200))
      assert.equal(approved.headers['location'], '/dashboard')

      const reused = await built.app.inject({ method: 'GET', url: `/auth/github/callback?code=approved-user&state=${state}` })
      assert.equal(reused.statusCode, 400, 'a state is consumed exactly once')

      const pendingState = randomToken(32)
      store.createOAuthState(sha256Hex(pendingState), addMinutes(20), null)
      const pending = await built.app.inject({ method: 'GET', url: `/auth/github/callback?code=pending-user&state=${pendingState}` })
      assert.equal(pending.statusCode, 302, pending.body.slice(0, 200))
      assert.equal(pending.headers['location'], '/apply/status')
    } finally {
      await built.close()
    }
  } finally {
    await github.close()
  }
})

test('tokenLoginEnabled is the single rule both call sites use', async () => {
  // Imported here rather than at the top so this file still loads on the base
  // tree, where the module does not exist yet: the behavioural tests above must
  // fail on their assertions at the base, not on a missing import.
  const { tokenLoginEnabled } = await import('../src/auth/login.js')
  const github = { ...testConfig().github }
  const configured = { ...github, clientId: 'client', clientSecret: 'secret' }
  const missing = { ...github, clientId: '', clientSecret: '' }
  assert.equal(tokenLoginEnabled({ github: configured, allowTokenLoginOnly: true }), true, 'OAuth configured, fallback deliberately kept')
  assert.equal(tokenLoginEnabled({ github: configured, allowTokenLoginOnly: false }), false, 'OAuth configured, fallback off')
  assert.equal(tokenLoginEnabled({ github: missing, allowTokenLoginOnly: false }), true, 'no OAuth: the fallback is the only path')
})
