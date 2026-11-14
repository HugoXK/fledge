import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { randomToken, sha256Hex } from '../src/lib/secrets.js'
import { MockRunner } from '../src/jobs/mock.js'
import { parsePriceTable, requestCost } from '../src/metrics/cost.js'
import { json, makeUser, MemoryMailer, readBody, startFakeServer, testConfig } from './helpers.js'

// #636: a request is priced from a snapshot taken at the time of the call, and a
// missing price or a missing usage block is `unknown`, never a free call.
const table = parsePriceTable(JSON.stringify([
  { model: 'model-a', currency: 'USD', inputPerToken: 0.000001, outputPerToken: 0.000002, cachedInputPerToken: 0.0000001 },
  { model: 'model-cny', currency: 'CNY', inputPerToken: 0.00001, outputPerToken: 0.00002, cachedInputPerToken: 0.000001 },
]))

test('a request carries the price snapshot it was charged at', () => {
  const priced = requestCost({ prompt_tokens: 1000, completion_tokens: 500 }, 'model-a', table)
  assert.equal(priced.known, true)
  if (!priced.known) return
  assert.equal(priced.currency, 'USD')
  assert.equal(priced.snapshot.inputPerToken, 0.000001)
  assert.equal(Number(priced.amount.toFixed(10)), 0.002)

  const repriced = parsePriceTable(JSON.stringify([
    { model: 'model-a', currency: 'USD', inputPerToken: 0.00001, outputPerToken: 0.00002, cachedInputPerToken: 0.000001 },
  ]))
  const later = requestCost({ prompt_tokens: 1000, completion_tokens: 500 }, 'model-a', repriced)
  assert.equal(later.known, true)
  if (!later.known) return
  // The first request keeps its snapshot even though the table now says 10x.
  assert.equal(Number(priced.amount.toFixed(10)), 0.002)
  assert.equal(Number(later.amount.toFixed(10)), 0.02)
})

test('cached tokens are a subset of input and are charged at the cached price', () => {
  const priced = requestCost({
    prompt_tokens: 1000,
    completion_tokens: 500,
    prompt_tokens_details: { cached_tokens: 400 },
  }, 'model-a', table)
  assert.equal(priced.known, true)
  if (!priced.known) return
  assert.equal(priced.tokens.cached, 400)
  assert.equal(priced.tokens.input, 1000)
  // 600 billable input at 1e-6, 400 cached at 1e-7, 500 output at 2e-6.
  assert.equal(Number(priced.amount.toFixed(10)), 0.00164)
})

test('DeepSeek prompt_cache_hit_tokens is read as cached input', () => {
  const priced = requestCost({ prompt_tokens: 1000, completion_tokens: 0, prompt_cache_hit_tokens: 1000 }, 'model-a', table)
  assert.equal(priced.known, true)
  if (!priced.known) return
  assert.equal(priced.tokens.cached, 1000)
  assert.equal(Number(priced.amount.toFixed(10)), 0.0001)
})

test('a model with no price is unknown, never zero', () => {
  const priced = requestCost({ prompt_tokens: 10, completion_tokens: 5 }, 'unpriced-model', table)
  assert.equal(priced.known, false)
  if (priced.known) return
  assert.equal(priced.reason, 'no_price')
})

test('a missing usage block is unknown, never zero', () => {
  const priced = requestCost(null, 'model-a', table)
  assert.equal(priced.known, false)
  if (priced.known) return
  assert.equal(priced.reason, 'no_usage')
})

test('a usage block with no token count is unknown, never zero', () => {
  const priced = requestCost({}, 'model-a', table)
  assert.equal(priced.known, false)
  if (priced.known) return
  assert.equal(priced.reason, 'no_tokens')
})

test('currency buckets stay separate and unknown requests make the total a lower bound', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'meter', status: 'approved' })
    const usd = requestCost({ prompt_tokens: 100, completion_tokens: 0 }, 'model-a', table)
    const cny = requestCost({ prompt_tokens: 100, completion_tokens: 0 }, 'model-cny', table)
    assert.equal(usd.known && cny.known, true)
    if (!usd.known || !cny.known) return
    store.recordUsage(user.id, null, usd.amount, null, null, { currency: usd.currency, model: usd.snapshot.model, priceSnapshot: JSON.stringify(usd.snapshot) })
    store.recordUsage(user.id, null, cny.amount, null, null, { currency: cny.currency, model: cny.snapshot.model, priceSnapshot: JSON.stringify(cny.snapshot) })
    store.recordUsage(user.id, null, 0, null, null, { currency: null, model: 'unpriced-model', priceSnapshot: null, known: false })

    const report = store.costByCurrency('2000-01-01T00:00:00.000Z')
    const usdBucket = report.buckets.find((bucket) => bucket.currency === 'USD')
    const cnyBucket = report.buckets.find((bucket) => bucket.currency === 'CNY')
    assert.equal(usdBucket?.requests, 1)
    assert.equal(cnyBucket?.requests, 1)
    assert.equal(Number(usdBucket?.amount.toFixed(10)), 0.0001)
    assert.equal(Number(cnyBucket?.amount.toFixed(10)), 0.001)
    assert.equal(report.unknownRequests, 1)
    assert.equal(report.semantics, 'lower_bound')
  } finally {
    store.close()
  }
})

test('a job whose only ledger row is unknown still reads as an unknown cost', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'meter2', status: 'approved' })
    store.recordUsage(user.id, 'job_unknown', 0, null, null, { currency: null, model: 'unpriced-model', priceSnapshot: null, known: false })
    // #357: the per-job refusal keys on "no known ledger row", so an unknown row
    // must not be read as a zero-priced one.
    assert.equal(store.usageCountForJob('job_unknown'), 0)
    assert.equal(store.unknownUsageCountForJob('job_unknown'), 1)
  } finally {
    store.close()
  }
})

async function gatewayFor(options: { model: string; priceTable?: string; usage: unknown; headers?: Record<string, string> }): Promise<{ hit: () => number; close: () => Promise<void>; store: Store; user: ReturnType<typeof makeUser>; call: () => Promise<{ statusCode: number }> }> {
  let hits = 0
  const platform = await startFakeServer(async (request, response) => {
    hits += 1
    await readBody(request)
    json(response, 200, {
      id: 'x',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      ...(options.usage === null ? {} : { usage: options.usage }),
    }, options.headers ?? {})
  })
  const config = testConfig({
    llm: { baseUrl: `${platform.url}/v1`, key: 'platform-key', model: options.model, pricePerTokenUsd: 0.0000002, ...(options.priceTable === undefined ? {} : { priceTable: options.priceTable }) },
  })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  const user = makeUser(store, { login: `gw${Math.random().toString(36).slice(2, 8)}`, status: 'approved', quota: 100 })
  const raw = `flg_${randomToken(32)}`
  store.createApiToken({ id: `tok_${Math.random().toString(36).slice(2, 8)}`, userId: user.id, kind: 'pat', name: 'test', tokenHash: sha256Hex(raw), prefix: raw.slice(0, 8), expiresAt: null })
  return {
    hit: () => hits,
    close: async () => { await platform.close(); store.close() },
    store,
    user,
    call: async () => built.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      payload: { model: options.model, messages: [{ role: 'user', content: 'hi' }] },
    }),
  }
}

test('the gateway records the snapshot it charged, not the price of the row', async () => {
  const table = JSON.stringify([
    { model: 'gw-model', currency: 'USD', inputPerToken: 0.000001, outputPerToken: 0.000002, cachedInputPerToken: 0.0000001 },
  ])
  const gateway = await gatewayFor({ model: 'gw-model', priceTable: table, usage: { prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 400 } } })
  try {
    const answer = await gateway.call()
    assert.equal(answer.statusCode, 200)
    assert.equal(gateway.hit(), 1)
    const row = gateway.store.get<{ cost_usd: number; currency: string | null; model: string | null; price_snapshot: string | null; cost_known: number }>(
      'SELECT cost_usd, currency, model, price_snapshot, cost_known FROM quota_ledger ORDER BY id DESC LIMIT 1',
    )
    assert.equal(row?.currency, 'USD')
    assert.equal(row?.model, 'gw-model')
    assert.equal(row?.cost_known, 1)
    assert.equal(Number(row?.cost_usd.toFixed(10)), 0.00164)
    assert.deepEqual(JSON.parse(String(row?.price_snapshot)), { model: 'gw-model', currency: 'USD', inputPerToken: 0.000001, outputPerToken: 0.000002, cachedInputPerToken: 0.0000001 })
    // The spend the quota is checked against is the same figure the row carries.
    assert.equal(Number(gateway.store.usageTotal(gateway.user.id).toFixed(10)), 0.00164)
  } finally {
    await gateway.close()
  }
})

test('the gateway records an unpriced model as unknown and says so in the audit log', async () => {
  // A configured table that does not list this model, which is the shape a new
  // provider has before someone adds its prices.
  const table = JSON.stringify([{ model: 'some-other-model', currency: 'USD', inputPerToken: 0.000001, outputPerToken: 0.000002, cachedInputPerToken: 0.0000001 }])
  const gateway = await gatewayFor({ model: 'gw-unpriced', priceTable: table, usage: { prompt_tokens: 100, completion_tokens: 50 } })
  try {
    const answer = await gateway.call()
    assert.equal(answer.statusCode, 200)
    const row = gateway.store.get<{ cost_usd: number; cost_known: number; currency: string | null }>(
      'SELECT cost_usd, cost_known, currency FROM quota_ledger ORDER BY id DESC LIMIT 1',
    )
    assert.equal(row?.cost_known, 0)
    assert.equal(row?.cost_usd, 0)
    assert.equal(row?.currency, null)
    const audit = gateway.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'request.cost_unknown'")
    assert.equal(Number(audit?.n), 1)
    // An unknown call is not a free one: it must not move the spend it could not measure.
    assert.equal(gateway.store.usageTotal(gateway.user.id), 0)
    assert.equal(gateway.store.costByCurrency('2000-01-01T00:00:00.000Z').semantics, 'lower_bound')
  } finally {
    await gateway.close()
  }
})
