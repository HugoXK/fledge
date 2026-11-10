// Types for the template-injection checker, so the TypeScript suite can feed it
// fixture workflow text instead of asserting over the real tree.
export interface InjectionAllowEntry {
  expression: string
  reason: string
}

export interface InjectionFinding {
  file: string
  line: number
  expression: string
}

export interface InjectionReport {
  findings: InjectionFinding[]
  files: string[]
}

export declare const ALLOWLIST_FILE: string

export declare function scanWorkflowText(text: string, file: string, allowlist?: InjectionAllowEntry[]): InjectionFinding[]

export declare function parseAllowlist(text: string): InjectionAllowEntry[]

export declare function readAllowlist(path?: string): InjectionAllowEntry[]

export declare function scanWorkflows(directory: string, allowlist?: InjectionAllowEntry[]): InjectionReport
