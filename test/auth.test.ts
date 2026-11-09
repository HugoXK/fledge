import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp, safeLocalPath } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { MemoryMailer, makeUser, sessionFor, testConfig } from './helpers.js'

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
