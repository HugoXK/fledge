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

export type ActorGateProblem = 'missing-association-gate'

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
