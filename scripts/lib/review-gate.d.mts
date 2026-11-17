// Types for review-gate.mjs, the same pairing the other scripts/lib helpers use,
// so the suite can ask the parser which shapes are verdicts instead of keeping a
// copy of its expression (#931).

export interface ParsedConclusion {
  verdict: 'PASS' | 'FAIL' | 'INC' | 'REQUEST_CHANGES'
  sha: string
}

export function firstLine(body: unknown): string
export function parseConclusion(body: unknown): ParsedConclusion | null
