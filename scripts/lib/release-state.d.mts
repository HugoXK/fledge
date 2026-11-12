export interface PullRequestPageEntry {
  number?: number
  title?: string
  head?: { ref?: string; sha?: string; repo?: { full_name?: string } }
  base?: { repo?: { full_name?: string } }
  labels?: Array<{ name?: string }>
  merged_at?: string | null
}

export interface CheckRunEntry {
  id?: number
  name?: string
  status?: string
  conclusion?: string | null
}

export interface ReleaseBranchEntry {
  name?: string
  commit?: { sha?: string }
}

export interface OrphanBranch {
  branch: string
  version: string
  tag: string
  sha: string
}

export interface ReleaseState {
  lastTag: string
  lastTagCommittedAt: string
  packageVersion: string
  fragments: number
  tags: string[]
  dryRun: boolean
  ciOk: string
  openPr: PullRequestPageEntry | null
  openPrRejected: { number: number; title: string; branch: string; repo: string } | null
  lastMerged: PullRequestPageEntry | null
  mergedPrs: PullRequestPageEntry[]
  /** `release/v<version>` branches with no pull request in any state and no tag. */
  orphanBranches: OrphanBranch[]
}

export declare function flattenPages(value: unknown): PullRequestPageEntry[]
export declare function checkRunsOf(value: unknown): CheckRunEntry[]
export declare function latestConclusion(value: unknown, name: string): string
export declare function buildState(input: {
  lastTag?: string
  lastTagCommittedAt?: string
  packageVersion?: string
  fragments?: number | string
  tags?: string[]
  dryRun?: boolean | string
  closedPages?: unknown
  openPages?: unknown
  checks?: unknown
  branches?: Array<ReleaseBranchEntry | string> | unknown
}): ReleaseState

export declare function plannerInput(state: ReleaseState): {
  lastTag: string
  packageVersion: string
  prs: Array<{ number: number; title: string; labels: string[]; mergedAt: string }>
  fragments: string[]
  openReleasePr: boolean
  existingTags: string[]
  lastTagCommittedAt: string
}
