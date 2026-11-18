// #544: an occurrence records the configuration and the authorization it was
// decided under, frozen at the moment the row was written.
//
// A schedule is editable and a repository's permission can be re-checked while
// an instant sits in its lease. Without a snapshot, the occurrence row answers
// "what does this repository's schedule say now", which is a different question
// from "what did this instant run as". The two diverge exactly when it matters:
// an incident review, a budget dispute, or a question about which permission a
// scheduled run acted with. The row's identity
// `(schedule_id, logical_time, timing_revision)` already pins *which* schedule
// revision decided the instant; this pins what that revision said.
//
// `parseOccurrenceSnapshot` returns null for an absent, malformed or
// future-versioned snapshot. It never falls back to the live schedule: a row
// that cannot say what it ran as says "unknown", which is the one answer that
// cannot be wrong.
import type { RepoRow, ScheduleRow } from '../db.js'

/** Bumped only when the stored shape changes incompatibly. */
export const OCCURRENCE_SNAPSHOT_VERSION = 1

export interface ScheduleOccurrenceSnapshot {
  version: number
  config: {
    kind: string
    expression: string | null
    everyMs: number | null
    timezone: string | null
    startAt: number | null
    endAt: number | null
    timingRevision: number
    misfire: string
    graceMs: number | null
    dailyRuns: number | null
    status: string
  }
  authorization: {
    /** The account the run acts for: the repository's owner. */
    userId: string
    /** The GitHub App installation the run acts through, when it has one. */
    installationId: number | null
    permission: string
    repoRole: string | null
  }
}

/**
 * The snapshot of one schedule configuration and one repository authorization.
 * Pure: the caller reads both rows, so the values are the ones the decision was
 * taken with rather than a second read that could race an edit.
 */
export function occurrenceSnapshot(schedule: ScheduleRow, repo: RepoRow): ScheduleOccurrenceSnapshot {
  return {
    version: OCCURRENCE_SNAPSHOT_VERSION,
    config: {
      kind: schedule.kind,
      expression: schedule.expression,
      everyMs: schedule.every_ms,
      timezone: schedule.timezone,
      startAt: schedule.start_at,
      endAt: schedule.end_at,
      timingRevision: schedule.timing_revision,
      misfire: schedule.misfire,
      graceMs: schedule.grace_ms,
      dailyRuns: schedule.daily_runs,
      status: schedule.status,
    },
    authorization: {
      userId: repo.user_id,
      installationId: repo.installation_id,
      permission: repo.permission,
      repoRole: repo.repo_role,
    },
  }
}

export function encodeOccurrenceSnapshot(snapshot: ScheduleOccurrenceSnapshot): string {
  return JSON.stringify(snapshot)
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * The stored snapshot, or null. Null is a value, not an error: an occurrence row
 * written before the column existed, a hand-edited row, and a row written by a
 * newer build all answer null, and every reader must say "unknown" rather than
 * substitute today's values.
 */
export function parseOccurrenceSnapshot(raw: string | null | undefined): ScheduleOccurrenceSnapshot | null {
  if (typeof raw !== 'string' || raw === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const value = parsed as Record<string, unknown>
  if (value.version !== OCCURRENCE_SNAPSHOT_VERSION) return null
  const config = value.config
  const authorization = value.authorization
  if (typeof config !== 'object' || config === null) return null
  if (typeof authorization !== 'object' || authorization === null) return null
  const c = config as Record<string, unknown>
  const a = authorization as Record<string, unknown>
  if (typeof c.kind !== 'string') return null
  if (typeof c.timingRevision !== 'number' || !Number.isFinite(c.timingRevision)) return null
  if (typeof c.misfire !== 'string') return null
  if (typeof c.status !== 'string') return null
  if (typeof a.userId !== 'string' || a.userId === '') return null
  if (typeof a.permission !== 'string') return null
  return {
    version: OCCURRENCE_SNAPSHOT_VERSION,
    config: {
      kind: c.kind,
      expression: nullableString(c.expression),
      everyMs: nullableNumber(c.everyMs),
      timezone: nullableString(c.timezone),
      startAt: nullableNumber(c.startAt),
      endAt: nullableNumber(c.endAt),
      timingRevision: c.timingRevision,
      misfire: c.misfire,
      graceMs: nullableNumber(c.graceMs),
      dailyRuns: nullableNumber(c.dailyRuns),
      status: c.status,
    },
    authorization: {
      userId: a.userId,
      installationId: nullableNumber(a.installationId),
      permission: a.permission,
      repoRole: nullableString(a.repoRole),
    },
  }
}
