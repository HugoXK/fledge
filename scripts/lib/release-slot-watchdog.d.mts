// Types for the release-slot watchdog planner, so the TypeScript suite can
// build fixtures and run the same decision code the workflow runs.
export interface SlotRelease {
  tag_name?: string
  published_at?: string | null
  html_url?: string
}

export interface SlotRun {
  id?: number
  event?: string
  created_at?: string
  status?: string
  conclusion?: string | null
  head_sha?: string
}

export interface SlotIssue {
  number?: number
  state?: string
  body?: string | null
}

export interface SlotPlan {
  shouldRelease: boolean
  reason?: string
  total?: number
  features?: number
  fragments?: number
}

export interface SlotWindow {
  slot: string
  day: string
  graceEnds: string
}

export interface ObservedSlotRun {
  id: number
  event: string
  status: string
  conclusion: string
  createdAt: string
  headSha: string
}

export type SlotWatchdogAction =
  | 'invalid-clock'
  | 'too-early'
  | 'shipped'
  | 'missed'
  | 'already-open'
  | 'declined'

export type SlotWatchdogAlarm = 'workflow-failed' | 'no-run' | 'plan-unavailable' | 'release-not-shipped'

export interface SlotWatchdogDecision {
  action: SlotWatchdogAction
  reason: string
  checkedAt: string
  slot?: string
  day?: string
  graceEnds?: string
  release?: { tag: string; publishedAt: string }
  existingIssueNumber?: number
  observedRuns?: ObservedSlotRun[]
  alarm?: SlotWatchdogAlarm
  planReason?: string
  issue?: { title: string; body: string }
}

export declare const SLOT_HOUR_UTC: number
export declare const GRACE_MINUTES: number
export declare const SLOT_MARKER_PREFIX: string
export declare const ALARMS: SlotWatchdogAlarm[]

export declare function slotFor(now?: string | null, graceMinutes?: number): SlotWindow | null
export declare function markerFor(slot?: string | null): string
export declare function decideSlotWatchdog(input?: {
  now?: string
  graceMinutes?: number
  releases?: SlotRelease[]
  runs?: SlotRun[]
  issues?: SlotIssue[]
  plan?: SlotPlan | null
}): SlotWatchdogDecision

export declare function planFromArtifactZip(bytes?: Uint8Array | Buffer | null): SlotPlan | null
