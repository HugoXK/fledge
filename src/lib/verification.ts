import type { JobRow } from '../db.js'
import type { PathGuardResult } from './pathGuard.js'

export interface TestEvidence {
  state: 'verified' | 'unverified' | 'contradicted'
  claimed: boolean
  greenChecks: string[]
  failingChecks: string[]
}

export interface VerificationResult {
  ok: boolean
  checkedAt: string
  sha: string
  prState: string
  draft: boolean
  mergeableState: string
  checks: { total: number; green: number; failing: string[]; pending: string[] }
  combinedStatus: string
  reviews: { changesRequested: boolean; approvals: number }
  testEvidence: TestEvidence
  reasons: string[]
  ruleChange?: { paths: string[]; acknowledged: boolean }
}

export interface MergeReadiness {
  state: 'ready' | 'blocked' | 'unknown'
  reasons: string[]
}

// #134: the name has to say "test job", so the pattern is anchored and covers
// the plural forms ordinary CI jobs use (`tests (22)`, `unit-tests`, `specs`).
// The boundary alone would be a false-negative fix: a singular-only pattern stops
// matching `tests (22)` because the `test` is followed by a word character.
const TEST_CHECK = /\b(tests?|specs?|pytest|jest|vitest|mocha|cargo|go[- ]test)\b/i
// #134: only a check that actually produced a result is evidence. `neutral` and
// `skipped` are completions without a verdict: they are not green, and they are
// not a test failure either, so they sit in their own set and land in neither
// list. Treating them as green let a job whose test job never ran report
// "Verified", and a skipped job whose only test check was skipped contradicted
// itself instead of reporting an absence.
const GREEN = new Set(['success'])
const IGNORED = new Set(['neutral', 'skipped'])

export function evaluateTestEvidence(claimed: boolean, checks: Array<{ name: string; status: string; conclusion: string | null }>): TestEvidence {
  const greenChecks = checks.filter((check) => check.status === 'completed' && GREEN.has(check.conclusion ?? '') && TEST_CHECK.test(check.name)).map((check) => check.name)
  const failingChecks = checks.filter((check) => check.status === 'completed' && !GREEN.has(check.conclusion ?? '') && !IGNORED.has(check.conclusion ?? '') && TEST_CHECK.test(check.name)).map((check) => check.name)
  if (!claimed) return { state: 'unverified', claimed: false, greenChecks, failingChecks }
  if (failingChecks.length > 0) return { state: 'contradicted', claimed: true, greenChecks, failingChecks }
  if (greenChecks.length > 0) return { state: 'verified', claimed: true, greenChecks, failingChecks }
  if (checks.length === 0) return { state: 'contradicted', claimed: true, greenChecks, failingChecks }
  return { state: 'unverified', claimed: true, greenChecks, failingChecks }
}

export function parseVerification(value: string | null): VerificationResult | null {
  if (value === null || value === '') return null
  try {
    const parsed = JSON.parse(value) as VerificationResult
    return typeof parsed === 'object' && parsed !== null && typeof parsed.ok === 'boolean' ? parsed : null
  } catch {
    return null
  }
}

export function parsePathGuard(value: string | null): PathGuardResult | null {
  if (value === null || value === '') return null
  try {
    const parsed = JSON.parse(value) as PathGuardResult
    return typeof parsed === 'object' && parsed !== null && typeof parsed.ok === 'boolean' ? parsed : null
  } catch {
    return null
  }
}

export function mergeReadiness(job: Pick<JobRow, 'pr_url' | 'path_guard_json' | 'verification_json' | 'status' | 'pr_state'>): MergeReadiness {
  if (job.pr_url === null || job.pr_state === 'merged' || job.pr_state === 'closed') {
    return { state: 'unknown', reasons: ['No open pull request.'] }
  }
  const guard = parsePathGuard(job.path_guard_json)
  const verification = parseVerification(job.verification_json)
  if (guard !== null && !guard.ok) {
    const reasons = guard.violations.map((violation) => `${violation.file}: ${violation.reason}`)
    if (reasons.length === 0 && guard.truncated === true) {
      reasons.push(`The changed-file list was cut off: checked ${guard.checkedFiles} of ${guard.reportedFiles} reported files.`)
    }
    return { state: 'blocked', reasons }
  }
  if (verification !== null && !verification.ok) {
    return { state: 'blocked', reasons: verification.reasons.length === 0 ? ['Evidence verification failed.'] : verification.reasons }
  }
  // Ready is a claim about both halves of the evidence. A half-filled row means
  // "we did not look", which is not "it is fine": `tryMerge` stores the path
  // guard on its own before it verifies, so a refused merge leaves exactly this
  // shape, and the console must not print the greenest state over it.
  if (guard === null && verification === null) {
    return { state: 'unknown', reasons: ['Not verified yet: neither the path guard nor the evidence verification has run.'] }
  }
  if (guard === null) {
    return { state: 'unknown', reasons: ['The path guard has not been checked yet: the changed files were never measured against the allow/deny lists.'] }
  }
  if (verification === null) {
    return { state: 'unknown', reasons: ['The pull request evidence has not been verified yet: checks, reviews and test evidence were never read.'] }
  }
  return { state: 'ready', reasons: [] }
}
