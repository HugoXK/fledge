// One rule for "when does this repository run again?", copied from the worker
// so the console cannot answer with a second formula (#564). The worker is due
// after `max(15, min(interval, workCooldown))` (src/jobs/service.ts:3004-3005):
// a repository with open work is due after the short work cooldown, never after
// its discovery interval, and 15 minutes is the floor the UI already renders.
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
