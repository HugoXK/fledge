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
// job has finished and queued no notification is `none`, which is also not a
// happy zero; a run whose job is still queued or running is `unknown`, because
// a job queues its notifications only when it ends.

import type { NotificationOutboxState, RepoRow, ScheduleOccurrenceRow, ScheduleRow } from '../db.js'
import { nextTime, type Schedule } from './next.js'
import { parseOccurrenceSnapshot, type ScheduleOccurrenceSnapshot } from './snapshot.js'
import { scheduleFromRow } from './tick.js'

/**
 * What the console can say about the newest run's delivery. `none` is a finished
 * run that queued nothing; `unknown` is a caller that read nothing, a schedule
 * that never ran, or a run whose job has not finished; `unconfirmed` is an
 * outbox row whose send may have crossed the boundary and is never resent
 * automatically.
 */
export type ScheduleDelivery = 'unknown' | 'none' | 'unconfirmed' | 'dead' | 'blocked' | 'retry' | 'sending' | 'pending' | 'sent'

// One row per state, worst first: a state that needs a person outranks one that
// needs time, which outranks one that is in flight, which outranks one that is
// already done. Several sends for one job (a webhook that is retrying beside one
// that was accepted) must not read as the accepted one. `dead` outranks
// `blocked` even though both need a person: a dead send spent its retries
// against a destination that exists and is lost without one, while a blocked
// send never left — its destination was never reachable — and the row is still
// intact for a person to fix and resend.
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
  jobStatus: (jobId: string) => string | null,
  read: ((jobId: string) => Array<{ state: NotificationOutboxState }>) | undefined,
): ScheduleDelivery {
  if (newest === undefined) return 'unknown'
  // Only a decided instant can answer. `dispatched` names the job whose
  // notifications are the delivery fact, and `skipped` provably queued none.
  // A `claimed` row keeps its `job_id` NULL until the worker starts the job,
  // and an `expired` row is a lease that lapsed before anyone settled it, so
  // neither has decided yet and `none` would be a lie the page prints as
  // "not queued".
  if (newest.state !== 'dispatched' && newest.state !== 'skipped') return 'unknown'
  if (newest.job_id === null) return newest.state === 'skipped' ? 'none' : 'unknown'
  if (read === undefined) return 'unknown'
  // A job queues its notifications only when it ends (`succeeded`/`failed`),
  // so while it is queued or running the empty outbox read is a value nobody
  // knows yet — printing `none` there would deny a notification the run may
  // still queue. A job the store cannot find is unknown for the same reason:
  // the console cannot prove it will never queue one.
  const status = jobStatus(newest.job_id)
  if (status === null || status === 'queued' || status === 'running') return 'unknown'
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
  /** The revision this row was decided under; its identity, next to the snapshot's claim. */
  timingRevision: number
  /**
   * #544: the configuration and authorization this instant was frozen under, or
   * null when the row recorded none — an occurrence written before the column
   * existed, a hand-edited row, or one written by a build that speaks a newer
   * shape. Null is a fact, not a prompt to read today's schedule.
   */
  snapshot: ScheduleOccurrenceSnapshot | null
}

/**
 * The fields a later edit can move out from under an already-decided instant.
 * The page prints their names, so a disagreement is shown rather than dropped.
 */
export type FrozenSnapshotField = 'kind' | 'expression' | 'everyMs' | 'timezone' | 'startAt' | 'endAt' | 'owner' | 'installation' | 'permission' | 'role' | 'revision'

export interface FrozenSnapshotView {
  /** What the newest decided instant recorded, or null when it recorded nothing. */
  snapshot: ScheduleOccurrenceSnapshot | null
  /** The fields where that record disagrees with today's schedule or repository row. */
  differs: FrozenSnapshotField[]
  /**
   * #544: true when the snapshot's own revision is not the revision this row was
   * decided under. The snapshot then cannot be proven to describe this instant —
   * a row written by a hand edit or a bug — so the page says so instead of
   * printing the values as if they belonged.
   */
  revisionMismatch: boolean
}

/**
 * The frozen record beside the live rows it has drifted from. Only known values
 * are compared: a repository the caller did not read cannot disagree.
 */
function frozenOf(row: ScheduleRow | undefined, repo: RepoRow | undefined, occurrence: OccurrenceView | undefined): FrozenSnapshotView {
  const snapshot = occurrence?.snapshot ?? null
  if (snapshot === null || row === undefined) return { snapshot, differs: [], revisionMismatch: false }
  const revisionMismatch = occurrence!.timingRevision !== snapshot.config.timingRevision
  const differs: FrozenSnapshotField[] = []
  if (revisionMismatch) differs.push('revision')
  if (snapshot.config.kind !== row.kind) differs.push('kind')
  if (snapshot.config.expression !== row.expression) differs.push('expression')
  if (snapshot.config.everyMs !== row.every_ms) differs.push('everyMs')
  if (snapshot.config.timezone !== row.timezone) differs.push('timezone')
  if (snapshot.config.startAt !== row.start_at) differs.push('startAt')
  if (snapshot.config.endAt !== row.end_at) differs.push('endAt')
  if (repo !== undefined) {
    if (snapshot.authorization.userId !== repo.user_id) differs.push('owner')
    if (snapshot.authorization.installationId !== repo.installation_id) differs.push('installation')
    if (snapshot.authorization.permission !== repo.permission) differs.push('permission')
    if (snapshot.authorization.repoRole !== repo.repo_role) differs.push('role')
  }
  return { snapshot, differs, revisionMismatch }
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
   * dispatched. `unknown` means nobody read the outbox, nothing has run, or the
   * run's job has not finished — a job queues its notifications only when it
   * ends; `none` means a finished job queued no notification. The outbox's own
   * `unknown` — the send may have crossed the external boundary — is reported as
   * `unconfirmed` so it is never mistaken for "nobody looked".
   */
  delivery: ScheduleDelivery
  /**
   * #544 slice 6: the schedule layer of the run budget. `dailyRuns` null is
   * unbounded; `runsToday` null is unknown, which the page prints as unknown and
   * never as zero. `remaining` is null whenever either side is null.
   */
  budget: { dailyRuns: number | null; runsToday: number | null; remaining: number | null }
  /**
   * #544: what the newest decided instant was frozen under, and the fields where
   * that record disagrees with today's schedule and repository row. A null
   * snapshot means the row recorded nothing, which the page prints as unknown —
   * the live schedule is a different question and is never substituted.
   */
  frozen: FrozenSnapshotView
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
    timingRevision: row.timing_revision,
    snapshot: parseOccurrenceSnapshot(row.snapshot_json),
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
 * `jobStatus` decides the same line: a job still queued or running has not
 * queued anything yet, so its empty read is unknown, and only a terminal job
 * whose read is empty answers `none`.
 * `repo` is the repository row the authorization was frozen from; a caller that
 * did not read it leaves it out, and the frozen card reports what it has without
 * claiming a disagreement it cannot see.
 */
export function scheduleConsole(input: {
  repoId: string
  row: ScheduleRow | undefined
  /** #544: today's repository row, compared against the frozen authorization. */
  repo?: RepoRow
  occurrences: ScheduleOccurrenceRow[]
  now: number
  jobStatus: (jobId: string) => string | null
  /**
   * #1055: `Store.newestSucceededDispatch` — the newest dispatched instant whose
   * job succeeded, at any age. `occurrences` is only a window of the newest
   * decided instants, so a success older than it is invisible there and the
   * console used to print `unknown` for a run that existed. A caller that did
   * not read it leaves it out, and the window answer stands unchanged.
   */
  lastSucceeded?: ScheduleOccurrenceRow | null
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
  const lastSuccess = input.lastSucceeded === undefined
    ? occurrences.find((occurrence) => occurrence.jobId !== null && input.jobStatus(occurrence.jobId) === 'succeeded') ?? null
    : input.lastSucceeded === null ? null : viewOf(input.lastSucceeded, now)
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
    // #1051: a paused schedule will not run, so it has no next instant to name.
    // The console used to print the planner's next time for a paused row, which
    // reads as a promise nothing will keep; Resume computes its own instant.
    nextAt: schedule === null || row?.status === 'paused' ? null : nextTime(schedule, now),
    last: occurrences[0] ?? null,
    lastSuccess,
    delivery: deliveryOf(input.occurrences[0], input.jobStatus, input.jobDeliveries),
    budget: {
      dailyRuns,
      runsToday,
      remaining: dailyRuns === null || runsToday === null ? null : Math.max(0, dailyRuns - runsToday),
    },
    frozen: frozenOf(row, input.repo, occurrences[0]),
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
