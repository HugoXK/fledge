import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import type { Config } from '../src/config.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { resetMetrics } from '../src/lib/metrics.js'
import { randomToken, sha256Hex } from '../src/lib/secrets.js'
import { json, makeUser, MemoryMailer, readBody, startFakeServer, testConfig } from './helpers.js'

// #464: the per-tenant metering switch is default-off. Off must be today's
// behaviour byte for byte — one IP-keyed bucket per route and the same 429 body.
// On only meters; it must not split the bucket, cap a tenant or queue anything.
const LIMIT = 240
const WINDOW_MS = 60_000
const IP = '198.51.100.40'

function tokenFor(store: Store, userId: string, id: string, repoId?: string): string {
  const raw = `flg_${randomToken(32)}`
  store.createApiToken({
    id,
    userId,
    kind: repoId === undefined ? 'pat' : 'instance',
    name: 'metering-test',
    tokenHash: sha256Hex(raw),
    prefix: raw.slice(0, 8),
    repoId: repoId ?? null,
    expiresAt: null,
  })
  return raw
}

type Built = Awaited<ReturnType<typeof buildApp>>

async function withGateway(overrides: Partial<Config>, run: (built: Built, store: Store) => Promise<void>): Promise<void> {
  const config = testConfig(overrides)
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    await run(built, store)
  } finally {
    await built.close()
  }
}

const models = (built: Built, raw: string) => built.app.inject({
  method: 'GET',
  url: '/v1/models',
  headers: { authorization: `Bearer ${raw}` },
  remoteAddress: IP,
})

const chat = (built: Built, raw: string) => built.app.inject({
  method: 'POST',
  url: '/v1/chat/completions',
  headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
  payload: { messages: [{ role: 'user', content: 'hi' }] },
  remoteAddress: IP,
})

test('the switch off keeps one IP bucket and publishes no tenant label', async () => {
  resetMetrics()
  await withGateway({ gatewayTenantMetering: 'off' }, async (built, store) => {
    const a = makeUser(store, { login: 'off-a', status: 'approved' })
    const b = makeUser(store, { login: 'off-b', status: 'approved' })
    const tokenA = tokenFor(store, a.id, 'tok_off_a')
    const tokenB = tokenFor(store, b.id, 'tok_off_b')

    for (let i = 0; i < LIMIT; i += 1) {
      const response = await models(built, tokenA)
      assert.equal(response.statusCode, 200, `request ${i + 1} of the window was refused with ${response.statusCode}`)
    }
    const refused = await models(built, tokenB)
    assert.equal(refused.statusCode, 429, 'a second user from the same address has a bucket of their own')
    assert.deepEqual(refused.json(), { error: { type: 'rate_limited', message: 'Too many gateway requests' } })

    const scrape = await built.app.inject({ method: 'GET', url: '/metrics' })
    assert.equal(scrape.statusCode, 200)
    assert.doesNotMatch(scrape.body, /tenant=/, 'the switch off must not publish a tenant series')
  })
})

test('the switch on meters each tenant and leaves the shared IP bucket intact', async () => {
  resetMetrics()
  await withGateway({ gatewayTenantMetering: 'on' }, async (built, store) => {
    const a = makeUser(store, { login: 'on-a', status: 'approved' })
    const b = makeUser(store, { login: 'on-b', status: 'approved' })
    store.createRepo({
      id: 'repo_metering', userId: a.id, owner: 'o', name: 'm', defaultBranch: 'main', tokenEnc: 'x',
      permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
    })
    const tokenA = tokenFor(store, a.id, 'tok_on_a')
    const tokenB = tokenFor(store, b.id, 'tok_on_b')
    const tokenRepo = tokenFor(store, a.id, 'tok_on_repo', 'repo_metering')

    for (const raw of [tokenA, tokenB, tokenRepo]) assert.equal((await models(built, raw)).statusCode, 200)

    const scrape = await built.app.inject({ method: 'GET', url: '/metrics' })
    assert.equal(scrape.statusCode, 200)
    // A repository token is one request counted twice: once for its user and
    // once for the repository, which is what makes the series usable next to a
    // per-user split.
    assert.match(scrape.body, new RegExp(`fledge_gateway_requests_total\\{tenant="user:${a.id}"\\} 2`))
    assert.match(scrape.body, new RegExp(`fledge_gateway_requests_total\\{tenant="user:${b.id}"\\} 1`))
    assert.match(scrape.body, /fledge_gateway_requests_total\{tenant="repo:repo_metering"\} 1/)

    // The metered request still spends the one bucket the address owns: three
    // calls are already in it, so 237 more fill the window and the next one is
    // refused whichever tenant sends it.
    for (let i = 3; i < LIMIT; i += 1) {
      const response = await models(built, tokenA)
      assert.equal(response.statusCode, 200, `request ${i + 1} of the window was refused with ${response.statusCode}`)
    }
    const refused = await models(built, tokenB)
    assert.equal(refused.statusCode, 429, 'metering split the address bucket into per-tenant buckets')
  })
})

test('with the switch on both 429 routes carry the bucket reset time', async (t) => {
  resetMetrics()
  const frozen = 1_700_000_000_000
  t.mock.timers.enable({ apis: ['Date'], now: frozen })
  const upstream = await startFakeServer(async (request, response) => {
    await readBody(request)
    json(response, 200, { id: 'x', choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { total_tokens: 1 } })
  })
  try {
    await withGateway({
      gatewayTenantMetering: 'on',
      llm: { baseUrl: `${upstream.url}/v1`, key: 'platform-key', model: 'platform-model', pricePerTokenUsd: 0.0000002 },
    }, async (built, store) => {
      const user = makeUser(store, { login: 'reset-user', status: 'approved' })
      store.setUserQuotaUnlimited(user.id, true)
      const raw = tokenFor(store, user.id, 'tok_reset')

      for (let i = 0; i < LIMIT; i += 1) {
        const response = await models(built, raw)
        assert.notEqual(response.statusCode, 429, `models request ${i + 1} was throttled early`)
      }
      const modelsRefused = await models(built, raw)
      assert.equal(modelsRefused.statusCode, 429)

      for (let i = 0; i < LIMIT; i += 1) {
        const response = await chat(built, raw)
        assert.notEqual(response.statusCode, 429, `chat request ${i + 1} was throttled early`)
      }
      const chatRefused = await chat(built, raw)
      assert.equal(chatRefused.statusCode, 429)

      const resetAt = frozen + WINDOW_MS
      const modelsBody = modelsRefused.json() as { error: { retryAt?: number } }
      const chatBody = chatRefused.json() as { error: { retryAt?: number } }
      assert.equal(modelsBody.error.retryAt, resetAt, 'the models 429 does not name the bucket reset time')
      assert.equal(chatBody.error.retryAt, resetAt, 'the chat 429 does not name the bucket reset time')
    })
  } finally {
    await upstream.close()
  }
})
