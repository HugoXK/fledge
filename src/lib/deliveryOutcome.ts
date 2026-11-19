// #371: Fledge records that a pull request merged and then forgets it. This
// module is the read side of the post-merge ledger: the shape of one row, the
// matcher that recognises a revert commit, and the summary a windowed view
// prints. The writes live in the store and the webhook handlers; nothing here
// touches the database or GitHub.

/** One delivered change. `merged_at` is when it landed; the facts after it are
 * filled in as they arrive and are never rewritten once written. */
export interface DeliveryOutcomeRow {
  id: string
  repo_id: string
  job_id: string | null
  pr_url: string
  merge_commit: string
  merged_at: string
  title: string
  // A revert is one fact with its own instant and commit. The first sighting
  // wins: a second scan of the same history must not move the clock.
  reverted_at: string | null
  revert_commit: string | null
  // The JSON array of follow-up issue/PR links, deduplicated by link so a
  // comment on the same issue does not count twice.
  follow_up_json: string
  post_merge_failures: number
  // The job's cost when it finished, and the model/playbook that produced it,
  // so a window can be read per repository, per model and per playbook.
  cost_usd: number | null
  model: string | null
  playbook: string | null
}

/** The summary a window prints. A number nobody recorded stays `null`: the view
 * turns it into `—`, because a confident zero is a claim the data cannot make. */
export interface DeliveryOutcomeSummary {
  merged: number
  reverted: number
  /** Merged and not reverted: the changes that still stand. */
  kept: number
  withFollowUp: number
  postMergeFailures: number
  costUsd: number | null
  costPerKeptChange: number | null
}

const REVERT = /This reverts commit ([0-9a-f]{7,40})\.?/i

/**
 * The commit a revert commit names, or `null`.
 *
 * Only git's own revert trailer counts. A title that says "Revert …" names no
 * commit, and an ordinary message that mentions a fix is not a revert; matching
 * either would turn a linked fact into a guess.
 */
export function revertMatchOf(message: string): string | null {
  const found = REVERT.exec(message)
  return found === null ? null : (found[1] ?? '').toLowerCase()
}

/** The follow-up links recorded on a row, parsed defensively. */
export function followUpLinks(row: Pick<DeliveryOutcomeRow, 'follow_up_json'>): string[] {
  try {
    const parsed = JSON.parse(row.follow_up_json) as unknown
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

export function summariseDeliveries(rows: readonly DeliveryOutcomeRow[]): DeliveryOutcomeSummary {
  const merged = rows.length
  const reverted = rows.filter((row) => row.reverted_at !== null).length
  const kept = merged - reverted
  const withFollowUp = rows.filter((row) => followUpLinks(row).length > 0).length
  const postMergeFailures = rows.reduce((total, row) => total + (Number.isFinite(row.post_merge_failures) ? row.post_merge_failures : 0), 0)
  const costs = rows.flatMap((row) => (typeof row.cost_usd === 'number' && Number.isFinite(row.cost_usd) ? [row.cost_usd] : []))
  const costUsd = costs.length === 0 ? null : costs.reduce((total, cost) => total + cost, 0)
  return {
    merged,
    reverted,
    kept,
    withFollowUp,
    postMergeFailures,
    costUsd,
    costPerKeptChange: costUsd === null || kept <= 0 ? null : costUsd / kept,
  }
}
