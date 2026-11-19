// #635: the optional loop receiver. It is off unless the operator sets
// `PRODUCT_LOOP_WEBHOOK_URL`, and what it sends is the aggregate read model only:
// no repository digest, no row id, no account, no free text. The payload is
// built from `ProductLoopSnapshot` rather than from the table, so a field that
// is not a count or a duration cannot leave the process through this path.
import type { Config } from '../config.js'
import type { Store } from '../db.js'
import { NotificationWebhookError, postWebhook } from '../lib/webhook.js'
import type { ProductLoopSnapshot } from './product.js'

/** The settings marker that makes the push at most once per UTC day. */
export const PRODUCT_PUSH_KEY = 'product_push:last'

/** The window the scheduled push covers: the same 30 days the page opens on. */
export const PRODUCT_PUSH_WINDOW_DAYS = 30

export type ProductWebhookState = 'off' | 'duplicate' | 'sent' | 'retry' | 'blocked' | 'unknown'

export interface ProductWebhookOutcome {
  state: ProductWebhookState
  detail?: string
}

function durationValue(metric: { samples: number; medianMs: number | null }): number | 'unknown' {
  return metric.medianMs === null ? 'unknown' : metric.medianMs
}

function rateValue(value: number | null): number | 'unknown' {
  return value === null ? 'unknown' : value
}

/**
 * The body of a push. Every value is a count, a duration or a rate — the shape
 * is the boundary, so a later field cannot smuggle a digest in without changing
 * this function, and this function has no access to a row.
 */
export function productWebhookPayload(snapshot: ProductLoopSnapshot, windowDays: number, since: string): Record<string, unknown> {
  return {
    event: 'product.loop',
    window: { days: windowDays, since },
    funnel: { ...snapshot.funnel },
    durations: {
      to_first_job_ms: durationValue(snapshot.toFirstJob),
      to_first_pr_ms: durationValue(snapshot.toFirstPr),
      to_merge_ms: durationValue(snapshot.toMerge),
      samples: {
        to_first_job: snapshot.toFirstJob.samples,
        to_first_pr: snapshot.toFirstPr.samples,
        to_merge: snapshot.toMerge.samples,
      },
    },
    rescue: {
      failed: snapshot.rescue.failed,
      actions: snapshot.rescue.actions,
      rate: rateValue(snapshot.rescue.rate),
      mix: snapshot.rescue.mix.map((entry) => ({ action: entry.action, n: entry.n })),
    },
    returning: { ...snapshot.returning },
    evidence: {
      succeeded: snapshot.evidence.succeeded,
      with_pr: snapshot.evidence.withPr,
      with_cost: snapshot.evidence.withCost,
      complete_rate: rateValue(snapshot.evidence.completeRate),
      completed: snapshot.evidence.completed,
      unknown_cost: snapshot.evidence.unknownCost,
      unknown_cost_rate: rateValue(snapshot.evidence.unknownCostRate),
    },
  }
}

/** True when today's push has not happened yet, read from the marker, not a clock in memory. */
export function productPushDue(store: Store, now: number): boolean {
  const last = store.getSetting(PRODUCT_PUSH_KEY)
  if (last === undefined) return true
  return last.slice(0, 10) !== new Date(now).toISOString().slice(0, 10)
}

/**
 * Push the aggregate read model once per UTC day. Three refusals come before any
 * request: no configured URL, analytics switched off, and today's push already
 * recorded. A failed request leaves the marker unwritten, so the next tick
 * retries it instead of losing a day.
 */
export async function pushProductLoopWebhook(input: {
  store: Store
  config: Config
  now?: number
  fetch?: typeof fetch
  resolve?: (host: string) => Promise<Array<{ address: string; family: number }>>
}): Promise<ProductWebhookOutcome> {
  const { store, config } = input
  if (config.productWebhookUrl === '') return { state: 'off', detail: 'not-configured' }
  if (!store.productAnalyticsEnabled()) return { state: 'off', detail: 'analytics-off' }
  const now = input.now ?? Date.now()
  if (!productPushDue(store, now)) return { state: 'duplicate' }
  const at = new Date(now).toISOString()
  const since = new Date(now - PRODUCT_PUSH_WINDOW_DAYS * 86_400_000).toISOString()
  const body = JSON.stringify(productWebhookPayload(store.productLoopMetrics(since), PRODUCT_PUSH_WINDOW_DAYS, since))
  let response: Response
  try {
    response = await postWebhook(new URL(config.productWebhookUrl), body, {
      'content-type': 'application/json',
      'user-agent': 'fledge/0.2',
    }, {
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
      ...(input.resolve === undefined ? {} : { resolve: input.resolve }),
    })
  } catch (error) {
    if (error instanceof NotificationWebhookError) return { state: error.kind, detail: error.message }
    return { state: 'unknown', detail: String(error) }
  }
  await response.body?.cancel()
  if (response.status < 200 || response.status >= 300) return { state: 'retry', detail: `http-${response.status}` }
  store.setSetting(PRODUCT_PUSH_KEY, at)
  return { state: 'sent' }
}
