// Types for the required-check aggregate, so the TypeScript suite can read the
// required list and compare it with ci.yml without running the CLI.
export interface JobResult {
  result?: string
  [key: string]: unknown
}

export interface EvaluateOptions {
  required?: string[]
  skippable?: Record<string, string[]>
  eventName?: string
}

export interface Evaluation {
  lines: string[]
  problems: string[]
}

export declare const REQUIRED_JOBS: string[]
export declare const SKIPPABLE_ON: Record<string, string[]>
export declare function evaluate(needs: Record<string, JobResult>, options?: EvaluateOptions): Evaluation
export declare function main(): void
