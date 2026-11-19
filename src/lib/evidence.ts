import { parseFindings, type ReportedFinding } from './securityFindings.js'
import type { RedTestDecision, RedTestEvidence, RedTestRun } from './redTest.js'

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
  // #1040: the classified base run and the maintainer's answer to it. Both are
  // written by the server, so the page reads the record back instead of
  // re-deriving it from the prose.
  redTest?: RedTestEvidence
  redTestDecision?: RedTestDecision
}

const RISK = new Set(['low', 'medium', 'high', 'unknown'])
const VERDICTS = new Set(['red', 'passed', 'unverified'])
const SIGNATURES = new Set(['assertion', 'thrown', 'compile', 'missing-module', 'environment', 'timeout', 'skipped', 'flaky', 'unknown', 'passed', 'base-mismatch'])
// The record keeps a digest, never the output; the run that is parsed here is
// bounded at the same size so a hostile payload cannot carry more.
const RUN_OUTPUT_LIMIT = 20_000

function text(value: unknown, limit = 500): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().slice(0, limit)
  return trimmed === '' ? undefined : trimmed
}

// #1040: the base run arrives from the agent, so every field is bounded and a
// value that cannot be a run is dropped rather than guessed.
export function parseRedTestRun(value: unknown): RedTestRun | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const command = text(raw.command, 300)
  const baseSha = text(raw.baseSha, 100)
  const exitCode = typeof raw.exitCode === 'number' && Number.isFinite(raw.exitCode) ? Math.trunc(raw.exitCode) : null
  if (command === undefined || baseSha === undefined || exitCode === null) return null
  return {
    command,
    baseSha,
    exitCode,
    output: typeof raw.output === 'string' ? raw.output.slice(0, RUN_OUTPUT_LIMIT) : '',
    ...(raw.skipped === true ? { skipped: true } : {}),
    ...(raw.timedOut === true ? { timedOut: true } : {}),
  }
}

function parseRedTestEvidence(value: unknown): RedTestEvidence | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const command = text(raw.command, 300)
  const baseSha = text(raw.baseSha, 100)
  const signature = text(raw.signature, 40)
  const reason = text(raw.reason, 300)
  const outputSha256 = typeof raw.outputSha256 === 'string' && /^[0-9a-f]{64}$/.test(raw.outputSha256) ? raw.outputSha256 : null
  const exitCode = typeof raw.exitCode === 'number' && Number.isFinite(raw.exitCode) ? Math.trunc(raw.exitCode) : null
  if (command === undefined || baseSha === undefined || signature === undefined || reason === undefined || outputSha256 === null || exitCode === null) return null
  if (typeof raw.verdict !== 'string' || !VERDICTS.has(raw.verdict) || !SIGNATURES.has(signature)) return null
  return {
    command,
    baseSha,
    exitCode,
    verdict: raw.verdict as RedTestEvidence['verdict'],
    signature,
    reason,
    outputSha256,
    flaky: raw.flaky === true,
  }
}

function parseRedTestDecision(value: unknown): RedTestDecision | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const decision = raw.decision === 'confirmed' || raw.decision === 'challenged' ? raw.decision : null
  const by = text(raw.by, 100)
  const at = text(raw.at, 40)
  if (decision === null || by === undefined || at === undefined) return null
  return { decision, note: text(raw.note, 300) ?? '', by, at }
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
  const redTest = parseRedTestEvidence(raw.redTest)
  const redTestDecision = parseRedTestDecision(raw.redTestDecision)
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
  if (redTest !== null) out.redTest = redTest
  if (redTestDecision !== null) out.redTestDecision = redTestDecision
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
