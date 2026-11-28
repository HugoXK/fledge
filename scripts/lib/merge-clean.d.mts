// Types for the clean T0/T1 drain planner, so the TypeScript suite can build
// fixture pull requests and run the same decision code the workflow runs.
export interface MergeCandidateRepo {
  full_name?: string
}

export interface MergeCandidatePullRequest {
  number?: number
  state?: string
  draft?: boolean
  labels?: { name?: string }[]
  head?: { ref?: string; sha?: string; repo?: MergeCandidateRepo }
  base?: { ref?: string; repo?: MergeCandidateRepo }
  // `null` when the pull request is not queued; an object when auto-merge is
  // enabled. The drain skips anything it did not queue itself.
  auto_merge?: unknown
  // The API's count of changed files; the CLI compares it with the file list it
  // read to notice a truncated list.
  changed_files?: number
}

export interface MergeCandidateCheckRun {
  name?: string
  status?: string
  conclusion?: string | null
  // Ordering is by `started_at`, never by `completed_at`: a pending re-run has
  // no end time and must still win over an older green.
  started_at?: string
  completed_at?: string
}

export interface MergeCandidateEntry {
  pr?: MergeCandidatePullRequest
  // The tier the caller computed with `tierForChanges`; labels are never read
  // as a tier.
  tier?: string
  checks?: MergeCandidateCheckRun[]
  labels?: string[]
  hold?: boolean
  changesRequested?: boolean
  // The head SHA the caller re-read immediately before deciding, so a push
  // during the read produces `skip:head-moved` instead of a stale merge.
  observedHead?: string | null
  defaultBranch?: string
  filesTruncated?: boolean
}

export type MergeCleanAction = 'enqueue' | 'skip'

export interface MergeCleanDecision {
  action: MergeCleanAction
  reason: string
  number: number
  head: string
  tier: string
}

export declare const REQUIRED_CHECKS: readonly string[]
export declare const HOLD_LABELS: readonly string[]
export declare const CHANGES_LABEL: string
/** The newest run a name carries, by `started_at`. */
export declare function latestRun(
  checks: MergeCandidateCheckRun[] | undefined,
  name: string,
): MergeCandidateCheckRun | null
export declare function classifyMergeCandidate(entry?: MergeCandidateEntry): MergeCleanDecision
export declare function planMergeClean(input?: { entries?: MergeCandidateEntry[]; defaultBranch?: string }): {
  decisions: MergeCleanDecision[]
  candidates: MergeCleanDecision[]
}
