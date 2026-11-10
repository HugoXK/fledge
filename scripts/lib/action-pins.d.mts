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
