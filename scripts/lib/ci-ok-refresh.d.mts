export interface PolicyIdentity {
  requiredHash: string
  gateSha: string
  text: string
}

export interface PublishedPolicy {
  requiredHash: string
  gateSha: string
}

export interface CheckRunLike {
  name?: string
  status?: string
  conclusion?: string | null
  completed_at?: string
  output?: { title?: string; summary?: string }
}

export type RefreshReason =
  | 'stale-policy'
  | 'no-published-verdict'
  | 'current-policy'
  | 'already-refreshed'
  | 'publisher-pending'
  | 'awaiting-ci'

export interface RefreshDecision {
  publish: boolean
  reason: RefreshReason
  detail: string
}

export const REFRESH_CHECK: string

export function policyIdentity(input: { required?: string[]; gateSha: string }): PolicyIdentity
export function parsePolicyIdentity(summary: unknown): PublishedPolicy | null
export function jobsOf(summary: unknown): string[]
export function refreshDecision(input: {
  headSha: string
  policy: PolicyIdentity
  checks: CheckRunLike[]
  ciCompleted: boolean
  /** #1116: a `ci-ok-publish.yml` run for this head is queued or in progress, so
   *  the verdict is imminent and the in-run aggregate must not be judged. */
  publisherPending?: boolean
}): RefreshDecision
