// Which rule answers "when does this repository run again?", for a caller
// outside the view layer (#713).
//
// The rule itself already lives in one place: `nextTime` (`src/schedules/next.ts`)
// for a repository with a saved schedule row, and `nextRun` (`src/lib/nextRun.ts`)
// for one without. What the daily digest could not reach was the *choice*
// between them, because that choice lived in `src/views/pages.ts` — and a job
// module must not import the view layer. This helper owns only the choice, plus
// the two answers a saved row can have when the planner has no instant to name.
// Keeping the union here instead of widening `NextRunState` matters: `nextRunLine`
// switches on that union exhaustively, so a new member would drag a view change
// into a slice that is about the email.
import type { ScheduleRow } from '../db.js'
import { nextTime } from '../schedules/next.js'
import { scheduleFromRow } from '../schedules/tick.js'
import { nextRun, type NextRunState } from './nextRun.js'

export type NextRunForState = NextRunState | 'unknown-unreadable' | 'unknown-closed'

export interface NextRunForRepo {
  last_run_at: string | null
  interval_minutes: number
  auto_iterate: number
  enabled: number
}

export interface NextRunForInput {
  repo: NextRunForRepo
  // Present only when the repository has a saved schedule row. Absent means the
  // legacy interval rule still owns this repository's cadence.
  schedule: ScheduleRow | undefined
  openWork: boolean
  activeJob: boolean
  // Already computed by the caller through `instanceReadyFor`, so the "no
  // instance image configured" fallback has exactly one implementation.
  instanceReady: boolean
  workCooldownMinutes: number
  floorMinutes?: number
  now?: number
}

export interface NextRunForAnswer {
  at: number | null
  state: NextRunForState
}

export function nextRunFor(input: NextRunForInput): NextRunForAnswer {
  const now = input.now ?? Date.now()
  if (input.schedule !== undefined) {
    const schedule = scheduleFromRow(input.schedule)
    if (schedule === null) return { at: null, state: 'unknown-unreadable' }
    const at = nextTime(schedule, now)
    if (at === null) return { at: null, state: 'unknown-closed' }
    // A saved row owns the cadence whether or not the repository is enabled: the
    // page attaches the planner's answer whenever a row exists, so consulting
    // `enabled` first here would disagree with the page on exactly the
    // disabled-but-scheduled repository this rule exists to keep in step.
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
    ...(input.floorMinutes === undefined ? {} : { floorMinutes: input.floorMinutes }),
    now,
  })
}

// The fallback both existing surfaces apply: on a deployment with no instance
// image there is no instance to wait for, so an absent or stopped instance is
// not a reason to say "not ready". Without this the email would print
// "FlyBot 实例未就绪" for every repository on such a box — the same defect as
// the contradiction this slice removes, pointed the other way.
export function instanceReadyFor(instanceImage: string, status: string | undefined): boolean {
  return instanceImage === '' ? true : status === 'ready'
}
