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
  dryRun?: boolean
  orphanBranches?: Array<{ branch?: string; version?: string; tag?: string; sha?: string }>
}

export interface DriveDecision {
  action: 'open-pr' | 'enqueue' | 'report-blocked' | 'tag' | 'none'
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
}

export declare function decideDrive(state: DriveState): DriveDecision
