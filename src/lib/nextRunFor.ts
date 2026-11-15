// #713: the third surface of the one next-run rule.
//
// `src/lib/nextRun.ts` owns the legacy interval answer and
// `src/schedules/next.ts` owns the planner answer. The repository page and the
// dashboard already pick between them in the view layer, which a job module
// cannot call. This function is that choice, moved where the digest can reach it
// without importing `src/views/**`.
//
// The instant stays single-sourced: the interval branch delegates to `nextRun`
// (and through it `dueAfterMs`), and the schedule branch delegates to
// `scheduleFromRow` + `nextTime`. Only the state names are this module's own.
import type { RepoRow, ScheduleRow } from '../db.js'
import { nextRun, type NextRunState } from './nextRun.js'
import { nextTime } from '../schedules/next.js'
import { scheduleFromRow } from '../schedules/tick.js'

export type NextRunForState = NextRunState | 'unknown-unreadable' | 'unknown-closed'

export interface NextRunForInput {
  repo: RepoRow
  /** Present only when the repository has saved a schedule row. */
  row: ScheduleRow | undefined
  openWork: boolean
  activeJob: boolean
  /**
   * The caller applies the same fallback the page and dashboard use
   * (`config.flybot.instanceImage === '' ? true : instance?.status === 'ready'`),
   * so a deployment with no FlyBot image never reports `not-ready`.
   */
  instanceReady: boolean
  workCooldownMinutes: number
  now?: number
}

export interface NextRunFor {
  at: number | null
  state: NextRunForState
}

export function nextRunFor(input: NextRunForInput): NextRunFor {
  const now = input.now ?? Date.now()
  if (input.row !== undefined) {
    const schedule = scheduleFromRow(input.row)
    if (schedule === null) return { at: null, state: 'unknown-unreadable' }
    const at = nextTime(schedule, now)
    if (at === null) return { at: null, state: 'unknown-closed' }
    return { at, state: at <= now ? 'due' : 'scheduled' }
  }
  return nextRun({
    lastRunAt: input.repo.last_run_at,
    intervalMinutes: input.repo.interval_minutes,
    workCooldownMinutes: input.workCooldownMinutes,
    autoIterate: input.repo.auto_iterate === 1,
    hasOpenWork: input.openWork,
    hasActiveJob: input.activeJob,
    repoEnabled: input.repo.enabled === 1,
    instanceReady: input.instanceReady,
    now,
  })
}
