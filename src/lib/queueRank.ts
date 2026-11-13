import type { JobRow } from '../db.js'

// #565: one rule for "where is this job in the queue?", copied from the claimer
// so the console cannot answer with a second order. The claimer
// (Store.claimQueuedJob, src/db.ts) orders the instance queue by two keys:
// `priority DESC, created_at ASC`. Its id comparison sits inside the per-repo
// `NOT EXISTS` and decides which earlier job of the same repository blocks a
// claim, not the order of two queued jobs, so it is deliberately not a third
// key here: rows equal on both keys share a position instead of inventing an
// order the claimer does not have.
export interface QueueRank {
  position: number
  total: number
}

function aheadOf(candidate: JobRow, job: JobRow): boolean {
  return candidate.priority !== job.priority ? candidate.priority > job.priority : candidate.created_at < job.created_at
}

function claimerOrder(a: JobRow, b: JobRow): number {
  return a.priority !== b.priority ? b.priority - a.priority : a.created_at.localeCompare(b.created_at)
}

/** Position and total for every queued row, keyed by job id. */
export function queueRanks(queued: JobRow[]): Map<string, QueueRank> {
  const ranks = new Map<string, QueueRank>()
  for (const job of queued) {
    const ahead = queued.filter((other) => aheadOf(other, job)).length
    ranks.set(job.id, { position: ahead + 1, total: queued.length })
  }
  return ranks
}

export function rankQueued(queued: JobRow[], jobId: string): QueueRank | null {
  return queueRanks(queued).get(jobId) ?? null
}

export interface QueueAhead {
  owned: JobRow[]
  othersAhead: number
}

/**
 * The job page belongs to one user, the queue is instance-wide. The ahead-list
 * therefore names only the viewer's own queued jobs; jobs owned by anybody else
 * stay a count with no repository, account, priority or arrival time.
 *
 * `viewerActive` is `Store.listActiveJobsForUser`, which returns queued and
 * running rows in reverse arrival order: it is filtered to queued and re-sorted
 * here, because a running job is a separate fact, not a queue neighbour. The
 * count comes from the instance queue, which is what `position - 1` counts.
 */
export function aheadOfViewer(input: { queued: JobRow[]; viewerActive: JobRow[]; viewerId: string; jobId: string }): QueueAhead {
  const self = input.queued.find((job) => job.id === input.jobId)
  if (self === undefined) return { owned: [], othersAhead: 0 }
  const owned = input.viewerActive
    .filter((job) => job.status === 'queued' && job.id !== input.jobId && job.user_id === input.viewerId && aheadOf(job, self))
    .sort(claimerOrder)
  const othersAhead = input.queued.filter((job) => job.id !== input.jobId && job.user_id !== input.viewerId && aheadOf(job, self)).length
  return { owned, othersAhead }
}
