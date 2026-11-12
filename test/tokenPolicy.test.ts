// #355: a personal token has no expiry and no scope, so a leaked `flg_` token is
// permanent and unbounded. The card keeps the slice small: PATs get a finite,
// visible expiry and a `scope` whose only enforced value is `gateway`; job and
// instance tokens keep the expiry they already have.
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { randomToken, sha256Hex } from '../src/lib/secrets.js'
import { formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

const DAY = 86_400_000
const past = (): string => new Date(Date.now() - 60_000).toISOString()

function token(store: Store, input: { id: string; userId: string; raw: string; kind?: string; expiresAt?: string | null; scope?: string }): string {
  store.createApiToken({
    id: input.id,
    userId: input.userId,
    kind: input.kind ?? 'pat',
    name: input.id,
    tokenHash: sha256Hex(input.raw),
    prefix: input.raw.slice(0, 8),
    repoId: null,
    expiresAt: input.expiresAt === undefined ? new Date(Date.now() + 30 * DAY).toISOString() : input.expiresAt,
    ...(input.scope === undefined ? {} : { scope: input.scope }),
  })
  return input.raw
}

test('an expired personal token is refused by the gateway with 401', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'expired-token-user', status: 'approved' })
    const raw = token(store, { id: 'tok_expired', userId: user.id, raw: `flg_${randomToken(32)}`, expiresAt: past() })
    const response = await built.app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${raw}` } })
    assert.equal(response.statusCode, 401)
    assert.equal((response.json() as { error: { type: string } }).error.type, 'invalid_api_key')
    assert.ok(!response.body.includes(raw), 'the refusal must not echo the token')
  } finally {
    await built.close()
  }
})

test('a token whose scope is not gateway is refused with 403 and does not touch last-used', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'scope-token-user', status: 'approved' })
    const raw = token(store, { id: 'tok_read_scope', userId: user.id, raw: `flg_${randomToken(32)}`, scope: 'read' })
    const response = await built.app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${raw}` } })
    assert.equal(response.statusCode, 403)
    assert.equal((response.json() as { error: { type: string } }).error.type, 'insufficient_scope')
    // The chat route spends money and reaches the same refusal through the same
    // helper, so it gets its own case rather than riding on the models route.
    const chat = await built.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ model: 'any', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(chat.statusCode, 403)
    assert.equal((chat.json() as { error: { type: string } }).error.type, 'insufficient_scope')
    assert.equal(store.listApiTokens(user.id).find((row) => row.id === 'tok_read_scope')?.last_used_at, null)
  } finally {
    await built.close()
  }
})

test('a live gateway token still works end to end and revoke still ends it', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'live-token-user', status: 'approved' })
    const raw = token(store, { id: 'tok_live', userId: user.id, raw: `flg_${randomToken(32)}`, scope: 'gateway' })
    const live = await built.app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${raw}` } })
    assert.equal(live.statusCode, 200)
    assert.notEqual(store.listApiTokens(user.id).find((row) => row.id === 'tok_live')?.last_used_at, null)

    const { cookie, csrf } = sessionFor(built, user)
    const revoked = await built.app.inject({
      method: 'POST',
      url: '/settings/tokens/tok_live/revoke',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf }),
    })
    assert.equal(revoked.statusCode, 302)
    assert.equal(store.listAudit(50).filter((row) => row.action === 'token.revoked').length, 1)
    const after = await built.app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${raw}` } })
    assert.equal(after.statusCode, 401)
  } finally {
    await built.close()
  }
})

test('the create form records a finite expiry and the gateway scope', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'create-token-user', status: 'approved' })
    const { cookie, csrf } = sessionFor(built, user)
    const posted = await built.app.inject({
      method: 'POST',
      url: '/settings/tokens',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, name: 'laptop-cli', expiryDays: '30' }),
    })
    assert.equal(posted.statusCode, 200)
    const created = store.listApiTokens(user.id).find((row) => row.name === 'laptop-cli')
    assert.ok(created !== undefined, 'the token must be created')
    assert.equal(created.scope, 'gateway')
    assert.ok(created.expires_at !== null, 'a personal token must carry an expiry')
    const days = (Date.parse(created.expires_at!) - Date.now()) / DAY
    assert.ok(days > 29 && days < 31, `expected about 30 days, got ${days}`)

    const fallback = await built.app.inject({
      method: 'POST',
      url: '/settings/tokens',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, name: 'no-choice' }),
    })
    assert.equal(fallback.statusCode, 200)
    const defaults = store.listApiTokens(user.id).find((row) => row.name === 'no-choice')
    const defaultDays = (Date.parse(defaults!.expires_at!) - Date.now()) / DAY
    assert.ok(defaultDays > 89 && defaultDays < 91, `expected the default 90 days, got ${defaultDays}`)
  } finally {
    await built.close()
  }
})

test('never is refused for a normal user and allowed for an operator token', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'never-token-user', status: 'approved' })
    const { cookie, csrf } = sessionFor(built, user)
    const refused = await built.app.inject({
      method: 'POST',
      url: '/settings/tokens',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, name: 'forever', expiryDays: 'never' }),
    })
    assert.equal(refused.statusCode, 302)
    assert.match(String(refused.headers.location), /error=/)
    assert.equal(store.listApiTokens(user.id).find((row) => row.name === 'forever'), undefined)

    const admin = makeUser(store, { login: 'operator-token-user', status: 'approved', superadmin: true })
    const operator = sessionFor(built, admin)
    const allowed = await built.app.inject({
      method: 'POST',
      url: '/settings/tokens',
      headers: { cookie: operator.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: operator.csrf, name: 'operator', expiryDays: 'never' }),
    })
    assert.equal(allowed.statusCode, 200)
    const operatorToken = store.listApiTokens(admin.id).find((row) => row.name === 'operator')
    assert.equal(operatorToken?.expires_at, null)
    assert.equal(operatorToken?.scope, 'gateway')
  } finally {
    await built.close()
  }
})

test('the settings page shows the scope and the expiry of each token', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'list-token-user', status: 'approved' })
    const expiresAt = new Date(Date.now() + 12 * DAY).toISOString()
    token(store, { id: 'tok_listed', userId: user.id, raw: `flg_${randomToken(32)}`, expiresAt, scope: 'gateway' })
    const { cookie } = sessionFor(built, user)
    const page = await built.app.inject({ method: 'GET', url: '/settings', headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /gateway/)
    assert.match(page.body, new RegExp(expiresAt.slice(0, 10)))
    // The row carries prefix, name, scope, expiry, last used and revoke, so the
    // header must name six columns in that order. Counting cells is the half the
    // earlier assertions could not see: a four-cell header still contains the
    // word `gateway` and the date, only under the wrong column.
    const table = page.body.slice(page.body.indexOf('<table'), page.body.indexOf('</table>'))
    const head = table.slice(0, table.indexOf('</thead>'))
    const firstRow = table.slice(table.indexOf('<tbody>'), table.indexOf('</tr>', table.indexOf('<tbody>')))
    // `<thead>` starts with the same three characters, so count opening tags
    // only where the name ends.
    assert.equal((head.match(/<th[\s>]/g) ?? []).length, 6, 'the header must name the six columns the row emits')
    assert.equal((firstRow.match(/<td/g) ?? []).length, 6, 'the row must carry the same six cells')
    const headCells = [...head.matchAll(/<th>(.*?)<\/th>/g)].map((match) => match[1] ?? '')
    assert.match(headCells[2] ?? '', /^(范围|Scope)$/, 'the third column names the scope')
    assert.match(headCells[3] ?? '', /^(有效期|Expires)$/, 'the fourth column names the expiry')
    const rowCells = [...firstRow.matchAll(/<td>(.*?)<\/td>/g)].map((match) => match[1] ?? '')
    assert.match(rowCells[2] ?? '', /gateway/, 'the scope sits under its own header, not under Last used')
  } finally {
    await built.close()
  }
})

test('opening an older database gives a legacy PAT a scope and a finite expiry, and leaves job tokens alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-token-policy-'))
  const dbPath = join(dir, 'fledge.db')
  try {
    const legacy = new DatabaseSync(dbPath)
    legacy.exec(`CREATE TABLE api_tokens (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, repo_id TEXT, expires_at TEXT,
      revoked_at TEXT, last_used_at TEXT, created_at TEXT NOT NULL)`)
    legacy.exec(`INSERT INTO api_tokens (id, user_id, kind, name, token_hash, prefix, repo_id, expires_at, revoked_at, last_used_at, created_at)
      VALUES ('tok_legacy', 'usr_legacy', 'pat', 'laptop', 'hash_legacy', 'flg_legacy', NULL, NULL, NULL, NULL, '2026-01-01T00:00:00.000Z')`)
    legacy.close()

    const store = new Store(dbPath)
    const user = makeUser(store, { login: 'migration-user', status: 'approved' })
    const jobRaw = `flg_${randomToken(32)}`
    const jobExpiry = past()
    store.createApiToken({ id: 'tok_job', userId: user.id, kind: 'job', name: 'job:j1', tokenHash: sha256Hex(jobRaw), prefix: jobRaw.slice(0, 8), repoId: null, expiresAt: jobExpiry })
    store.close()

    // Re-open: the upgrade must not run twice, so a job token whose expiry has
    // already passed is not silently extended (its lifecycle is the job's).
    const reopened = new Store(dbPath)
    try {
      const legacyRow = reopened.listApiTokens('usr_legacy').find((row) => row.id === 'tok_legacy')
      // listApiTokens filters revoked rows only; a token with no user row still
      // answers here because the query is by user_id.
      assert.equal(legacyRow?.scope, 'gateway')
      assert.ok(legacyRow?.expires_at !== null && Date.parse(legacyRow!.expires_at!) > Date.now(), 'the legacy PAT needs a future expiry')
      assert.equal(reopened.listApiTokens(user.id).find((row) => row.id === 'tok_job')?.expires_at, jobExpiry)
    } finally {
      reopened.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
