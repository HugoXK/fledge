// Types for release-trigger.mjs (#315).

export interface TriggerOpenPullRequest {
  number: number
  branch?: string
}

export interface TriggerBranchEntry {
  name?: string
}

export interface TriggerInput {
  /** `push`, `schedule` or `workflow_dispatch`; anything else never plans. */
  event: string
  /** The moment the run evaluates the slot, ISO 8601 or a `Date`. */
  now: string | Date
  tags?: string[]
  branches?: Array<string | TriggerBranchEntry>
  openReleasePullRequests?: TriggerOpenPullRequest[]
  nextVersion?: string
  /** The newest tag's commit time; empty when there is no tag at all. */
  lastTagCommittedAt?: string
  guardsPass?: boolean
  guardReason?: string
}

export interface TriggerDecision {
  plan: boolean
  /** True only for a push before today's boundary that fills a dropped slot. */
  catchUp: boolean
  /** The 14:30Z boundary the decision was taken against, or null. */
  boundary: string | null
  /** Starts with a stable token: slot-open, catch-up, guard, open-pr, … */
  reason: string
}

export declare const BOUNDARY: string

export declare function latestBoundary(now: string | Date): string | null

export declare function decideTrigger(input?: TriggerInput): TriggerDecision
