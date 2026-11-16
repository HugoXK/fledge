// #637: a `@fledge` mention is a trigger, and this file is the whole rule for
// what it starts. It is a pure function on purpose: the decision depends on the
// target's state and on the job that is already in flight, and every case is
// cheaper to prove here than through a webhook, a database and a fake GitHub.
//
// The rule (Lead, 2026-11-15): the job kind comes from the mention's target. A
// mention on a pull request starts a review of that pull request at its head
// sha; it reads the diff and comments and never writes to the branch. A mention
// on an issue starts a follow-up for that issue, which may open one branch and
// one pull request under the normal one-issue-one-branch-one-PR rule.
//
// Identity is `(target kind, target number, head sha)`. A mention is the same
// mention while that identity is unchanged, which is what keeps a repeated
// comment from starting a second job: the second one is recorded on the job
// that is already queued or running.
export type MentionTargetKind = 'pull_request' | 'issue'

export interface MentionTarget {
  kind: MentionTargetKind
  number: number
  url: string
  /** Empty for an issue, which has no head; the identity is still stable per issue. */
  headSha: string
  state: 'open' | 'closed'
  draft: boolean
  /** Pull requests only: the head branch the review reads. */
  branch?: string
  baseBranch?: string
}

export interface MentionJobFacts {
  id: string
  status: 'queued' | 'running'
  /** The identity of the mention that started this job; null when it started otherwise. */
  mention: string | null
}

export type MentionAction =
  | { action: 'refuse'; reason: 'closed' | 'draft' }
  | { action: 'start' }
  | { action: 'record'; jobId: string }
  | { action: 'supersede'; jobId: string }
  | { action: 'park'; jobId: string }

/** `(target kind, target number, head sha)` as one comparable string. */
export function mentionIdentity(target: MentionTarget): string {
  return `${target.kind}:${target.number}:${target.headSha}`
}

/**
 * The window a mention can open: a review reads a pull request, a follow-up may
 * write to it. The union is `JobKind`-compatible where it is used, so the two
 * cannot drift.
 */
export function mentionJobKind(target: MentionTarget): 'review' | 'iterate' {
  return target.kind === 'pull_request' ? 'review' : 'iterate'
}

/**
 * What a mention does, given the target and the job already holding the
 * repository's one active slot.
 *
 * - a closed target or a draft pull request starts nothing;
 * - with no active job the mention starts one, of the target's kind;
 * - the same identity while one is queued or running starts nothing and is
 *   recorded on that job;
 * - a queued job of a different identity is superseded, because it has not
 *   started work yet;
 * - a running job is never interrupted: the mention is parked, and the newest
 *   one is started when that job ends.
 */
export function decideMention(target: MentionTarget, active: MentionJobFacts | undefined): MentionAction {
  if (target.state === 'closed') return { action: 'refuse', reason: 'closed' }
  if (target.draft) return { action: 'refuse', reason: 'draft' }
  if (active === undefined) return { action: 'start' }
  if (active.mention === mentionIdentity(target)) return { action: 'record', jobId: active.id }
  return active.status === 'queued' ? { action: 'supersede', jobId: active.id } : { action: 'park', jobId: active.id }
}
