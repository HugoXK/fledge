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
// with no occurrence row has not run yet, which is not "zero runs"; a delivery has
// no outbox in this slice, so its result is `unknown` rather than a happy zero.

import type { ScheduleOccurrenceRow, ScheduleRow } from '../db.js'
import { nextTime, type Schedule } from './next.js'
import { scheduleFromRow } from './tick.js'

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
  schedule: Schedule | null
  timingRevision: number | null
  misfire: string | null
  /** The next instant the planner answers for `now`; null when it cannot answer. */
  nextAt: number | null
  /** The newest decided instant, whatever it decided. */
  last: OccurrenceView | null
  /** The newest dispatched instant whose job has succeeded. */
  lastSuccess: OccurrenceView | null
  /** There is no delivery outbox in this slice, so the result is never known. */
  delivery: 'unknown'
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
 */
export function scheduleConsole(input: {
  repoId: string
  row: ScheduleRow | undefined
  occurrences: ScheduleOccurrenceRow[]
  now: number
  jobStatus: (jobId: string) => string | null
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
  return {
    kind,
    schedule,
    timingRevision: row === undefined ? null : row.timing_revision,
    misfire: row === undefined ? null : row.misfire,
    nextAt: schedule === null ? null : nextTime(schedule, now),
    last: occurrences[0] ?? null,
    lastSuccess,
    delivery: 'unknown',
    occurrences,
  }
}
