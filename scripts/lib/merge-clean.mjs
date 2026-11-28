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
//   - the head repository must be the base repository and the base ref must be
//     the default branch; a fork head or a release-branch base reads `skip:fork`
//     or `skip:base`. A claim the drain cannot enforce is removed from the docs.
//   - a `review:changes` label, or any `CHANGES_REQUESTED` review, blocks. The
//     gate returns `ok` for a T0/T1 tip before it reads verdicts, so a green
//     `review-gate` is not evidence that no change was requested.
//   - `hold` and `state:hold` block. This is the label alone, stricter than the
//     documented label-plus-comment pair, so a forgotten comment cannot let a
//     veto through.
//   - an already queued or auto-merging pull request is skipped, never queued
//     twice.
//   - a truncated file list is not a tier: the list is capped, so a page that
//     fills the cap reads `skip:files-truncated` instead of under-tiering.
//   - every required check must be present and successful at the head SHA, and
//     the newest run of a name decides: ordering is by `started_at`, so a newer
//     `in_progress` re-run blocks an older green (PB §22.1).
//   - a head that moved between the read and the merge reads `skip:head-moved`;
//     nothing is merged on a stale read.
//
// Pure: the caller supplies the pull request, its computed tier, its check
// runs, its review state and the head it re-read after computing them, so every
// decision is executable in the suite without a token, a repository or a clock.

export const REQUIRED_CHECKS = ['ci-ok', 'review-gate', 'pr-lint']
export const HOLD_LABELS = ['hold', 'state:hold']
export const CHANGES_LABEL = 'review:changes'

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

function repoOf(pr, side) {
  return String(pr?.[side]?.repo?.full_name ?? '')
}

/** The newest run a name carries, by `started_at` (a pending run has no end). */
export function latestRun(checks, name) {
  let picked = null
  for (const check of Array.isArray(checks) ? checks : []) {
    if (String(check?.name ?? '') !== name) continue
    if (picked === null) {
      picked = check
      continue
    }
    const previous = Date.parse(String(picked.started_at ?? '')) || 0
    const next = Date.parse(String(check.started_at ?? '')) || 0
    if (next >= previous) picked = check
  }
  return picked
}

export function classifyMergeCandidate({
  pr,
  tier = '',
  checks = [],
  hold = false,
  changesRequested = false,
  observedHead = null,
  defaultBranch = '',
  filesTruncated = false,
} = {}) {
  if (String(pr?.state ?? 'open').toLowerCase() !== 'open') return decision(pr, 'skip', 'not-open', { tier })
  if (number(pr) === 0) return decision(pr, 'skip', 'no-number', { tier })
  if (!SHA.test(String(pr?.head?.sha ?? ''))) return decision(pr, 'skip', 'no-head', { tier })
  if (pr?.draft === true) return decision(pr, 'skip', 'draft', { tier })
  const headRepo = repoOf(pr, 'head')
  const baseRepo = repoOf(pr, 'base')
  if (headRepo === '' || baseRepo === '' || headRepo !== baseRepo) return decision(pr, 'skip', 'fork', { tier })
  if (defaultBranch !== '' && String(pr?.base?.ref ?? '') !== defaultBranch) return decision(pr, 'skip', 'base', { tier })
  if (pr?.auto_merge !== undefined && pr?.auto_merge !== null) return decision(pr, 'skip', 'queued', { tier })
  if (hold) return decision(pr, 'skip', 'hold', { tier })
  if (changesRequested) return decision(pr, 'skip', 'changes', { tier })
  if (filesTruncated) return decision(pr, 'skip', 'files-truncated', { tier })
  if (observedHead !== null && String(observedHead) !== String(pr?.head?.sha ?? '')) {
    return decision(pr, 'skip', 'head-moved', { tier })
  }
  const declared = String(tier).toUpperCase()
  if (declared !== 'T0' && declared !== 'T1') {
    const reason = declared === 'T2' || declared === 'T3' ? `tier${declared}` : 'tier-unknown'
    return decision(pr, 'skip', reason, { tier: declared })
  }
  for (const name of REQUIRED_CHECKS) {
    const check = latestRun(checks, name)
    if (check === null) return decision(pr, 'skip', 'checks', { tier: declared })
    if (String(check.status ?? '') !== 'completed') return decision(pr, 'skip', 'checks', { tier: declared })
    if (String(check.conclusion ?? '') !== 'success') return decision(pr, 'skip', 'checks', { tier: declared })
  }
  return decision(pr, 'enqueue', '', { tier: declared })
}

export function planMergeClean({ entries = [], defaultBranch = '' } = {}) {
  const list = Array.isArray(entries) ? entries : []
  const decisions = list.map((entry) => {
    const labels = Array.isArray(entry?.labels) ? entry.labels.map((label) => String(label)) : []
    const hold = HOLD_LABELS.some((label) => labels.includes(label)) || entry?.hold === true
    const changesRequested = labels.includes(CHANGES_LABEL) || entry?.changesRequested === true
    return classifyMergeCandidate({
      pr: entry?.pr,
      tier: entry?.tier ?? '',
      checks: entry?.checks ?? [],
      hold,
      changesRequested,
      observedHead: entry?.observedHead ?? null,
      defaultBranch,
      filesTruncated: entry?.filesTruncated === true,
    })
  })
  return { decisions, candidates: decisions.filter((entry) => entry.action === 'enqueue') }
}
