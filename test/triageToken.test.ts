import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/db.js'
import { GithubApp } from '../src/repos/app.js'
import { TRIAGE_TOKEN_PERMISSIONS, ReadOnlyTokenUnavailable, triageReadOnlyToken } from '../src/repos/token.js'
import { makeUser, testConfig } from './helpers.js'

// #390 review: the read-only property of a triage run has to be in the token the
// model holds, not only in the callback that judges its result. These cases pin
// the three ways that can be untrue: a write token, a cached token reused across
// scopes, or a fallback to a user token that cannot be narrowed.
test('a triage installation token is minted read-only and cached per scope', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-triage-token-'))
  const keyPath = join(dir, 'app.pem')
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  writeFileSync(keyPath, privateKey)
  const app = new GithubApp(testConfig({ githubApp: { id: '1', slug: 'fledge-platform', privateKeyPath: keyPath, webhookSecret: 'secret', useUserToken: false } }))
  const posts: Array<Record<string, unknown>> = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    if (String(input).endsWith('/rate_limit')) return new Response('{}', { status: 200, headers: { date: new Date().toUTCString() } })
    posts.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    return new Response(JSON.stringify({ token: `tok_${posts.length}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() }), { status: 200 })
  }) as typeof fetch
  try {
    const scoped = await app.installationToken(7, TRIAGE_TOKEN_PERMISSIONS)
    assert.equal(posts.length, 1, 'one access-token request')
    assert.deepEqual(posts[0]?.permissions, { contents: 'read', issues: 'read', pull_requests: 'read' }, 'the token is asked for read-only')
    assert.equal(await app.installationToken(7, TRIAGE_TOKEN_PERMISSIONS), scoped)
    assert.equal(posts.length, 1, 'the same scope is served from the cache')

    const full = await app.installationToken(7)
    assert.equal(posts.length, 2, 'the full token is not served from the read-only cache entry')
    assert.equal(posts[1]?.permissions, undefined, 'and it is minted with no narrowing')
    assert.notEqual(full, scoped, 'the two tokens are different credentials')
    assert.equal(await app.installationToken(7), full, 'the full token is cached under its own key')
  } finally {
    globalThis.fetch = original
    rmSync(dir, { recursive: true, force: true })
  }
})

test('every triage permission is read, and a token that cannot be narrowed is refused', async () => {
  assert.deepEqual(Object.values(TRIAGE_TOKEN_PERMISSIONS), ['read', 'read', 'read'], 'triage writes nothing')

  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'triage-token', status: 'approved' })
    const userTokenRepo = store.createRepo({ id: 'repo_token_user', userId: user.id, owner: 'o', name: 'u', defaultBranch: 'main', tokenEnc: 'x', goal: '', autoIterate: false, intervalMinutes: 60 })
    const configured = new GithubApp(testConfig({ githubApp: { id: '1', slug: 'fledge-platform', privateKeyPath: '/tmp/not-read.pem', webhookSecret: 'secret', useUserToken: true } }))
    // A user token cannot be narrowed, so the run is refused instead of handed one.
    await assert.rejects(() => triageReadOnlyToken(userTokenRepo, configured), (error: unknown) => error instanceof ReadOnlyTokenUnavailable && /TRIAGE_READ_ONLY_TOKEN/.test(error.message))

    // An installation that exists but an App that is not configured is the same
    // refusal for the same reason: there is no narrower token to mint.
    const appRepo = store.createRepo({ id: 'repo_token_app', userId: user.id, owner: 'o', name: 'a', defaultBranch: 'main', tokenEnc: 'x', installationId: 42, goal: '', autoIterate: false, intervalMinutes: 60 })
    await assert.rejects(() => triageReadOnlyToken(appRepo, new GithubApp(testConfig())), /TRIAGE_READ_ONLY_TOKEN/)
  } finally {
    store.close()
  }
})
