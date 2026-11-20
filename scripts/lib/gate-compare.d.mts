// Types for the workflow comparator (#1108), so the TypeScript suite can drive
// the real implementation over two workflow texts.
export interface WorkflowJobKey {
  name: string
  lines: string[]
}

export interface WorkflowJob {
  id: string
  keys: Map<string, WorkflowJobKey>
}

export interface GateCompareInput {
  base?: string
  head?: string
  required?: readonly string[] | string[]
}

export interface GateCompareResult {
  ok: boolean
  problems: string[]
  lines: string[]
}

export declare const GATE_COMPARE_FILE: string
export declare const GATE_COMPARE_ALLOWED_KEYS: readonly ['timeout-minutes']
export declare const REQUIRED_EVALUATOR: string
export declare const AGGREGATE_JOB: string
export declare const WORKFLOW_CHANGE_LABEL: string

export declare class GateWorkflowError extends Error {
  constructor(message: string)
}

export declare function parseWorkflowJobs(text: string): Map<string, WorkflowJob>

export declare function compareGate(input?: GateCompareInput): GateCompareResult
