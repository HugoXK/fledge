import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { Jobs } from '../src/jobs/service.js'
import { metricsSnapshot, renderMetrics, resetMetrics } from '../src/lib/metrics.js'
import { resetRouterProbeCache } from '../src/lib/routerHealth.js'
import type { Config } from '../src/config.js'
import { json, makeUser, MemoryMailer, startFakeServer, testConfig } from './helpers.js'

// #282: the shared model router is a dependency this tree could not see. The
// probe is optional, the readiness answer fails only on a router that is
// unreachable or whose every key is capped, and nothing the router says about a
// provider key may reach the payload.

const RATE_UNTIL = new Date(Date.now() + 120_000).toISOString()
const BUDGET_UNTIL = new Date(Date.now() + 3_600_000).toISOString()

interface RouterKeyFixture {
  budgetUntil: number | null
  rateUntil: number | null
  spend: number | null
  max: number | null
}

function healthBody(mode: 'primary' | 'rate' | 'budget', keys: Record<string, RouterKeyFixture>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ok: true,
    mode,
    rateUntil: null,
    budgetUntil: null,
    primarySpend: keys.primary?.spend ?? null,
    primaryMax: keys.primary?.max ?? null,
    routed: 0,
    queue: { depth: 0, max: 2, maxWaitMs: 60_000 },
    altRatio: 0.3,
    weights: {},
    effectiveWeights: {},
    uptimeSeconds: 60,
    keys,
    ...extra,
  })
}

const ms = (iso: string): number => Date.parse(iso)
const free: RouterKeyFixture = { budgetUntil: null, rateUntil: null, spend: 0, max: 5 }

function withRouter(base: Config, url: string, timeoutMs = 400): Config {
  ;(base as unknown as { router: { url: string; timeoutMs: number } }).router = { url, timeoutMs }
  return base
}

async function startRouter(answer: (request: import('node:http').IncomingMessage) => { status?: number; body: string }): Promise<{ url: string; close: () => Promise<void>; hits: () => number }> {
  let hits = 0
  const server = await startFakeServer((request, response) => {
    hits += 1
    const result = answer(request)
    json(response, result.status ?? 200, JSON.parse(result.body))
  })
  return { ...server, hits: () => hits }
}

async function readyz(config: Config): Promise<{ status: number; body: string; parsed: Record<string, unknown> }> {
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const response = await built.app.inject({ method: 'GET', url: '/readyz' })
    return { status: response.statusCode, body: response.body, parsed: response.json() as Record<string, unknown> }
  } finally {
    // buildApp owns the store on close; closing it twice is an error.
    await built.close()
  }
}

test('an unset MODEL_ROUTER_URL leaves the readiness body exactly as it is today', async () => {
  resetMetrics()
  const router = await startRouter(() => ({ body: healthBody('rate', {}) }))
  try {
    const config = testConfig()
    ;(config as unknown as { router: { url: string; timeoutMs: number } }).router = { url: '', timeoutMs: 400 }
    const first = await readyz(config)
    assert.equal(first.status, 200)
    assert.deepEqual(first.parsed, {
      ok: true,
      db: true,
      instances: { ready: 0, failed: 0, total: 0 },
      clock: { skewSeconds: null, measuredAt: null, thresholdSeconds: 120, state: 'not-configured', source: 'github' },
    })
    assert.equal(router.hits(), 0, 'an unconfigured router is never contacted')
    const series = metricsSnapshot()
    assert.equal(series.counters.some((entry) => entry.name.startsWith('fledge_router_')), false, 'no router series without a router')
  } finally {
    await router.close()
  }
})

// #282 decision: `mode: rate` on one key is a detail, not a readiness failure —
// the process keeps answering 200 while another key can still serve.
test('a router cooling one key reports rate-limited and keeps readiness', async () => {
  resetMetrics()
  const router = await startRouter(() => ({
    body: healthBody('rate', { primary: { budgetUntil: null, rateUntil: ms(RATE_UNTIL), spend: 1, max: 5 }, alt: free, third: free }),
  }))
  try {
    const answer = await readyz(withRouter(testConfig(), router.url))
    assert.equal(answer.status, 200)
    assert.equal(answer.parsed.ok, true)
    const routerField = answer.parsed.router as { state: string; latencyMs: number }
    assert.equal(routerField.state, 'rate-limited')
    assert.equal(typeof routerField.latencyMs, 'number')
    assert.ok(Number.isFinite(routerField.latencyMs) && routerField.latencyMs >= 0)
    assert.equal(typeof answer.parsed.db, 'boolean')
    assert.equal(answer.parsed.db, true)
    const series = metricsSnapshot()
    assert.equal(series.counters.some((entry) => entry.name === 'fledge_router_mode_rate_total'), true)
    assert.equal(series.counters.some((entry) => entry.name === 'fledge_router_all_keys_rate_limited_total'), false, 'one cooling key is not every key')
  } finally {
    await router.close()
  }
})

test('every key capped by rate fails readiness and counts the all-keys condition', async () => {
  resetMetrics()
  const rate = { budgetUntil: null, rateUntil: ms(RATE_UNTIL), spend: 1, max: 5 }
  const router = await startRouter(() => ({ body: healthBody('rate', { primary: rate, alt: rate, third: rate }) }))
  try {
    const answer = await readyz(withRouter(testConfig(), router.url))
    assert.equal(answer.status, 503)
    assert.equal(answer.parsed.ok, false)
    assert.equal((answer.parsed.router as { state: string }).state, 'rate-limited')
    assert.equal(answer.parsed.db, true, 'the database field still tells the truth')
    const series = metricsSnapshot()
    const allCapped = series.counters.find((entry) => entry.name === 'fledge_router_all_keys_rate_limited_total')
    assert.notEqual(allCapped, undefined)
    assert.ok((allCapped?.value ?? 0) >= 1)
    assert.equal(series.counters.some((entry) => entry.name === 'fledge_router_mode_rate_total'), true)
  } finally {
    await router.close()
  }
})

test('a budget-capped router reports budget-exhausted and fails readiness', async () => {
  resetMetrics()
  const capped = { budgetUntil: ms(BUDGET_UNTIL), rateUntil: null, spend: 5, max: 5 }
  const router = await startRouter(() => ({ body: healthBody('budget', { primary: capped, alt: capped, third: capped }) }))
  try {
    const answer = await readyz(withRouter(testConfig(), router.url))
    assert.equal(answer.status, 503)
    assert.equal(answer.parsed.ok, false)
    assert.equal((answer.parsed.router as { state: string }).state, 'budget-exhausted')
    const series = metricsSnapshot()
    assert.equal(series.counters.some((entry) => entry.name === 'fledge_router_all_keys_exhausted_total'), true)
    assert.equal(series.counters.some((entry) => entry.name === 'fledge_router_mode_budget_total'), true)
  } finally {
    await router.close()
  }
})

test('no listener on the router port is unreachable and the other readiness fields do not lie', async () => {
  resetMetrics()
  const router = await startRouter(() => ({ body: healthBody('primary', {}) }))
  const url = router.url
  await router.close()
  const answer = await readyz(withRouter(testConfig(), url, 300))
  assert.equal(answer.status, 503)
  assert.equal(answer.parsed.ok, false)
  assert.equal((answer.parsed.router as { state: string }).state, 'unreachable')
  assert.equal(answer.parsed.db, true)
  assert.deepEqual(answer.parsed.instances, { ready: 0, failed: 0, total: 0 })
  assert.equal((answer.parsed.clock as { state: string }).state, 'not-configured')
  const series = metricsSnapshot()
  assert.equal(series.counters.some((entry) => entry.name === 'fledge_router_unreachable_total'), true)
})

// #282: fail closed on the reading. A router that answers something this code
// cannot understand must read as unreachable, never as healthy.
test('a malformed, truncated, mode-less or non-200 health answer reads as unreachable', async () => {
  const shapes: Array<{ label: string; status?: number; body: string }> = [
    { label: 'truncated json', body: '{"ok":true,"mode":"primary","keys":' },
    { label: 'no mode', body: JSON.stringify({ ok: true, keys: {} }) },
    { label: 'mode is not a state', body: JSON.stringify({ ok: true, mode: 'banana', keys: {} }) },
    { label: 'not an object', body: '"ok"' },
    { label: '503 from the router', status: 503, body: JSON.stringify({ error: 'starting' }) },
  ]
  for (const shape of shapes) {
    const router = await startFakeServer((_request, response) => {
      if (shape.status !== undefined && shape.body.startsWith('{')) json(response, shape.status, JSON.parse(shape.body))
      else {
        response.writeHead(shape.status ?? 200, { 'content-type': 'application/json' })
        response.end(shape.body)
      }
    })
    try {
      const answer = await readyz(withRouter(testConfig(), router.url, 400))
      assert.equal(answer.status, 503, `${shape.label}: readiness must fail on an unreadable answer`)
      assert.equal(answer.parsed.ok, false, shape.label)
      assert.equal((answer.parsed.router as { state: string }).state, 'unreachable', shape.label)
      assert.equal(answer.parsed.db, true, `${shape.label}: the database field still tells the truth`)
    } finally {
      await router.close()
    }
  }
})

// #282 review finding: the removal guarantee has to remove the labeled children.
// `clearGauge(name)` without labels addresses one series, so the per-key
// `{key=…}` gauges survived an unreadable answer while `fledge_router_up` read 0
// — the stale-gauge case #758 forbids. Assert on the rendered scrape, not a
// snapshot, so the guarantee is checked where a dashboard reads it.
test('an unreadable answer after a readable one removes the per-key gauges too', async () => {
  resetMetrics()
  resetRouterProbeCache()
  const router = await startRouter(() => ({
    body: healthBody('primary', { primary: { budgetUntil: null, rateUntil: null, spend: 3, max: 5 }, alt: free, third: free }),
  }))
  const url = router.url
  const first = await readyz(withRouter(testConfig(), url, 400))
  assert.equal(first.status, 200)
  assert.match(renderMetrics(), /fledge_router_key_spend\{key="primary"\} 3/, 'the readable answer publishes the labeled gauge')
  await router.close()
  resetRouterProbeCache()
  const second = await readyz(withRouter(testConfig(), url, 300))
  assert.equal(second.status, 503)
  assert.equal((second.parsed.router as { state: string }).state, 'unreachable')
  const text = renderMetrics()
  assert.doesNotMatch(text, /fledge_router_key_spend\{/, 'a labeled spend series survived an unreadable answer')
  assert.doesNotMatch(text, /fledge_router_key_max\{/, 'a labeled budget series survived an unreadable answer')
  assert.doesNotMatch(text, /fledge_router_rate_cooldown_seconds/)
  assert.doesNotMatch(text, /fledge_router_budget_cooldown_seconds/)
  assert.doesNotMatch(text, /fledge_router_queue_depth/)
  assert.match(text, /^fledge_router_up 0$/m, 'the up gauge still reports 0')
})

// The second removal branch: a readable answer that reports no keys at all. The
// same stale-label defect, so the same assertion — otherwise it is the same bug
// six months from now.
test('an answer that reports no keys removes the per-key gauges from an earlier reading', async () => {
  resetMetrics()
  resetRouterProbeCache()
  let reportKeys = true
  const router = await startRouter(() => ({
    body: healthBody('primary', reportKeys ? { primary: { budgetUntil: null, rateUntil: null, spend: 2, max: 4 }, alt: free, third: free } : {}),
  }))
  const url = router.url
  try {
    const first = await readyz(withRouter(testConfig(), url, 400))
    assert.equal(first.status, 200)
    assert.match(renderMetrics(), /fledge_router_key_spend\{key="primary"\} 2/)
    reportKeys = false
    resetRouterProbeCache()
    const second = await readyz(withRouter(testConfig(), url, 400))
    assert.equal(second.status, 200, 'a readable answer with no keys is still a health answer')
    assert.equal((second.parsed.router as { state: string }).state, 'ok')
    const text = renderMetrics()
    assert.doesNotMatch(text, /fledge_router_key_spend\{/, 'a labeled spend series outlived the keys it described')
    assert.doesNotMatch(text, /fledge_router_key_max\{/)
    assert.doesNotMatch(text, /fledge_router_rate_cooldown_seconds/)
    assert.doesNotMatch(text, /fledge_router_budget_cooldown_seconds/)
  } finally {
    await router.close()
  }
})

// #282 review, non-blocking: a cap with two causes is not a single-cause event.
// The names are read by an operator as "why nothing can serve"; a set where one
// key is budget-capped and the rest are rate-capped must not be counted as
// either. Readiness is unchanged (503), and `router.state` still names the mode.
test('a mixed cap increments neither all-keys counter while readiness still fails', async () => {
  resetMetrics()
  resetRouterProbeCache()
  const budgetAndRate = { budgetUntil: ms(BUDGET_UNTIL), rateUntil: ms(RATE_UNTIL), spend: 5, max: 5 }
  const rateOnly = { budgetUntil: null, rateUntil: ms(RATE_UNTIL), spend: 1, max: 5 }
  const router = await startRouter(() => ({ body: healthBody('budget', { primary: budgetAndRate, alt: rateOnly, third: rateOnly }) }))
  try {
    const answer = await readyz(withRouter(testConfig(), router.url))
    assert.equal(answer.status, 503)
    assert.equal((answer.parsed.router as { state: string }).state, 'budget-exhausted')
    const text = renderMetrics()
    assert.doesNotMatch(text, /fledge_router_all_keys_rate_limited_total/, 'a mixed cap was counted as all-rate')
    assert.doesNotMatch(text, /fledge_router_all_keys_exhausted_total/, 'a mixed cap was counted as all-budget')
  } finally {
    await router.close()
  }
})

test('the readiness payload and the ops alert carry neither the provider key nor its name', async () => {
  resetMetrics()
  // Not `sk-` shaped on purpose: the repository's own secret scan reads tracked files, and a fixture that looks like an OpenAI key makes every future check red.
  const keyValue = 'fixture-provider-key-2f8a-do-not-print'
  const keyName = 'fixture-primary-key-name'
  const capped = { budgetUntil: ms(BUDGET_UNTIL), rateUntil: null, spend: 5, max: 5 }
  const router = await startRouter(() => ({
    body: JSON.stringify({
      ...JSON.parse(healthBody('budget', { primary: capped, alt: capped, third: capped })),
      // A router that volunteers credential material: none of it may reach a
      // payload, an alert or a label, and the assertion runs on the rendered
      // response rather than on a log line.
      providerKey: keyValue,
      keyName,
      keyFile: '/home/xuke/.model-router-primary-key',
      keys: {
        primary: { ...capped, keyValue, keyName, path: '/home/xuke/.model-router-primary-key' },
        alt: capped,
        third: capped,
      },
    }),
  }))
  try {
    const answer = await readyz(withRouter(testConfig(), router.url))
    assert.equal(answer.body.includes(keyValue), false, 'no provider key in /readyz')
    assert.equal(answer.body.includes(keyName), false, 'no key name in /readyz')

    const admin = testConfig({ github: { ...testConfig().github, adminLogin: 'router-ops-admin' } })
    const config = withRouter(admin, router.url)
    const store = new Store(':memory:')
    const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
    try {
      makeUser(store, { login: 'router-ops-admin', status: 'approved' })
      const sent = await jobs.notifyOpsAlerts()
      assert.equal(sent, 1, 'the router alert reaches the superadmin even with no repository')
      const notifications = store.listNotifications(store.userByLogin('router-ops-admin')?.id ?? '')
      assert.equal(notifications.length, 1)
      const text = notifications[0]?.message ?? ''
      assert.equal(text.includes(keyValue), false, 'no provider key in the alert text')
      assert.equal(text.includes(keyName), false, 'no key name in the alert text')
      assert.match(text, /router/i)
      assert.match(text, /budget-exhausted/)
      assert.equal(await jobs.notifyOpsAlerts(), 0, 'the existing cooldown holds the second pass')
    } finally {
      store.close()
    }
  } finally {
    await router.close()
  }
})

test('the router metrics carry spend, budget and cooldowns as gauges and no identifier labels', async () => {
  resetMetrics()
  const cooling = { budgetUntil: ms(BUDGET_UNTIL), rateUntil: ms(RATE_UNTIL), spend: 2, max: 8 }
  const router = await startRouter(() => ({
    body: JSON.stringify({
      ...JSON.parse(healthBody('rate', { primary: cooling, alt: cooling, third: cooling })),
      queue: { depth: 1, max: 2, maxWaitMs: 60_000 },
    }),
  }))
  try {
    await readyz(withRouter(testConfig(), router.url))
    const series = metricsSnapshot()
    const gauge = (name: string, labels: Record<string, string> = {}): number | undefined =>
      series.gauges.find((entry) => entry.name === name && Object.entries(labels).every(([key, value]) => entry.labels[key] === value))?.value
    assert.equal(gauge('fledge_router_up'), 1, 'a reachable router is up even when every key is capped')
    assert.equal(gauge('fledge_router_key_spend', { key: 'primary' }), 2)
    assert.equal(gauge('fledge_router_key_max', { key: 'primary' }), 8)
    assert.ok((gauge('fledge_router_rate_cooldown_seconds') ?? 0) > 0)
    assert.ok((gauge('fledge_router_budget_cooldown_seconds') ?? 0) > 0)
    assert.equal(gauge('fledge_router_queue_depth'), 1)
    for (const entry of series.gauges.filter((item) => item.name.startsWith('fledge_router_'))) {
      const labels = JSON.stringify(entry.labels)
      assert.equal(/sk-|@|repo_|repo[0-9]/.test(labels), false, `no identifier in a router label: ${labels}`)
    }
  } finally {
    await router.close()
  }
})

test('the prometheus rules and the docs describe the router target', () => {
  const rules = readFileSync(new URL('../deploy/prometheus/fledge-alerts.yml', import.meta.url), 'utf8')
  assert.match(rules, /alert: FledgeRouterUnavailable/)
  assert.match(rules, /fledge_router_up/)
  const observability = readFileSync(new URL('../docs/observability.md', import.meta.url), 'utf8')
  assert.match(observability, /MODEL_ROUTER_URL/)
  assert.match(observability, /fledge_router_up/)
  // The issue names a `MODEL_ROUTER_PARALLEL_WINDOW_MS` knob; the router has no
  // such variable, so the runbook documents the two it does have.
  assert.match(observability, /MODEL_ROUTER_RATE_WINDOW_MS/)
  assert.match(observability, /MODEL_ROUTER_QUEUE_DEPTH/)
  const deploy = readFileSync(new URL('../docs/deploy.md', import.meta.url), 'utf8')
  assert.match(deploy, /MODEL_ROUTER_URL/)
})
