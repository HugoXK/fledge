import { ATTRIBUTION_FIELDS } from './attribution.js'
import type { Attribution, AttributionGround, AttributionGroundState, AttributionGroundStep } from './attribution.js'

export interface TeamStat {
  role: string
  calls: number
}

export function observedAttribution(stats: TeamStat[]): Attribution | null {
  const calls = (role: string): number => stats.find((entry) => entry.role === role)?.calls ?? 0
  const out: Attribution = {}
  if (calls('lead') > 0) out.claimedBy = 'Lead'
  if (calls('product') > 0) {
    out.claimedBy = out.claimedBy ?? 'Product'
    out.writtenBy = 'Product'
  }
  if (calls('dev1') > 0) out.implementedBy = 'Dev-1'
  else if (calls('dev2') > 0) out.implementedBy = 'Dev-2'
  if (calls('test') > 0) out.testedBy = 'Test'
  if (calls('reviewer') > 0) out.reviewedBy = 'Reviewer'
  else if (calls('security') > 0) out.reviewedBy = 'Security'
  return Object.keys(out).length === 0 ? null : out
}

export function observedRoles(stats: TeamStat[]): string[] {
  return stats.filter((entry) => entry.calls > 0).map((entry) => entry.role)
}

// #368: pair what the job claimed with what the instance saw, per attribution
// key, and never let one replace the other. `stats === null` means no instance
// observed this job, which is `no-observation`: the claim is unverified, not
// false, and not proven. Presence is the whole claim the call counts can carry —
// they say a seat worked, never that it wrote a file.
export function groundAttribution(claimed: Attribution | null, stats: TeamStat[] | null): AttributionGround {
  const observed = stats === null ? null : observedAttribution(stats)
  const steps: AttributionGroundStep[] = []
  for (const field of ATTRIBUTION_FIELDS) {
    const claim = claimed?.[field.key] ?? null
    const seen = observed?.[field.key] ?? null
    if (claim === null && seen === null) continue
    const state: AttributionGroundState = stats === null
      ? 'no-observation'
      : seen !== null && (claim === null || seen === claim) ? 'grounded' : 'unobserved'
    steps.push({ key: field.key, claimed: claim, observed: seen, state })
  }
  return { steps }
}
