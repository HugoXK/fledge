import type { RepoProviderModelRow } from '../db.js'
import type { ModelAttempt } from '../lib/modelRun.js'

// One provider answer during a model attempt is `ModelAttempt` in
// `src/lib/modelRun.ts`: it is what a job row stores. The four refusals that must
// never fall back — auth, an exhausted quota, a payment problem and a policy
// refusal — are decided in `retryableModelFailure` and nowhere else.

// The order the repository allows, head first. A call that names one of the
// selection starts there; otherwise `is_default` is the head and the rest keep
// `listRepoModelSelection`'s order (provider created_at, then model created_at),
// which is the same order the picker in `src/flybot/instances.ts` uses. No order
// column is invented, so the two cannot disagree about the primary.
export function modelOrder(
  selection: readonly RepoProviderModelRow[],
  requestedId?: string,
): RepoProviderModelRow[] {
  const requested = requestedId === undefined ? undefined : selection.find((entry) => entry.id === requestedId)
  const head = requested ?? selection.find((entry) => entry.is_default === 1) ?? selection[0]
  if (head === undefined) return []
  return [head, ...selection.filter((entry) => entry.id !== head.id)]
}

// A provider quota is not a transient rate limit even when it arrives as 429.
const QUOTA_WORDS = /insufficient_quota|quota|billing|payment|budget|额度|余额/i
const POLICY_WORDS = /content[_ ]?policy|policy[_ ]?violation|safety|refus/i

export function retryableModelFailure(status: number, body: string): boolean {
  // Auth is the repository's credential, not the model's health: another model
  // behind the same key is no more likely to be accepted.
  if (status === 401 || status === 403) return false
  // Payment or plan: another model does not fix it.
  if (status === 402) return false
  if (status === 429) return !QUOTA_WORDS.test(body) && !POLICY_WORDS.test(body)
  if (status === 408) return true
  // A retired model is the one "unavailable" a 404 can mean; any other 404 is a
  // wrong URL, which another model will not repair.
  if (status === 404) return /model[^\n]{0,60}(not found|not exist|unavailable|decommission|retired)/i.test(body)
  if (status === 500 || status === 502 || status === 503 || status === 504) return true
  return false
}
