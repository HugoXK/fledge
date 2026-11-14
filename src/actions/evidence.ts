import { stripAnsi } from './workflowLog.js'

// A model may only cite what the failed step printed. Timestamps and whitespace
// are formatting, not content, so they are removed before the comparison; every
// other difference is a mismatch.

const TIMESTAMP = /^\s*(?:\[\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\[\d{2}:\d{2}:\d{2}(?:\.\d+)?\]|\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*/

export type FailureCategory = 'external' | 'code' | 'unknown'

export interface EvidenceVerification {
  verified: string[]
  unverified: string[]
  excerpt: string
  allVerified: boolean
}

export function normalizeEvidenceLine(value: string): string {
  return stripAnsi(value)
    .replace(TIMESTAMP, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function verifyCitedEvidence(
  citedLines: readonly string[],
  failedStepOutput: string,
  maxExcerptChars = 4000,
): EvidenceVerification {
  const output = String(failedStepOutput ?? '')
    .split(/\r?\n/)
    .map((line) => ({ original: stripAnsi(line), normalized: normalizeEvidenceLine(line) }))
  const verified: string[] = []
  const unverified: string[] = []
  const excerptLines: string[] = []
  const seen = new Set<string>()
  for (const cited of citedLines) {
    const normalized = normalizeEvidenceLine(cited)
    if (normalized === '') {
      unverified.push(cited)
      continue
    }
    const match = output.find((line) => line.normalized === normalized)
    if (match === undefined) {
      unverified.push(cited)
      continue
    }
    verified.push(cited)
    if (!seen.has(match.original)) {
      seen.add(match.original)
      excerptLines.push(match.original)
    }
  }
  const joined = excerptLines.join('\n')
  return {
    verified,
    unverified,
    excerpt: joined.length <= maxExcerptChars ? joined : joined.slice(0, maxExcerptChars),
    allVerified: unverified.length === 0 && verified.length > 0,
  }
}

// The issue's rule: an unverified citation cannot support a classification. The
// caller passes the model's category and gets `unknown` unless every cited line
// was found in the failed step.
export function categoryWithVerifiedEvidence(category: FailureCategory, verification: EvidenceVerification): FailureCategory {
  return verification.allVerified ? category : 'unknown'
}
