// Types for the action-pin checker, so the TypeScript suite can call the real
// implementation and build its fixtures in a temporary directory instead of
// restating the rules.
export type ActionPinProblem = 'not-pinned' | 'missing-tag-comment'

export interface ActionPinFinding {
  file: string
  line: number
  value: string
  problem: ActionPinProblem
}

export interface ActionPinReport {
  findings: ActionPinFinding[]
  checked: number
  files: string[]
}

export declare function checkWorkflow(text: string, file: string): ActionPinFinding[]

export declare function scanWorkflows(dir: string): ActionPinReport

// One per reason the gate refuses: an ungated privileged job, an event it cannot
// classify, a privileged job whose triggers it could not read, and every shape it
// will not guess at (an `on:` value, a `jobs:` block, a header or a permission).
export type ActorGateProblem =
  | 'missing-association-gate'
  | 'unknown-event'
  | 'no-readable-trigger'
  | 'missing-trigger-block'
  | 'unparsed-on-entries'
  | 'unparsed-event-header'
  | `unparsed-on "${string}"`
  | 'missing-jobs-block'
  | 'unparsed-jobs-block'
  | 'unparsed-jobs-value'
  | 'unparsed-job-header'
  | `unparsed permissions value "${string}"`

export interface ActorGateFinding {
  file: string
  line: number
  job: string
  event: string
  problem: ActorGateProblem
}

export interface ActorGateReport {
  findings: ActorGateFinding[]
  checked: number
  files: string[]
}

/** Maps a stranger-reachable event to where its `author_association` lives. */
export declare const STRANGER_EVENT_ASSOCIATION: Record<string, string>

export declare function checkActorGates(text: string, file: string): ActorGateFinding[]

export declare function scanActorGates(dir: string): ActorGateReport
