// #544 slice 3A/3B, the console: one view model for "what does this repository's
// schedule say right now".
//
// `src/schedules/next.ts` owns the rules and `src/jobs/service.ts` runs them. This
// module is what a maintainer reads: the next run, the last instant that
// succeeded, why the last decided instant was skipped, and who holds it. It calls
// the planner rather than restating it, so the page cannot answer with a second
// formula.
//
// Every value it cannot know is `null`, and the page prints `unknown`. A schedule
// with no occurrence row has not run yet, which is not "zero runs"; a run whose
// job queued no notification is `none`, which is also not a happy zero.

import type { NotificationOutboxState, ScheduleOccurrenceRow, ScheduleRow } from '../db.js'
import { nextTime, type Schedule } from './next.js'
import { scheduleFromRow } from './tick.js'

/**
 * What the console can say about the newest run's delivery. `none` is a run that
 * queued nothing; `unknown` is a caller that read nothing (or a schedule that
 * never ran); `unconfirmed` is an outbox row whose send may have crossed the
 * boundary and is never resent automatically.
 */
export type ScheduleDelivery = 'unknown' | 'none' | 'unconfirmed' | 'dead' | 'blocked' | 'retry' | 'sending' | 'pending' | 'sent'

// One row per state, worst first: a state that needs a person outranks one that
// needs time, which outranks one that is in flight, which outranks one that is
// already done. Several sends for one job (a webhook that is retrying beside one
// that was accepted) must not read as the accepted one.
const DELIVERY_RANK: Record<NotificationOutboxState, number> = {
  unknown: 0, dead: 1, blocked: 2, retry: 3, sending: 4, pending: 5, sent: 6,
}

function worstDelivery(states: NotificationOutboxState[]): ScheduleDelivery {
  let worst = states[0] ?? 'sent'
  for (const state of states) if (DELIVERY_RANK[state] < DELIVERY_RANK[worst]) worst = state
  return worst === 'unknown' ? 'unconfirmed' : worst
}

function deliveryOf(
  newest: ScheduleOccurrenceRow | undefined,
  read: ((jobId: string) => Array<{ state: NotificationOutboxState }>) | undefined,
): ScheduleDelivery {
  if (newest === undefined) return 'unknown'
  if (newest.job_id === null) return 'none'
  if (read === undefined) return 'unknown'
  const rows = read(newest.job_id)
  return rows.length === 0 ? 'none' : worstDelivery(rows.map((row) => row.state))
}

export interface OccurrenceView {
  id: string
  logicalTime: number
  state: string
  reason: string | null
  missed: number
  attempts: number
  /** True while a worker holds a lease that has not lapsed. */
  leaseHeld: boolean
  leaseExpiresAt: number | null
  jobId: string | null
  lagMs: number | null
}

export interface ScheduleConsoleState {
  /** `none` when the repository has no schedule row; `unreadable` when it has one the planner cannot use. */
  kind: 'none' | 'unreadable' | 'cron' | 'interval'
  /**
   * #544 slice 9: `none` when there is no row, otherwise the stored state. A
   * paused schedule still answers `nextAt` — the instant the planner would use —
   * but nothing fires until it is resumed, and the page says so rather than
   * promising a run.
   */
  status: 'none' | 'active' | 'paused'
  /** The instant the schedule was paused, or null while it is active or absent. */
  pausedAt: number | null
  schedule: Schedule | null
  timingRevision: number | null
  misfire: string | null
  /** #544 slice 5: how late a due instant may be dispatched; null is unbounded. */
  graceMs: number | null
  /** The next instant the planner answers for `now`; null when it cannot answer. */
  nextAt: number | null
  /** The newest decided instant, whatever it decided. */
  last: OccurrenceView | null
  /** The newest dispatched instant whose job has succeeded. */
  lastSuccess: OccurrenceView | null
  /**
   * #544: the delivery of the newest decided instant, read through the job it
   * dispatched. `unknown` means nobody read the outbox (or nothing has run);
   * `none` means that job queued no notification. The outbox's own `unknown` —
   * the send may have crossed the external boundary — is reported as
   * `unconfirmed` so it is never mistaken for "nobody looked".
   */
  delivery: ScheduleDelivery
  /**
   * #544 slice 6: the schedule layer of the run budget. `dailyRuns` null is
   * unbounded; `runsToday` null is unknown, which the page prints as unknown and
   * never as zero. `remaining` is null whenever either side is null.
   */
  budget: { dailyRuns: number | null; runsToday: number | null; remaining: number | null }
  occurrences: OccurrenceView[]
}

function viewOf(row: ScheduleOccurrenceRow, now: number): OccurrenceView {
  return {
    id: row.id,
    logicalTime: row.logical_time,
    state: row.state,
    reason: row.reason,
    missed: row.missed,
    attempts: row.attempts,
    leaseHeld: row.lease_token !== null && row.lease_expires_at !== null && row.lease_expires_at > now,
    leaseExpiresAt: row.lease_expires_at,
    jobId: row.job_id,
    lagMs: row.lag_ms,
  }
}

/**
 * The console's answer for one repository. `occurrences` is the list
 * `Store.listScheduleOccurrences` returns: newest logical time first. `jobStatus`
 * resolves a dispatched occurrence's job so a failed dispatch is not mistaken for
 * a success; an unknown job answers null and is not counted as either.
 * `runsToday` is `Store.countScheduleDispatchesBetween` over the current UTC day;
 * a caller that did not read it leaves it out, and the page says unknown.
 * `jobDeliveries` resolves the notifications a job queued; a caller that did not
 * read the outbox leaves it out, and the page says unknown rather than `none`.
 */
export function scheduleConsole(input: {
  repoId: string
  row: ScheduleRow | undefined
  occurrences: ScheduleOccurrenceRow[]
  now: number
  jobStatus: (jobId: string) => string | null
  runsToday?: number
  jobDeliveries?: (jobId: string) => Array<{ state: NotificationOutboxState }>
}): ScheduleConsoleState {
  const { row, now } = input
  const schedule = row === undefined ? null : scheduleFromRow(row)
  const occurrences = input.occurrences.map((occurrence) => viewOf(occurrence, now))
  const kind: ScheduleConsoleState['kind'] = row === undefined
    ? 'none'
    : schedule === null
      ? 'unreadable'
      : row.kind === 'cron' ? 'cron' : 'interval'
  const lastSuccess = occurrences.find((occurrence) => occurrence.jobId !== null && input.jobStatus(occurrence.jobId) === 'succeeded') ?? null
  const dailyRuns = row === undefined ? null : row.daily_runs
  const runsToday = row === undefined ? null : (input.runsToday ?? null)
  return {
    kind,
    status: row === undefined ? 'none' : row.status === 'paused' ? 'paused' : 'active',
    pausedAt: row === undefined ? null : row.paused_at,
    schedule,
    timingRevision: row === undefined ? null : row.timing_revision,
    misfire: row === undefined ? null : row.misfire,
    graceMs: row === undefined ? null : row.grace_ms,
    nextAt: schedule === null ? null : nextTime(schedule, now),
    last: occurrences[0] ?? null,
    lastSuccess,
    delivery: deliveryOf(input.occurrences[0], input.jobDeliveries),
    budget: {
      dailyRuns,
      runsToday,
      remaining: dailyRuns === null || runsToday === null ? null : Math.max(0, dailyRuns - runsToday),
    },
    occurrences,
  }
}

// The stored interval is exact, so every surface that prints it or pre-fills it
// echoes it exactly. `90s` is legal (`parseEvery`), and rounding it to `2m`
// would make one unmodified click on Save rewrite 90000 to 120000: a data change
// on a click. Minutes are used only when the value divides evenly by a minute.
export function intervalFieldText(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  if (ms % 1000 === 0) return `${ms / 1000}s`
  return `${ms}ms`
}
