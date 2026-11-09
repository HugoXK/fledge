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

export interface ReleaseState {
  lastTag: string
  lastTagCommittedAt: string
  packageVersion: string
  fragments: number
  tags: string[]
  dryRun: boolean
  ciOk: string
  openPr: PullRequestPageEntry | null
  openPrRejected: { number: number; title: string; branch: string } | null
  lastMerged: PullRequestPageEntry | null
  mergedPrs: PullRequestPageEntry[]
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
}): ReleaseState
