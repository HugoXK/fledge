import type { JobRow, RepoRow, WorkItemRow } from '../db.js'
import { redact } from '../lib/secrets.js'

//: A scheduled run's product, so a zero-output or meta run cannot look like a
//: productive one in the aggregate.
export type OutputKind = 'pr' | 'issue' | 'review' | 'zero' | 'meta' | 'failed'

//: Titles that describe a backlog report rather than a product change. The
//: scheduler still schedules work; this only classifies the run, and the prompt
//: asks the agent not to create one.
const META_TITLE = /存量|盘点|清账|清帐|reconcile|inventory|backlog audit|audit the backlog/i

export function isMetaTitle(value: string | null | undefined): boolean {
  return typeof value === 'string' && META_TITLE.test(value)
}

export function classifyOutput(input: {
  status: string
  kind: string
  prUrl?: string | null
  issueUrl?: string | null
  summary?: string | null
}): OutputKind {
  if (input.status !== 'succeeded') return 'failed'
  if (input.kind === 'review') return 'review'
  if (input.prUrl) return 'pr'
  if (!input.issueUrl) return 'zero'
  // Only the result is classified. The goal now carries a block that names the
  // forbidden words, so reading it would mark every scheduled issue as meta.
  if (isMetaTitle(input.summary)) return 'meta'
  return 'issue'
}

export interface RunDigest {
  schema_version: 1
  job_id: string
  kind: string
  status: string
  output_kind: OutputKind
  started_at: string | null
  finished_at: string | null
  summary: string
  issue_url: string | null
  pr_url: string | null
  work_item_id: string | null
}

// #458: a link can carry a credential in its userinfo or query; it is stored and
// carried into the next prompt, so it goes through the same redactor.
function cleanLink(value: string | null): string | null {
  return value === null ? null : redact(value)
}

export function buildRunDigest(
  job: JobRow,
  result: { status: string; summary?: string | null; issueUrl?: string | null; prUrl?: string | null },
): RunDigest {
  const outputKind = classifyOutput({
    status: result.status,
    kind: job.kind,
    prUrl: result.prUrl ?? job.pr_url,
    issueUrl: result.issueUrl ?? job.issue_url,
    summary: result.summary ?? job.summary,
  })
  return {
    schema_version: 1,
    job_id: job.id,
    kind: job.kind,
    status: result.status,
    output_kind: outputKind,
    started_at: job.started_at,
    finished_at: job.finished_at,
    // #458: redact before the slice. A secret cut in half is a fragment no
    // pattern can match, so the cut must see the clean value.
    summary: redact(result.summary ?? job.summary ?? '').slice(0, 1200),
    issue_url: cleanLink(result.issueUrl ?? job.issue_url),
    pr_url: cleanLink(result.prUrl ?? job.pr_url),
    work_item_id: job.work_item_id,
  }
}

//: The carry-over block is data, not a new goal. It is bounded so a long
//: history cannot crowd out the actual task in the bridge prompt.
export const CARRY_OVER_MAX_CHARS = 3200

export function buildCarryOver(input: {
  recent?: JobRow[]
  openWork?: WorkItemRow[]
  maxChars?: number
}): string {
  const lines: string[] = [
    '[Carry-over - auto-generated state, not a new goal]',
    'Continue the open work item when one exists; do not create a duplicate issue/PR.',
    'Do not create inventory, backlog, or "存量/盘点/清账/reconcile" issues.',
  ]
  const recent = (input.recent ?? []).filter((job) => job.id).slice(0, 3)
  if (recent.length > 0) {
    lines.push('Recent runs:')
    for (const job of recent) {
      const digest = parseDigest(job.continuity_json)
      const summary = redact(digest?.summary ?? job.summary ?? job.error ?? '').replace(/\s+/g, ' ').slice(0, 220)
      const links = [digest?.issue_url ?? job.issue_url, digest?.pr_url ?? job.pr_url]
        .filter(Boolean)
        .map((link) => redact(link as string))
      lines.push(
        `- ${job.created_at.slice(0, 16)} ${job.kind} ${job.status}: ${summary || '(no summary)'}` +
        (links.length > 0 ? ` [${[...new Set(links)].join(' ')}]` : ''),
      )
    }
  }
  const work = (input.openWork ?? []).slice(0, 4)
  if (work.length > 0) {
    lines.push('Open work:')
    for (const item of work) {
      lines.push(
        `- ${item.id} state=${item.state} priority=${item.priority}` +
        `${item.issue_url ? ` issue=${item.issue_url}` : ''}` +
        `${item.pr_url ? ` pr=${item.pr_url}` : ''} title=${item.title.slice(0, 120)}`,
      )
    }
  }
  const text = lines.join('\n')
  const limit = input.maxChars ?? CARRY_OVER_MAX_CHARS
  return text.length <= limit ? text : `${text.slice(0, limit - 20)}\n[carry-over truncated]`
}

function parseDigest(value: string | null): RunDigest | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<RunDigest>
    return parsed.schema_version === 1 ? (parsed as RunDigest) : null
  } catch {
    return null
  }
}

export type NextJob =
  | { kind: 'discover' }
  | { kind: 'followup'; workItemId: string; prUrl?: string; branch?: string }
  | { kind: 'review'; workItemId: string; prUrl: string; branch?: string }
  | { kind: 'none'; reason: 'not due' | 'idle' }

export interface SchedulerState {
  repo: RepoRow
  now: number
  lastRunAt: string | null
  intervalMinutes: number
  lastDurationMs: number | null
  failureStreak: number
  openWork: WorkItemRow[]
  reviewerEnabled: boolean
  reviewDue: boolean
  /** Last discovery session for this repo, from the `discover:<repo>` setting. */
  lastDiscoverAt?: string | null
  /** The repo interval; discovery runs at this cadence, not every work tick. */
  discoverIntervalMinutes?: number
}

export const DEFAULT_COOLDOWN_MS = 10 * 60_000
// Discovery may create an issue, so it must not inherit a 15/30-minute work
// cadence. A user with no backlog would otherwise get an issue every tick.
export const MIN_DISCOVERY_INTERVAL_MINUTES = 60

//: Pick the next scheduled job kind. This never blocks a due repo (the #219
//: lesson): when work is open it changes *what* runs, not whether a run happens.
export function decideNextJob(state: SchedulerState, options: { cooldownMs?: number } = {}): NextJob {
  const work = state.openWork
    .filter((item) => item.state !== 'merged' && item.state !== 'closed')
    .sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at))
  // #478/#503: no open work is a valid state. The team may run one low-frequency
  // discovery session, but it never invents a PR. The work cooldown only gates
  // work items, not discovery.
  if (work.length === 0) {
    if (isDiscoverDue(state)) return { kind: 'discover' }
    return { kind: 'none', reason: 'idle' }
  }
  if (!isDue(state, options.cooldownMs ?? DEFAULT_COOLDOWN_MS)) {
    return { kind: 'none', reason: 'not due' }
  }
  const item = work[0]
  if (item === undefined) return { kind: 'none', reason: 'idle' }
  if (item.pr_url) {
    const canReview = state.reviewerEnabled && state.repo.repo_role === 'maintainer'
    // A review that is not due never skips a due repo (#219). Continue the same
    // pull request with a follow-up instead; the next review window turns it
    // back into a review job.
    if (canReview && state.reviewDue) return { kind: 'review', workItemId: item.id, prUrl: item.pr_url }
    return { kind: 'followup', workItemId: item.id, prUrl: item.pr_url }
  }
  return { kind: 'followup', workItemId: item.id }
}

export function isDiscoverDue(state: SchedulerState, now: number = state.now): boolean {
  if (state.lastDiscoverAt === null || state.lastDiscoverAt === undefined || state.lastDiscoverAt === '') return true
  const last = Date.parse(state.lastDiscoverAt)
  if (!Number.isFinite(last)) return true
  const interval = Math.max(MIN_DISCOVERY_INTERVAL_MINUTES, state.discoverIntervalMinutes ?? state.intervalMinutes) * 60_000
  return now - last >= interval
}

export function isDue(state: SchedulerState, cooldownMs: number = DEFAULT_COOLDOWN_MS): boolean {
  if (state.lastRunAt === null) return true
  const last = Date.parse(state.lastRunAt)
  if (!Number.isFinite(last)) return true
  // #478: this is the work-session cooldown, already capped by the caller at
  // WORK_SESSION_COOLDOWN_MINUTES. The last job's duration no longer pushes the
  // next work item out by another 1.5x; a finished job may be followed as soon
  // as the cooldown has passed.
  const base = Math.max(Math.max(1, state.intervalMinutes) * 60_000, cooldownMs)
  const backoff = state.failureStreak >= 2
    ? Math.min(2 ** (state.failureStreak - 1), 4)
    : 1
  return state.now - last >= base * backoff
}

export function failureStreak(jobs: JobRow[]): number {
  let streak = 0
  for (const job of jobs) {
    if (job.kind !== 'iterate') continue
    if (
      job.status === 'failed'
      || job.status === 'quota_exhausted'
      || job.output_kind === 'zero'
      || job.output_kind === 'meta'
    ) {
      streak += 1
    } else {
      break
    }
  }
  return streak
}

export function lastDurationMs(jobs: JobRow[]): number | null {
  for (const job of jobs) {
    if (job.kind !== 'iterate') continue
    if (job.started_at === null || job.finished_at === null) continue
    const started = Date.parse(job.started_at)
    const finished = Date.parse(job.finished_at)
    if (Number.isFinite(started) && Number.isFinite(finished) && finished >= started) return finished - started
  }
  return null
}
