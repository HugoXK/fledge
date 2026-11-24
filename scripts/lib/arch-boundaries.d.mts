export interface SourceFile {
  path: string
  content: string
}

export interface Violation {
  file: string
  line: number
  rule: string
  reason: string
}

export interface BoundaryRule {
  id: string
  from: RegExp
  to: RegExp
  runtimeOnly: boolean
  allow?: string[]
  reason: string
}

export interface ParsedImport {
  line: number
  specifier: string
  typeOnly: boolean
}

export const MAX_FILE_LINES: number
export const DEFAULT_RULES: BoundaryRule[]

export function parseImports(content: string): ParsedImport[]
export function checkImports(input: { files: SourceFile[]; rules?: BoundaryRule[] }): Violation[]
export function lineCount(content: string): number
export function checkFileSizes(input: {
  files: SourceFile[]
  grandfather?: Record<string, number>
  maxLines?: number
}): Violation[]
export function checkArchitecture(input: {
  files: SourceFile[]
  grandfather?: Record<string, number>
  maxLines?: number
  rules?: BoundaryRule[]
}): {
  violations: Violation[]
  checked: { files: number; imports: number; grandfathered: number }
}
