// Types for the secret scanner so the suite can read the same rules the CLI
// uses instead of restating them.

export interface Rule {
  name: string
  pattern: RegExp
  valueGroup?: number
}

export interface AllowEntry {
  file: string
  line: number
  reason: string
}

export interface Finding {
  file: string
  line: number
  rule: string
  prefix: string
  length: number
}

export interface Skipped {
  file: string
  // The fs error code, e.g. ENOENT for a tracked symlink that points nowhere.
  reason: string
}

export interface ScanResult {
  findings: Finding[]
  skipped: Skipped[]
}

export declare const RULES: Rule[]
export declare const ALLOWLIST_FILE: string
export declare function trackedFiles(root: string): string[]
export declare function isBinary(text: string): boolean
export declare function isPlaceholder(value: string): boolean
export declare function allowlisted(file: string, line: number, allowlist: AllowEntry[]): boolean
export declare function loadAllowlist(root: string): AllowEntry[]
export declare function scan(root: string, allowlist: AllowEntry[]): ScanResult
export declare function scanText(text: string, file: string, allowlist: AllowEntry[]): Finding[]
