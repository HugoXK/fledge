import type { JobRow } from '../db.js'
import type { PathGuardResult } from './pathGuard.js'

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
  reasons: string[]
}

export interface MergeReadiness {
  state: 'ready' | 'blocked' | 'unknown'
  reasons: string[]
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
    return { state: 'blocked', reasons: guard.violations.map((violation) => `${violation.file}: ${violation.reason}`) }
  }
  if (verification !== null && !verification.ok) {
    return { state: 'blocked', reasons: verification.reasons.length === 0 ? ['Evidence verification failed.'] : verification.reasons }
  }
  if (guard === null && verification === null) return { state: 'unknown', reasons: ['Not verified yet.'] }
  return { state: 'ready', reasons: [] }
}
