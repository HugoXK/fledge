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
  base?: { repo?: MergeCandidateRepo }
  // `null` when the pull request is not queued; an object when auto-merge is
  // enabled. The drain skips anything it did not queue itself.
  auto_merge?: unknown
}

export interface MergeCandidateCheckRun {
  name?: string
  status?: string
  conclusion?: string | null
  completed_at?: string
}

export interface MergeCandidateEntry {
  pr?: MergeCandidatePullRequest
  // The tier the caller computed with `tierForChanges`; labels are never read.
  tier?: string
  checks?: MergeCandidateCheckRun[]
  labels?: string[]
  hold?: boolean
  // The head SHA the caller re-read immediately before deciding, so a push
  // during the read produces `skip:head-moved` instead of a stale merge.
  observedHead?: string | null
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
export declare const HOLD_LABEL: string
/** The newest check run a name carries, by `completed_at`. */
export declare function latestConclusion(
  checks: MergeCandidateCheckRun[] | undefined,
  name: string,
): MergeCandidateCheckRun | null
export declare function classifyMergeCandidate(entry?: MergeCandidateEntry): MergeCleanDecision
export declare function planMergeClean(input?: { entries?: MergeCandidateEntry[] }): {
  decisions: MergeCleanDecision[]
  candidates: MergeCleanDecision[]
}
