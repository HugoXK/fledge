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
  dryRun?: boolean
  wouldHave?: string
}

export declare function decideDrive(state: DriveState): DriveDecision
