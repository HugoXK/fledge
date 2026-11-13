import { createHash } from 'node:crypto'
import type { JobEventRow, JobRow, RepoInstanceRow } from '../db.js'
import { classifyFailure } from './failure.js'

export type PostmortemEvidenceState = 'verified' | 'unverified'
export type PreventiveActionKind = 'test' | 'guard' | 'doc' | 'config'

export const PREVENTIVE_ACTION_KINDS: readonly PreventiveActionKind[] = ['test', 'guard', 'doc', 'config']

export interface PostmortemTimelineEntry {
  at: string
  kind: string
  step: string | null
  meta: string | null
}

export interface PostmortemEvidence {
  error: string | null
  errorCode: string | null
  lastHeartbeat: string | null
  stage: string
  instance: { status: string; lastError: string | null } | null
  timeline: PostmortemTimelineEntry[]
}

export interface PostmortemAnalysis {
  category: string
  outcome: string
  evidence: PostmortemEvidence
  evidenceState: PostmortemEvidenceState
  suspectedCause: string | null
  recurrenceKey: string
}

type JobFacts = Pick<JobRow, 'id' | 'status' | 'kind' | 'error' | 'error_code' | 'last_callback_at' | 'created_at' | 'started_at' | 'finished_at'>
type InstanceFacts = Pick<RepoInstanceRow, 'status' | 'last_error'>

export function postmortemCategory(job: Pick<JobFacts, 'status' | 'error' | 'error_code' | 'kind'>): string {
  if (job.status === 'cancelled') return 'cancelled'
  const failure = classifyFailure({ status: 'failed', error: job.error, kind: job.kind, error_code: job.error_code })
  return failure?.kind ?? (job.status === 'quota_exhausted' ? 'quota' : 'unknown')
}

// A recurrence key groups the same cause across jobs. The stable failure code is
// the whole signature when it exists; otherwise a normalised error sentence is,
// with job ids, URLs and numbers removed so two sightings of one cause land on
// one key.
export function failureSignature(error: string | null | undefined, errorCode: string | null | undefined): string {
  const code = String(errorCode ?? '').trim()
  if (code !== '') return code
  const text = String(error ?? '').trim().toLowerCase()
  if (text === '') return 'unclassified'
  return text
    .replace(/\bjob_[a-z0-9]+\b/g, 'job')
    .replace(/https?:\/\/\S+/g, 'url')
    .replace(/\b[0-9a-f]{8,}\b/g, 'id')
    .replace(/\d+/g, 'n')
    .replace(/\s+/g, ' ')
    .slice(0, 240)
}

export function recurrenceKeyFor(category: string, signature: string): string {
  return `pmk_${createHash('sha256').update(`${category}|${signature}`).digest('hex').slice(0, 24)}`
}

export function buildPostmortem(input: {
  job: JobFacts
  events?: JobEventRow[]
  instance?: InstanceFacts | null
}): PostmortemAnalysis {
  const error = String(input.job.error ?? '').trim()
  const errorCode = String(input.job.error_code ?? '').trim()
  const timeline = [...(input.events ?? [])]
    .sort((left, right) => left.at.localeCompare(right.at) || left.id - right.id)
    .map((entry) => ({ at: entry.at, kind: entry.kind, step: entry.step, meta: entry.meta }))
  const category = postmortemCategory(input.job)
  // The cause is only stated when a failure message or code actually exists.
  // A timeline or heartbeat without either is evidence, but not a cause.
  const evidenceState: PostmortemEvidenceState = error !== '' || errorCode !== '' ? 'verified' : 'unverified'
  const suspectedCause = evidenceState === 'verified' ? (error !== '' ? error.slice(0, 1000) : errorCode) : null
  return {
    category,
    outcome: input.job.status,
    evidence: {
      error: error === '' ? null : error.slice(0, 2000),
      errorCode: errorCode === '' ? null : errorCode,
      lastHeartbeat: input.job.last_callback_at ?? null,
      stage: input.job.kind,
      instance: input.instance === undefined || input.instance === null
        ? null
        : { status: input.instance.status, lastError: input.instance.last_error === null ? null : input.instance.last_error.slice(0, 1000) },
      timeline,
    },
    evidenceState,
    suspectedCause,
    recurrenceKey: recurrenceKeyFor(category, failureSignature(error, errorCode)),
  }
}

export function isPreventiveActionKind(value: string): value is PreventiveActionKind {
  return (PREVENTIVE_ACTION_KINDS as readonly string[]).includes(value)
}
