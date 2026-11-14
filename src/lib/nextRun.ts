// The legacy interval rule: "when does a repository with no schedule run again?".
//
// This answers only for a repository that has saved no schedule row. A repository
// that has one is answered by the planner in `src/schedules/next.ts`, and the page
// reads that number instead (#544). The claim this file used to make — that it
// restates the worker's formula — is gone with the citation it rested on: the
// worker's scheduled path no longer evaluates this expression for a scheduled
// repository, so a second copy of it would be a second answer, not the same one.
export type NextRunState =
  | 'disabled'
  | 'not-ready'
  | 'auto-off'
  | 'active-job'
  | 'idle'
  | 'waiting-first-run'
  | 'due'
  | 'scheduled'

export interface NextRunInput {
  lastRunAt: string | null
  intervalMinutes: number
  workCooldownMinutes: number
  autoIterate: boolean
  hasOpenWork: boolean
  hasActiveJob: boolean
  // A disabled repository and a sleeping instance are reasons a run will not
  // happen; the console used to print a happy time for both.
  repoEnabled: boolean
  instanceReady: boolean
  floorMinutes?: number
  now?: number
}

export interface NextRun {
  at: number | null
  state: NextRunState
}

export function dueAfterMs(intervalMinutes: number, workCooldownMinutes: number, floorMinutes = 15): number {
  return Math.max(floorMinutes, Math.min(intervalMinutes, workCooldownMinutes)) * 60_000
}

export function nextRun(input: NextRunInput): NextRun {
  if (!input.repoEnabled) return { at: null, state: 'disabled' }
  if (!input.instanceReady) return { at: null, state: 'not-ready' }
  if (!input.autoIterate) return { at: null, state: 'auto-off' }
  if (input.hasActiveJob) return { at: null, state: 'active-job' }
  if (!input.hasOpenWork) return { at: null, state: 'idle' }
  const last = input.lastRunAt === null ? Number.NaN : Date.parse(input.lastRunAt)
  if (!Number.isFinite(last)) return { at: null, state: 'waiting-first-run' }
  const at = last + dueAfterMs(input.intervalMinutes, input.workCooldownMinutes, input.floorMinutes)
  return at <= (input.now ?? Date.now()) ? { at, state: 'due' } : { at, state: 'scheduled' }
}
