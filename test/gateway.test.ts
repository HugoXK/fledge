import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { encryptSecret, randomToken, sha256Hex } from '../src/lib/secrets.js'
import { MockRunner } from '../src/jobs/mock.js'
import { quotaView } from '../src/gateway/quota.js'
import { json, makeUser, readBody, startFakeServer, testConfig, MemoryMailer } from './helpers.js'

test('platform quota is metered, enforced and bypassed by a user model', async () => {
  const platformHits: unknown[] = []
  const platform = await startFakeServer(async (request, response) => {
    const body = JSON.parse((await readBody(request)).toString('utf8')) as Record<string, unknown>
    platformHits.push(body)
    json(response, 200, { id: 'x', choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { total_tokens: 1000 } }, { 'x-litellm-response-cost': '0.0002' })
  })
  const ownHits: unknown[] = []
  const own = await startFakeServer(async (request, response) => {
    const body = JSON.parse((await readBody(request)).toString('utf8')) as Record<string, unknown>
    ownHits.push(body)
    json(response, 200, { id: 'y', choices: [{ message: { role: 'assistant', content: 'own' } }], usage: { total_tokens: 10 } })
  })

  const config = testConfig({
    llm: { baseUrl: `${platform.url}/v1`, key: 'platform-key', model: 'platform-model', pricePerTokenUsd: 0.0000002 },
    quota: { initialCny: 0.001, usdCny: 7.2 },
  })
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  const built = await buildApp({ config, store, mailer, runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'quota-user', status: 'approved', quota: 0.001 })
    const raw = `flg_${randomToken(32)}`
    store.createApiToken({ id: 'tok_gateway', userId: user.id, kind: 'pat', name: 'test', tokenHash: sha256Hex(raw), prefix: raw.slice(0, 8), expiresAt: null })
    const headers = { authorization: `Bearer ${raw}`, 'content-type': 'application/json' }

    const first = await built.app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: { model: 'ignored', messages: [{ role: 'user', content: 'hi' }] } })
    assert.equal(first.statusCode, 200)
    assert.equal(first.headers['x-fledge-quota-remaining-cny'], '0.0010')
    assert.equal(platformHits.length, 1)
    assert.equal((store.userById(user.id)?.quota_used_usd ?? 0) > 0.0001, true)

    const second = await built.app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: { model: 'ignored', messages: [{ role: 'user', content: 'again' }] } })
    assert.equal(second.statusCode, 402)
    const error = second.json() as { error: { type: string; code: string } }
    assert.equal(error.error.type, 'quota_exhausted')
    assert.equal(error.error.code, 'FLEDGE_QUOTA_EXHAUSTED')

    const encrypted = encryptSecret('own-key', config.tokenEncryptionKey)
    store.setUserOwnModel(user.id, `${own.url}/v1`, encrypted, 'own-model')
    const third = await built.app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: { model: 'ignored', messages: [{ role: 'user', content: 'own' }] } })
    assert.equal(third.statusCode, 200)
    assert.equal(ownHits.length, 1)
    assert.equal((ownHits[0] as { model: string }).model, 'own-model')

    const bad = await built.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: 'Bearer flg_bad', 'content-type': 'application/json' }, payload: {} })
    assert.equal(bad.statusCode, 401)
  } finally {
    await built.close()
    await platform.close()
    await own.close()
  }
})

test('streaming usage with nested details is metered', async () => {
  const platform = await startFakeServer(async (request, response) => {
    await readBody(request)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: {"id":"x","choices":[{"delta":{"content":"ok"}}]}\n\n')
    response.write('data: {"id":"x","choices":[],"usage":{"total_tokens":37,"completion_tokens":5,"prompt_tokens":32,"completion_tokens_details":{"reasoning_tokens":5},"prompt_tokens_details":{"cached_tokens":0}}}\n\n')
    response.end('data: [DONE]\n\n')
  })
  const config = testConfig({
    llm: { baseUrl: `${platform.url}/v1`, key: 'platform-key', model: 'platform-model', pricePerTokenUsd: 0.0000002 },
    quota: { initialCny: 1, usdCny: 7.2 },
  })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'stream-user', status: 'approved', quota: 1 })
    const raw = `flg_${randomToken(32)}`
    store.createApiToken({ id: 'tok_stream', userId: user.id, kind: 'pat', name: 'test', tokenHash: sha256Hex(raw), prefix: raw.slice(0, 8), expiresAt: null })
    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json', accept: 'text/event-stream' },
      payload: { model: 'ignored', messages: [{ role: 'user', content: 'hi' }], stream: true },
    })
    assert.equal(response.statusCode, 200)
    assert.equal((store.userById(user.id)?.quota_used_usd ?? 0) > 0, true)
    assert.equal(quotaView(store.userById(user.id)!, config).usedCny > 0, true)
  } finally {
    await built.close()
    await platform.close()
  }
})

test('unlimited quota is never exhausted but still records usage', async () => {
  const platform = await startFakeServer(async (request, response) => {
    await readBody(request)
    json(response, 200, { id: 'x', choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { total_tokens: 1000 } }, { 'x-litellm-response-cost': '0.0002' })
  })
  const config = testConfig({
    llm: { baseUrl: `${platform.url}/v1`, key: 'platform-key', model: 'platform-model', pricePerTokenUsd: 0.0000002 },
    quota: { initialCny: 0, usdCny: 7.2 },
  })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'unlimited-user', status: 'approved', quota: 0 })
    store.setUserQuotaUnlimited(user.id, true)
    const unlimited = store.userById(user.id)!
    assert.equal(quotaView(unlimited, config).unlimited, true)
    assert.equal(quotaView(unlimited, config).exhausted, false)

    const raw = `flg_${randomToken(32)}`
    store.createApiToken({ id: 'tok_unlimited', userId: user.id, kind: 'pat', name: 'test', tokenHash: sha256Hex(raw), prefix: raw.slice(0, 8), expiresAt: null })
    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      payload: { model: 'ignored', messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(response.statusCode, 200)
    assert.equal((store.userById(user.id)?.quota_used_usd ?? 0) > 0, true)
  } finally {
    await built.close()
    await platform.close()
  }
})

test('a job-scoped token records usage and cost on the job', async () => {
  const platform = await startFakeServer(async (request, response) => {
    await readBody(request)
    json(response, 200, { id: 'x', choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { total_tokens: 1000 } }, { 'x-litellm-response-cost': '0.0002' })
  })
  const config = testConfig({ llm: { baseUrl: `${platform.url}/v1`, key: 'platform-key', model: 'platform-model', pricePerTokenUsd: 0.0000002 }, quota: { initialCny: 10, usdCny: 7.2 } })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'job-cost-user', status: 'approved', quota: 10 })
    const repo = store.createRepo({ id: 'repo_cost', userId: user.id, owner: 'o', name: 'c', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.createJob({ id: 'job_cost', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    const raw = `flg_${randomToken(32)}`
    store.createApiToken({ id: 'tok_job_cost', userId: user.id, kind: 'job', name: 'job:job_cost', tokenHash: sha256Hex(raw), prefix: raw.slice(0, 8), expiresAt: null })
    const response = await built.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' }, payload: { model: 'ignored', messages: [{ role: 'user', content: 'hi' }] } })
    assert.equal(response.statusCode, 200)
    assert.equal((store.getJob('job_cost')?.cost_usd ?? 0) > 0, true)
    assert.equal(store.usageForJob('job_cost') > 0, true)
  } finally {
    await built.close()
    await platform.close()
  }
})

test('gateway tokens are scoped to their user', async () => {
  const platform = await startFakeServer(async (request, response) => {
    await readBody(request)
    json(response, 200, { id: 'x', choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { total_tokens: 1000 } }, { 'x-litellm-response-cost': '0.0002' })
  })
  const config = testConfig({ llm: { baseUrl: `${platform.url}/v1`, key: 'platform-key', model: 'platform-model', pricePerTokenUsd: 0.0000002 }, quota: { initialCny: 10, usdCny: 7.2 } })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const alice = makeUser(store, { login: 'alice-token', status: 'approved', quota: 10 })
    const bob = makeUser(store, { login: 'bob-token', status: 'approved', quota: 10 })
    const aliceRaw = `flg_${randomToken(32)}`
    const bobRaw = `flg_${randomToken(32)}`
    store.createApiToken({ id: 'tok_alice', userId: alice.id, kind: 'pat', name: 'alice', tokenHash: sha256Hex(aliceRaw), prefix: aliceRaw.slice(0, 8), expiresAt: null })
    store.createApiToken({ id: 'tok_bob', userId: bob.id, kind: 'pat', name: 'bob', tokenHash: sha256Hex(bobRaw), prefix: bobRaw.slice(0, 8), expiresAt: null })
    const payload = { model: 'ignored', messages: [{ role: 'user', content: 'hi' }] }
    const a = await built.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${aliceRaw}`, 'content-type': 'application/json' }, payload })
    assert.equal(a.statusCode, 200)
    assert.equal((store.userById(alice.id)?.quota_used_usd ?? 0) > 0, true)
    assert.equal(store.userById(bob.id)?.quota_used_usd, 0)
    const b = await built.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${bobRaw}`, 'content-type': 'application/json' }, payload })
    assert.equal(b.statusCode, 200)
    assert.equal((store.userById(bob.id)?.quota_used_usd ?? 0) > 0, true)
    assert.equal((store.userById(alice.id)?.quota_used_usd ?? 0) > 0, true)
  } finally {
    await built.close()
    await platform.close()
  }
})
