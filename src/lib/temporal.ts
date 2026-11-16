// #366 slice 1: the temporal contract. A job's goal carries one line saying what
// happened between the previous run's base and this run's base. The wording is
// decided here, in a pure function, so the same inputs always produce the same
// line and the reads cannot quietly change it.
//
// The rule the line exists for: a read that failed or hit its page cap is
// reported as `partial`, never as the smaller number it managed to see. A job
// that is told "2 merged PRs" when the walk stopped at two pages would rather
// not be told anything than be told a number it can trust.

export type TemporalStatus = 'ahead' | 'identical' | 'behind' | 'diverged' | 'unknown'

export interface TemporalDelta {
  // `base_sha` of the newest finished job for the same repository, `null` for a
  // first run. Never the current job's own base.
  sinceSha: string | null
  // `compareCommits(sinceSha, baseSha).status`, or `unknown` when that read failed.
  status: TemporalStatus
  aheadBy: number
  // Merged pull request numbers inside the window, deduplicated by the caller or
  // here; `complete` is false when the page cap was reached or a read failed.
  mergedPrs: number[]
  complete: boolean
}

const STATUSES: readonly TemporalStatus[] = ['ahead', 'identical', 'behind', 'diverged', 'unknown']

// GitHub returns `status: 'unknown'` for a compare it could not resolve, so the
// name alone does not prove the read worked; anything not in the list is treated
// the same way rather than guessed at.
export function isTemporalStatus(value: string): value is TemporalStatus {
  return (STATUSES as readonly string[]).includes(value)
}

const SHORT_SHA = 7
const LISTED_PRS = 5

export function summariseSince(sinceSha: string | null): string {
  return sinceSha === null ? 'Since' : `Since ${sinceSha.slice(0, SHORT_SHA)}`
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many
}

function describeCommits(delta: TemporalDelta): string {
  if (delta.status === 'identical') return 'no new commits'
  if (delta.status === 'behind') return 'base is behind the previous run'
  if (delta.status === 'diverged') return 'diverged from the previous run'
  return `${String(delta.aheadBy)} ${plural(delta.aheadBy, 'commit', 'commits')} ahead`
}

function describePullRequests(delta: TemporalDelta): string {
  if (!delta.complete) return 'merged PRs partial'
  const numbers = [...new Set(delta.mergedPrs)].sort((a, b) => a - b)
  const count = numbers.length
  const head = `${String(count)} ${plural(count, 'merged PR', 'merged PRs')}`
  if (count === 0) return head
  const shown = numbers.slice(0, LISTED_PRS).map((number) => `#${String(number)}`)
  const tail = count > LISTED_PRS ? `${shown.join(', ')}, …` : shown.join(', ')
  return `${head} (${tail})`
}

export function summariseDelta(delta: TemporalDelta): string {
  if (delta.sinceSha === null) return 'Since: no previous run'
  if (delta.status === 'unknown') return `${summariseSince(delta.sinceSha)}: delta unavailable (partial)`
  return `${summariseSince(delta.sinceSha)}: ${describeCommits(delta)}, ${describePullRequests(delta)}`
}
