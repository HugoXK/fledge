// Types for the retrigger entrypoint, so the TypeScript suite can call the real
// decision (the conclusion filter and the lookup by head sha) instead of
// restating it, and can count the API reads a refused completion performs.
export declare const TRIGGERING_CONCLUSIONS: string[]

// The part of a `workflow_run` payload this entrypoint reads. Every field is
// optional because the payload is whatever GitHub sent, and a missing one has to
// refuse rather than throw.
export interface FinishedRunPayload {
  id?: number | string
  event?: string
  conclusion?: string | null
  head_sha?: string
  head_repository?: { full_name?: string }
}

export interface WorkflowRunEvent {
  workflow_run?: FinishedRunPayload
}

export interface RetriggerInput {
  eventName: string
  event: WorkflowRunEvent | Record<string, unknown> | null
  repository: string
  api: (path: string, init?: { method?: string }) => Promise<unknown>
}

export interface RetriggerResult {
  /** The pull request to repair, or null when this completion triggers nothing. */
  number: number | null
  /** Why nothing was resolved, or which pull request was. Always set. */
  reason: string
}

/** Null when the completion wakes the gate, otherwise the reason it does not. */
export declare function refusalFor(input: Omit<RetriggerInput, 'api'>): string | null

/** The open pull request whose head is exactly `headSha`, in one API read. */
export declare function resolvePullRequest(input: {
  api: RetriggerInput['api']
  repo: string
  headSha: string
}): Promise<number | null>

/** The whole decision: filter, then at most one API read. */
export declare function execRetrigger(input: RetriggerInput): Promise<RetriggerResult>
