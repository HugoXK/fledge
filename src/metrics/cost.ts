/**
 * #636: request-level model cost.
 *
 * The ledger keeps a snapshot of the price a request was charged at, so a later
 * price change never rewrites history, and a request that cannot be priced is
 * `unknown` rather than a free call. A per-token price in USD cannot answer
 * either question on its own: it carries no model, no currency and no cache
 * rate, and `0` is both "free" and "we do not know".
 */

export interface ModelPrice {
  model: string
  currency: string
  inputPerToken: number
  outputPerToken: number
  cachedInputPerToken: number
}

export type PriceSnapshot = ModelPrice

export type UnknownReason = 'no_price' | 'no_usage' | 'no_tokens'

export interface KnownRequestCost {
  known: true
  model: string
  currency: string
  amount: number
  snapshot: PriceSnapshot
  tokens: { input: number; cached: number; completion: number }
}

export interface UnknownRequestCost {
  known: false
  model: string
  reason: UnknownReason
}

export type RequestCost = KnownRequestCost | UnknownRequestCost

export type PriceTable = Map<string, ModelPrice>

function count(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function money(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * A price table is configuration, not a security boundary: a malformed entry is
 * dropped, which makes that model `unknown` at pricing time. A malformed table
 * therefore under-reports cost but can never invent a price.
 */
export function parsePriceTable(json: string | null | undefined): PriceTable {
  const table: PriceTable = new Map()
  if (json === null || json === undefined || json.trim() === '') return table
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return table
  }
  if (!Array.isArray(parsed)) return table
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const model = typeof record.model === 'string' ? record.model.trim() : ''
    const currency = typeof record.currency === 'string' ? record.currency.trim().toUpperCase() : ''
    const input = money(record.inputPerToken)
    const output = money(record.outputPerToken)
    const cached = money(record.cachedInputPerToken)
    if (model === '' || !/^[A-Z]{3}$/.test(currency)) continue
    if (input === null || output === null || cached === null) continue
    table.set(model, { model, currency, inputPerToken: input, outputPerToken: output, cachedInputPerToken: cached })
  }
  return table
}

/** The single platform price, as a one-entry table in USD, for a config that predates the table. */
export function fallbackPriceTable(model: string, pricePerTokenUsd: number): PriceTable {
  const table: PriceTable = new Map()
  const price = money(pricePerTokenUsd)
  if (model.trim() === '' || price === null) return table
  table.set(model, { model, currency: 'USD', inputPerToken: price, outputPerToken: price, cachedInputPerToken: price })
  return table
}

function cachedTokens(record: Record<string, unknown>, input: number): number {
  const details = record.prompt_tokens_details
  const nested = details !== null && typeof details === 'object'
    ? count((details as Record<string, unknown>).cached_tokens)
    : null
  // DeepSeek reports the same quantity as prompt_cache_hit_tokens.
  const flat = count(record.prompt_cache_hit_tokens)
  const cached = nested ?? flat ?? 0
  return Math.min(input, Math.max(0, cached))
}

/**
 * A cached token is a subset of the input tokens, so it is charged at the cached
 * price instead of the input price; charging both would bill it twice.
 */
export function requestCost(usage: unknown, model: string, table: PriceTable): RequestCost {
  const price = table.get(model)
  if (price === undefined) return { known: false, model, reason: 'no_price' }
  if (usage === null || typeof usage !== 'object') return { known: false, model, reason: 'no_usage' }
  const record = usage as Record<string, unknown>
  const prompt = count(record.prompt_tokens)
  const completion = count(record.completion_tokens)
  const total = count(record.total_tokens)
  if (prompt === null && completion === null && total === null) return { known: false, model, reason: 'no_tokens' }
  const output = completion ?? 0
  // No prompt count but a total still bounds the input tokens from below; the
  // call is priced, and the caller reports the total as a lower bound.
  const input = prompt ?? Math.max(0, (total ?? 0) - output)
  const cached = cachedTokens(record, input)
  const amount = (input - cached) * price.inputPerToken + cached * price.cachedInputPerToken + output * price.outputPerToken
  return {
    known: true,
    model,
    currency: price.currency,
    amount,
    snapshot: { ...price },
    tokens: { input, cached, completion: output },
  }
}

export interface CostBucket {
  currency: string
  amount: number
  requests: number
}

export interface CostReport {
  buckets: CostBucket[]
  unknownRequests: number
  /** `lower_bound` while any request in the window is unknown. */
  semantics: 'exact' | 'lower_bound'
}
