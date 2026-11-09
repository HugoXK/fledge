import type { FailureKind } from './failure.js'

export interface RetryDecision {
  retry: boolean
  delayMs: number
  reason: string
}

const TRANSIENT: ReadonlySet<FailureKind> = new Set(['bridge', 'model', 'github', 'timeout', 'stalled'])

export function retryDecision(kind: FailureKind | undefined, attempt: number, maxAttempts = 2): RetryDecision {
  if (kind === undefined) return { retry: false, delayMs: 0, reason: 'no failure category' }
  if (!TRANSIENT.has(kind)) return { retry: false, delayMs: 0, reason: `${kind} is not transient` }
  if (attempt >= maxAttempts) return { retry: false, delayMs: 0, reason: `retry limit ${maxAttempts} reached` }
  const delayMs = Math.min(30 * 60_000, 60_000 * 2 ** attempt)
  return { retry: true, delayMs, reason: `${kind} is transient` }
}
