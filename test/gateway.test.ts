import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { encryptSecret, randomToken, sha256Hex } from '../src/lib/secrets.js'
import { MockRunner } from '../src/jobs/mock.js'
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
