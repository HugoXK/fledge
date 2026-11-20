// Types for the out-of-run aggregate (#855). The publisher workflow reads a
// finished `CI` run's job list and publishes the `ci-ok` check run itself, so
// the suite needs the pure half to assert what a head cannot do.
export interface FinishedJob {
  name?: string
  status?: string
  conclusion?: string | null
}

export interface JobResult {
  result: string
}

export interface AggregateVerdict {
  needs: Record<string, JobResult>
  lines: string[]
  problems: string[]
  ok: boolean
}

export interface AggregateInput {
  jobs: FinishedJob[]
  eventName?: string
  changes?: Record<string, boolean | string>
  required?: string[]
}

export interface CheckRunPayload {
  name: string
  head_sha: string
  status: string
  conclusion: string
  output: { title: string; summary: string }
}

export interface FinishedRun {
  conclusion?: string | null
  event?: string
  pull_requests?: Array<{ base?: { sha?: string; ref?: string } }>
}

export interface MergedPullRequest {
  number: number | null
  mergedAt: string
}

export declare const REQUIRED_CHECK: string
export declare const HEAD_AGGREGATE_JOB: string
export declare const CHECK_STATUS: string
export declare const CHECK_CONCLUSIONS: Readonly<{ pass: string; fail: string }>
export declare const SKIP_REASONS: Readonly<{ superseded: string; merged: string; notARun: string }>
export declare function runIdFrom(input?: { args?: string[]; env?: Record<string, string | undefined> }): number
export declare function jobKey(name: string, required?: string[]): string | null
export declare function needsFromJobs(jobs: FinishedJob[], required?: string[]): Record<string, JobResult>
export declare function verdict(input: AggregateInput): AggregateVerdict
export declare function baseShas(run: FinishedRun | null): string[]
export declare function lostItsBase(run: FinishedRun | null): boolean
export declare function mergedPullRequestOf(candidate: unknown): MergedPullRequest | null
export declare function skipReason(run: FinishedRun | null, mergedCandidate?: unknown): string | null
export declare function skipDetail(run: FinishedRun | null, reason: string | null, mergedCandidate?: unknown): string
export declare function shouldPublish(run: FinishedRun | null, mergedCandidate?: unknown): boolean
export declare function checkRunPayload(input: {
  headSha: string
  result: AggregateVerdict
  runId: number
  runUrl?: string
  required?: string[]
  /** #1116: the policy this verdict was computed under. When present it is
   *  written into the summary so the out-of-band scanner can compare hashes
   *  instead of inferring from a title. */
  policy?: { requiredHash: string; gateSha: string; text: string }
}): CheckRunPayload
