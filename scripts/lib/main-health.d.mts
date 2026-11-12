// Types for main-health.mjs so the TypeScript suites can import it.

export declare const MAIN_REF: string
export declare const RED_LABEL: string
export declare const RED_TITLE: string
export declare const RED_LABEL_COLOR: string
export declare const RED_LABEL_DESCRIPTION: string
export declare const MAIN_EVENTS: string[]

export type JobResult = 'success' | 'failure' | 'cancelled' | 'skipped' | (string & {})

export declare function failingJobsFrom(needs?: Record<string, { result?: JobResult } | undefined>): string[]

export interface EnsureTrackerLabelInput {
  label?: string
  listLabels: () => Promise<string[]>
  createLabel: (label: string) => Promise<void>
}

export interface EnsureTrackerLabelResult {
  present: boolean
  created: boolean
}

export declare function ensureTrackerLabel(input: EnsureTrackerLabelInput): Promise<EnsureTrackerLabelResult>

export interface OpenTracker {
  number: number
  title?: string
  createdAt?: string
}

export interface MainHealthInput {
  conclusion?: string
  eventName?: string
  ref?: string
  sha?: string
  failingJobs?: string[]
  runUrl?: string
  openTrackers?: OpenTracker[]
}

export interface TrackerRef {
  number: number
  title: string
}

export interface IssuePayload {
  title: string
  labels: string[]
  body: string
}

export type MainHealthAction = 'create' | 'comment' | 'close' | 'none'

export interface MainHealthDecision {
  action: MainHealthAction
  reason: string
  tracker?: TrackerRef
  issue?: IssuePayload
  body?: string
}

export declare function decision(input?: MainHealthInput): MainHealthDecision

// One `gh` call: the caller's argv in, the command's stdout out.
export type GhRunner = (args: string[]) => string

export declare function labelListArgs(): string[]
export declare function labelCreateArgs(label?: string): string[]
export declare function issueListArgs(): string[]
export declare function issueCreateArgs(issue?: Partial<IssuePayload>): string[]
export declare function issueCommentArgs(number: string | number, body: string): string[]
export declare function issueCloseArgs(number: string | number, body: string): string[]

export declare function apply(result: MainHealthDecision, run: GhRunner): Promise<string>
