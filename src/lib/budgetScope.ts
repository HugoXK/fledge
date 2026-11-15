// #697: a budget scope is one cap with one enforcement point. The job scope is
// `repos.job_budget_cny` (#357/#636); the repository and principal scopes live in
// the additive `budget_scopes` table. This module is the decision only — no
// clock, no store, no SQL — so the precedence rule is testable on its own, and
// the one enforcement point only has to ask it a question.

export type BudgetScopeKind = 'job' | 'repository' | 'principal'

// Most specific first. The order *is* the precedence rule: an outer scope may
// never loosen an inner cap, so a more specific exceeded scope always fires
// before a wider one, whatever room each has left.
export const BUDGET_SCOPE_KINDS: readonly BudgetScopeKind[] = ['job', 'repository', 'principal']

export function isBudgetScopeKind(value: string): value is BudgetScopeKind {
  return (BUDGET_SCOPE_KINDS as readonly string[]).includes(value)
}

export const BUDGET_SCOPE_ACTIONS = ['alert', 'pause', 'cancel'] as const

export type BudgetScopeAction = (typeof BUDGET_SCOPE_ACTIONS)[number]

export function isBudgetScopeAction(value: string): value is BudgetScopeAction {
  return (BUDGET_SCOPE_ACTIONS as readonly string[]).includes(value)
}

export interface BudgetScopeCandidate {
  kind: BudgetScopeKind
  // The scope key: the job id, the repository id, or `identityPrincipalId()`.
  id: string
  capCny: number
  // `alert` is kept for the console and the finish notice; it never stops a job,
  // so it can never shadow a stopping cap.
  action: string
  spentUsd: number
}

export interface BudgetStop {
  kind: BudgetScopeKind
  id: string
  capCny: number
  spentUsd: number
  spentCny: number
  action: 'pause' | 'cancel'
  code: 'JOB_BUDGET_PAUSED' | 'JOB_BUDGET_CANCELLED'
}

// The scope word the job sentence and the console use. Kept here so the
// enforcement point, the localiser and the view cannot drift apart.
export function budgetScopeWordZh(kind: BudgetScopeKind): string {
  if (kind === 'job') return '单任务'
  return kind === 'repository' ? '仓库' : '用户'
}

export function budgetScopeWordEn(kind: BudgetScopeKind): string {
  if (kind === 'job') return 'this job'
  return kind === 'repository' ? 'this repository' : 'this user'
}

// `usdCny` is passed in rather than read from config: the CNY cap is fed only by
// USD-billed rows, and the rate is the one the rest of the quota path uses.
export function budgetStop(candidates: readonly BudgetScopeCandidate[], usdCny: number): BudgetStop | null {
  const over = candidates
    .filter((entry) => entry.capCny > 0)
    .filter((entry) => entry.action === 'pause' || entry.action === 'cancel')
    .map((entry) => ({ ...entry, spentCny: entry.spentUsd * usdCny }))
    .filter((entry) => entry.spentCny > entry.capCny)
  if (over.length === 0) return null
  over.sort((left, right) => {
    const rank = BUDGET_SCOPE_KINDS.indexOf(left.kind) - BUDGET_SCOPE_KINDS.indexOf(right.kind)
    if (rank !== 0) return rank
    // Same specificity: the stricter cap wins, and "stricter" is the lower
    // remaining budget rather than the lower cap, because a cap twice the size
    // can still be the one with less room left.
    const remaining = left.capCny - left.spentCny - (right.capCny - right.spentCny)
    if (remaining !== 0) return remaining
    return left.id.localeCompare(right.id)
  })
  const winner = over[0]
  if (winner === undefined) return null
  const cancel = winner.action === 'cancel'
  return {
    kind: winner.kind,
    id: winner.id,
    capCny: winner.capCny,
    spentUsd: winner.spentUsd,
    spentCny: winner.spentCny,
    action: cancel ? 'cancel' : 'pause',
    code: cancel ? 'JOB_BUDGET_CANCELLED' : 'JOB_BUDGET_PAUSED',
  }
}
