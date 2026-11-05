import type { Attribution } from './attribution.js'

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
