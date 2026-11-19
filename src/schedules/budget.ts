// #544 slice 6: the schedule layer of the layered budget.
//
// A schedule may carry a daily run limit. The window is the UTC day of the
// logical instant being decided, never the day the dispatch happens: a late or
// recovered run stays in the day it was scheduled for, so crossing midnight
// grants no fresh allowance and a retry cannot spend a second bucket.
//
// This is the run-count layer only. The cost layer is separate and already
// enforced elsewhere: `repos.monthly_budget_cny` / `job_budget_cny` for a
// repository and the account quota for a user. Neither is a run count, so
// neither is folded into this limit.

export const DAILY_RUNS_MAX = 1000
const DAY_MS = 86_400_000

/** Midnight UTC of the day `at` falls in. */
export function utcDayStart(at: number): number {
  return Math.floor(at / DAY_MS) * DAY_MS
}

/** The exclusive end of the day `at` falls in. */
export function utcDayEnd(at: number): number {
  return utcDayStart(at) + DAY_MS
}

export type DailyRunsParse =
  | { ok: true; dailyRuns: number | null }
  | { ok: false; reason: 'not-an-integer' | 'out-of-range' }

/**
 * The form's daily limit. Empty means unbounded, which is the behaviour every
 * existing schedule has. `0` is refused rather than read as "never run": a
 * schedule that must not run is deleted or its window closed, so a zero limit
 * would be a second, silently different way to say the same thing.
 */
export function parseDailyRuns(raw: string): DailyRunsParse {
  const text = raw.trim()
  if (text === '') return { ok: true, dailyRuns: null }
  if (!/^[0-9]+$/.test(text)) return { ok: false, reason: 'not-an-integer' }
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value < 1 || value > DAILY_RUNS_MAX) return { ok: false, reason: 'out-of-range' }
  return { ok: true, dailyRuns: value }
}

export type RunBudgetLayer = 'schedule' | 'project' | 'tenant'

export interface RunBudgetInput {
  scope: RunBudgetLayer
  limit: number | null
  used: number
}

/**
 * The first layer whose logical day is already spent. The layers are checked in
 * schedule -> project -> tenant order, and a null limit is unbounded. The counts
 * are nested, so the layer that stops the instant is the one with no room left,
 * whether it is the schedule, the project or the tenant.
 */
export function runBudgetStop(layers: RunBudgetInput[]): RunBudgetInput | null {
  for (const layer of layers) {
    if (layer.limit !== null && layer.used >= layer.limit) return layer
  }
  return null
}
