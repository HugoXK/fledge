// Types for the CI watchdog planner, so the TypeScript suite can build fixture
// pull requests and run the same decision code the workflow runs.
export interface WatchdogRepo {
  full_name?: string
}

export interface WatchdogPullRequest {
  number?: number
  state?: string
  head?: { ref?: string; sha?: string; repo?: WatchdogRepo }
  base?: { repo?: WatchdogRepo }
}

export interface WatchdogCheckRun {
  name?: string
  status?: string
  conclusion?: string | null
}

export interface WatchdogWorkflowRun {
  id?: number
  name?: string
  path?: string
  status?: string
  conclusion?: string | null
}

export interface WatchdogEntry {
  pr?: WatchdogPullRequest
  // Declared but never read by the planner: it stays as the witness that a check
  // run from another workflow is not evidence that `CI` reached the tip.
  checks?: WatchdogCheckRun[]
  runs?: WatchdogWorkflowRun[]
}

export type WatchdogAction = 'dispatch' | 'skip'
export type WatchdogReason =
  | 'not-open'
  | 'fork'
  | 'no-number'
  | 'no-head'
  | 'active-ci'
  | 'has-ci-run'
  | 'no-ci-run'

export interface WatchdogDecision {
  action: WatchdogAction
  reason: WatchdogReason
  number: number
  branch: string
  sha: string
  activeRunId?: number
  previousRunId?: number
}

export interface WatchdogDispatch {
  number: number
  branch: string
  sha: string
}

export interface WatchdogPlan {
  dispatches: WatchdogDispatch[]
  decisions: WatchdogDecision[]
  cap: number
}

export declare const CI_WORKFLOW_FILE: string
export declare const CI_WORKFLOW_NAME: string
export declare const CI_WORKFLOW_PATH: string
export declare const DEFAULT_DISPATCH_LIMIT: number

export declare function isSameRepoPullRequest(pr?: WatchdogPullRequest): boolean
export declare function isCiRun(run?: WatchdogWorkflowRun): boolean
export declare function activeCiRun(runs?: WatchdogWorkflowRun[]): WatchdogWorkflowRun | null
export declare function classifyPullRequest(entry?: WatchdogEntry): WatchdogDecision
export declare function planCiWatchdog(input?: { entries?: WatchdogEntry[]; limit?: number }): WatchdogPlan
