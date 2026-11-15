// #379: the per-repository ledger of security findings that jobs report.
//
// A finding is identified by the triple rule + path + line, so the same defect
// reported by a later job lands on the same row instead of looking new. The
// ledger keeps three different questions apart:
//
//   * what a job reported (this module's `applyReport`), which may only move a
//     row that the report names — absence is never evidence of a fix;
//   * what an operator decided (`dismissed` needs a written reason, `fixed`
//     needs written evidence), which is the only path to those two states;
//   * what the reader sees (`fixed` without evidence is displayed as
//     unverified, and a finding seen again after a decision is `regressed`).
//
// The module is pure: no clock, no database, no network. The caller passes the
// job id and reads the result back.

export type FindingState = 'open' | 'dismissed' | 'fixed' | 'regressed'

export type ReportedState = 'open' | 'dismissed'

export interface ReportedFinding {
  rule: string
  path: string
  line: number
  state: ReportedState
}

export interface ParsedFindings {
  findings: ReportedFinding[]
  //: Entries that named no usable finding. The count is kept so a report cannot
  //: look empty and clean when its entries were all malformed.
  dropped: number
  //: Entries that claimed `dismissed`. A dismissal needs a reason an operator
  //: writes, so the callback cannot set that state; the count makes the refusal
  //: visible instead of turning it into a silent `open`.
  refusedDismissals: number
}

export interface LedgerDecision {
  state: FindingState
  lastSeenJob: string
  dismissedInJob: string | null
}

export const FINDINGS_MAX = 100
export const RULE_MAX = 120
export const PATH_MAX = 200

const STATES: ReadonlySet<string> = new Set(['open', 'dismissed'])

export function findingId(finding: { rule: string; path: string; line: number }): string {
  return `${finding.rule} ${finding.path}:${finding.line}`
}

//: A bounded string, or undefined when the report broke the contract. Unlike a
//: truncated value, a refused one cannot pass a longer string off as its prefix.
function bounded(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > limit) return undefined
  return trimmed
}

function parseFinding(value: unknown): ReportedFinding | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const rule = bounded(raw.rule, RULE_MAX)
  const path = bounded(raw.path, PATH_MAX)
  const line = raw.line
  const state = raw.state === undefined ? 'open' : raw.state
  if (rule === undefined || path === undefined) return null
  if (typeof line !== 'number' || !Number.isInteger(line) || line <= 0) return null
  if (typeof state !== 'string' || !STATES.has(state)) return null
  return { rule, path, line, state: state as ReportedState }
}

export function parseFindings(value: unknown): ParsedFindings {
  if (!Array.isArray(value)) return { findings: [], dropped: 0, refusedDismissals: 0 }
  const findings: ReportedFinding[] = []
  const seen = new Set<string>()
  let dropped = 0
  let refusedDismissals = 0
  for (const entry of value) {
    const parsed = parseFinding(entry)
    if (parsed === null) {
      dropped += 1
      continue
    }
    if (parsed.state === 'dismissed') {
      // The callback carries no reason, so it may not set the dismissed state.
      refusedDismissals += 1
      continue
    }
    if (findings.length >= FINDINGS_MAX || seen.has(findingId(parsed))) {
      dropped += 1
      continue
    }
    seen.add(findingId(parsed))
    findings.push(parsed)
  }
  return { findings, dropped, refusedDismissals }
}

//: What one report does to a row. `undefined` means "this entry may not move
//: the ledger". An id the report does not name is not passed here at all, which
//: is the fail-closed rule: a missing finding is never a fix.
export function applyReport(
  previous: { state: FindingState; firstSeenJob: string; dismissedInJob: string | null } | undefined,
  reported: ReportedFinding,
  jobId: string,
): LedgerDecision | null {
  // A dismissal without a reason is not a state this ledger can hold.
  if (reported.state !== 'open') return null
  if (previous === undefined) return { state: 'open', lastSeenJob: jobId, dismissedInJob: null }
  if (previous.state === 'dismissed') {
    // The page names the job the finding was dismissed in; the first sighting
    // is the fallback for a row dismissed before that field was written.
    return { state: 'regressed', lastSeenJob: jobId, dismissedInJob: previous.dismissedInJob ?? previous.firstSeenJob }
  }
  if (previous.state === 'fixed') return { state: 'regressed', lastSeenJob: jobId, dismissedInJob: null }
  return { state: previous.state, lastSeenJob: jobId, dismissedInJob: previous.dismissedInJob }
}

//: A fixed row is only "verified" when the evidence the fix rested on is still
//: recorded. The store refuses to write one without it; the view calls the row
//: unverified rather than trusting the state alone.
export function isVerifiedFixed(row: { state: string; reason: string | null }): boolean {
  return row.state === 'fixed' && row.reason !== null && row.reason.trim() !== ''
}
