// Types for the changed-lines coverage gate, so the TypeScript suite can drive
// the join of the pull request diff and the Node coverage report without
// spawning the CLI for every case.
export interface AddedLine {
  line: number
  text: string
}

export interface Violation {
  path: string
  line: number
}

export interface ChangedLinesVerdict {
  ok: boolean
  code: 'OK' | 'BELOW_FLOOR' | 'NO_SOURCE_LINES'
  measured: number
  covered: number
  ratio: number
  floor: number
  violations: Violation[]
  /** Changed files the report has no row for: the suite never loaded them. */
  missing: string[]
}

export declare function isGeneratedPath(path: string): boolean
export declare function isMeasuredLine(line: string): boolean
export declare function addedLinesFromDiff(diffText: string): Record<string, AddedLine[]>
export declare function parseCoverageReport(reportText: string): Record<string, number[]>
export declare function waiverFromBody(body: string): string | null
export declare function evaluateChangedLines(input: { diff: string; report: string; floor?: number }): ChangedLinesVerdict
