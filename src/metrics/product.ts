// #635 slice: the two loop answers the existing counts cannot give — how long a
// connected repository takes to reach its first merge, and how long a ready pull
// request waits for a human. Everything here is a pair of timestamps: no user id,
// no login, no prompt, no code and no URL reaches these functions, so the read
// model is an aggregate by construction rather than by a later filter.

export interface LoopMetric {
  samples: number
  medianMs: number | null
}

export interface LoopInput {
  /** Every repository in the window and the moment its first work item merged, if it has. */
  repositories: Array<{ createdAt: string; firstMergedAt: string | null }>
  /** A merged pull request: the job that opened it finished (it was ready) at `readyAt`. */
  readyPrs: Array<{ readyAt: string; mergedAt: string }>
}

export interface LoopMetrics {
  repositories: number
  firstMerge: LoopMetric
  readyWait: LoopMetric
}

/** Half-open median of the values, or `null` when there is nothing to measure. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] ?? null
  const lower = sorted[middle - 1]
  const upper = sorted[middle]
  return lower === undefined || upper === undefined ? null : Math.round((lower + upper) / 2)
}

// A timestamp pair that runs backwards is a clock that moved, not a negative
// duration: the sample is dropped rather than averaged in as a zero.
function spanMs(from: string, to: string): number | null {
  const start = Date.parse(from)
  const end = Date.parse(to)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  const span = end - start
  return span < 0 ? null : span
}

export function loopMetrics(input: LoopInput): LoopMetrics {
  const firstMerge = input.repositories.flatMap((repo) => {
    if (repo.firstMergedAt === null) return []
    const value = spanMs(repo.createdAt, repo.firstMergedAt)
    return value === null ? [] : [value]
  })
  const readyWait = input.readyPrs.flatMap((pr) => {
    const value = spanMs(pr.readyAt, pr.mergedAt)
    return value === null ? [] : [value]
  })
  return {
    repositories: input.repositories.length,
    firstMerge: { samples: firstMerge.length, medianMs: median(firstMerge) },
    readyWait: { samples: readyWait.length, medianMs: median(readyWait) },
  }
}

// ---------------------------------------------------------------------------
// #635 slice 2: the event model behind the funnel
//
// The event names are a closed set. `recordProductEvent` refuses anything else,
// so a caller cannot smuggle a URL, an address or a sentence into a column that
// has no room for content in the first place.
// ---------------------------------------------------------------------------

export const PRODUCT_EVENT_NAMES: ReadonlySet<string> = new Set([
  'repo_connected',
  'goal_set',
  'first_job_started',
  'first_pr_opened',
  'pr_merged',
  'job_failed',
  'human_action_approve',
  'human_action_reject',
  'human_action_retry',
  'human_action_answer',
])

export interface StageCounts {
  connected: number
  firstJob: number
  firstPr: number
  merged: number
}

export interface StageRow {
  connectedAt: string | null
  firstJobAt: string | null
  firstPrAt: string | null
  mergedAt: string | null
}

/**
 * The funnel counts a repository once per stage it reached. A repository that
 * connected and opened a PR but never merged counts in the first two stages
 * only, so a drop is visible instead of a flat total.
 */
export function loopFunnel(stages: StageRow[]): StageCounts {
  const count = (pick: (row: StageRow) => string | null): number => stages.filter((row) => pick(row) !== null).length
  return {
    connected: count((row) => row.connectedAt),
    firstJob: count((row) => row.firstJobAt),
    firstPr: count((row) => row.firstPrAt),
    merged: count((row) => row.mergedAt),
  }
}

/** A percentage with one decimal, or `null` when the denominator is zero. */
export function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null
  return Math.round((numerator / denominator) * 1000) / 10
}

export interface RescueSummary {
  failed: number
  actions: number
  rate: number | null
  mix: Array<{ action: string; n: number }>
}

/**
 * A human action is a rescue only when the run failed; the rate is actions per
 * failed run, which can exceed 100% on purpose — one failure answered twice is
 * two rescues, and hiding that would flatten the difference between "someone
 * unstuck it" and "someone had to answer four questions".
 */
export function rescueSummary(failed: number, mix: Array<{ action: string; n: number }>): RescueSummary {
  const actions = mix.reduce((sum, entry) => sum + entry.n, 0)
  return {
    failed,
    actions,
    rate: ratio(actions, failed),
    mix: [...mix].sort((left, right) => right.n - left.n || (left.action < right.action ? -1 : left.action > right.action ? 1 : 0)),
  }
}

/**
 * A repository returns when it is active in the window and was last active at
 * least a week before the window opened. The window is passed in, not read from
 * a clock, so the answer is reproducible in a test.
 */
export function returningRepositories(
  rows: Array<{ firstInWindowAt: string; priorAt: string | null }>,
  weekMs = 7 * 24 * 60 * 60 * 1_000,
): { repositories: number; returned: number } {
  const returned = rows.filter((row) => {
    if (row.priorAt === null) return false
    const prior = Date.parse(row.priorAt)
    const first = Date.parse(row.firstInWindowAt)
    if (!Number.isFinite(prior) || !Number.isFinite(first)) return false
    return first - prior >= weekMs
  }).length
  return { repositories: rows.length, returned }
}

/** Durations of the stage pairs that are both present; a backwards pair is dropped, never clamped. */
export function spanMetrics(pairs: Array<{ from: string | null; to: string | null }>): LoopMetric {
  const values = pairs.flatMap((pair) => {
    if (pair.from === null || pair.to === null) return []
    const value = spanMs(pair.from, pair.to)
    return value === null ? [] : [value]
  })
  return { samples: values.length, medianMs: median(values) }
}

export interface ProductLoopSnapshot {
  windowEvents: number
  funnel: StageCounts
  toFirstJob: LoopMetric
  toFirstPr: LoopMetric
  toMerge: LoopMetric
  rescue: RescueSummary
  returning: { repositories: number; returned: number }
  evidence: {
    succeeded: number
    withPr: number
    withCost: number
    completeRate: number | null
    completed: number
    unknownCost: number
    unknownCostRate: number | null
  }
  analyticsEnabled: boolean
}

/**
 * The CSV of the read model, one metric per line. It is the same snapshot the
 * page renders, not a query of its own, so the export cannot disagree with the
 * page; there is no event row in it, and a metric with no sample is `unknown`
 * rather than a zero that reads as measured.
 */
export function loopCsv(snapshot: ProductLoopSnapshot, windowDays: number, since: string): string {
  const row = (section: string, key: string, value: string | number | null): string =>
    `${section},${key},${value === null ? 'unknown' : String(value)}`
  const lines = [
    'section,metric,value',
    row('window', 'days', windowDays),
    row('window', 'since', since),
    row('funnel', 'connected', snapshot.funnel.connected),
    row('funnel', 'first_job', snapshot.funnel.firstJob),
    row('funnel', 'first_pr', snapshot.funnel.firstPr),
    row('funnel', 'merged', snapshot.funnel.merged),
    row('duration_ms', 'connected_to_first_job', snapshot.toFirstJob.medianMs),
    row('duration_ms', 'connected_to_first_pr', snapshot.toFirstPr.medianMs),
    row('duration_ms', 'connected_to_merge', snapshot.toMerge.medianMs),
    row('samples', 'to_first_job', snapshot.toFirstJob.samples),
    row('samples', 'to_first_pr', snapshot.toFirstPr.samples),
    row('samples', 'to_merge', snapshot.toMerge.samples),
    row('rescue', 'failed', snapshot.rescue.failed),
    row('rescue', 'actions', snapshot.rescue.actions),
    row('rescue', 'rate', snapshot.rescue.rate),
    ...snapshot.rescue.mix.map((entry) => row('rescue_mix', entry.action, entry.n)),
    row('returning', 'repositories', snapshot.returning.repositories),
    row('returning', 'returned', snapshot.returning.returned),
    row('evidence', 'succeeded', snapshot.evidence.succeeded),
    row('evidence', 'with_pr', snapshot.evidence.withPr),
    row('evidence', 'with_cost', snapshot.evidence.withCost),
    row('evidence', 'complete_rate', snapshot.evidence.completeRate),
    row('evidence', 'completed', snapshot.evidence.completed),
    row('evidence', 'unknown_cost', snapshot.evidence.unknownCost),
    row('evidence', 'unknown_cost_rate', snapshot.evidence.unknownCostRate),
  ]
  return `${lines.join('\n')}\n`
}
