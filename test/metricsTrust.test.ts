import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { assertProductionConfig, type Config } from '../src/config.js'
import { MemoryMailer, testConfig } from './helpers.js'
import { resetMetrics } from '../src/lib/metrics.js'

async function build(overrides: Partial<Config> = {}) {
  const config = testConfig(overrides)
  const store = new Store(':memory:')
  const app = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  return app
}

const PUBLIC_PEER = '203.0.113.9'

test('a forged X-Forwarded-For cannot make a public /metrics request look loopback', async () => {
  // The reproduction in the issue: with `trustProxy: true`, an X-Forwarded-For of
  // 127.0.0.1 made a request from a public peer resolve to loopback and skip the
  // 403. TRUST_PROXY names the hop, so a header from an untrusted peer is ignored.
  resetMetrics()
  const built = await build()
  try {
    const forged = await built.app.inject({ method: 'GET', url: '/metrics', remoteAddress: PUBLIC_PEER, headers: { 'x-forwarded-for': '127.0.0.1' } })
    assert.equal(forged.statusCode, 403, 'a public peer with a forged loopback header must not read metrics')
    const chained = await built.app.inject({ method: 'GET', url: '/metrics', remoteAddress: PUBLIC_PEER, headers: { 'x-forwarded-for': '127.0.0.1, 198.51.100.7' } })
    assert.equal(chained.statusCode, 403)
    const loopback = await built.app.inject({ method: 'GET', url: '/metrics', remoteAddress: '127.0.0.1' })
    assert.equal(loopback.statusCode, 200, 'a genuine loopback peer keeps the fallback outside production')
  } finally {
    await built.close()
  }
})

test('the metrics token is accepted only from the Authorization header, never the query string', async () => {
  // #127 D2: a query token lands in the access log, browser history and referrers,
  // so it must never authenticate anything.
  resetMetrics()
  const built = await build({ metrics: { token: 'metrics-secret' } })
  try {
    const viaQuery = await built.app.inject({ method: 'GET', url: '/metrics?token=metrics-secret' })
    assert.equal(viaQuery.statusCode, 401, 'a correct token in the query string must not authenticate')
    const wrong = await built.app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer nope' } })
    assert.equal(wrong.statusCode, 401)
    const missing = await built.app.inject({ method: 'GET', url: '/metrics' })
    assert.equal(missing.statusCode, 401)
    const allowed = await built.app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer metrics-secret' } })
    assert.equal(allowed.statusCode, 200)
    assert.match(allowed.body, /fledge_http_requests_total/)
  } finally {
    await built.close()
  }
})

test('the metrics limiter is keyed by the real peer, so a rotating header cannot buy a fresh bucket', async () => {
  resetMetrics()
  const built = await build({ metrics: { token: 'metrics-secret' } })
  try {
    // The api bucket is 120 requests a minute. A header-derived key would give every
    // request its own bucket and never reach the limit.
    let throttled = 0
    for (let index = 0; index < 130; index += 1) {
      const response = await built.app.inject({
        method: 'GET',
        url: '/metrics',
        remoteAddress: PUBLIC_PEER,
        headers: { authorization: 'Bearer metrics-secret', 'x-forwarded-for': `10.0.0.${index % 250}` },
      })
      if (response.statusCode === 429) throttled += 1
    }
    assert.ok(throttled > 0, 'the same real peer must share one bucket however the forwarded header changes')
  } finally {
    await built.close()
  }
})

test('production refuses to start without METRICS_TOKEN and with a non-https notification webhook', async () => {
  // buildApp() is the gate src/index.ts calls unguarded, so this is the real
  // startup path: a refusal here means the process never listens.
  const noToken: Config = testConfig({ env: 'production', metrics: { token: '' }, notifyWebhookUrl: 'https://hooks.example.com/fledge' })
  await assert.rejects(
    () => buildApp({ config: noToken, store: new Store(':memory:'), mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false }),
    /METRICS_TOKEN/,
    'production must not start with an unauthenticated /metrics',
  )

  const plainHttp: Config = testConfig({ env: 'production', metrics: { token: 'metrics-secret' }, notifyWebhookUrl: 'http://hooks.example.com/fledge' })
  assert.throws(() => assertProductionConfig(plainHttp), /NOTIFY_WEBHOOK_URL/, 'an http webhook would send the alert payload and bearer secret in cleartext')

  const relative: Config = testConfig({ env: 'production', metrics: { token: 'metrics-secret' }, notifyWebhookUrl: '/hooks/fledge' })
  assert.throws(() => assertProductionConfig(relative), /NOTIFY_WEBHOOK_URL/)
})

test('production starts with a token and an https webhook, and dev and test keep the permissive forms', async () => {
  const production: Config = testConfig({ env: 'production', metrics: { token: 'metrics-secret' }, notifyWebhookUrl: 'https://hooks.example.com/fledge' })
  assertProductionConfig(production)

  const development: Config = testConfig({ env: 'development', metrics: { token: '' }, notifyWebhookUrl: 'http://127.0.0.1:9999/hook' })
  assert.doesNotThrow(() => assertProductionConfig(development))

  const testing: Config = testConfig({ env: 'test', metrics: { token: '' }, notifyWebhookUrl: 'http://127.0.0.1:9999/hook' })
  assert.doesNotThrow(() => assertProductionConfig(testing))

  // A production config without a webhook at all is fine: nothing is sent.
  const noWebhook: Config = testConfig({ env: 'production', metrics: { token: 'metrics-secret' }, notifyWebhookUrl: '' })
  assert.doesNotThrow(() => assertProductionConfig(noWebhook))

  resetMetrics()
  const built = await build({ metrics: { token: 'metrics-secret' } })
  try {
    const allowed = await built.app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer metrics-secret' } })
    assert.equal(allowed.statusCode, 200)
  } finally {
    await built.close()
  }
})
