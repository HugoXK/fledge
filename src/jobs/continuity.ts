import type { JobRow, RepoRow, WorkItemRow } from '../db.js'
import { redact } from '../lib/secrets.js'
import { readySinceMs } from './automationHealth.js'

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

//: #365: the block is a claim about live state, so a line that names an issue or
//: a pull request is checked before it is carried — one read per line, at most
//: three digests plus four work items. A line that names both is governed by its
//: pull request: a merged PR is the finished state of the work the issue still
//: describes. Deduplicated, so the same link never costs a second read.
export const CARRY_OVER_MAX_READS = 7

//: `open` is still work and stays; `closed`/`merged` is finished and is dropped.
export type CarryOverLinkState = 'open' | 'closed' | 'merged'

export interface CarryOverReader {
  /** One live read. Throws when the state cannot be established; that keeps the
   * line and counts it `unverified` rather than dropping it on a failed read. */
  read(link: string): Promise<CarryOverLinkState>
}

//: What was checked, in the counts the header and the job page both read. A
//: failed read is `unverified` and is also `used`: the line is still carried.
export interface CarryOverReport {
  used: number
  dropped: number
  unverified: number
  reads: number
  droppedLinks: string[]
  unverifiedLinks: string[]
  observations: CarryOverObservation[]
  /** #791: one row per dropped or unverified item, so the job page lists what
   * the header counts instead of recounting it. `reason` is null only on a
   * value written before this field existed. */
  items: CarryOverItem[]
}

/** Why one item is not carried: the read answered `closed`/`merged`, or the
 * read failed, or the run's read ceiling was already spent. */
export type CarryOverItemReason = 'closed' | 'merged' | 'failed read' | 'budget spent'

export interface CarryOverItem {
  link: string
  kind: 'dropped' | 'unverified'
  reason: CarryOverItemReason | null
}

//: #788: the state a read returned, when it returned one. `observedAt` is null
//: unless the read produced a state, so a failed read cannot borrow a time.
export interface CarryOverObservation {
  link: string
  state: CarryOverLinkState | 'unverified'
  observedAt: string | null
}

//: The live state of a pull request: merged and closed are both finished, and
//: only an open one is still work. Kept here so the reader and the tests agree
//: on the mapping rather than each spelling it.
export function carryOverPullState(pull: { merged: boolean; state: string }): CarryOverLinkState {
  if (pull.merged) return 'merged'
  // #788: a pull request closed without merging is finished. Reading it as
  // `open` kept the line while the header called it dropped.
  return pull.state === 'closed' ? 'closed' : 'open'
}

export interface CarryOverBlock {
  text: string
  report: CarryOverReport
}

//: The block's first line. The generated block is appended after the owner's own
//: goal, so the last occurrence is the one this deployment wrote; a marker typed
//: into the goal cannot move it.
export const CARRY_OVER_MARKER = '[Carry-over - auto-generated state, not a new goal]'

//: The header line a block states, or '' when the goal carries no block. It is
//: read from the marker line and the line after it, never from a `carry-over:`
//: line the owner typed into the goal, so the page cannot print counts nobody
//: computed (#791).
export function carryOverHeaderFromBlock(goal: string): string {
  const lines = goal.split('\n')
  const marker = lines.lastIndexOf(CARRY_OVER_MARKER)
  if (marker === -1) return ''
  const header = (lines[marker + 1] ?? '').trim()
  return header.startsWith('carry-over: ') ? header : ''
}

//: The one spelling of the counts, so the goal and the stored report cannot
//: describe the same block two ways.
export function carryOverHeaderText(report: CarryOverReport): string {
  const unverified = report.unverified > 0 ? `, ${report.unverified} unverified` : ''
  return `carry-over: ${report.used} used, ${report.dropped} dropped (closed/merged)${unverified}`
}

//: What a page reads back from `jobs.carry_over_json`: the counts and the
//: per-link observation. An unreadable or pre-#788 value is null, and the page
//: then says the observation was not recorded rather than inventing one.
export function parseCarryOverReport(value: string | null): CarryOverReport | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<CarryOverReport>
    if (typeof parsed.used !== 'number' || typeof parsed.dropped !== 'number' || typeof parsed.reads !== 'number') return null
    const observations = Array.isArray(parsed.observations) ? parsed.observations : []
    const kept = observations.filter((entry): entry is CarryOverObservation =>
      typeof entry?.link === 'string'
      && ['open', 'closed', 'merged', 'unverified'].includes(entry.state))
    const droppedLinks = Array.isArray(parsed.droppedLinks)
      ? parsed.droppedLinks.filter((entry): entry is string => typeof entry === 'string')
      : []
    const unverifiedLinks = Array.isArray(parsed.unverifiedLinks)
      ? parsed.unverifiedLinks.filter((entry): entry is string => typeof entry === 'string')
      : []
    const storedItems = Array.isArray(parsed.items)
      ? parsed.items.filter((entry): entry is CarryOverItem =>
          typeof entry?.link === 'string'
          && (entry.kind === 'dropped' || entry.kind === 'unverified')
          && (entry.reason === null || ['closed', 'merged', 'failed read', 'budget spent'].includes(entry.reason as string)))
      : []
    // #791: a value written before this field still lists what it dropped, from
    // the links and observations it already stored. A reason it never recorded
    // stays null so the page can say "not recorded" instead of naming one.
    const observedState = new Map(kept.map((entry) => [entry.link, entry.state]))
    const items: CarryOverItem[] = storedItems.length > 0
      ? storedItems
      : [
          ...droppedLinks.map((link): CarryOverItem => {
            const state = observedState.get(link)
            return { link, kind: 'dropped', reason: state === 'closed' || state === 'merged' ? state : null }
          }),
          ...unverifiedLinks.map((link): CarryOverItem => ({ link, kind: 'unverified', reason: null })),
        ]
    return {
      used: parsed.used,
      dropped: parsed.dropped,
      unverified: typeof parsed.unverified === 'number' ? parsed.unverified : 0,
      reads: parsed.reads,
      droppedLinks,
      unverifiedLinks,
      observations: kept,
      items,
    }
  } catch {
    return null
  }
}

export interface CarryOverLinkRef {
  owner: string
  name: string
  kind: 'issue' | 'pull'
  number: number
}

//: One link shape, anchored at both ends: `https://<host>/<owner>/<name>/(issues|pull)/<n>`,
//: optionally with a trailing path, query or fragment. Anything else is a link
//: this slice cannot verify, and the reader reports it unverified rather than
//: guessing which repository a bare number belongs to.
export function parseCarryOverLink(link: string): CarryOverLinkRef | null {
  const match = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)(?:[/?#]\S*)?$/.exec(link)
  if (match === null) return null
  // A trailing path segment that climbs out of the artifact (`/issues/42/../..`)
  // names a different resource than the one it appears to. It is not a link this
  // slice reads; the line is carried unverified instead.
  if (/(?:^|[/?#])\.\.(?:[/?#]|$)/.test(link)) return null
  return { owner: match[1]!, name: match[2]!, kind: match[3] === 'pull' ? 'pull' : 'issue', number: Number(match[4]) }
}

export async function buildCarryOver(input: {
  recent?: JobRow[]
  openWork?: WorkItemRow[]
  maxChars?: number
  //: Absent means no live state was available to this caller, so nothing is
  //: claimed: every linked line is kept and the header carries no counts. A
  //: count of zero dropped without a read is the false claim this slice removes.
  read?: CarryOverReader
  now?: () => string
}): Promise<CarryOverBlock> {
  const recent = (input.recent ?? []).filter((job) => job.id).slice(0, 3)
  const work = (input.openWork ?? []).slice(0, 4)
  const reader = input.read
  const clock = input.now ?? (() => new Date().toISOString())
  const states = new Map<string, CarryOverLinkState | 'unverified'>()
  //: #791: a failed read and a spent read ceiling are different answers, so the
  //: item keeps which one it was instead of the page guessing.
  const unverifiedReasons = new Map<string, 'failed read' | 'budget spent'>()
  const report: CarryOverReport = { used: 0, dropped: 0, unverified: 0, reads: 0, droppedLinks: [], unverifiedLinks: [], observations: [], items: [] }

  const observationOf = (link: string | null): CarryOverObservation | undefined =>
    link === null ? undefined : report.observations.find((entry) => entry.link === link)

  const stateOf = async (link: string | null): Promise<CarryOverLinkState | 'unverified' | null> => {
    if (link === null) return null
    if (reader === undefined) return null
    const known = states.get(link)
    if (known !== undefined) return known
    let state: CarryOverLinkState | 'unverified'
    let observedAt: string | null = null
    if (report.reads >= CARRY_OVER_MAX_READS) {
      // The ceiling is a bound on a job's GitHub budget, not a reason to drop:
      // an item nobody had budget to read is unverified, and it stays.
      state = 'unverified'
      unverifiedReasons.set(link, 'budget spent')
    } else {
      report.reads += 1
      try {
        state = await reader.read(link)
        // #788: the moment the read answered. It is taken after the read, so the
        // time is the observation's and not the block's start.
        observedAt = clock()
      } catch {
        state = 'unverified'
        unverifiedReasons.set(link, 'failed read')
      }
    }
    states.set(link, state)
    report.observations.push({ link, state, observedAt })
    return state
  }

  const recentLines: string[] = []
  for (const job of recent) {
    const digest = parseDigest(job.continuity_json)
    const issue = cleanLink(digest?.issue_url ?? job.issue_url)
    const pr = cleanLink(digest?.pr_url ?? job.pr_url)
    const link = pr ?? issue
    const state = await stateOf(link)
    if (state === 'closed' || state === 'merged') {
      report.dropped += 1
      if (link !== null && !report.droppedLinks.includes(link)) {
        report.droppedLinks.push(link)
        report.items.push({ link, kind: 'dropped', reason: state })
      }
      continue
    }
    if (state === 'unverified') {
      report.unverified += 1
      if (link !== null && !report.unverifiedLinks.includes(link)) {
        report.unverifiedLinks.push(link)
        report.items.push({ link, kind: 'unverified', reason: unverifiedReasons.get(link) ?? null })
      }
    }
    report.used += 1
    const summary = redact(digest?.summary ?? job.summary ?? job.error ?? '').replace(/\s+/g, ' ').slice(0, 220)
    const links = [issue, pr].filter(Boolean).map((value) => value as string)
    recentLines.push(
      `- ${job.created_at.slice(0, 16)} ${job.kind} ${job.status}: ${summary || '(no summary)'}` +
      (links.length > 0 ? ` [${[...new Set(links)].join(' ')}]` : '') +
      observationText(observationOf(link)),
    )
  }

  const workLines: string[] = []
  for (const item of work) {
    const link = cleanLink(item.pr_url) ?? cleanLink(item.issue_url)
    const state = await stateOf(link)
    if (state === 'closed' || state === 'merged') {
      report.dropped += 1
      if (link !== null && !report.droppedLinks.includes(link)) {
        report.droppedLinks.push(link)
        report.items.push({ link, kind: 'dropped', reason: state })
      }
      continue
    }
    if (state === 'unverified') {
      report.unverified += 1
      if (link !== null && !report.unverifiedLinks.includes(link)) {
        report.unverifiedLinks.push(link)
        report.items.push({ link, kind: 'unverified', reason: unverifiedReasons.get(link) ?? null })
      }
    }
    report.used += 1
    workLines.push(
      `- ${item.id}${observationText(observationOf(link))}` +
      ` priority=${item.priority}` +
      `${item.issue_url ? ` issue=${item.issue_url}` : ''}` +
      `${item.pr_url ? ` pr=${item.pr_url}` : ''} title=${item.title.slice(0, 120)}`,
    )
  }

  const lines: string[] = [CARRY_OVER_MARKER]
  if (reader !== undefined) lines.push(carryOverHeaderText(report))
  lines.push(
    'Continue the open work item when one exists; do not create a duplicate issue/PR.',
    'Do not create inventory, backlog, or "存量/盘点/清账/reconcile" issues.',
  )
  if (recentLines.length > 0) lines.push('Recent runs:', ...recentLines)
  if (workLines.length > 0) lines.push('Open work:', ...workLines)
  const text = lines.join('\n')
  const limit = input.maxChars ?? CARRY_OVER_MAX_CHARS
  return {
    text: text.length <= limit ? text : `${text.slice(0, limit - 20)}\n[carry-over truncated]`,
    report,
  }
}

//: One observation, as a line suffix: `observed 07:12Z open`. A read that failed
//: says `observed unverified` and carries no time, because it saw no state.
function observationText(observation: CarryOverObservation | undefined): string {
  if (observation === undefined) return ''
  if (observation.state === 'unverified' || observation.observedAt === null) return ' observed unverified'
  return ` observed ${observation.observedAt.slice(11, 16)}Z ${observation.state}`
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
  // #789: the chosen row's artifact is finished, so the run does not continue it.
  // The row is named so the dispatcher can mark it; the run itself is a fresh
  // iterate on the repository's own goal.
  | { kind: 'iterate'; staleWorkItemId: string; artifactState: 'closed' | 'merged' }
  // #807: a ready item that does not start names what held it back, and when it
  // became dispatchable, so the dispatcher can publish why instead of a gap.
  | { kind: 'none'; reason: 'not due'; blockedBy: 'cooldown' | 'failure_backoff'; readyAt: number | null }
  | { kind: 'none'; reason: 'idle' }

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
//: #789: the run must also be supported by the item's live artifact, so the
//: reader is consulted after due-ness (a held-back repo costs no read) and only
//: for an item that names a GitHub link. A read that fails keeps the item: a
//: failed read saw nothing, so it is not evidence that the work is finished.
export async function decideNextJob(
  state: SchedulerState,
  options: { cooldownMs?: number; read?: CarryOverReader } = {},
): Promise<NextJob> {
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
    // #807: the same test `isDue` applies, named. From the second consecutive
    // failure the wait is the backoff, so a dashboard can tell a throttle from a
    // loop that is being held down.
    const blockedBy = state.failureStreak >= 2 ? 'failure_backoff' : 'cooldown'
    return {
      kind: 'none',
      reason: 'not due',
      blockedBy,
      readyAt: readySinceMs({ workCreatedAt: work.map((item) => item.created_at), lastRunAt: state.lastRunAt }),
    }
  }
  const item = work[0]
  if (item === undefined) return { kind: 'none', reason: 'idle' }
  // #789: the pull request is the finished state of the work when there is one,
  // so it governs; only an item with no pull request is judged by its issue.
  const link = cleanLink(item.pr_url) ?? cleanLink(item.issue_url)
  if (link !== null && options.read !== undefined) {
    let artifactState: CarryOverLinkState | 'unverified'
    try {
      artifactState = await options.read.read(link)
    } catch {
      artifactState = 'unverified'
    }
    // `unverified` keeps the item: the read saw no state, which is exactly
    // slice 1's rule for a thrown line read.
    if (artifactState === 'closed' || artifactState === 'merged') {
      return { kind: 'iterate', staleWorkItemId: item.id, artifactState }
    }
  }
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
