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
