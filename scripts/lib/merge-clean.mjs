// Which open pull request a scheduled drain may merge without a human press.
//
// The gap this closes: a pull request with every required check green sits in
// the `CLEAN` state, and `enablePullRequestAutoMerge` refuses with "Pull request
// is in clean status", so a green T0/T1 tip waits for a person to press squash.
// This planner decides one pull request at a time; the CLI applies the decision.
//
// It never decides a tier itself: the caller passes the tier computed by
// `tierForChanges`, so a label can never widen what the drain may merge.
//
// Invariants:
//   - only T0/T1 is enqueued; a T2/T3 tip still needs a PASS and reads
//     `skip:tierT2` or `skip:tierT3`.
//   - every required check must be present and successful at the head SHA. A
//     missing check is not evidence that it will turn green, so it is a skip.
//   - `hold` blocks. The label is the machine signal and the comment is the
//     rule, so the drain never merges over the label.
//   - an already queued or auto-merging pull request is skipped, never queued
//     twice.
//   - a head that moved between the read and the merge reads `skip:head-moved`;
//     nothing is merged on a stale read.
//
// Pure: the caller supplies the pull request, its computed tier, its check runs
// and the head it re-read after computing them, so every decision is executable
// in the suite without a token, a repository or a clock.

export const REQUIRED_CHECKS = ['ci-ok', 'review-gate', 'pr-lint']
export const HOLD_LABEL = 'hold'

const SHA = /^[0-9a-f]{40}$/

function number(pr) {
  const value = Number(pr?.number ?? 0)
  return Number.isInteger(value) && value > 0 ? value : 0
}

function decision(pr, action, reason, extra = {}) {
  return {
    action,
    reason,
    number: number(pr),
    head: String(pr?.head?.sha ?? ''),
    tier: String(extra.tier ?? ''),
  }
}

/** The newest completed check run a name carries, by `completed_at`. */
export function latestConclusion(checks, name) {
  let picked = null
  for (const check of Array.isArray(checks) ? checks : []) {
    if (String(check?.name ?? '') !== name) continue
    if (picked === null) {
      picked = check
      continue
    }
    const previous = Date.parse(String(picked.completed_at ?? '')) || 0
    const next = Date.parse(String(check.completed_at ?? '')) || 0
    if (next >= previous) picked = check
  }
  return picked
}

export function classifyMergeCandidate({ pr, tier = '', checks = [], hold = false, observedHead = null } = {}) {
  if (String(pr?.state ?? 'open').toLowerCase() !== 'open') return decision(pr, 'skip', 'not-open', { tier })
  if (number(pr) === 0) return decision(pr, 'skip', 'no-number', { tier })
  if (!SHA.test(String(pr?.head?.sha ?? ''))) return decision(pr, 'skip', 'no-head', { tier })
  if (pr?.draft === true) return decision(pr, 'skip', 'draft', { tier })
  if (pr?.auto_merge !== undefined && pr?.auto_merge !== null) return decision(pr, 'skip', 'queued', { tier })
  if (hold) return decision(pr, 'skip', 'hold', { tier })
  if (observedHead !== null && String(observedHead) !== String(pr?.head?.sha ?? '')) {
    return decision(pr, 'skip', 'head-moved', { tier })
  }
  const declared = String(tier).toUpperCase()
  if (declared !== 'T0' && declared !== 'T1') {
    const reason = declared === 'T2' || declared === 'T3' ? `tier${declared}` : 'tier-unknown'
    return decision(pr, 'skip', reason, { tier: declared })
  }
  for (const name of REQUIRED_CHECKS) {
    const check = latestConclusion(checks, name)
    if (check === null) return decision(pr, 'skip', 'checks', { tier: declared })
    if (String(check.status ?? '') !== 'completed') return decision(pr, 'skip', 'checks', { tier: declared })
    if (String(check.conclusion ?? '') !== 'success') return decision(pr, 'skip', 'checks', { tier: declared })
  }
  return decision(pr, 'enqueue', '', { tier: declared })
}

export function planMergeClean({ entries = [] } = {}) {
  const list = Array.isArray(entries) ? entries : []
  const decisions = list.map((entry) => {
    const labels = Array.isArray(entry?.labels) ? entry.labels.map((label) => String(label)) : []
    const hold = labels.includes(HOLD_LABEL) || entry?.hold === true
    return classifyMergeCandidate({
      pr: entry?.pr,
      tier: entry?.tier ?? '',
      checks: entry?.checks ?? [],
      hold,
      observedHead: entry?.observedHead ?? null,
    })
  })
  return { decisions, candidates: decisions.filter((entry) => entry.action === 'enqueue') }
}
