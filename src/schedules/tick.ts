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

/** #544 slice 5: an instant this decision covered but will not dispatch. */
export interface SkippedInstant {
  at: number
  /** Why it was skipped: the policy did not make it up, or it ran past its grace. */
  reason: 'misfire-once' | 'grace-exceeded'
}

export interface TickPlan {
  /** The logical instant to dispatch at `now`, or null when none is. */
  dueAt: number | null
  /**
   * Logical instants strictly between `from` and `dueAt` that were passed over.
   * Under `misfire: 'skip'` they are reported as skipped, never run later.
   */
  missed: number
  /** First logical instant strictly after `now`, or null when the window closed. */
  nextAt: number | null
  /**
   * #544 slice 5: the passed-over instants this decision records instead of
   * counting. `skip` records none, `once` records the ones it does not make up,
   * and a grace-exceeded instant is recorded so it is not reconsidered forever.
   */
  skipped: SkippedInstant[]
  /**
   * Where the high water mark must move once this decision is written: the last
   * instant it covered, so the next tick starts after the whole window instead of
   * re-deciding the instants this one already answered for.
   */
  cursorAt: number | null
}

export interface TickOptions {
  /** `skip` (default) forgets the passed-over instants; `once` makes up the oldest. */
  misfire?: 'skip' | 'once'
  /** How late a due instant may still be dispatched; null or absent means no bound. */
  graceMs?: number | null
}

// A hourly cron with a year of missed instants is ~9k steps; this bound keeps a
// pathological clock jump from spinning the tick. Reaching it is not silent: the
// caller sees `nextAt === null` and records what it could not enumerate.
const MAX_STEPS = 12_000

export function planTick(schedule: Schedule, from: number, now: number, options: TickOptions = {}): TickPlan {
  const misfire = options.misfire === 'once' ? 'once' : 'skip'
  const graceMs = options.graceMs === undefined || options.graceMs === null ? null : options.graceMs
  const empty: TickPlan = { dueAt: null, missed: 0, nextAt: null, skipped: [], cursorAt: null }
  if (!Number.isFinite(from) || !Number.isFinite(now)) return empty
  // Every instant the window covers, in order. The loop stays the same shape as
  // before so `skip` cannot drift; the list is what `once` and the grace bound
  // need to answer with rows instead of a count.
  const passed: number[] = []
  let cursor = from
  let nextAt: number | null = null
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const at = nextOccurrence(schedule, cursor).at
    if (at === null) {
      nextAt = null
      break
    }
    if (at > now) {
      nextAt = at
      break
    }
    passed.push(at)
    cursor = at
  }
  const last = passed.length === 0 ? null : passed[passed.length - 1]!
  if (last === null) return { dueAt: null, missed: 0, nextAt, skipped: [], cursorAt: null }
  // `skip` decides only the newest instant and counts the rest. `once` makes up
  // the oldest — the run keeps the logical time it was scheduled for — and
  // records the later ones, so nothing in the window is silently dropped.
  const chosen = misfire === 'once' ? passed[0]! : last
  const carried = misfire === 'once'
    ? passed.slice(1).map((at): SkippedInstant => ({ at, reason: 'misfire-once' }))
    : []
  const missed = misfire === 'once' ? 0 : passed.length - 1
  if (graceMs !== null && now - chosen > graceMs) {
    // Too late to dispatch. The instant is still decided: it becomes a skipped
    // row, and the cursor moves past it, or the next tick would decide it again.
    const tooLate = misfire === 'once'
      ? passed.map((at): SkippedInstant => ({ at, reason: 'grace-exceeded' }))
      : [{ at: chosen, reason: 'grace-exceeded' as const }]
    return { dueAt: null, missed, nextAt, skipped: tooLate, cursorAt: last }
  }
  return { dueAt: chosen, missed, nextAt, skipped: carried, cursorAt: last }
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
