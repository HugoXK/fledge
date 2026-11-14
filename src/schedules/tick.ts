// #544, slice 3A: the tick side of the scheduling core.
//
// `nextTime` answers "when, after this instant". The worker needs a different
// question answered: "as of now, which logical instant is due, how many did I
// pass over, and when is the next one". `planTick` is that question, kept pure so
// the worker cannot disagree with the preview about when a run was due.
//
// A schedule names logical instants; an occurrence is one of them that the
// worker actually decides to run or to skip. `planTick` stays pure and knows
// nothing about storage: the tick stores the decision as a `schedule_occurrences`
// row keyed by `(schedule_id, logical_time, timing_revision)` and keeps
// `last_occurrence_at` as the high water mark, so the same instant is not
// reported twice even though a second process can reach it too. `misfire: 'skip'`
// is the only policy here — a passed-over instant is counted on the decided row
// and is not made up later.
//
// Boundaries, stated once because both the tests and slice B depend on them:
//   - `start_at` is inclusive: an instant equal to `start_at` is a run.
//   - the caller's `from` is exclusive: `nextTime(schedule, from) > from`, so a
//     worker that advances the high water mark to the instant it dispatched
//     cannot be handed that instant again.
//   - `end_at` is exclusive: the window is `[start_at, end_at)`.

import type { ScheduleRow } from '../db.js'
import { nextOccurrence } from './next.js'
import type { Schedule } from './next.js'

export interface TickPlan {
  /** The latest logical instant that is due at `now`, or null when none is. */
  dueAt: number | null
  /**
   * Logical instants strictly between `from` and `dueAt` that were passed over.
   * Under `misfire: 'skip'` they are reported as skipped, never run later.
   */
  missed: number
  /** First logical instant strictly after `now`, or null when the window closed. */
  nextAt: number | null
}

// A hourly cron with a year of missed instants is ~9k steps; this bound keeps a
// pathological clock jump from spinning the tick. Reaching it is not silent: the
// caller sees `nextAt === null` and records what it could not enumerate.
const MAX_STEPS = 12_000

export function planTick(schedule: Schedule, from: number, now: number): TickPlan {
  if (!Number.isFinite(from) || !Number.isFinite(now)) return { dueAt: null, missed: 0, nextAt: null }
  let cursor = from
  let dueAt: number | null = null
  let missed = 0
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const at = nextOccurrence(schedule, cursor).at
    if (at === null) return { dueAt, missed, nextAt: null }
    if (at > now) return { dueAt, missed, nextAt: at }
    if (dueAt !== null) missed += 1
    dueAt = at
    cursor = at
  }
  return { dueAt, missed, nextAt: null }
}

// The stored row back to the schedule the planner takes. A cron row without an
// expression or zone cannot be scheduled, so it answers null instead of guessing
// a cadence — the caller skips the repository and says so.
export function scheduleFromRow(row: ScheduleRow): Schedule | null {
  const startAt = row.start_at
  const endAt = row.end_at
  if (row.kind === 'cron') {
    if (row.expression === null || row.expression === '' || row.timezone === null || row.timezone === '') return null
    return { kind: 'cron', expression: row.expression, timezone: row.timezone, startAt, endAt }
  }
  if (row.kind === 'interval') {
    if (row.every_ms === null || !Number.isFinite(row.every_ms) || row.every_ms <= 0) return null
    return { kind: 'interval', everyMs: row.every_ms, startAt, endAt }
  }
  return null
}
