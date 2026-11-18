import type { JobRow } from '../db.js'
import type { PathGuardResult } from './pathGuard.js'
import type { TestImpact } from './testImpact.js'

export interface TestEvidence {
  state: 'verified' | 'unverified' | 'contradicted'
  claimed: boolean
  greenChecks: string[]
  failingChecks: string[]
  quarantinedChecks: string[]
}

export interface TestRun {
  name: string
  passed: boolean
}

export interface TestStability {
  name: string
  runs: number
  alternations: number
  state: 'quarantined' | 'stable' | 'insufficient-evidence'
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
  // #378: which tests the change was expected to run, and why. Absent on a
  // snapshot written before the map existed, so the page omits the row instead
  // of printing an empty selection.
  testImpact?: TestImpact
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

// #378: a check that is green now is not evidence a change works if the same
// test has been changing its mind. A test that alternates pass/fail across
// recorded runs is quarantined: it still runs and its result is still shown, but
// it cannot be the only reason to call a pull request verified. The threshold is
// two flips inside at least three runs, so a single failure — or a first
// failure that has not alternated yet — is never a quarantine.
// The one place that decides what a "test job" is, so the ledger and the
// evidence gate accept the same names.
export function isTestCheckName(name: string): boolean {
  return TEST_CHECK.test(name)
}

export function quarantineTests(runs: TestRun[], threshold = 2): TestStability[] {
  const order: string[] = []
  const ledger = new Map<string, { runs: number; alternations: number; last: boolean | null }>()
  for (const run of runs) {
    let entry = ledger.get(run.name)
    if (entry === undefined) {
      entry = { runs: 0, alternations: 0, last: null }
      ledger.set(run.name, entry)
      order.push(run.name)
    }
    if (entry.last !== null && entry.last !== run.passed) entry.alternations += 1
    entry.runs += 1
    entry.last = run.passed
  }
  return order.map((name) => {
    const entry = ledger.get(name) as { runs: number; alternations: number }
    const enough = entry.runs >= threshold + 1
    return {
      name,
      runs: entry.runs,
      alternations: entry.alternations,
      state: enough && entry.alternations >= threshold ? 'quarantined' : enough ? 'stable' : 'insufficient-evidence',
    }
  })
}

export function evaluateTestEvidence(claimed: boolean, checks: Array<{ name: string; status: string; conclusion: string | null }>, runs: TestRun[] = []): TestEvidence {
  const quarantined = new Set(quarantineTests(runs).filter((entry) => entry.state === 'quarantined').map((entry) => entry.name))
  const green = checks.filter((check) => check.status === 'completed' && GREEN.has(check.conclusion ?? '') && TEST_CHECK.test(check.name)).map((check) => check.name)
  const greenChecks = green.filter((name) => !quarantined.has(name))
  const quarantinedChecks = green.filter((name) => quarantined.has(name))
  // A quarantined test does not excuse a red: a failure is still a failure, it
  // just cannot be counted on when it is green.
  const failingChecks = checks.filter((check) => check.status === 'completed' && !GREEN.has(check.conclusion ?? '') && !IGNORED.has(check.conclusion ?? '') && TEST_CHECK.test(check.name)).map((check) => check.name)
  if (!claimed) return { state: 'unverified', claimed: false, greenChecks, failingChecks, quarantinedChecks }
  if (failingChecks.length > 0) return { state: 'contradicted', claimed: true, greenChecks, failingChecks, quarantinedChecks }
  if (greenChecks.length > 0) return { state: 'verified', claimed: true, greenChecks, failingChecks, quarantinedChecks }
  if (checks.length === 0) return { state: 'contradicted', claimed: true, greenChecks, failingChecks, quarantinedChecks }
  return { state: 'unverified', claimed: true, greenChecks, failingChecks, quarantinedChecks }
}

export function parseVerification(value: string | null): VerificationResult | null {
  if (value === null || value === '') return null
  try {
    const parsed = JSON.parse(value) as VerificationResult
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.ok !== 'boolean') return null
    // #378: a snapshot written before the quarantine field existed has no
    // `quarantinedChecks`. Reading one must not throw on `undefined.length`, and
    // "no field" means "nothing was quarantined when this was written", not an
    // empty list invented by the reader.
    if (parsed.testEvidence !== null && typeof parsed.testEvidence === 'object') parsed.testEvidence.quarantinedChecks ??= []
    return parsed
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
