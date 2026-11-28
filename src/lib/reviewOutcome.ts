// #794: the review-outcome detail format and its readers. They are pure and
// theirs is the one shape both the trend and a merge override read, so they
// live together; `src/db.ts` re-exports them for the call sites that predate
// this move.
import type { ReviewDecisionRecord, ReviewOverrideRecord } from '../db.js'

function detailValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '-'
  const text = String(value).trim()
  return text === '' ? '-' : text
}

function detailField(text: string, key: string, next: string | null): string | null {
  const start = text.indexOf(key)
  if (start < 0) return null
  const from = start + key.length
  const end = next === null ? text.length : text.indexOf(next, from)
  if (end < 0) return null
  const value = text.slice(from, end).trim()
  return value === '' || value === '-' ? null : value
}

function detailNumber(value: string | null): number | null {
  if (value === null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** The `work_item.review_outcome` detail both the trend and an override read. */
export function formatReviewOutcomeDetail(input: {
  workItemId: string
  outcome: 'approved' | 'changes_requested'
  score: number | null
  reviewJobId: string | null
  model: string | null
  tip: string | null
}): string {
  return `${input.workItemId}: ${input.outcome} score=${detailValue(input.score)} review=${detailValue(input.reviewJobId)} tip=${detailValue(input.tip)} model=${detailValue(input.model)}`
}

/**
 * Reads a decision row. A row written before the identity was recorded has no
 * `review=`/`tip=`/`model=` field; it still parses, and the caller shows
 * "not recorded" rather than inventing a revision.
 */
export function parseReviewOutcomeDetail(detail: string): ReviewDecisionRecord | undefined {
  const separator = detail.indexOf(': ')
  if (separator < 0) return undefined
  const body = detail.slice(separator + 2)
  const outcome = body.startsWith('changes_requested ') ? 'changes_requested' : body.startsWith('approved ') ? 'approved' : undefined
  if (outcome === undefined) return undefined
  const scoreAt = body.indexOf(' score=')
  if (scoreAt < 0) return undefined
  const tail = body.slice(scoreAt + 1)
  return {
    workItemId: detail.slice(0, separator),
    outcome,
    // The score is the one field every row has carried since #361, so it is read
    // from the prefix rather than between two markers a newer row introduced.
    score: detailNumber(/^score=(\S+)/.exec(tail)?.[1] ?? null),
    reviewJobId: detailField(tail, 'review=', ' tip='),
    tip: detailField(tail, 'tip=', ' model='),
    model: detailField(tail, 'model=', null),
  }
}

/** The `job.merge_review_override` detail, built beside its reader. */
export function formatReviewOverrideDetail(input: {
  jobId: string
  reviewJobId: string | null
  score: number | null
  model: string | null
  tip: string | null
  reason: string
}): string {
  return `${input.jobId}: review ${detailValue(input.reviewJobId)} score=${detailValue(input.score)} tip=${detailValue(input.tip)} model=${detailValue(input.model)} reason=${input.reason}`
}

/** A row in the shape this build never wrote returns undefined, not a guess. */
export function parseReviewOverrideDetail(detail: string): ReviewOverrideRecord | undefined {
  const separator = detail.indexOf(': ')
  if (separator < 0) return undefined
  const body = detail.slice(separator + 2)
  if (!body.startsWith('review ')) return undefined
  const scoreAt = body.indexOf(' score=')
  if (scoreAt < 0) return undefined
  const tail = body.slice(scoreAt + 1)
  return {
    reviewJobId: detailField(body, 'review ', ' score='),
    score: detailNumber(/^score=(\S+)/.exec(tail)?.[1] ?? null),
    tip: detailField(tail, 'tip=', ' model='),
    model: detailField(tail, 'model=', ' reason='),
    reason: detailField(body, 'reason=', null) ?? '',
  }
}
