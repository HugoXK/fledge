// Types for the lint-warning gate, so the TypeScript suite can compute the
// comparison without running the CLI.

export interface WarningEntry {
  file: string
  rule: string
  message: string
  count: number
}

export interface WarningComparison {
  ok: boolean
  added: WarningEntry[]
  stale: WarningEntry[]
}

export interface OxlintDiagnostic {
  filename?: string
  code?: string
  message?: string
  severity?: string
}

export declare const BASELINE_VERSION: number
export declare const BASELINE_FILE: string
export declare const DEFAULT_TARGETS: string[]
export declare const BASELINE_POLICY: string
export declare function summarizeWarnings(diagnostics: OxlintDiagnostic[]): WarningEntry[]
export declare function compareWarnings(baseline: WarningEntry[], actual: WarningEntry[]): WarningComparison
export declare function formatFailure(result: WarningComparison): string
