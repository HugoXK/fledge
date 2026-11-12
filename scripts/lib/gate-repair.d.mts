// Types for the pure repair planner, so the TypeScript suite can unit-test the
// invariant directly instead of only through the CLI.
export declare const REQUIRED_CONTEXT: string
export declare const MAX_REPAIR_ATTEMPT: number

export interface GateCheckRun {
  id?: number | string
  name: string
  status: string
  conclusion: string | null
  started_at?: string
  completed_at?: string
  check_suite?: { id?: number | string }
}

export interface GateWorkflowRun {
  id: number | string
  run_attempt: number | string
  status?: string
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

export declare function isRepairCandidate(run: GateWorkflowRun, currentRunId?: string): boolean

export declare function standingChecks(checkRuns: GateCheckRun[]): GateCheckRun[]

export declare function repairPlan(input: {
  expected: 'success' | 'failure'
  checkRuns: GateCheckRun[]
  runs: GateWorkflowRun[]
  jobsFor: (runId: number | string) => GateJob[]
  currentRunId?: string
}): RepairPlan
