import type { UserRow } from '../db.js'

// #732: the platform pays only when the job has no own model to use. A
// repository selection is an own model too: the bridge patches the instance from
// `listRepoModelSelection` and the gateway resolves the same row, so checking
// only the legacy users.own_llm_* columns refused a job that would never spend
// platform quota.
export function platformFunded(user: UserRow, repoSelectionCount: number): boolean {
  const legacyOwnModel =
    user.own_llm_base_url !== null &&
    user.own_llm_base_url !== '' &&
    user.own_llm_key_enc !== null
  return !legacyOwnModel && repoSelectionCount === 0
}

// #942: one formula answers "how much platform quota is left", so the console,
// the gateway and the dispatcher cannot disagree about the same user. `usdCny`
// is the rate the callers already pass in; an unlimited account keeps its full
// initial amount.
export function remainingQuotaCny(user: UserRow, usdCny: number): number {
  if (user.quota_unlimited === 1) return user.quota_cny
  return Math.max(0, user.quota_cny - Math.max(0, user.quota_used_usd * usdCny))
}

// #942: only a job the platform pays for can be refused for quota, so a
// repository with its own model is never reported as blocked by one.
export function platformQuotaExhausted(user: UserRow, repoSelectionCount: number, usdCny: number): boolean {
  if (!platformFunded(user, repoSelectionCount)) return false
  return remainingQuotaCny(user, usdCny) <= 0
}
