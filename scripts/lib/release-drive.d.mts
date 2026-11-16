// Types for release-drive.mjs.

export interface DrivePlan {
  shouldRelease: boolean
  nextVersion: string
  reason: string
}

export interface DriveCheck {
  name: string
  status?: string
  conclusion?: string
}

export interface DriveOpenReleasePr {
  number: number
  headSha: string
  branch?: string
  title?: string
  files?: string[]
  blocked?: boolean
  checks?: DriveCheck[]
  /** True only when the head branch lives in the base repository, never a fork. */
  sameRepo?: boolean
}

export interface DriveMergedPr {
  number: number
  title: string
  headRef?: string
  mergeCommitSha?: string
  mergedAt?: string
}

export interface DriveState {
  plan?: DrivePlan
  openReleasePr?: DriveOpenReleasePr | null
  mergedPrs?: DriveMergedPr[]
  lastMergedPr?: { number: number; title: string; headRef: string } | null
  tags?: string[]
  ciOk?: string
  /** The newest `ci-ok` run: the id tells "not yet" from "red" (#864). */
  ciOkRun?: { id?: number; status?: string; conclusion?: string | null }
  dryRun?: boolean
  orphanBranches?: Array<{ branch?: string; version?: string; tag?: string; sha?: string }>
}

export interface DriveDecision {
  action: 'open-pr' | 'enqueue' | 'report-blocked' | 'tag' | 'wait-ci' | 'none'
  reason: string
  pr?: number
  headSha?: string
  tag?: string
  sha?: string
  version?: string
  failing?: string[]
  branch?: string
  dryRun?: boolean
  wouldHave?: string
  ciOkRunId?: number
  ciOkReads?: number
  ciOkWaitedMs?: number
}

export interface CiOkObservation {
  ciOk?: string
  ciOkRun?: { id?: number; status?: string; conclusion?: string | null }
}

/** Reads before the `ci-ok` re-read gives up, and the pause between them (#864). */
export declare const CI_OK_READS: number
export declare const CI_OK_INTERVAL_MS: number

export declare function decideDrive(state: DriveState): DriveDecision

export declare function decideWithCiRetry(input: {
  state: DriveState
  decide?: (state: DriveState) => DriveDecision
  readCiOk: () => Promise<CiOkObservation | null | undefined>
  wait: (ms: number) => Promise<void>
  attempts?: number
  intervalMs?: number
}): Promise<DriveDecision>
