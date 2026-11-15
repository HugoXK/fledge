// Types for the gate-integrity classifier, so the TypeScript suite can call the
// real implementation instead of restating the path rules.
export interface GateFileRule {
  prefix: string
  kind: string
}

export interface GateSummaryOptions {
  changed?: number
  base?: string
}

export declare const GATE_FILE_RULES: GateFileRule[]

export declare function isGateFile(path: string): boolean

export declare function classifyGateFiles(paths: readonly string[] | string[] | null | undefined): string[]

export declare function gateSummary(files: readonly string[] | string[], options?: GateSummaryOptions): string
