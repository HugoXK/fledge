import type { Config } from '../config.js'
import { clearGauge, incCounter, observeHistogram, setGauge } from './metrics.js'

// #282: the shared model router (`/home/xuke/work/model-router.mjs`, loopback)
// is a dependency this process could not see. This module is the only place
// that knows its wire shape; everything else reads a four-state observation.
//
// Two rules hold the design together:
//
//   - Fail closed on the reading, fail open on the service. An answer this code
//     cannot parse — a non-200, a truncated body, a missing or unknown `mode` —
//     is `unreachable`, never `ok`, because "I could not read it" is not
//     "it is fine". A one-key cooldown stays `rate-limited` and does not fail
//     readiness; only an unreachable router or one whose every key is capped
//     does.
//   - Nothing the router says about credentials leaves this module. The
//     observation carries a state, a latency and the per-key numbers used for
//     gauges; the four state names and the three fixed key aliases are this
//     file's own vocabulary, never a string copied from the response.

/** The four states an operator can be shown. */
export type RouterState = 'ok' | 'rate-limited' | 'budget-exhausted' | 'unreachable'

export interface RouterObservation {
  state: RouterState
  /** Round-trip time of the health call, in milliseconds. */
  latencyMs: number
  /**
   * True only when every provider key the router reports is capped by rate or
   * by budget. This, not `state`, is what fails readiness: `mode: rate` on the
   * router means at least one key is cooling, which is still service.
   */
  allKeysCapped: boolean
}

/** Fixed aliases, so a label can never be a string the router invented. */
const KEY_ALIASES = ['primary', 'alt', 'third'] as const

// Every gauge this module publishes except `fledge_router_up`, removed as a
// whole. `fledge_router_key_spend` and `fledge_router_key_max` exist only as
// `{key=…}` children, so `clearGauge(name)` without labels would leave them at
// the last reading while `fledge_router_up` says 0 — the stale-gauge case #758
// forbids (#282 review). Enumerating the fixed aliases is safe: the label set is
// this module's own vocabulary, not something the router can extend.
function clearReadingGauges(): void {
  for (const alias of KEY_ALIASES) {
    clearGauge('fledge_router_key_spend', { key: alias })
    clearGauge('fledge_router_key_max', { key: alias })
  }
  clearGauge('fledge_router_rate_cooldown_seconds')
  clearGauge('fledge_router_budget_cooldown_seconds')
  clearGauge('fledge_router_queue_depth')
}

// A public `/readyz` must not become a way to hammer the loopback router: a
// monitor polls it far more often than a tick runs, and a flood of readiness
// calls would otherwise turn one unauthenticated endpoint into outbound
// traffic. A short cache is the cheapest bound that keeps the answer honest.
const CACHE_MS = 2_000

interface KeyReading {
  spend: number | null
  max: number | null
  rateCooldownSeconds: number
  budgetCooldownSeconds: number
}

interface Reading {
  observation: RouterObservation
  keys: Map<(typeof KEY_ALIASES)[number], KeyReading>
  queueDepth: number | null
}

const numberOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

const secondsUntil = (ms: number | null, nowMs: number): number => (ms === null ? 0 : Math.max(0, (ms - nowMs) / 1000))

function healthUrl(url: string): string {
  return url.endsWith('/healthz') ? url : `${url.replace(/\/$/, '')}/healthz`
}

function readKeys(raw: unknown, nowMs: number): Map<(typeof KEY_ALIASES)[number], KeyReading> {
  const keys = new Map<(typeof KEY_ALIASES)[number], KeyReading>()
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  for (const alias of KEY_ALIASES) {
    // Only a key the router actually reported is read: "every key is capped"
    // must mean every key it told us about, not three aliases this file invented
    // and then found free because they were absent.
    if (!Object.hasOwn(source, alias)) continue
    const entry = source[alias]
    const record = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {}
    keys.set(alias, {
      spend: numberOrNull(record.spend),
      max: numberOrNull(record.max),
      rateCooldownSeconds: secondsUntil(numberOrNull(record.rateUntil), nowMs),
      budgetCooldownSeconds: secondsUntil(numberOrNull(record.budgetUntil), nowMs),
    })
  }
  return keys
}

function readQueueDepth(raw: unknown): number | null {
  if (typeof raw !== 'object' || raw === null) return null
  return numberOrNull((raw as Record<string, unknown>).depth)
}

/**
 * Turn a router health answer into an observation. Exported so the mapping can
 * be tested directly; every caller in the process goes through `probeRouter`.
 */
export function interpretHealth(payload: unknown, nowMs = Date.now()): { state: RouterState; allKeysCapped: boolean; keys: Map<(typeof KEY_ALIASES)[number], KeyReading>; queueDepth: number | null } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { state: 'unreachable', allKeysCapped: false, keys: new Map(), queueDepth: null }
  }
  const body = payload as Record<string, unknown>
  const mode = body.mode
  if (mode !== 'primary' && mode !== 'rate' && mode !== 'budget') {
    // An unknown mode is not "probably fine": it means this code no longer
    // understands the router, which is exactly the state a probe must shout.
    return { state: 'unreachable', allKeysCapped: false, keys: new Map(), queueDepth: null }
  }
  const keys = readKeys(body.keys, nowMs)
  const readings = [...keys.values()]
  const rateCappedEverywhere = readings.length > 0 && readings.every((key) => key.rateCooldownSeconds > 0)
  const budgetCappedEverywhere = readings.length > 0 && readings.every((key) => key.budgetCooldownSeconds > 0)
  const state: RouterState = mode === 'budget' ? 'budget-exhausted' : mode === 'rate' ? 'rate-limited' : 'ok'
  return { state, allKeysCapped: rateCappedEverywhere || budgetCappedEverywhere, keys, queueDepth: readQueueDepth(body.queue) }
}

function record(reading: Reading, state: RouterState): void {
  const { observation, keys, queueDepth } = reading
  observeHistogram('fledge_router_probe_seconds', observation.latencyMs / 1000, {}, 'Seconds spent reading the model router health')
  setGauge('fledge_router_up', state === 'unreachable' ? 0 : 1, {}, '1 when the last model router probe answered')
  if (state === 'unreachable') {
    incCounter('fledge_router_unreachable_total', {}, 1, 'Model router probes that could not read a health answer')
    // An unreachable router has no numbers to publish. A stale gauge is worse
    // than an absent one (#758): drop every series — the per-key gauges are
    // labeled children, not the unlabeled series — rather than leave last
    // tick's spend on a dashboard as if it were current.
    clearReadingGauges()
    return
  }
  if (state === 'rate-limited') incCounter('fledge_router_mode_rate_total', {}, 1, 'Model router probes answered in rate mode')
  if (state === 'budget-exhausted') incCounter('fledge_router_mode_budget_total', {}, 1, 'Model router probes answered in budget mode')
  // The `all_keys` names are only incremented when the per-key reading says
  // every key is capped; naming a partial cooldown `all_keys` would publish a
  // false statement in the metric namespace. A cap with more than one cause
  // (one key budget-capped, the others rate-capped) increments neither name:
  // the counters exist to say *why* nothing can serve, and `router.state` is
  // where a mixed cause is reported, not a counter whose name would overstate
  // one of them (#282 review).
  if (observation.allKeysCapped) {
    const readings = [...keys.values()]
    const budgetCappedEverywhere = readings.length > 0 && readings.every((key) => key.budgetCooldownSeconds > 0)
    const anyBudgetCapped = readings.some((key) => key.budgetCooldownSeconds > 0)
    const rateCappedEverywhere = readings.length > 0 && readings.every((key) => key.rateCooldownSeconds > 0)
    if (budgetCappedEverywhere) incCounter('fledge_router_all_keys_exhausted_total', {}, 1, 'Model router probes where every key was capped by budget')
    else if (rateCappedEverywhere && !anyBudgetCapped) incCounter('fledge_router_all_keys_rate_limited_total', {}, 1, 'Model router probes where every key was capped by rate')
  }
  if (keys.size === 0) {
    clearReadingGauges()
    return
  }
  let rateCooldown = 0
  let budgetCooldown = 0
  for (const [alias, key] of keys) {
    if (key.spend !== null) setGauge('fledge_router_key_spend', key.spend, { key: alias }, 'Provider spend reported by the model router')
    else clearGauge('fledge_router_key_spend', { key: alias })
    if (key.max !== null) setGauge('fledge_router_key_max', key.max, { key: alias }, 'Provider budget reported by the model router')
    else clearGauge('fledge_router_key_max', { key: alias })
    rateCooldown = Math.max(rateCooldown, key.rateCooldownSeconds)
    budgetCooldown = Math.max(budgetCooldown, key.budgetCooldownSeconds)
  }
  setGauge('fledge_router_rate_cooldown_seconds', rateCooldown, {}, 'Longest rate cooldown across router keys')
  setGauge('fledge_router_budget_cooldown_seconds', budgetCooldown, {}, 'Longest budget cooldown across router keys')
  if (queueDepth === null) clearGauge('fledge_router_queue_depth')
  else setGauge('fledge_router_queue_depth', queueDepth, {}, 'Requests waiting in the model router queue')
}

/** One health call. Never throws: every failure is an `unreachable` reading. */
export async function probeRouter(config: Config, timeoutMs = config.router.timeoutMs): Promise<RouterObservation> {
  const started = performance.now()
  const elapsed = (): number => Math.round(performance.now() - started)
  let payload: unknown
  try {
    const response = await fetch(healthUrl(config.router.url), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`router health ${response.status}`)
    payload = await response.json()
  } catch {
    const reading: Reading = { observation: { state: 'unreachable', latencyMs: elapsed(), allKeysCapped: false }, keys: new Map(), queueDepth: null }
    record(reading, 'unreachable')
    return reading.observation
  }
  const interpreted = interpretHealth(payload)
  const reading: Reading = { observation: { state: interpreted.state, latencyMs: elapsed(), allKeysCapped: interpreted.allKeysCapped }, keys: interpreted.keys, queueDepth: interpreted.queueDepth }
  record(reading, interpreted.state)
  return reading.observation
}

let cache: { url: string; at: number; value: Promise<RouterObservation> } | null = null

/**
 * The probe behind `/readyz`. A caller that arrives within the cache window
 * reuses the same in-flight or settled reading, so a monitor's cadence — not an
 * unauthenticated caller's — decides how often the router is asked.
 */
export function cachedRouterProbe(config: Config): Promise<RouterObservation> {
  if (config.router.url === '') return Promise.resolve({ state: 'ok', latencyMs: 0, allKeysCapped: false })
  const now = Date.now()
  if (cache !== null && cache.url === config.router.url && now - cache.at < CACHE_MS) return cache.value
  const value = probeRouter(config)
  cache = { url: config.router.url, at: now, value }
  return value
}

/** Test seam: a suite that wants two different readings from one URL. */
export function resetRouterProbeCache(): void {
  cache = null
}
