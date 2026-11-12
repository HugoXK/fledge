import type { FailureKind } from './failure.js'

export interface RetryDecision {
  retry: boolean
  delayMs: number
  reason: string
}

const TRANSIENT: ReadonlySet<FailureKind> = new Set(['bridge', 'model', 'github', 'timeout', 'stalled'])

// github is excluded on purpose: a review that failed on the GitHub side may have
// moved on (the PR was updated or merged), so it goes back to the human.
const REVIEW_TRANSIENT: ReadonlySet<FailureKind> = new Set(['bridge', 'model', 'timeout', 'stalled'])

export const REVIEW_MAX_ATTEMPTS = 1

export function retryDecision(kind: FailureKind | undefined, attempt: number, maxAttempts = 2): RetryDecision {
  if (kind === undefined) return { retry: false, delayMs: 0, reason: 'no failure category' }
  if (!TRANSIENT.has(kind)) return { retry: false, delayMs: 0, reason: `${kind} is not transient` }
  if (attempt >= maxAttempts) return { retry: false, delayMs: 0, reason: `retry limit ${maxAttempts} reached` }
  const delayMs = Math.min(30 * 60_000, 60_000 * 2 ** attempt)
  return { retry: true, delayMs, reason: `${kind} is transient` }
}

// A review is idempotent only while it has produced no result: retrying is cheap,
// but a second review that could post another COMMENT set is not. The caller
// refuses to schedule when the job already recorded a review_score; summary is
// the progress line, not a result, so it is not a reason to refuse.
export function reviewRetryDecision(kind: FailureKind | undefined, attempt: number): RetryDecision {
  if (kind === undefined) return { retry: false, delayMs: 0, reason: 'no failure category' }
  if (!REVIEW_TRANSIENT.has(kind)) return { retry: false, delayMs: 0, reason: `${kind} is not a transient review failure` }
  if (attempt >= REVIEW_MAX_ATTEMPTS) return { retry: false, delayMs: 0, reason: `review retry limit ${REVIEW_MAX_ATTEMPTS} reached` }
  const delayMs = Math.min(30 * 60_000, 60_000 * 2 ** attempt)
  return { retry: true, delayMs, reason: `${kind} is a transient review failure` }
}
