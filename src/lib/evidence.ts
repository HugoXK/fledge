export interface Evidence {
  tests?: string
  checks?: string
  files?: number
  risk?: string
  rollback?: string
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
  const tests = text(raw.tests)
  const checks = text(raw.checks)
  const rollback = text(raw.rollback)
  const risk = text(raw.risk, 20)?.toLowerCase()
  const files = typeof raw.files === 'number' && Number.isFinite(raw.files) ? Math.max(0, Math.round(raw.files)) : undefined
  if (tests !== undefined) out.tests = tests
  if (checks !== undefined) out.checks = checks
  if (rollback !== undefined) out.rollback = rollback
  if (files !== undefined) out.files = files
  if (risk !== undefined && RISK.has(risk)) out.risk = risk
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
