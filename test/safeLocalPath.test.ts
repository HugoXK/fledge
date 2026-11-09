import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp, safeLocalPath } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { sha256Hex } from '../src/lib/secrets.js'
import { makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// `..` and `.` are folded away by the URL parser, so these three inputs are
// ordinary paths before parsing and `//host` after it. The live `/lang/:locale`
// route used to redirect to the folded value.
const FOLDED = ['/..//evil.com', '/.//evil.com', '/..\\/evil.com']

test('a next path that only becomes protocol-relative after normalisation falls back', () => {
  for (const value of FOLDED) {
    assert.equal(safeLocalPath(value, '/'), '/', `${value} must fall back`)
  }
})

test('a next path that is already protocol-relative or an absolute URL falls back', () => {
  // The query layer decodes once, so these are the values the helper really
  // sees; the percent-encoded spellings are what an attacker sends.
  const encoded = ['//evil.com', '///evil.com', '/\t/evil.com', '/%2f%2fevil.com', '/%5c%5cevil.com']
  const hostile = [...encoded.map((value) => decodeURIComponent(value)), 'https://evil.com/apply', 'evil.com', '']
  for (const value of hostile) {
    assert.equal(safeLocalPath(value, '/'), '/', `${JSON.stringify(value)} must fall back`)
  }
})

test('a legitimate local path keeps its query and hash', () => {
  assert.equal(safeLocalPath('/../ok', '/'), '/ok')
  assert.equal(safeLocalPath('/apply?x=1#y', '/'), '/apply?x=1#y')
  assert.equal(safeLocalPath('/dashboard', '/'), '/dashboard')
})

test('the language route redirects a folded next value to the fallback, not to another host', async () => {
  const store = new Store(':memory:')
  const built = await buildApp({ config: testConfig(), store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const hostile = await built.app.inject({ method: 'GET', url: '/lang/en?next=%2F..%2F%2Fevil.com' })
    assert.equal(hostile.statusCode, 302)
    assert.equal(hostile.headers.location, '/', `Location must be the fallback, got ${String(hostile.headers.location)}`)

    const legit = await built.app.inject({ method: 'GET', url: '/lang/en?next=%2Fapply' })
    assert.equal(legit.statusCode, 302)
    assert.equal(legit.headers.location, '/apply')
  } finally {
    await built.close()
  }
})

test('the OAuth next value is stored as exactly the string safeLocalPath returns', async () => {
  // /auth/github/reauthorize writes the checked value into the OAuth state; the
  // callback reads it back through the same helper. Asserting the stored value
  // proves the pair without a browser round trip.
  const store = new Store(':memory:')
  const built = await buildApp({ config: testConfig(), store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'oauth-user', status: 'approved' })
    const session = sessionFor(built, user)
    for (const input of ['/settings?tab=github', '/..//evil.com', '//evil.com', '/apply']) {
      const response = await built.app.inject({
        method: 'GET',
        url: `/auth/github/reauthorize?next=${encodeURIComponent(input)}`,
        headers: { cookie: session.cookie },
      })
      assert.equal(response.statusCode, 302, String(response.headers.location))
      const state = new URL(String(response.headers.location)).searchParams.get('state')
      assert.ok(state !== null && state !== '', 'the authorize URL must carry a state')
      const stored = store.consumeOAuthState(sha256Hex(state))
      assert.equal(stored?.redirect_to, safeLocalPath(input, '/dashboard'), `${input} must be stored as the checked value`)
    }
  } finally {
    await built.close()
  }
})

test('the sign-in route stores the page the visitor was sent away from', async () => {
  // The 401 guard sends a visitor to /auth/github?next=<page>. That page only
  // survives the round trip if the plain sign-in route writes it into the OAuth
  // state, which the callback then reads back.
  const store = new Store(':memory:')
  const built = await buildApp({ config: testConfig(), store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    for (const input of ['/apply', '/dashboard?window=30', '//evil.com', 'https://evil.com/apply']) {
      const response = await built.app.inject({ method: 'GET', url: `/auth/github?next=${encodeURIComponent(input)}` })
      assert.equal(response.statusCode, 302, String(response.headers.location))
      const state = new URL(String(response.headers.location)).searchParams.get('state')
      assert.ok(state !== null && state !== '', 'the authorize URL must carry a state')
      assert.equal(store.consumeOAuthState(sha256Hex(state))?.redirect_to, safeLocalPath(input, '/dashboard'), `${input} must be stored as the checked value`)
    }
  } finally {
    await built.close()
  }
})
