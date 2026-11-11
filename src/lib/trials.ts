import type { TrialCandidate } from '../db.js'

// #279: the preview-trial state is derived, never stored: one registration date,
// one repository count and the sweep's `trial.expired` audit row are enough to
// say what an operator needs to know, and a stored state bit would be a second
// source of truth that can drift from the audit trail the sweep writes.
export const TRIAL_DAYS = 7
export const REMINDER_DAY = 5

export type TrialCandidateSource = TrialCandidate

export type TrialState = 'running' | 'expiring' | 'eligible' | 'expired' | 'exempt_used' | 'exempt_admin' | 'inactive'

export interface TrialRowView {
  id: string
  login: string
  registeredAt: string
  lastLoginAt: string | null
  status: string
  role: string
  days: number
  repos: number
  state: TrialState
  expiredAt: string | null
}

export function trialStateOf(row: TrialCandidate, now: number = Date.now()): TrialRowView {
  const created = Date.parse(row.created_at)
  const days = Number.isFinite(created) ? Math.max(0, Math.floor((now - created) / 86_400_000)) : 0
  const used = row.repos > 0 || row.repo_added_at !== null
  const admin = row.role === 'admin' || row.role === 'superadmin'

  let state: TrialState
  if (row.expired_at !== null) state = 'expired'
  else if (used) state = 'exempt_used'
  else if (admin) state = 'exempt_admin'
  else if (row.status !== 'approved') state = 'inactive'
  else if (days >= TRIAL_DAYS) state = 'eligible'
  else if (days >= REMINDER_DAY) state = 'expiring'
  else state = 'running'

  return {
    id: row.id,
    login: row.login,
    registeredAt: row.created_at,
    lastLoginAt: row.last_login_at,
    status: row.status,
    role: row.role,
    days,
    repos: row.repos,
    state,
    expiredAt: row.expired_at,
  }
}

export type TrialFilter = 'all' | 'eligible' | 'expiring' | 'expired'

export const TRIAL_FILTERS: readonly TrialFilter[] = ['all', 'eligible', 'expiring', 'expired']

export function isTrialFilter(value: string): value is TrialFilter {
  return (TRIAL_FILTERS as readonly string[]).includes(value)
}

export function filterTrials(rows: TrialRowView[], filter: TrialFilter): TrialRowView[] {
  if (filter === 'all') return rows
  return rows.filter((row) => row.state === filter)
}

export function trialCounts(rows: TrialRowView[]): Record<TrialFilter, number> {
  return {
    all: rows.length,
    eligible: rows.filter((row) => row.state === 'eligible').length,
    expiring: rows.filter((row) => row.state === 'expiring').length,
    expired: rows.filter((row) => row.state === 'expired').length,
  }
}
