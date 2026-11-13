import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { sha256Hex } from '../src/lib/secrets.js'
import { MemoryMailer, formBody, makeUser, sessionFor, testConfig } from './helpers.js'

// #356: a signed-in user can only sign out of the current cookie, so a stolen or
// forgotten session stays valid until it expires and nobody can see where they are
// signed in. The three properties this file separates are the ones the card names:
// revoking one session leaves the other working, "revoke all others" keeps the
// current session, and a non-owner can neither see nor revoke another user's rows.
//
// The mechanism that keeps the current session out of "revoke all others" is the
// excluded row: the delete is scoped to `user_id` with `id_hash <> current`, so the
// current row is never in the affected set. The assertion that matters is that the
// current cookie still works afterwards - a confirmation step could not fake it,
// and re-creating the row would fail it, because the cookie would then address a
// hash that no longer exists.

type Built = Awaited<ReturnType<typeof buildApp>>

async function withApp(run: (built: Built, store: Store) => Promise<void>): Promise<void> {
  const store = new Store(':memory:')
  const built = await buildApp({
    config: testConfig(),
    store,
    mailer: new MemoryMailer(),
    runner: new MockRunner(),
    startScheduler: false,
  })
  try {
    await run(built, store)
  } finally {
    await built.close()
  }
}

function extraSession(built: Built, userId: string, ip = '127.0.0.1', agent = 'fledge-test other'): { hash: string; cookie: string } {
  const raw = built.sessions.start(userId, { ip, headers: { 'user-agent': agent } } as never)
  const hash = sha256Hex(raw)
  return { hash, cookie: `fledge_session=${raw}` }
}

async function settingsPage(built: Built, cookie: string): Promise<{ statusCode: number; body: string }> {
  const response = await built.app.inject({ method: 'GET', url: '/settings', headers: { cookie } })
  return { statusCode: response.statusCode, body: response.body }
}

// A dead cookie is refused in one of the two ways the app already uses: the page
// answers 401, or the request is sent to sign-in. Anything else means the session
// was still accepted.
async function refused(built: Built, cookie: string): Promise<boolean> {
  const response = await built.app.inject({ method: 'GET', url: '/settings', headers: { cookie } })
  if (response.statusCode === 401) return true
  return response.statusCode === 302 && String(response.headers['location'] ?? '').startsWith('/auth')
}

function post(built: Built, cookie: string, url: string, csrf?: string) {
  return built.app.inject({
    method: 'POST',
    url,
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: formBody({ csrf }),
  })
}

function auditActions(store: Store, action: string): Array<{ detail: string | null }> {
  return store.all<{ detail: string | null }>('SELECT detail FROM audit_log WHERE action = ?', action)
}

test('revoking one session leaves the other one working, and the revoked cookie is refused', async () => {
  await withApp(async (built, store) => {
    const user = makeUser(store, { login: 'two-sessions', status: 'approved' })
    const current = sessionFor(built, user)
    const other = extraSession(built, user.id)

    assert.equal((await settingsPage(built, current.cookie)).statusCode, 200)
    assert.equal((await settingsPage(built, other.cookie)).statusCode, 200)

    const revoke = await post(built, current.cookie, `/settings/sessions/${other.hash}/revoke`, current.csrf)
    assert.equal(revoke.statusCode, 302, 'the row action redirects back to the page')
    assert.match(String(revoke.headers['location'] ?? ''), /^\/settings/)

    assert.equal(await refused(built, other.cookie), true, 'the revoked cookie must be refused on its next request')
    assert.equal((await settingsPage(built, current.cookie)).statusCode, 200, 'the current session stays signed in')
    assert.ok(auditActions(store, 'session.revoked').length >= 1, 'the revocation is audited')
  })
})

test('revoke all others keeps the current session and drops every other one', async () => {
  await withApp(async (built, store) => {
    const user = makeUser(store, { login: 'three-sessions', status: 'approved' })
    const current = sessionFor(built, user)
    const first = extraSession(built, user.id, '127.0.0.1', 'fledge-test first')
    const second = extraSession(built, user.id, '127.0.0.1', 'fledge-test second')

    assert.equal((await settingsPage(built, first.cookie)).statusCode, 200)
    assert.equal((await settingsPage(built, second.cookie)).statusCode, 200)

    const response = await post(built, current.cookie, '/settings/sessions/revoke-others', current.csrf)
    assert.equal(response.statusCode, 302)

    // The excluded row: the current session is the one that must survive.
    assert.equal((await settingsPage(built, current.cookie)).statusCode, 200, 'the current session is not revoked')
    assert.equal(await refused(built, first.cookie), true)
    assert.equal(await refused(built, second.cookie), true)
  })
})

test('a non-owner can neither see nor revoke another user rows', async () => {
  await withApp(async (built, store) => {
    const alice = makeUser(store, { login: 'alice', status: 'approved' })
    const bob = makeUser(store, { login: 'bob', status: 'approved' })
    const aliceSession = sessionFor(built, alice)
    const bobSession = sessionFor(built, bob)

    const page = await settingsPage(built, aliceSession.cookie)
    assert.equal(page.statusCode, 200)
    assert.equal(page.body.includes(bobSession.raw), false, 'the page never carries a raw session cookie')
    assert.equal(
      page.body.includes(sha256Hex(bobSession.raw)),
      false,
      "another user's session id must not appear on this page",
    )

    const attempt = await post(built, aliceSession.cookie, `/settings/sessions/${sha256Hex(bobSession.raw)}/revoke`, aliceSession.csrf)
    assert.equal(attempt.statusCode, 302, 'the attempt is refused without revealing whether the row exists')
    assert.match(String(attempt.headers['location'] ?? ''), /error=/, 'the refusal is reported to the actor')
    assert.equal((await settingsPage(built, bobSession.cookie)).statusCode, 200, "bob's session must still work")
  })
})

test('the current session row is not revocable through the row action', async () => {
  await withApp(async (built, store) => {
    const user = makeUser(store, { login: 'current-row', status: 'approved' })
    const current = sessionFor(built, user)
    const ownHash = sha256Hex(current.raw)

    const response = await post(built, current.cookie, `/settings/sessions/${ownHash}/revoke`, current.csrf)
    assert.equal(response.statusCode, 302)
    assert.match(
      String(response.headers['location'] ?? ''),
      /error=/,
      'revoking the current session needs its own path (sign out or rotate), not the row action',
    )
    assert.equal((await settingsPage(built, current.cookie)).statusCode, 200)
  })
})

test('the session mutations are CSRF-protected', async () => {
  await withApp(async (built, store) => {
    const user = makeUser(store, { login: 'csrf-sessions', status: 'approved' })
    const current = sessionFor(built, user)
    const other = extraSession(built, user.id)

    const withoutToken = await post(built, current.cookie, `/settings/sessions/${other.hash}/revoke`)
    assert.equal(withoutToken.statusCode, 403)
    assert.equal((await settingsPage(built, other.cookie)).statusCode, 200, 'a refused request revokes nothing')

    const allWithoutToken = await post(built, current.cookie, '/settings/sessions/revoke-others')
    assert.equal(allWithoutToken.statusCode, 403)
    assert.equal((await settingsPage(built, other.cookie)).statusCode, 200)
  })
})

test('the list masks the address and marks the current session', async () => {
  await withApp(async (built, store) => {
    const user = makeUser(store, { login: 'masked-list', status: 'approved' })
    const current = sessionFor(built, user)
    extraSession(built, user.id, '203.0.113.7', 'Mozilla/5.0 (X11; Linux x86_64) fledge-test-agent')

    const page = await settingsPage(built, current.cookie)
    assert.equal(page.statusCode, 200)
    assert.equal(page.body.includes('203.0.113.7'), false, 'a full address is never rendered')
    assert.match(page.body, /203\.0\.113\./, 'the masked address is shown so a user can recognise the session')
    assert.match(page.body, /id="sessions"/, 'the section has an anchor a user can be sent to')
    assert.match(page.body, /\/settings\/sessions\/revoke-others/, 'the page offers "sign out other sessions"')
  })
})

// A stolen cookie is what this card is about, so the three mutations that end a
// session have to be bounded: CSRF proves the request came from our page, it does
// not say how many a stolen cookie may send. Same window as the other form posts
// (30/60s), and the limiter has to run before the action, otherwise the refused
// call is a free mutation.
test('each session mutation is rate limited, and a refused call deletes nothing', async () => {
  await withApp(async (built, store) => {
    const user = makeUser(store, { login: 'burst', status: 'approved' })
    const current = sessionFor(built, user)

    const allowed: number[] = []
    for (let i = 0; i < 30; i += 1) {
      const response = await post(built, current.cookie, '/settings/sessions/revoke-others', current.csrf)
      allowed.push(response.statusCode)
    }
    assert.deepEqual([...new Set(allowed)], [302], 'the route closed the window before the burst did')

    // A row that exists only for the refused call, so "nothing changed" is visible.
    const survivor = extraSession(built, user.id, '127.0.0.1', 'fledge-test survivor')
    const auditsBefore = auditActions(store, 'session.revoked').length

    const blocked = await post(built, current.cookie, '/settings/sessions/revoke-others', current.csrf)
    assert.equal(blocked.statusCode, 429, 'a burst past the form threshold was accepted')
    assert.match(String(blocked.headers['content-type']), /text\/html/, 'a form route answered a browser with a machine body')
    assert.equal(auditActions(store, 'session.revoked').length, auditsBefore, 'the refused call still wrote an audit row')
    assert.equal((await settingsPage(built, survivor.cookie)).statusCode, 200, 'the refused call deleted a session')

    // Each route has its own window: one refused bucket must not close another.
    const other = extraSession(built, user.id, '127.0.0.1', 'fledge-test other')
    const single = await post(built, current.cookie, `/settings/sessions/${other.hash}/revoke`, current.csrf)
    assert.equal(single.statusCode, 302, 'one route drew down another route window')
    assert.equal(await refused(built, other.cookie), true)
  })
})
