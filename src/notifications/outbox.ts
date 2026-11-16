// #544 slice 7: the delivery half of the notification outbox.
//
// The store owns the states; this module owns the decision to attempt one. The
// rule it exists for is the difference between "failed" and "unknown": a
// timeout after the request left the process is not a failure, because the
// destination may have received it. Retrying that would duplicate a digest or a
// question mail nobody can take back, so `unknown` waits for a human.
//
// Every pass does two things in this order: sweep lapsed leases into `unknown`,
// then claim the due `pending`/`retry` rows. The sweep runs first so a row that
// died in the previous pass is visible before this one decides what is due.
import type { NotificationOutboxRow, NotificationTransport, Store } from '../db.js'

/** How long one worker holds a row before it is presumed lost. */
export const OUTBOX_LEASE_MS = 60_000
const RETRY_BASE_MS = 60_000
const RETRY_MAX_MS = 60 * 60 * 1_000

/** Exponential backoff: 1m, 2m, 4m ... capped at one hour. */
export function retryDelayMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1)
  return Math.min(RETRY_BASE_MS * 2 ** exponent, RETRY_MAX_MS)
}

export interface OutboxSendResult {
  state: 'sent' | 'retry' | 'dead' | 'unknown' | 'blocked'
  /** Why it did not settle as sent; bounded by the caller. */
  error?: string
  /** Overrides the exponential backoff for `retry` (a transport Retry-After). */
  retryDelayMs?: number
}

export interface OutboxTransport {
  send(row: NotificationOutboxRow): Promise<OutboxSendResult>
}

export type OutboxTransports = Record<NotificationTransport, OutboxTransport>

export interface OutboxPassResult {
  claimed: number
  sent: number
  retry: number
  dead: number
  unknown: number
  blocked: number
  expired: number
}

export interface OutboxPassOptions {
  now?: number
  leaseMs?: number
  limit?: number
}

function bounded(error: unknown): string {
  return String(error).replace(/[\r\n]+/g, ' ').slice(0, 500)
}

/**
 * One delivery pass. Never throws for a single failed send: the row records the
 * outcome and the next pass reads it. A transport that throws is treated as a
 * retryable failure, because an exception before the commit boundary is the
 * only thing it can prove — the transports themselves return `unknown` when
 * they know the request may have landed.
 */
export async function deliverOutbox(
  store: Store,
  transports: OutboxTransports,
  options: OutboxPassOptions = {},
): Promise<OutboxPassResult> {
  const now = options.now ?? Date.now()
  const leaseMs = options.leaseMs ?? OUTBOX_LEASE_MS
  const limit = options.limit ?? 25
  const result: OutboxPassResult = { claimed: 0, sent: 0, retry: 0, dead: 0, unknown: 0, blocked: 0, expired: 0 }

  result.expired = store.expireNotificationLeases(now).expired

  for (const row of store.claimNotificationOutbox(now, leaseMs, limit)) {
    result.claimed += 1
    const transport = transports[row.transport]
    let outcome: OutboxSendResult
    if (transport === undefined) {
      outcome = { state: 'dead', error: `unknown-transport:${row.transport}` }
    } else {
      try {
        outcome = await transport.send(row)
      } catch (error) {
        outcome = { state: 'retry', error: bounded(error) }
      }
    }
    const settled = store.settleNotificationOutbox({
      id: row.id,
      leaseToken: row.lease_token ?? '',
      state: outcome.state,
      error: outcome.error ?? null,
      retryDelayMs: outcome.retryDelayMs ?? retryDelayMs(row.attempts),
      now,
    })
    // A rejected settle means the lease lapsed and the sweep already owns the
    // row; this worker's result is not written and must not be counted.
    if (!settled.settled) continue
    result[outcome.state] += 1
  }
  return result
}
