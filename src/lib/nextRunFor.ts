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

export type NextRunForState = NextRunState | 'unknown-unreadable' | 'unknown-closed' | 'paused'

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
  const intervalAnswer = (): NextRunFor => nextRun({
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
  // #723: `enabled` answers before the row does, exactly as the worker does.
  // `listAutoRepos()` is `WHERE enabled = 1 AND auto_iterate = 1` and a manual
  // start on a paused repository is refused with `REPO_DISABLED`, so a saved
  // schedule row must not buy a paused repository a next run on any surface.
  // The interval answer already carries the `disabled` state, so the page,
  // dashboard and digest keep one wording.
  if (input.repo.enabled !== 1) return intervalAnswer()
  if (input.row !== undefined) {
    // #940: a paused schedule (#932) keeps its row and its repository stays
    // enabled, but the worker turns a due instant into a skipped occurrence with
    // `reason: 'paused'` and moves the cursor, so the window is never made up.
    // The console already says `已暂停 / paused · since <iso>`; a surface that
    // named the skipped instant promised a run that could not happen.
    if (input.row.status === 'paused') return { at: null, state: 'paused' }
    const schedule = scheduleFromRow(input.row)
    if (schedule === null) return { at: null, state: 'unknown-unreadable' }
    const at = nextTime(schedule, now)
    if (at === null) return { at: null, state: 'unknown-closed' }
    return { at, state: at <= now ? 'due' : 'scheduled' }
  }
  return intervalAnswer()
}
