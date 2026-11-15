import { parseFindings, type ReportedFinding } from './securityFindings.js'

export interface Evidence {
  scope?: string
  acceptance?: string
  testPlan?: string
  testRed?: string
  testGreen?: string
  tests?: string
  checks?: string
  files?: number
  risk?: string
  rollback?: string
  //: #379: the security findings this job reports, already bounded and
  //: validated. Reported ids only — the ledger behind them is not GitHub's
  //: alert store, and an id missing from one report proves nothing.
  findings?: ReportedFinding[]
  findingsDropped?: number
  findingsDismissedRefused?: number
}

const RISK = new Set(['low', 'medium', 'high', 'unknown'])

function text(value: unknown, limit = 500): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().slice(0, limit)
  return trimmed === '' ? undefined : trimmed
}

export function parseEvidence(value: unknown): Evidence | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const out: Evidence = {}
  const scope = text(raw.scope, 2000)
  const acceptance = text(raw.acceptance, 2000)
  const testPlan = text(raw.testPlan, 1000)
  const testRed = text(raw.testRed, 1000)
  const testGreen = text(raw.testGreen, 1000)
  const tests = text(raw.tests)
  const checks = text(raw.checks)
  const rollback = text(raw.rollback)
  const risk = text(raw.risk, 20)?.toLowerCase()
  const files = typeof raw.files === 'number' && Number.isFinite(raw.files) ? Math.max(0, Math.round(raw.files)) : undefined
  // #379: a malformed list is counted, not silently empty: a job whose findings
  // were all refused must not look like a job that found nothing.
  const parsedFindings = parseFindings(raw.findings)
  if (scope !== undefined) out.scope = scope
  if (acceptance !== undefined) out.acceptance = acceptance
  if (testPlan !== undefined) out.testPlan = testPlan
  if (testRed !== undefined) out.testRed = testRed
  if (testGreen !== undefined) out.testGreen = testGreen
  if (tests !== undefined) out.tests = tests
  if (checks !== undefined) out.checks = checks
  if (rollback !== undefined) out.rollback = rollback
  if (files !== undefined) out.files = files
  if (risk !== undefined && RISK.has(risk)) out.risk = risk
  if (parsedFindings.findings.length > 0) out.findings = parsedFindings.findings
  if (parsedFindings.dropped > 0) out.findingsDropped = parsedFindings.dropped
  if (parsedFindings.refusedDismissals > 0) out.findingsDismissedRefused = parsedFindings.refusedDismissals
  return Object.keys(out).length === 0 ? null : out
}

export function parseEvidenceJson(value: string | null): Evidence | null {
  if (value === null || value === '') return null
  try {
    return parseEvidence(JSON.parse(value))
  } catch {
    return null
  }
}
