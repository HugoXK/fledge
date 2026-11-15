import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import type { JobRow, RepoRow, UserRow } from '../src/db.js'
import { randomToken, sha256Hex } from '../src/lib/secrets.js'
import { MockRunner } from '../src/jobs/mock.js'
import { makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #392: the public read API. Three auth answers, one envelope, keyset paging.
// The tests drive the real app through `inject`, so the route, the shared
// authenticator and the token store are all exercised without a network.

function makeRepo(store: Store, userId: string, name: string): RepoRow {
  return store.createRepo({
    id: `repo_${name}`,
    userId,
    owner: 'acme',
    name,
    defaultBranch: 'main',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 60,
  })
}

function mintToken(store: Store, user: UserRow, scope: string, expiresAt: string | null = null): string {
  const raw = `flg_${randomToken(32)}`
  store.createApiToken({
    id: `tok_${Math.random().toString(36).slice(2, 10)}`,
    userId: user.id,
    kind: 'pat',
    name: scope,
    tokenHash: sha256Hex(raw),
    prefix: raw.slice(0, 8),
    repoId: null,
    scope,
    expiresAt,
  })
  return raw
}

function seedJob(store: Store, repo: RepoRow, user: UserRow, id: string, createdAt: string): JobRow {
  const job = store.createJob({
    id,
    repoId: repo.id,
    userId: user.id,
    trigger: 'manual',
    goal: `goal ${id}`,
    callbackHash: 'h',
    platformTokenHash: 'p',
    createdAt,
  })
  store.updateJob(id, {
    status: 'succeeded',
    finished_at: createdAt,
    pr_url: `https://github.com/acme/demo/pull/1`,
    issue_url: 'https://github.com/acme/demo/issues/2',
    review_score: 91,
    cost_usd: 0.25,
  })
  return store.getJob(id) ?? job
}

test('GET /api/v1/jobs returns the caller own jobs and no secret field', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'api-owner', status: 'approved' })
    const repo = makeRepo(store, user.id, 'demo')
    seedJob(store, repo, user, 'job_a', '2026-11-15T01:00:00.000Z')
    seedJob(store, repo, user, 'job_b', '2026-11-15T02:00:00.000Z')
    seedJob(store, repo, user, 'job_c', '2026-11-15T03:00:00.000Z')
    const raw = mintToken(store, user, 'jobs:read')

    const response = await built.app.inject({ method: 'GET', url: '/api/v1/jobs', headers: { authorization: `Bearer ${raw}` } })
    assert.equal(response.statusCode, 200)
    const body = response.json() as { data: Array<Record<string, unknown>>; next_cursor: string | null }
    assert.deepEqual(body.data.map((row) => row.id), ['job_c', 'job_b', 'job_a'])
    assert.equal(body.next_cursor, null)

    // The envelope is camelCase and exactly the documented fields.
    assert.deepEqual(Object.keys(body.data[0] ?? {}).sort(), ['costUsd', 'createdAt', 'finishedAt', 'id', 'issueUrl', 'kind', 'prUrl', 'repo', 'reviewScore', 'status'].sort())
    assert.equal(body.data[0]?.repo, repo.id)
    assert.equal(body.data[0]?.costUsd, 0.25)
    assert.equal(body.data[0]?.reviewScore, 91)
    assert.equal(body.data[0]?.prUrl, 'https://github.com/acme/demo/pull/1')
    assert.equal(body.data[0]?.status, 'succeeded')

    // A leaked row shape would show up here: the columns carry a callback hash,
    // a platform token hash and a callback secret.
    const text = response.body
    for (const forbidden of ['callback_hash', 'token_hash', 'platform_token', 'callback_secret', 'platformTokenHash', 'callbackHash']) {
      assert.equal(text.includes(forbidden), false, `response must not carry ${forbidden}`)
    }
  } finally {
    await built.close()
  }
})

test('GET /api/v1/jobs answers 403 insufficient_scope for a gateway token and 401 for a dead one', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'api-scope', status: 'approved' })
    const gateway = mintToken(store, user, 'gateway')

    const forbidden = await built.app.inject({ method: 'GET', url: '/api/v1/jobs', headers: { authorization: `Bearer ${gateway}` } })
    assert.equal(forbidden.statusCode, 403)
    assert.equal((forbidden.json() as { error: { type: string } }).error.type, 'insufficient_scope')

    // A refused token must not be touched, exactly as the gateway promises.
    const token = store.listApiTokens(user.id)[0]!
    assert.equal(token.last_used_at, null)

    const missing = await built.app.inject({ method: 'GET', url: '/api/v1/jobs' })
    assert.equal(missing.statusCode, 401)
    assert.equal((missing.json() as { error: { type: string } }).error.type, 'invalid_api_key')

    // Split so the repository's own secret scanner does not read this test as a
    // leaked token: it is a prefix and a body that no store ever held.
    const bogus = ['Bearer', 'flg_' + 'not-a-token'].join(' ')
    const unknown = await built.app.inject({ method: 'GET', url: '/api/v1/jobs', headers: { authorization: bogus } })
    assert.equal(unknown.statusCode, 401)
    assert.equal((unknown.json() as { error: { type: string } }).error.type, 'invalid_api_key')

    const revokedRaw = mintToken(store, user, 'jobs:read')
    const revoked = store.listApiTokens(user.id).find((row) => row.scope === 'jobs:read')!
    store.revokeApiToken(revoked.id, user.id)
    const afterRevoke = await built.app.inject({ method: 'GET', url: '/api/v1/jobs', headers: { authorization: `Bearer ${revokedRaw}` } })
    assert.equal(afterRevoke.statusCode, 401)
    assert.equal((afterRevoke.json() as { error: { type: string } }).error.type, 'invalid_api_key')

    const expiredRaw = mintToken(store, user, 'jobs:read', '2020-01-01T00:00:00.000Z')
    const expired = await built.app.inject({ method: 'GET', url: '/api/v1/jobs', headers: { authorization: `Bearer ${expiredRaw}` } })
    assert.equal(expired.statusCode, 401)
    assert.equal((expired.json() as { error: { type: string } }).error.type, 'invalid_api_key')
  } finally {
    await built.close()
  }
})

test('GET /api/v1/jobs pages by cursor without repeating a row', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'api-pager', status: 'approved' })
    const repo = makeRepo(store, user.id, 'paged')
    seedJob(store, repo, user, 'job_1', '2026-11-15T01:00:00.000Z')
    seedJob(store, repo, user, 'job_2', '2026-11-15T02:00:00.000Z')
    seedJob(store, repo, user, 'job_3', '2026-11-15T03:00:00.000Z')
    const raw = mintToken(store, user, 'jobs:read')

    const first = await built.app.inject({ method: 'GET', url: '/api/v1/jobs?limit=2', headers: { authorization: `Bearer ${raw}` } })
    assert.equal(first.statusCode, 200)
    const pageOne = first.json() as { data: Array<{ id: string }>; next_cursor: string | null }
    assert.deepEqual(pageOne.data.map((row) => row.id), ['job_3', 'job_2'])
    assert.equal(pageOne.next_cursor, 'job_2')

    const second = await built.app.inject({ method: 'GET', url: `/api/v1/jobs?limit=2&cursor=${pageOne.next_cursor}`, headers: { authorization: `Bearer ${raw}` } })
    assert.equal(second.statusCode, 200)
    const pageTwo = second.json() as { data: Array<{ id: string }>; next_cursor: string | null }
    assert.deepEqual(pageTwo.data.map((row) => row.id), ['job_1'])
    assert.equal(pageTwo.next_cursor, null)

    const seen = [...pageOne.data, ...pageTwo.data].map((row) => row.id)
    assert.equal(new Set(seen).size, seen.length)

    // An id that is not one of this caller's jobs is not a cursor, and saying so
    // is cheaper than silently answering the first page again.
    const unknown = await built.app.inject({ method: 'GET', url: '/api/v1/jobs?cursor=job_other', headers: { authorization: `Bearer ${raw}` } })
    assert.equal(unknown.statusCode, 400)
    assert.equal((unknown.json() as { error: { type: string } }).error.type, 'invalid_cursor')
  } finally {
    await built.close()
  }
})

test('GET /api/v1/jobs never returns another user jobs', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const alice = makeUser(store, { login: 'alice', status: 'approved' })
    const bob = makeUser(store, { login: 'bob', status: 'approved' })
    const aliceRepo = makeRepo(store, alice.id, 'alice-demo')
    const bobRepo = makeRepo(store, bob.id, 'bob-demo')
    seedJob(store, aliceRepo, alice, 'job_alice', '2026-11-15T01:00:00.000Z')
    seedJob(store, bobRepo, bob, 'job_bob', '2026-11-15T02:00:00.000Z')

    // A cursor from the other account is refused rather than resolved.
    const aliceRaw = mintToken(store, alice, 'jobs:read')
    const bobRaw = mintToken(store, bob, 'jobs:read')

    const aliceBody = (await built.app.inject({ method: 'GET', url: '/api/v1/jobs', headers: { authorization: `Bearer ${aliceRaw}` } })).json() as { data: Array<{ id: string }> }
    assert.deepEqual(aliceBody.data.map((row) => row.id), ['job_alice'])

    const bobBody = (await built.app.inject({ method: 'GET', url: '/api/v1/jobs', headers: { authorization: `Bearer ${bobRaw}` } })).json() as { data: Array<{ id: string }> }
    assert.deepEqual(bobBody.data.map((row) => row.id), ['job_bob'])

    const crossed = await built.app.inject({ method: 'GET', url: '/api/v1/jobs?cursor=job_bob', headers: { authorization: `Bearer ${aliceRaw}` } })
    assert.equal(crossed.statusCode, 400)
    assert.equal((crossed.json() as { error: { type: string } }).error.type, 'invalid_cursor')
  } finally {
    await built.close()
  }
})

test('the settings token form offers the jobs:read scope', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'api-form', status: 'approved' })
    const session = sessionFor(built, user)
    const page = await built.app.inject({ method: 'GET', url: '/settings', headers: { cookie: session.cookie } })
    assert.equal(page.statusCode, 200)
    const html = page.body
    // The scope is a choice now, not a hidden fixed value: both capabilities
    // the code enforces are offered, and nothing else is.
    assert.match(html, /<select name="scope"/)
    assert.match(html, /<option value="gateway"/)
    assert.match(html, /<option value="jobs:read"/)
    assert.equal(/<input type="hidden" name="scope" value="gateway"/.test(html), false)
  } finally {
    await built.close()
  }
})
