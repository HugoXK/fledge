// Types for the pure repair planner, so the TypeScript suite can unit-test the
// invariant directly instead of only through the CLI.
export declare const REQUIRED_CONTEXT: string

export interface GateCheckRun {
  name: string
  status: string
  conclusion: string | null
}

export interface GateWorkflowRun {
  id: number | string
  run_attempt: number | string
  conclusion: string | null
  created_at?: string
}

export interface GateJob {
  name: string
  conclusion: string | null
}

export interface RepairPlan {
  action: 'rerun' | 'none' | 'blocked'
  ids: Array<number | string>
  reason: string
}

export declare function repairPlan(input: {
  expected: 'success' | 'failure'
  checkRuns: GateCheckRun[]
  runs: GateWorkflowRun[]
  jobsFor: (runId: number | string) => GateJob[]
  currentRunId?: string
}): RepairPlan
