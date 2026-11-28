export interface ReviewLike {
  state?: string
  commit_id?: string
  submitted_at?: string
}

export interface CommentLike {
  user?: { login?: string; type?: string }
  body?: string
  created_at?: string
}

export type RereviewKind = 'request' | 'no-op' | 'refused'

export interface RereviewDecision {
  kind: RereviewKind
  code: string
  head: string
}

export const MAINTAINER_ASSOCIATIONS: readonly string[]
export const REQUEST_MARKER: string
export const VERDICT_STATES: readonly string[]
export const RERUN_ATTEMPT_LIMIT: number

export function isMaintainer(association?: string | null): boolean
export function parseReason(body?: string | null): string | null
export function requestedHead(body?: string | null): string | null
export function openRequestAt(comments: CommentLike[] | undefined, reviews: ReviewLike[] | undefined, head: string): string | null
export function headMoveDecision(input: {
  head: string
  reviews?: ReviewLike[]
  hasOpenRequest: boolean
}): RereviewDecision
export function commentDecision(input: {
  head: string
  association?: string
  body?: string
  hasOpenRequest: boolean
}): RereviewDecision
export function decisionText(decided: RereviewDecision): string
export function reportLine(input: { number: number; head: string; decision: RereviewDecision }): string
export function rerunAllowed(attempt: number): boolean
