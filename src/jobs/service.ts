import { createHash } from 'node:crypto'
import type { Config } from '../config.js'
import type { JobRow, RepoRow, Store, UserRow } from '../db.js'
import type { Mailer } from '../email/mailer.js'
import { QuotaNotifier } from '../gateway/notifier.js'
import { quotaView } from '../gateway/quota.js'
import { dailyDigestEmail, jobAttentionEmail, jobFailedEmail, jobSucceededEmail, type DigestInput } from '../email/templates.js'
import { notifyEmail, replyAddressFor } from '../email/recipient.js'
import { sendNotificationWebhook } from '../lib/webhook.js'
import { log } from '../lib/log.js'
import { redact } from '../lib/secrets.js'
import { isValidBranchName } from '../lib/branches.js'
import { attributionSentence, parseAttribution, type Attribution } from '../lib/attribution.js'
import { parseEvidence, parseEvidenceJson, type Evidence } from '../lib/evidence.js'
import { classifyFailure, providerRefusalCode, type FailureCode } from '../lib/failure.js'
import { parseModelRun } from '../lib/modelRun.js'
import { retryDecision, reviewRetryDecision } from '../lib/retry.js'
import { jobEmailDecision } from '../lib/emailPolicy.js'
import { duplicateOutcome, issueNumberFromText } from '../lib/duplicates.js'
import { incCounter, observeHistogram, setGauge } from '../lib/metrics.js'
import { checkStage, parseStageMode } from '../lib/stages.js'
import { checkPathGuard, splitPathPatterns, type PathGuardResult } from '../lib/pathGuard.js'
import { reviewMergeBlock } from '../lib/mergeReview.js'
import {
  MAX_DIFF_CHARS,
  adversarialMergeBlock,
  adversarialPrompt,
  assembleAdversarialPacket,
  openAiAdversarialModel,
  runAdversarialReview,
  type AdversarialModel,
  type AdversarialReview,
  type AdversarialVerdict,
} from '../lib/adversarialReview.js'
import { evaluateTestEvidence, type VerificationResult } from '../lib/verification.js'
import { observedAttribution } from '../lib/teamStats.js'
import { reviewInstructionLine } from '../lib/followUpInstruction.js'
import { sweepExpiredTrials, type TrialSweepResult } from '../users/trial.js'
import { decryptSecret, encryptSecret, randomId, randomToken, safeEqual, sha256Hex } from '../lib/secrets.js'
import { addMinutes, nowIso } from '../lib/time.js'
import { GithubClient, GithubError, prepareRepo, prepareRepoWithInstallation, repoPermissionWithToken } from '../repos/github.js'
import { GithubApp } from '../repos/app.js'
import { parseIssueUrl, parsePrUrl } from './prUrl.js'
import { buildCarryOver, buildRunDigest, decideNextJob, failureStreak, lastDurationMs, MIN_DISCOVERY_INTERVAL_MINUTES } from './continuity.js'
import { isImplementedWorkType, missingWorkTypeEvidence, resolveWorkType, workTypeForKind, workTypeMayAutoMerge } from '../lib/workTypes.js'
import { parseTriage } from '../lib/triage.js'
import { repoGithubToken, ReadOnlyTokenUnavailable, triageReadOnlyToken } from '../repos/token.js'
import { parseTeam } from '../flybot/instances.js'
import { isRuleChange, loadRepoRules, RulesError, type RepoRules } from '../rules.js'
import type { JobKind, RepoRef, Runner } from './runner.js'
import type { InstanceManager } from '../flybot/instances.js'

export const DEFAULT_GOAL =
  'Review this repository for one high-value defect or improvement. Write a failing test first, implement the smallest correct fix, run the relevant tests, and open a pull request. Do not refactor unrelated code.'

export const DEFAULT_SCOPE_GOAL =
  'Produce a Product scope for the requested issue: goal, non-goals, acceptance criteria and a test plan. Do not write code, create a branch, open a PR or change settings.'

export const DEFAULT_VERIFY_GOAL =
  'Verify the existing pull request and branch with the Test role: run the relevant tests, report the failing evidence and the passing evidence after the fix, plus CI/check status. Do not write code, push, open a PR or merge.'

export const DEFAULT_DISCOVER_GOAL =
  'Discovery only: inspect the repository, open issues/PRs, tests and recent CI. Do not write code, create a branch, push, open a PR or change settings. If you find one concrete, reproducible defect or high-value improvement not already covered, create exactly one focused issue on the upstream with evidence and a failing-test idea, then report issueUrl. If there is nothing concrete, report zero output and create nothing. Never create an inventory/backlog/盘点/清账/reconcile issue.'

export const DEFAULT_TRIAGE_GOAL =
  'Triage only: read the open issues and pull requests of the upstream repository, rank them by the priority labels, link duplicates and name the one item the next work session should start with. Do not write code, create a branch, open a pull request or merge. Return the board in the callback "triage" object.'

export const DEFAULT_REVIEW_GOAL =
  'Review every open pull request on the upstream repository. For each PR, inspect the diff, tests and risk, give a score from 0 to 100 with a short rationale, and post a COMMENT review. Do not request changes, approve, merge, push or change repository settings. Return followUps for every Fledge PR that needs a same-branch fix. Summarize the scores and the most important issues.'

export interface EnqueueResult {
  ok: boolean
  job?: JobRow
  error?: string
  code?: string
  // The value a refusal names, such as the missing target branch, so the banner
  // can say which one instead of a bare sentence.
  detail?: string
}

// #283: the whole platform stop is one `settings` row, and every reader goes back
// to the row instead of to a field on this object. A cached copy is exactly how a
// restart, or a second process, would silently resume scheduling.
const PLATFORM_STOP_KEY = 'platform.stop'
// #283 review: one operator action has to finish, so the drain is bounded in two
// places. The inline pass runs while the operator is waiting on a form post, so it
// takes a small slice; the tick then finishes the drain at the per-pass bound and
// keeps going on later ticks until nothing is active. Admission is already
// closed, so no new job can take the place of a drained one.
export const PLATFORM_DRAIN_LIMIT = 25
export const PLATFORM_STOP_DRAIN_LIMIT = 5

export interface PlatformStopRecord {
  at: string
  by: string
  reason: string
}

export interface PlatformStopOutcome {
  stop: PlatformStopRecord
  // A stop while stopped changes nothing: the operator who first stopped the
  // platform and the reason they gave stay the record.
  already: boolean
  paused: number
  cancelled: number
  // Active jobs past the drain bound; the tick completes them.
  left: number
}

export interface PlatformResumeOutcome {
  // A resume with no stop in place changes nothing and writes no audit row.
  already: boolean
  // Repositories the next tick will consider, in `owner/name` form. Resume
  // reports them; it enqueues none of them.
  due: string[]
}

// #390 review: one answer for "what kind does a re-enqueued run have?", shared by
// resume and retry so the two cannot disagree. A row keeps its own kind when that
// kind's contract does not depend on the row being re-enqueued — a plan is still a
// plan, a review a review, a triage run a triage run. `scope` and `verify` are
// work-item runs and `discover` is scheduler-owned, so those re-enqueue as iterate
// work, which is the contract they can actually run under.
const REENQUEUE_KEEPS_KIND: ReadonlySet<string> = new Set(['review', 'plan', 'triage'])

function reenqueueKind(job: JobRow): JobKind {
  // `jobs.kind` is a TEXT column, so the stored value is checked against the
  // declared set before it is narrowed back to `JobKind`.
  const kind = job.kind
  return REENQUEUE_KEEPS_KIND.has(kind) ? (kind as JobKind) : 'iterate'
}

/**
 * A declared work type that is not what the new kind implies is carried through
 * the re-enqueue, so a row written under a contract with no handler is refused
 * (`WORK_TYPE_UNSUPPORTED`) instead of quietly running as iterate work.
 */
function reenqueueWorkType(job: JobRow, kind: JobKind): string | undefined {
  return job.work_type !== null && job.work_type !== workTypeForKind(kind) ? job.work_type : undefined
}

function progressSummary(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as { summary?: unknown }
      if (typeof parsed.summary === 'string' && parsed.summary.trim() !== '') return redact(parsed.summary).slice(0, 4000)
    } catch {}
  }
  return redact(value).slice(0, 4000)
}

// #251: the follow-up's duplicate key and parked key are both built from this,
// never from `reason` alone. `reason` is the constant `review requested changes`
// for a review, so keying on it collapsed two different requests on one commit
// into a duplicate, and overwrote the first parked request with the second.
function followUpFingerprint(reason: string, instruction: string | undefined): string {
  return createHash('sha256').update(`${reason}\n${instruction ?? ''}`).digest('hex').slice(0, 16)
}

export interface ReviewFollowUp {
  prUrl: string
  branch: string
  baseBranch?: string
  headSha?: string
  reason?: string
  /** #251: the reviewer's own words, carried into the goal the agent is given. */
  instruction?: string
}

export interface CallbackPayload {
  status?: unknown
  branch?: unknown
  prUrl?: unknown
  issueUrl?: unknown
  reviewScore?: unknown
  summary?: unknown
  error?: unknown
  attribution?: unknown
  evidence?: unknown
  checkpoint?: unknown
  followUps?: unknown
  triage?: unknown
}

// The canonical form of a terminal report. Two deliveries that describe the same
// result produce the same value, so a replay is a no-op while a contradicting
// report is a conflict (docs/decisions/0004, section 2).
function terminalFingerprint(input: {
  status: string
  branch?: string
  prUrl?: string | null
  issueUrl?: string | null
  reviewScore?: number
  evidence: Evidence | null
  attribution: Attribution | null
  followUps: ReviewFollowUp[]
}): string {
  return sha256Hex(JSON.stringify({
    status: input.status,
    branch: input.branch ?? null,
    prUrl: input.prUrl ?? null,
    issueUrl: input.issueUrl ?? null,
    reviewScore: input.reviewScore ?? null,
    evidence: input.evidence,
    attribution: input.attribution,
    followUps: input.followUps.map((entry) => ({ prUrl: entry.prUrl, branch: entry.branch, headSha: entry.headSha ?? null })),
  }))
}

// #556: the one class of patch-less file that may still merge. A screenshot or
// font change must not be refused for a binary, and the exemption is assets
// under public/ or docs/ only — code, config, lockfiles and scripts are exactly
// what this gate exists to read, so a patch the API withheld for them is a
// refusal, not an exemption. Widening this list needs a reason in the diff.
const ADVERSARIAL_ASSET_EXEMPT = /^(?:public|docs)\/.+\.(?:png|jpe?g|gif|webp|ico|woff2?|ttf|eot)$/i

function adversarialAssetExempt(filename: string): boolean {
  return ADVERSARIAL_ASSET_EXEMPT.test(filename)
}

export type PreparedStop =
  | { ok: true; stop: { sent?: boolean; stopped?: number; requested?: number }; apply: () => void }
  | { ok: false; error: string }

export class Jobs {
  private timer: NodeJS.Timeout | null = null
  private trialTimer: NodeJS.Timeout | null = null
  private questionBusy = false
  private readonly followUpLocks = new Set<string>()
  private ticking = false
  private stopped = false
  private lastPruneAt = 0
  private readonly credentialCache = new Map<string, { at: number }>()
  private readonly leaseTimers = new Map<string, NodeJS.Timeout>()
  private readonly quotaNotifier: QuotaNotifier
  // Tests inject a fake; production binds the platform model inside
  // `adversarialPass`. Null means "use the configured platform model, or skip
  // the pass when there is none".
  adversarialModel: AdversarialModel | null = null

  constructor(
    private readonly store: Store,
    private readonly config: Config,
    private readonly runner: Runner,
    private readonly mailer: Mailer,
    private readonly instances?: InstanceManager,
    private readonly githubApp: GithubApp = new GithubApp(config),
  ) {
    this.quotaNotifier = new QuotaNotifier(store, mailer, config)
  }

  get notifier(): QuotaNotifier {
    return this.quotaNotifier
  }

  async quotaBlocked(user: UserRow): Promise<void> {
    await this.quotaNotifier.notify(user)
    for (const job of this.store.listActiveJobsForUser(user.id)) {
      const revoke = (): void => {
        const row = job.platform_token_hash === null ? undefined : this.store.findApiToken(job.platform_token_hash)
        if (row !== undefined) this.store.revokeApiToken(row.id, row.user_id)
      }
      this.finish(job.id, { status: 'quota_exhausted', error: '平台额度已用完，请在 Settings → Model 配置自己的模型 API 后重试。', errorCode: 'QUOTA_EXHAUSTED' }, revoke)
    }
  }

  async cancelUserJobs(userId: string, reason: string): Promise<void> {
    for (const job of this.store.listActiveJobsForUser(userId)) {
      const revoke = (): void => {
        const row = job.platform_token_hash === null ? undefined : this.store.findApiToken(job.platform_token_hash)
        if (row !== undefined) this.store.revokeApiToken(row.id, row.user_id)
      }
      this.finish(job.id, { status: 'failed', error: reason }, revoke)
    }
  }

  // The stop outcome travels back to the caller so a reply can say what happened
  // instead of claiming a send: `instances` is undefined in queue-dispatch mode and
  // the bridge call can fail, and both mean no stop was delivered. `sent` is absent
  // when no attempt was made (a queued job or no controller), `false` when the
  // attempt failed, and the counts are the stop's own answer.
  private async stopLiveSessions(repoId: string, jobId: string): Promise<{ sent?: boolean; stopped?: number; requested?: number }> {
    if (this.instances === undefined) return {}
    try {
      const state = await this.instances.teamState(repoId, 5_000)
      const sessions = state.bots.filter((bot) => bot.activity === 'thinking' || bot.activity === 'working').map((bot) => bot.sessionId)
      if (sessions.length === 0) return { sent: true, stopped: 0, requested: 0 }
      const result = await this.instances.stopSessions(repoId, sessions)
      return { sent: true, stopped: result.stopped.length, requested: result.requested.length }
    } catch (error) {
      log.warn('job stop failed', { trace: jobId, error: String(error) })
      return { sent: false }
    }
  }

  // #540 slice 2: a stop's local writes are synchronous, so a management command
  // can commit them in the same transaction as its receipt. Everything that has
  // to await — stopping live sessions over the bridge, clearing the instance's
  // job token — happens first, is best-effort and is safe to repeat. If the
  // command's transaction then fails, the effect rolls back with it and the
  // receipt still says `accepted`, which is the truth: nothing landed.
  private async prepareStop(jobId: string, reason: string, status: 'cancelled' | 'paused'): Promise<PreparedStop> {
    const job = this.store.getJob(jobId)
    if (job === undefined) return { ok: false, error: '任务不存在。' }
    if (job.status !== 'queued' && job.status !== 'running') return { ok: false, error: '这个任务已经结束。' }
    const stop = job.status === 'running' ? await this.stopLiveSessions(job.repo_id, jobId) : {}
    const row = job.platform_token_hash === null ? undefined : this.store.findApiToken(job.platform_token_hash)
    if (row !== undefined) this.store.revokeApiToken(row.id, row.user_id)
    await this.instances?.clearJobToken(job.repo_id, jobId).catch((error) => log.warn('clear job token failed', { trace: jobId, error: String(error) }))
    const cleanReason = redact(reason).slice(0, 1000)
    const apply = (): void => {
      if (status === 'cancelled') {
        this.store.updateJob(jobId, { status: 'cancelled', error: cleanReason, finished_at: nowIso() })
        if (job.kind === 'review') this.store.updateRepo(job.repo_id, { last_review_status: 'cancelled' })
        else this.store.updateRepo(job.repo_id, { last_status: 'cancelled' })
        if (job.work_item_id !== null) {
          const item = this.store.getWorkItem(job.work_item_id)
          if (item !== undefined) this.store.updateWorkItem(item.id, { state: 'closed' })
        }
        this.store.audit(job.user_id, 'job.cancelled', `${jobId}: ${cleanReason.slice(0, 300)}`)
        this.store.event('job_cancelled', { userId: job.user_id, repoId: job.repo_id, jobId })
        this.store.recordJobEvent({ jobId, repoId: job.repo_id, userId: job.user_id, kind: 'job.cancelled', meta: cleanReason })
        this.notePostmortem(jobId)
        return
      }
      this.store.updateJob(jobId, { status: 'paused', error: cleanReason })
      this.store.updateRepo(job.repo_id, { last_status: 'paused', ...(job.kind === 'review' ? { last_review_status: 'paused' } : {}) })
      this.store.audit(job.user_id, 'job.paused', jobId)
      this.store.event('job_paused', { userId: job.user_id, repoId: job.repo_id, jobId })
      this.store.recordJobEvent({ jobId, repoId: job.repo_id, userId: job.user_id, kind: 'job.paused', meta: cleanReason })
    }
    return { ok: true, stop, apply }
  }

  // The command adapters use these two: prepare performs the awaited, repeatable
  // work and hands back the local write, which the service runs inside its
  // receipt transaction. `cancelJob` and `pauseJob` keep their behaviour for
  // every caller that is not a command.
  prepareCancel(jobId: string, reason: string): Promise<PreparedStop> {
    return this.prepareStop(jobId, reason, 'cancelled')
  }

  preparePause(jobId: string, reason = '任务已暂停'): Promise<PreparedStop> {
    return this.prepareStop(jobId, reason, 'paused')
  }

  async cancelJob(jobId: string, reason: string): Promise<{ ok: boolean; error?: string; sent?: boolean; stopped?: number; requested?: number }> {
    const prepared = await this.prepareStop(jobId, reason, 'cancelled')
    if (!prepared.ok) return prepared
    prepared.apply()
    return { ok: true, ...prepared.stop }
  }

  async pauseJob(jobId: string, reason = '任务已暂停'): Promise<{ ok: boolean; error?: string; sent?: boolean; stopped?: number; requested?: number }> {
    const prepared = await this.prepareStop(jobId, reason, 'paused')
    if (!prepared.ok) return prepared
    prepared.apply()
    return { ok: true, ...prepared.stop }
  }

  async resumeJob(jobId: string): Promise<{ ok: boolean; job?: JobRow; error?: string }> {
    const job = this.store.getJob(jobId)
    if (job === undefined) return { ok: false, error: '任务不存在。' }
    if (job.status !== 'paused') return { ok: false, error: '只有已暂停的任务可以恢复。' }
    const repo = this.store.getRepo(job.repo_id)
    if (repo === undefined) return { ok: false, error: '仓库不存在。' }
    const goal = job.checkpoint === null || job.checkpoint === '' ? job.goal : `${job.goal}\n\nResume from checkpoint:\n${job.checkpoint}`
    const kind = reenqueueKind(job)
    const declared = reenqueueWorkType(job, kind)
    const result = await this.enqueue(repo, 'manual', goal, kind, {
      ...(declared === undefined ? {} : { workType: declared }),
      ...(job.branch === null ? {} : { branch: job.branch }),
      ...(job.pr_url === null ? {} : { prUrl: job.pr_url }),
      ...(job.base_branch === null ? {} : { baseBranch: job.base_branch }),
      ...(job.work_item_id === null ? {} : { workItemId: job.work_item_id }),
      priority: job.priority,
    })
    if (!result.ok || result.job === undefined) return { ok: false, error: result.error ?? '恢复失败。' }
    this.store.updateJob(jobId, { status: 'cancelled', error: `resumed as ${result.job.id}`, finished_at: nowIso() })
    this.store.audit(job.user_id, 'job.resumed', `${jobId} -> ${result.job.id}`)
    this.store.recordJobEvent({ jobId, repoId: job.repo_id, userId: job.user_id, kind: 'job.resumed', meta: `resumed as ${result.job.id}` })
    this.store.recordJobEvent({ jobId: result.job.id, repoId: job.repo_id, userId: job.user_id, kind: 'job.resumed_from', meta: jobId })
    return { ok: true, job: result.job }
  }

  // One retry path for the console route and the issue command: the checkpoint,
  // the kind and the "resume the same pull request" rule were copied in the route
  // until #360, which is exactly the second-place-to-disagree shape this codebase
  // keeps paying for. The caller names the actor so the audit row is the same
  // `job.retried` action either way.
  async retryJob(jobId: string, actorUserId: string, options: { workItemId?: string } = {}): Promise<{ ok: boolean; job?: JobRow; error?: string; code?: string; detail?: string }> {
    const job = this.store.getJob(jobId)
    if (job === undefined) return { ok: false, error: '任务不存在。' }
    if (job.status === 'queued' || job.status === 'running') return { ok: false, error: '这个任务还在运行；请先暂停或取消。' }
    const repo = this.store.getRepo(job.repo_id)
    if (repo === undefined) return { ok: false, error: '仓库不存在。' }
    // #390 review: the kind comes from the shared rule, not a ternary — mapping
    // a triage row to `iterate` turned a no-touch, read-only run into a job that
    // may write, and the same expression sat in the resume path.
    const kind = reenqueueKind(job)
    const declared = reenqueueWorkType(job, kind)
    const goal = job.checkpoint === null || job.checkpoint === '' ? job.goal : `${job.goal}\n\nResume from checkpoint:\n${job.checkpoint}`
    const resumePr = kind === 'iterate' && job.pr_url !== null
    const result = await this.enqueue(repo, resumePr ? 'followup' : 'manual', goal, kind, {
      // #353: both callers are a person — the console's retry button and an
      // issue-thread `/fledge retry` — so the run is theirs. The trigger alone
      // cannot say that: `followup` is also what `tick()` enqueues.
      ownerStarted: true,
      ...(declared === undefined ? {} : { workType: declared }),
      ...(resumePr ? { branch: job.branch ?? undefined, prUrl: job.pr_url ?? undefined, baseBranch: job.base_branch ?? undefined } : {}),
      ...(options.workItemId === undefined ? {} : { workItemId: options.workItemId }),
    })
    this.store.audit(actorUserId, 'job.retried', `${jobId} -> ${result.job?.id ?? (result.error === undefined ? 'failed' : redact(result.error))}`)
    // The console banner builds its sentence from the enqueue code, so the
    // refusal has to travel with it rather than being flattened to one string.
    if (!result.ok || result.job === undefined) return { ok: false, error: result.error ?? '重试失败。', code: result.code, detail: result.detail }
    this.store.recordJobEvent({ jobId, repoId: job.repo_id, userId: actorUserId, kind: 'job.retry_started', step: kind, meta: result.job.id })
    return { ok: true, job: result.job }
  }

  async cancelRepoJobs(repoId: string, reason: string, errorCode?: FailureCode): Promise<void> {
    for (const job of this.store.listActiveJobs().filter((entry) => entry.repo_id === repoId)) {
      const revoke = (): void => {
        const row = job.platform_token_hash === null ? undefined : this.store.findApiToken(job.platform_token_hash)
        if (row !== undefined) this.store.revokeApiToken(row.id, row.user_id)
      }
      this.finish(job.id, { status: 'failed', error: reason, errorCode }, revoke)
    }
  }

  // #283: the platform emergency stop. One settings row is the state, read fresh
  // on every enqueue and once per tick, so neither a restart nor a second process
  // can be running with a stale "we are open" in memory.
  platformStop(): PlatformStopRecord | null {
    const raw = this.store.getSetting(PLATFORM_STOP_KEY)
    if (raw === undefined) return null
    try {
      const value = JSON.parse(raw) as Partial<PlatformStopRecord>
      return { at: String(value.at ?? ''), by: String(value.by ?? ''), reason: String(value.reason ?? '') }
    } catch {
      // An unreadable row is still a stop. Resuming on a parse error would be the
      // one failure this row exists to prevent, and the resume route clears it.
      return { at: '', by: '', reason: '' }
    }
  }

  // One pass over the active jobs. A running job whose bridge answers is paused so
  // its checkpoint survives; anything else is cancelled with a terminal reason.
  // Either way its platform token is revoked, so it cannot keep spending while the
  // platform says it is stopped. `left` is the count the bound did not reach.
  private async drainActiveJobs(limit: number): Promise<{ paused: number; cancelled: number; left: number }> {
    const active = this.store.listActiveJobs()
    const draining = active.slice(0, limit)
    let paused = 0
    let cancelled = 0
    for (const job of draining) {
      if (job.status === 'running' && this.instances !== undefined) {
        const result = await this.pauseJob(job.id, '平台已紧急停止，任务已暂停。')
        if (result.ok) {
          paused += 1
          continue
        }
      }
      const result = await this.cancelJob(job.id, '平台已紧急停止，任务已取消。')
      if (result.ok) cancelled += 1
    }
    return { paused, cancelled, left: Math.max(0, active.length - draining.length) }
  }

  async stopPlatform(actor: { id: string; login: string }, reason: string): Promise<PlatformStopOutcome> {
    const existing = this.platformStop()
    if (existing !== null) return { stop: existing, already: true, paused: 0, cancelled: 0, left: 0 }
    const stop: PlatformStopRecord = { at: nowIso(), by: actor.login, reason: reason.trim().slice(0, 200) }
    this.store.setSetting(PLATFORM_STOP_KEY, JSON.stringify(stop))
    // One audit row for the stop itself; the drain below writes the per-job rows
    // through `pauseJob`/`cancelJob`, which is where a reader looks for a job.
    this.store.audit(actor.id, 'platform.stopped', `${stop.by}: ${stop.reason === '' ? 'no reason given' : stop.reason}`)
    this.store.event('platform_stopped', { userId: actor.id, meta: stop.reason.slice(0, 100) })
    const drain = await this.drainActiveJobs(PLATFORM_STOP_DRAIN_LIMIT)
    if (drain.left > 0) {
      this.store.audit(actor.id, 'platform.drain_incomplete', `${drain.left} active jobs past the inline drain bound of ${PLATFORM_STOP_DRAIN_LIMIT}; the tick completes them, ${PLATFORM_DRAIN_LIMIT} per pass`)
    }
    return { stop, already: false, paused: drain.paused, cancelled: drain.cancelled, left: drain.left }
  }

  // The inline drain is bounded, so the tick is where it finishes. One pass per
  // tick at the per-pass bound, with the stop's own operator recorded as the actor
  // and its own audit rows: an `incomplete` row while work remains, a `complete`
  // row once nothing is active. Without this the drain's own audit row promised
  // something no code did, and jobs past the inline bound kept their tokens.
  private async completeStoppedDrain(stop: PlatformStopRecord): Promise<void> {
    if (this.store.listActiveJobs().length === 0) return
    const operator = stop.by === '' ? undefined : this.store.userByLogin(stop.by)
    const drain = await this.drainActiveJobs(PLATFORM_DRAIN_LIMIT)
    const left = this.store.listActiveJobs().length
    if (operator !== undefined) {
      if (left > 0) {
        this.store.audit(operator.id, 'platform.drain_incomplete', `${left} active jobs still running while stopped; the next tick continues the drain, ${PLATFORM_DRAIN_LIMIT} per pass`)
      } else {
        this.store.audit(operator.id, 'platform.drain_complete', `paused ${drain.paused}, cancelled ${drain.cancelled}; no job is active while the platform is stopped`)
      }
    }
    if (left > 0) log.info('platform drain continues', { left, paused: drain.paused, cancelled: drain.cancelled })
  }

  async resumePlatform(actor: { id: string; login: string }): Promise<PlatformResumeOutcome> {
    const existing = this.platformStop()
    if (existing === null) return { already: true, due: this.nextTickDue() }
    this.store.deleteSetting(PLATFORM_STOP_KEY)
    this.store.audit(actor.id, 'platform.resumed', `${actor.login} cleared ${existing.by === '' ? 'an unreadable stop' : `the stop by ${existing.by}`}`)
    this.store.event('platform_resumed', { userId: actor.id })
    // Resume enqueues nothing: it reports what the next tick will consider, and
    // the tick decides under its own rules. Replaying the frozen set would start
    // work the operator has not seen.
    return { already: false, due: this.nextTickDue() }
  }

  // The repositories the next tick would consider, in `owner/name` form. It is a
  // read: it makes no bridge call and no enqueue, so the answer cannot itself
  // start work. A stale GitHub role is left to the tick, which refreshes it.
  nextTickDue(): string[] {
    const due = new Set<string>()
    for (const repo of this.store.listReviewRepos()) {
      if (repo.repo_role !== 'maintainer') continue
      if (!this.userReadyForScheduling(repo.user_id)) continue
      if (!this.instanceReady(repo.id)) continue
      if (this.store.activeJobForRepo(repo.id) !== undefined) continue
      if (this.dueReview(repo)) due.add(`${repo.owner}/${repo.name}`)
    }
    for (const repo of this.store.listAutoRepos()) {
      if (repo.repo_role !== 'maintainer' && repo.repo_role !== 'developer') continue
      if (!this.userReadyForScheduling(repo.user_id)) continue
      if (!this.instanceReady(repo.id)) continue
      if (this.store.activeJobForRepo(repo.id) !== undefined) continue
      // #478/#503: work items drive work sessions; an empty backlog may still
      // produce one low-frequency discovery session. Review due is its own lane.
      const work = this.store.listOpenWorkItems(repo.id)
      if (work.length > 0 ? this.workDue(repo) : this.discoverDue(repo)) due.add(`${repo.owner}/${repo.name}`)
    }
    return [...due].sort()
  }

  private rulesCache = new Map<string, { at: number; rules: RepoRules }>()

  private async loadRules(
    repo: RepoRow,
    baseBranch: string,
    preflightSha: string | null,
  ): Promise<{ ok: true; rules: RepoRules } | { ok: false; error: string; code: string; detail?: string }> {
    const owner = repo.upstream_owner || repo.owner
    const name = repo.upstream_name || repo.name
    try {
      const token = await repoGithubToken(repo, this.config, this.githubApp, this.store)
      const client = new GithubClient(token, this.config.github.apiBase)
      let commit = preflightSha
      if (commit === null) {
        const branch = await client.getBranch(owner, name, baseBranch)
        commit = branch?.sha ?? null
      }
      if (commit === null) {
        return { ok: false, error: '无法确定仓库的基准提交，暂时不能读取仓库规则。', code: 'RULES_UNAVAILABLE' }
      }
      const overrides = this.store.listRepoRuleOverrides(repo.id).map((row) => ({ path: row.path, content: row.content, revision: row.revision }))
      const key = `${repo.id}:${commit}:${overrides.map((override) => `${override.path}@${override.revision}`).join('|')}`
      const cached = this.rulesCache.get(key)
      if (cached !== undefined && Date.now() - cached.at < 5 * 60_000) {
        return { ok: true, rules: cached.rules }
      }
      const rules = await loadRepoRules(client, owner, name, commit, overrides)
      if (this.rulesCache.size > 100) this.rulesCache.clear()
      this.rulesCache.set(key, { at: Date.now(), rules })
      return { ok: true, rules }
    } catch (error) {
      if (error instanceof RulesError) {
        return {
          ok: false,
          error: error.message,
          code: error.code === 'rules_invalid' ? 'RULES_INVALID' : 'RULES_UNAVAILABLE',
          detail: error.path,
        }
      }
      return {
        ok: false,
        error: `读取仓库规则失败：${error instanceof Error ? error.message : String(error)}`,
        code: 'RULES_UNAVAILABLE',
      }
    }
  }

  private async duplicatePreflight(repo: RepoRow, goal: string, workItemId?: string): Promise<{ ok: boolean; error?: string; code?: string; detail?: string }> {
    // Only the FlyBot runner reads the upstream repository; the sibling
    // `preflight` has the same guard at its first line. Without it a deployment
    // on another runner decrypted the repo token and made GitHub reads it never
    // made before this feature.
    if (this.runner.name !== 'flybot') return { ok: true }
    const owner = repo.upstream_owner || repo.owner
    const name = repo.upstream_name || repo.name
    const repository = `${owner}/${name}`
    const item = workItemId === undefined ? undefined : this.store.getWorkItem(workItemId)
    const issue = issueNumberFromText(item?.issue_url ?? goal, repository)
    if (issue === null) return { ok: true }
    try {
      const token = await repoGithubToken(repo, this.config, this.githubApp, this.store)
      const client = new GithubClient(token, this.config.github.apiBase)
      const outcome = await duplicateOutcome(
        issue,
        repository,
        await client.listOpenPullRequests(owner, name),
        () => client.listMergedPullRequests(owner, name),
        () => client.issueIsClosed(owner, name, issue),
      )
      if (outcome === null) return { ok: true }
      // #174: the two outcomes are recorded apart on purpose — an open pull request
      // is work in flight, a merged one is the fix already being in, and only the
      // second carries the commit that proves it. The record is the audit detail
      // and the event meta (no job row exists at this point, by design).
      const evidence =
        outcome.kind === 'already-fixed'
          ? ` (${outcome.mergeCommitSha ?? 'merge commit not reported'}, merged ${outcome.mergedAt.slice(0, 10)})`
          : ''
      this.store.audit(
        repo.user_id,
        'job.duplicate_work',
        `${repository} issue #${issue} -> ${outcome.kind === 'already-fixed' ? 'already fixed by' : 'open PR'} ${outcome.url}${evidence}`,
      )
      this.store.event('job_duplicate_work', {
        userId: repo.user_id,
        repoId: repo.id,
        meta: `issue=${issue};outcome=${outcome.kind};pr=${outcome.url}${outcome.kind === 'already-fixed' ? `;commit=${outcome.mergeCommitSha ?? ''}` : ''}`.slice(0, 400),
      })
      if (outcome.kind === 'already-fixed') {
        return {
          ok: false,
          code: 'ALREADY_FIXED',
          error: `这个 issue 的修复已经合入上游：${outcome.url}`,
          detail: outcome.url,
        }
      }
      return { ok: false, code: 'DUPLICATE_WORK', error: `已有 PR 覆盖这个 issue：${outcome.url}`, detail: outcome.url }
    } catch (error) {
      log.warn('duplicate preflight failed', { repo: repo.id, error: String(error) })
      return { ok: true }
    }
  }

  private async preflight(repo: RepoRow, baseBranch: string, trigger: string): Promise<{ ok: boolean; baseSha?: string; warning?: string; error?: string; code?: string; detail?: string }> {
    if (this.runner.name !== 'flybot') return { ok: true }
    try {
      const token = await repoGithubToken(repo, this.config, this.githubApp, this.store)
      const client = new GithubClient(token, this.config.github.apiBase)
      const upstreamOwner = repo.upstream_owner || repo.owner
      const upstreamName = repo.upstream_name || repo.name
      const branch = await client.getBranch(upstreamOwner, upstreamName, baseBranch)
      this.store.markRepoCredential(repo.id, 'ok')
      this.credentialCache.set(repo.id, { at: Date.now() })
      if (branch === null) return { ok: false, error: `目标分支 ${baseBranch} 不存在或不可访问。`, code: 'BRANCH_MISSING', detail: baseBranch }
      await client.canReadContents(upstreamOwner, upstreamName, baseBranch)
      let warning = ''
      if (repo.is_fork === 1) {
        const forkOwner = repo.fork_owner || repo.owner
        const forkName = repo.fork_name || repo.name
        if (forkOwner !== upstreamOwner || forkName !== upstreamName) {
          const forkBranch = await client.getBranch(forkOwner, forkName, baseBranch)
          if (forkBranch === null) warning = 'fork target branch is missing'
          else if (forkBranch.sha !== branch.sha) warning = 'fork is behind upstream'
        }
      }
      return { ok: true, baseSha: branch.sha, warning }
    } catch (error) {
      if (error instanceof GithubError && (error.status === 401 || error.status === 403) && !/rate limit/i.test(error.message)) {
        this.markCredentialInvalid(repo, error)
        return { ok: false, error: 'GitHub token 权限不足，请重新授权这个仓库。', code: 'REPO_CREDENTIAL_INVALID' }
      }
      return { ok: false, error: String(error instanceof Error ? error.message : error), code: 'PREFLIGHT_FAILED' }
    }
  }

  private async checkCredential(repo: RepoRow): Promise<{ ok: boolean; code?: string; error?: string }> {
    const cached = this.credentialCache.get(repo.id)
    if (cached !== undefined && Date.now() - cached.at < 10 * 60_000) return { ok: true }
    try {
      const token = await repoGithubToken(repo, this.config, this.githubApp, this.store)
      const client = new GithubClient(token, this.config.github.apiBase)
      const owner = repo.upstream_owner || repo.owner
      const name = repo.upstream_name || repo.name
      const branch = await client.getBranch(owner, name, repo.upstream_default_branch || repo.default_branch)
      await client.canReadContents(owner, name, repo.upstream_default_branch || repo.default_branch)
      if (branch !== null) this.credentialCache.set(repo.id, { at: Date.now() })
      this.store.markRepoCredential(repo.id, 'ok')
      return { ok: true }
    } catch (error) {
      if (error instanceof GithubError && (error.status === 401 || error.status === 403) && !/rate limit/i.test(error.message)) {
        this.markCredentialInvalid(repo, error)
        return { ok: false, code: 'REPO_CREDENTIAL_INVALID', error: 'GitHub token 权限不足，请重新授权这个仓库。' }
      }
      return { ok: true }
    }
  }

  private markCredentialInvalid(repo: RepoRow, error: unknown): void {
    this.credentialCache.delete(repo.id)
    this.store.markRepoCredential(repo.id, 'invalid')
    const current = this.store.getRepo(repo.id)
    if (current !== undefined && current.auto_iterate === 1) this.store.updateRepo(repo.id, { auto_iterate: 0 })
    const message = error instanceof Error ? error.message : String(error)
    this.store.audit(repo.user_id, 'repo.credential_invalid', `${repo.owner}/${repo.name}: ${redact(message).slice(0, 200)}`)
    this.store.notify(repo.user_id, 'job', `${repo.owner}/${repo.name} 的 GitHub token 权限不足，自动迭代已暂停；请重新授权后手动开启。`)
    void sendNotificationWebhook(this.config, 'repo.credential_invalid', { text: `${repo.owner}/${repo.name}: GitHub token is invalid`, repoId: repo.id, error: redact(message).slice(0, 300) })
  }

  /**
   * #353: who started this run, recorded on the row so the mail policy reads a
   * fact instead of guessing from the trigger. Every `manual` enqueue is a
   * console route, so it is a person by construction; a `followup` is only a
   * person's when the caller says so (the retry/resume button), because
   * `tick()` reaches the same trigger through `decideNextJob()`.
   */
  private ownerStartedFor(trigger: string, options: { ownerStarted?: boolean }): boolean {
    return options.ownerStarted ?? trigger === 'manual'
  }

  async enqueue(repo: RepoRow, trigger: 'manual' | 'schedule' | 'followup', goalOverride?: string, kind: JobKind = 'iterate', options: { branch?: string; prUrl?: string; baseBranch?: string; workItemId?: string; priority?: number; retryAttempt?: number; retryOf?: string; ownerStarted?: boolean; workType?: string } = {}): Promise<EnqueueResult> {
    // #283: the platform stop outranks every other refusal. It is checked first,
    // above the work-type resolution and the per-repository and per-role gates, so
    // the answer says the platform is stopped rather than naming a work type or
    // implying this one repository is disabled, and it is checked in the admission
    // path itself: a due repository reaches `enqueue` without a route.
    if (this.platformStop() !== null) return { ok: false, error: '平台已紧急停止，暂不接受新任务。', code: 'PLATFORM_PAUSED' }
    // #390: the work type is resolved before the gates, and an unknown one is
    // refused. A default here would run work under a contract nobody declared.
    const workType = resolveWorkType(options.workType ?? workTypeForKind(kind))
    if (workType === null) {
      return { ok: false, error: '未知的工作类型。', code: 'UNKNOWN_WORK_TYPE', detail: String(options.workType ?? kind) }
    }
    if (!isImplementedWorkType(workType.type)) {
      return { ok: false, error: `${workType.type} 工作类型已登记但还没有实现。`, code: 'WORK_TYPE_UNSUPPORTED', detail: workType.type }
    }
    // #390 review: the pair must agree in both directions. Refusing only
    // `iterate` + `workType='triage'` let a triage run be declared as another
    // work type, which stored `work_type='iterate'` and showed the iterate
    // contract for a run that is forbidden to open a branch or a PR.
    if ((workType.type === 'triage') !== (kind === 'triage')) {
      return { ok: false, error: '分诊是独立的任务类型，不能借用其他任务类型。', code: 'UNKNOWN_WORK_TYPE', detail: `${kind}/${workType.type}` }
    }
    if (kind !== 'triage' && workType.branch === false) {
      return { ok: false, error: `${workType.type} 工作类型不能创建分支或 PR。`, code: 'UNKNOWN_WORK_TYPE', detail: workType.type }
    }
    if (repo.enabled !== 1) return { ok: false, error: '这个仓库已停用', code: 'REPO_DISABLED' }
    if (repo.repo_role !== 'maintainer' && repo.repo_role !== 'developer') {
      return { ok: false, error: '请先选择你在这个仓库的角色。', code: 'ROLE_REQUIRED' }
    }
    if (kind === 'review' && repo.repo_role !== 'maintainer') {
      return { ok: false, error: '只有 maintainer 可以运行审核任务。', code: 'ROLE_FORBIDDEN' }
    }
    if (kind === 'review' && (repo.reviewer_enabled !== 1 || repo.can_review !== 1)) {
      return { ok: false, error: '这个仓库没有启用审核角色', code: 'REVIEW_DISABLED' }
    }
    if (kind === 'review' && !this.roleFresh(repo)) {
      const refreshed = await this.refreshRepoAccess(repo)
      if (refreshed === undefined) return { ok: false, error: 'GitHub 权限检查已过期，请刷新仓库后再审核。', code: 'ROLE_STALE' }
      repo = refreshed
    }
    const active = this.store.activeJobForRepo(repo.id)
    if (active !== undefined) return { ok: false, error: '这个仓库已有任务在运行', code: 'JOB_ACTIVE' }
    const user = this.store.userById(repo.user_id)
    if (user === undefined || user.status !== 'approved') return { ok: false, error: '用户不可用', code: 'USER_UNAVAILABLE' }
    if (kind === 'discover') this.store.setSetting(`discover:${repo.id}`, nowIso())
    if (this.config.runner.queueDispatch) {
      if (this.store.countQueuedJobs() >= this.config.runner.maxQueueDepth) {
        incCounter('fledge_admission_rejected_total', { reason: 'queue_full' }, 1, 'Queue admission rejections')
        return { ok: false, error: '任务队列已满，请稍后再试。', code: 'QUEUE_FULL' }
      }
      if (this.store.countQueuedJobsForUser(user.id) >= this.config.runner.maxUserQueue) {
        incCounter('fledge_admission_rejected_total', { reason: 'queue_limit' }, 1, 'Queue admission rejections')
        return { ok: false, error: '你排队的任务过多，请稍后再试。', code: 'QUEUE_LIMIT' }
      }
    }
    if (kind !== 'iterate') {
      const credential = await this.checkCredential(repo)
      if (!credential.ok) return { ok: false, error: credential.error ?? 'GitHub token 权限不足。', code: credential.code ?? 'REPO_CREDENTIAL_INVALID' }
    }
    if (repo.monthly_budget_cny > 0) {
      const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
      const spentCny = this.store.repoUsageSince(repo.id, since) * this.config.quota.usdCny
      if (spentCny >= repo.monthly_budget_cny) {
        return { ok: false, error: '仓库月度预算已用完。', code: 'REPO_BUDGET_EXHAUSTED' }
      }
    }

    const repoBaseBranch = repo.target_branch !== '' ? repo.target_branch : (repo.upstream_default_branch || repo.default_branch)
    const baseBranch = (options.baseBranch ?? repoBaseBranch).trim()
    if (!isValidBranchName(baseBranch)) return { ok: false, error: '目标分支格式不正确。', code: 'BRANCH_INVALID' }
    if (kind === 'iterate' && options.prUrl === undefined) {
      const duplicate = await this.duplicatePreflight(repo, goalOverride ?? repo.goal, options.workItemId)
      if (!duplicate.ok) return { ok: false, error: duplicate.error, code: duplicate.code, detail: duplicate.detail }
    }
    let preflightSha: string | null = null
    let preflightWarning = ''
    if (kind === 'iterate') {
      const preflight = await this.preflight(repo, baseBranch, trigger)
      if (!preflight.ok) return { ok: false, error: preflight.error, code: preflight.code, detail: preflight.detail }
      preflightSha = preflight.baseSha ?? null
      preflightWarning = preflight.warning ?? ''
    }
    let rules: RepoRules | undefined
    if (this.runner.name === 'flybot') {
      const loaded = await this.loadRules(repo, baseBranch, preflightSha)
      if (!loaded.ok) return { ok: false, error: loaded.error, code: loaded.code, detail: loaded.detail }
      rules = loaded.rules
    }
    const baseGoal = kind === 'review' ? DEFAULT_REVIEW_GOAL : kind === 'discover' ? DEFAULT_DISCOVER_GOAL : kind === 'triage' ? DEFAULT_TRIAGE_GOAL : kind === 'scope' ? DEFAULT_SCOPE_GOAL : kind === 'verify' ? DEFAULT_VERIFY_GOAL : (repo.goal !== '' ? repo.goal : DEFAULT_GOAL)
    const rawGoal = goalOverride ?? baseGoal
    const carryOver = trigger === 'schedule' || trigger === 'followup'
      ? buildCarryOver({ recent: this.store.listJobsForRepo(repo.id, 3), openWork: this.store.listOpenWorkItems(repo.id) })
      : ''
    const goal = ((preflightWarning === '' ? rawGoal : `${rawGoal}\n\nPreflight: ${preflightWarning}. Sync the fork before creating the working branch.`)
      + (carryOver === '' ? '' : `\n\n${carryOver}`)).slice(0, 4000)
    const continuityUsed = carryOver !== ''
    const jobId = `job_${randomToken(10)}`
    const callbackSecret = randomToken(24)
    const callbackHash = sha256Hex(callbackSecret)
    const platformFunded = user.own_llm_base_url === null || user.own_llm_base_url === '' || user.own_llm_key_enc === null

    if (platformFunded && quotaView(user, this.config).exhausted) {
      const job = this.store.createJob({ id: jobId, repoId: repo.id, userId: user.id, trigger, goal, callbackHash, platformTokenHash: '', kind, workType: workType.type, ownerStarted: this.ownerStartedFor(trigger, options) })
      this.store.updateJob(job.id, { status: 'quota_exhausted', error: '平台额度已用完，请在 Settings → Model 配置自己的模型 API。', error_code: 'QUOTA_EXHAUSTED', finished_at: nowIso() })
      if (kind === 'review') this.store.updateRepo(repo.id, { last_review_status: 'quota_exhausted' })
      else if (kind === 'iterate') this.store.updateRepo(repo.id, { last_status: 'quota_exhausted', last_run_at: nowIso() })
      else this.store.updateRepo(repo.id, { last_status: 'quota_exhausted' })
      await this.quotaNotifier.notify(user)
      return { ok: false, error: '平台额度已用完，请先配置自己的模型 API', code: 'QUOTA_EXHAUSTED', job: this.store.getJob(job.id) }
    }

    let flybot: { url: string; token: string; sessionId: string; role: 'chief' | 'lead' | 'reviewer' | 'product' | 'test'; leadName: string } | undefined
    if (!this.config.runner.queueDispatch && this.config.flybot.instanceImage !== '') {
      if (this.instances === undefined) return { ok: false, error: 'FlyBot 实例管理器未配置', code: 'INSTANCE_UNAVAILABLE' }
      try {
        await this.instances.ensurePlaybook(repo.id).catch((error) => {
          log.warn('team playbook not refreshed', { repo: repo.id, error: String(error) })
        })
        await this.instances.refreshTeam(repo.id).catch((error) => log.warn('team session refresh before dispatch failed', { repo: repo.id, error: String(error) }))
        const bridge = this.instances.bridgeFor(repo.id)
        const assignment = await this.instances.applyBotModels(repo.id).catch((error) => {
          log.warn('bot model check before dispatch failed', { repo: repo.id, error: String(error) })
          return { updated: 0, skipped: ['model-check'] }
        })
        if (assignment.skipped.length > 0) {
          return { ok: false, error: `机器人模型未就绪：${assignment.skipped.join(', ')}；请在仓库设置里重新应用模型。`, code: 'BOT_MODEL_ASSIGNMENT_FAILED', detail: assignment.skipped.join(', ') }
        }
        const reviewer = kind === 'review' ? bridge.team.reviewer : null
        const role: 'chief' | 'lead' | 'reviewer' | 'product' | 'test' = kind === 'review'
          ? 'reviewer'
          : kind === 'scope'
            ? 'product'
            : kind === 'verify'
              ? 'test'
              : bridge.team.chief !== '' ? 'chief' : 'lead'
        const sessionId = kind === 'review'
          ? (reviewer ?? '')
          : kind === 'scope'
            ? bridge.team.product
            : kind === 'verify'
              ? bridge.team.test
              : bridge.team.chief !== '' ? bridge.team.chief : bridge.team.lead
        flybot = { url: bridge.url, token: bridge.token, sessionId, role, leadName: `${bridge.team.team} Lead` }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error), code: 'INSTANCE_NOT_READY' }
      }
    }

    if (this.store.activeJobForRepo(repo.id) !== undefined) {
      return { ok: false, error: '这个仓库已有任务在运行', code: 'JOB_ACTIVE' }
    }
    if (!this.config.runner.queueDispatch && this.store.countActiveJobs() >= this.config.runner.maxActiveJobs) {
      return { ok: false, error: `平台当前已有 ${this.config.runner.maxActiveJobs} 个任务在运行，请稍后再试。`, code: 'JOB_LIMIT', detail: String(this.config.runner.maxActiveJobs) }
    }

    const platformToken = `flg_${randomToken(32)}`
    const tokenRow = this.store.createApiToken({
      id: `tok_${randomToken(8)}`,
      userId: user.id,
      kind: 'job',
      name: `job:${jobId}`,
      tokenHash: sha256Hex(platformToken),
      prefix: platformToken.slice(0, 8),
      repoId: repo.id,
      expiresAt: addMinutes(this.config.runner.timeoutMinutes + 60),
    })
    const priorJobs = this.store.listJobs(user.id, 1).length
    const priority = options.priority ?? (trigger === 'followup' ? 20 : trigger === 'manual' ? 10 : 0)
    let job: JobRow
    try {
      job = this.store.createJob({ id: jobId, repoId: repo.id, userId: user.id, trigger, goal, callbackHash, platformTokenHash: tokenRow.token_hash, kind, workType: workType.type, baseBranch, workItemId: options.workItemId ?? null, priority, baseSha: preflightSha, retryAttempt: options.retryAttempt ?? 0, retryOf: options.retryOf ?? null, ownerStarted: this.ownerStartedFor(trigger, options) })
    } catch (error) {
      // SQLite reports the column of a partial unique index, not its name, so
      // this index surfaces as "UNIQUE constraint failed: jobs.repo_id". Only
      // that column with a live active row for the repository means "queue busy";
      // a duplicate jobs.id, a foreign-key or a NOT NULL failure is a bug and has
      // to surface instead of being reported as a busy queue.
      if (/UNIQUE constraint failed: jobs\.repo_id/.test(String(error)) && this.store.activeJobForRepo(repo.id) !== undefined) {
        return { ok: false, error: '这个仓库已有任务在运行', code: 'JOB_ACTIVE' }
      }
      throw error
    }
    if (continuityUsed) this.store.updateJob(job.id, { continuity_used: 1 })
    if (rules !== undefined) {
      this.store.saveJobContext({
        jobId: job.id,
        repoId: repo.id,
        commitSha: rules.commit,
        rulesJson: JSON.stringify({
          owner: rules.owner,
          name: rules.name,
          commit: rules.commit,
          hash: rules.hash,
          effective: rules.effective,
          layers: rules.layers,
          files: rules.files.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes, layer: file.layer })),
          skills: rules.skills.map((skill) => ({ name: skill.name, path: skill.path, description: skill.description, sha256: skill.sha256, bytes: skill.bytes })),
        }),
        manifestJson: JSON.stringify([
          ...rules.files.map((file) => ({ path: file.path, kind: 'rule', sha256: file.sha256, bytes: file.bytes })),
          ...rules.skills.map((skill) => ({ path: skill.path, kind: 'skill', sha256: skill.sha256, bytes: skill.bytes })),
        ]),
        files: [...rules.files, ...rules.skills].map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes, content: file.content })),
      })
      this.store.recordJobEvent({ jobId: job.id, repoId: repo.id, userId: user.id, kind: 'job.rules', step: kind, meta: `${rules.commit} ${rules.hash}`.slice(0, 200) })
    }
    if (options.workItemId !== undefined) {
      this.store.updateWorkItem(options.workItemId, { state: 'in_progress', job_id: job.id, assignee_user_id: user.id })
    }
    if (options.branch !== undefined || options.prUrl !== undefined) {
      this.store.updateJob(job.id, { branch: options.branch ?? null, pr_url: options.prUrl ?? null })
      job.branch = options.branch ?? null
      job.pr_url = options.prUrl ?? null
    }
    this.store.event('job_enqueued', { userId: user.id, repoId: repo.id, jobId: job.id, meta: `${kind}:${trigger}` })
    this.store.recordJobEvent({ jobId: job.id, repoId: repo.id, userId: user.id, kind: 'job.enqueued', step: kind, meta: `${kind}:${trigger}` })
    if (priorJobs === 0) this.store.event('first_job_start', { userId: user.id, repoId: repo.id, jobId: job.id })
    if (kind === 'review') this.store.updateRepo(repo.id, { last_review_status: 'queued' })
    else if (kind === 'iterate') this.store.updateRepo(repo.id, { last_run_at: nowIso(), last_status: 'queued' })
    else this.store.updateRepo(repo.id, { last_status: 'queued' })
    this.store.audit(user.id, 'job.enqueued', `${job.id} ${repo.owner}/${repo.name} (${kind}, ${trigger})`)

    if (this.config.runner.queueDispatch) {
      this.store.updateJob(job.id, {
        callback_secret_enc: encryptSecret(callbackSecret, this.config.tokenEncryptionKey),
        platform_token_enc: encryptSecret(platformToken, this.config.tokenEncryptionKey),
      })
      return { ok: true, job: this.store.getJob(job.id) ?? job }
    }

    const revoke = (): void => {
      const row = this.store.findApiToken(tokenRow.token_hash)
      if (row !== undefined) this.store.revokeApiToken(row.id, row.user_id)
    }

    const upstream: RepoRef = {
      owner: repo.upstream_owner || repo.owner,
      name: repo.upstream_name || repo.name,
      defaultBranch: baseBranch,
      htmlUrl: repo.upstream_html_url ?? `https://github.com/${repo.owner}/${repo.name}`,
    }
    const fork: RepoRef = {
      owner: repo.fork_owner || repo.owner,
      name: repo.fork_name || repo.name,
      defaultBranch: repo.fork_default_branch || repo.default_branch,
      htmlUrl: repo.fork_html_url ?? `https://github.com/${repo.owner}/${repo.name}`,
    }
    // #100: the job's own logger, built once and handed to the runner. Every
    // line this job writes — here, in the runner, in the side effects — carries
    // the same value under `trace`, so one search returns the whole job.
    const jobLog = log.with({ trace: job.id })
    try {
      // Mark the job running before dispatch: the bridge may send its first
      // heartbeat as soon as the agent is up, and a queued row may not accept one.
      this.store.updateJob(job.id, {
        status: 'running',
        started_at: nowIso(),
        lease_owner: 'inline',
        lease_until: addMinutes(5),
      })
      this.startLeaseHeartbeat(job.id, 'inline', 5 * 60_000)
      observeHistogram('fledge_job_queue_seconds', Math.max(0, (Date.now() - Date.parse(job.created_at)) / 1000), { kind }, 'Time from enqueue to dispatch')
      this.store.recordJobEvent({ jobId: job.id, repoId: repo.id, userId: user.id, kind: 'job.running', step: kind })
      if (kind === 'review') this.store.updateRepo(repo.id, { last_review_status: 'running' })
      else this.store.updateRepo(repo.id, { last_status: 'running' })
      const result = await this.runner.run({
        job,
        log: jobLog,
        repo,
        user,
        kind,
        goal,
        upstream,
        fork,
        isFork: repo.is_fork === 1,
        permission: repo.permission,
        repoRole: repo.repo_role === 'maintainer' || repo.repo_role === 'developer' ? repo.repo_role : null,
        autoMerge: kind === 'iterate' && workTypeMayAutoMerge(workType.type) && repo.repo_role === 'maintainer' && repo.auto_merge === 1,
        canReview: repo.can_review === 1,
        canCreateIssue: repo.can_create_issue === 1,
        callback: { url: `${this.config.baseUrl}/api/jobs/${job.id}/callback`, secret: callbackSecret },
        credential: { url: `${this.config.baseUrl}/api/jobs/${job.id}/credential`, secret: callbackSecret },
        platform: { baseUrl: `${this.config.baseUrl}/v1`, model: this.config.llm.model, token: platformToken },
        ...(flybot === undefined ? {} : { flybot }),
        ...(rules === undefined ? {} : { rules }),
        timeoutMinutes: this.config.runner.timeoutMinutes,
      })
      if (result.status === 'running') {
        // The row is already running; a callback may have finished it while the
        // runner was dispatching, so report whatever state it ended in.
        const current = this.store.getJob(job.id)
        if (current !== undefined && (current.status === 'succeeded' || current.status === 'running')) return { ok: true, job: current }
        return { ok: false, job: current, error: current?.error ?? '任务失败' }
      }
      this.finish(job.id, { status: result.status === 'succeeded' ? 'succeeded' : 'failed', branch: result.branch, prUrl: result.prUrl, issueUrl: result.issueUrl, reviewScore: result.reviewScore, summary: result.summary, error: result.error }, revoke)
      return { ok: result.status === 'succeeded', job: this.store.getJob(job.id), ...(result.status === 'failed' ? { error: result.error ?? '任务失败' } : {}) }
    } catch (error) {
      revoke()
      const message = String(error instanceof Error ? error.message : error)
      // #260: BRIDGE_ERROR is a transient category, so a provider refusal relayed
      // by the bridge (a budget or rate-limit answer to the send) used to be
      // retried twice as if the instance had been down. The refusal has its own
      // code; only a failure that names neither keeps the bridge category.
      const startCode: FailureCode = providerRefusalCode(message) ?? 'BRIDGE_ERROR'
      this.store.updateJob(job.id, { status: 'failed', error: redact(message).slice(0, 1000), error_code: startCode, finished_at: nowIso() })
      this.store.releaseJobLease(job.id)
      this.clearLeaseHeartbeat(job.id)
      if (kind === 'review') this.store.updateRepo(repo.id, { last_review_at: nowIso(), last_review_status: 'failed' })
      else this.store.updateRepo(repo.id, { last_status: 'failed' })
      this.store.notify(user.id, 'job', `${kind === 'review' ? '审核' : '任务'} ${job.id} 启动失败：${redact(message)}`, startCode)
      this.store.audit(user.id, 'job.failed', `${job.id}: ${redact(message).slice(0, 300)}`)
      jobLog.error('job start failed', { error: message })
      return { ok: false, job: this.store.getJob(job.id), error: message, code: 'RUNNER_ERROR' }
    }
  }

  private syncWorkItemForJob(job: JobRow, result: { status: 'succeeded' | 'failed' | 'quota_exhausted'; prUrl: string | null; issueUrl: string | null }): void {
    const existing = job.work_item_id === null ? undefined : this.store.getWorkItem(job.work_item_id)
    if (existing !== undefined) {
      const prState = result.prUrl === null ? existing.pr_state : 'open'
      // Every terminal status without a pull request returns an active item to the
      // board: a failed job and a quota-refused one both leave the work undone.
      const active = existing.state === 'in_progress' || existing.state === 'assigned'
      const terminalWithoutPr = result.status === 'failed' || result.status === 'quota_exhausted'
      const state = result.status === 'succeeded' && result.prUrl !== null
        ? 'pr_ready'
        : terminalWithoutPr && active
          ? 'triaged'
          : existing.state
      this.store.updateWorkItem(existing.id, {
        state,
        ...(result.prUrl === null ? {} : { pr_url: result.prUrl, pr_state: prState }),
        ...(result.issueUrl === null ? {} : { issue_url: result.issueUrl }),
        job_id: job.id,
      })
      return
    }
    if (result.status !== 'succeeded' || (result.prUrl === null && result.issueUrl === null)) return
    const title = (result.prUrl ?? result.issueUrl ?? job.goal).slice(0, 160)
    this.store.createWorkItem({
      id: randomId('work'),
      repoId: job.repo_id,
      userId: job.user_id,
      title,
      detail: job.goal.slice(0, 2000),
      issueUrl: result.issueUrl,
      prUrl: result.prUrl,
      state: result.prUrl === null ? 'in_progress' : 'pr_ready',
      priority: job.priority,
      jobId: job.id,
      prState: result.prUrl === null ? null : 'open',
    })
  }

  // Returns whether this call moved the row to a terminal state. Callers that
  // perform side effects must only do so when it returns true.
  private finish(jobId: string, result: { status: 'succeeded' | 'failed' | 'quota_exhausted'; branch?: string; prUrl?: string | null; issueUrl?: string | null; reviewScore?: number; summary?: string; error?: string; errorCode?: FailureCode }, revoke: () => void, attribution: Attribution | null = null, evidence: Evidence | null = null, fingerprint: string | null = null): boolean {
    const job = this.store.getJob(jobId)
    if (job === undefined) return false
    if (job.status !== 'queued' && job.status !== 'running') return false
    const branch = result.branch ?? job.branch
    // undefined means "not reported, keep the column"; null means "reported but
    // unplaceable, store no link" (a rejected callback URL must not linger).
    const prUrl = result.prUrl === undefined ? job.pr_url : result.prUrl
    const issueUrl = result.issueUrl === undefined ? job.issue_url : result.issueUrl
    const reviewScore = result.reviewScore ?? job.review_score
    // #458: redact before either cut. The same clean values go to the row, the
    // digest and the notices; a secret cut in half is a fragment no later pass
    // can recognise.
    const summary = redact(result.summary ?? job.summary ?? '').slice(0, 4000)
    const error = redact(result.error ?? job.error ?? '').slice(0, 2000)
    // The guarded transition is the idempotency key: a lost update means another
    // delivery already finalised the job and must own the side effects.
    const claimed = this.store.claimJobTerminal(jobId, result.status, fingerprint, {
      branch,
      pr_url: prUrl,
      issue_url: issueUrl,
      review_score: reviewScore,
      attribution_json: attribution === null ? job.attribution_json : JSON.stringify(attribution),
      evidence_json: evidence === null ? job.evidence_json : JSON.stringify(evidence),
      summary,
      error,
      error_code: result.errorCode ?? job.error_code ?? null,
      finished_at: nowIso(),
    })
    if (!claimed) return false
    this.store.releaseJobLease(jobId)
    this.clearLeaseHeartbeat(jobId)
    incCounter('fledge_jobs_total', { status: result.status, kind: job.kind }, 1, 'Jobs by terminal status')
    const started = Date.parse(job.started_at ?? job.created_at)
    const ended = Date.parse(nowIso())
    if (Number.isFinite(started) && Number.isFinite(ended)) observeHistogram('fledge_job_seconds', Math.max(0, (ended - started) / 1000), { kind: job.kind, status: result.status }, 'Job duration')
    this.syncWorkItemForJob(job, { status: result.status, prUrl, issueUrl })
    const finalJob = this.store.getJob(jobId) ?? job
    const digest = buildRunDigest(finalJob, { status: result.status, summary, issueUrl, prUrl })
    this.store.updateJob(jobId, { continuity_json: JSON.stringify(digest), output_kind: digest.output_kind })
    incCounter('fledge_job_output_total', { kind: job.kind, output: digest.output_kind }, 1, 'Scheduled output classification')
    if (digest.output_kind === 'meta') {
      incCounter('fledge_meta_issue_total', { kind: job.kind }, 1, 'Inventory/meta issues rejected by classification')
      // Close the tracking row so the next scheduled run does not follow up a
      // meta issue. The GitHub issue itself is left for the owner to decide on.
      if (issueUrl !== null) {
        const item = this.store.findWorkItemByIssueUrl(job.repo_id, issueUrl)
        if (item !== undefined) this.store.updateWorkItem(item.id, { state: 'closed' })
      }
      this.store.notify(job.user_id, 'job', `任务 ${jobId} 产出的是盘点/清账类 issue，不计为产品产出；请改为具体问题。`)
    }
    if (job.kind === 'review') this.store.updateRepo(job.repo_id, { last_review_at: nowIso(), last_review_status: result.status })
    else this.store.updateRepo(job.repo_id, { last_status: result.status })
    void this.instances?.clearJobToken(job.repo_id, jobId).catch((error) => {
      log.warn('clear job model token failed', { trace: jobId, error: String(error) })
    })
    revoke()
    const providerAudit = [finalJob.provider_label, finalJob.provider_region, finalJob.provider_model]
      .filter((part): part is string => part !== null && part !== '')
      .map((part) => part.replace(/[\r\n]+/g, ' ').slice(0, 120))
    this.store.audit(job.user_id, `job.${result.status}`, providerAudit.length === 0 ? jobId : `${jobId} ${providerAudit.join(' · ')}`)
    this.store.event(`job_${result.status}`, { userId: job.user_id, repoId: job.repo_id, jobId })
    // The event meta keeps its original choice of value (the payload's error,
    // else its summary), redacted; the fallback to `job.error` stays local to the
    // row and the notice.
    const eventMeta = result.error ?? result.summary ?? null
    this.store.recordJobEvent({ jobId, repoId: job.repo_id, userId: job.user_id, kind: `job.${result.status}`, step: job.kind, meta: eventMeta === null ? null : redact(eventMeta) })
    if (result.status === 'failed') this.notePostmortem(jobId)
    if (result.status === 'succeeded' && prUrl !== null) this.store.event('pr_open', { userId: job.user_id, repoId: job.repo_id, jobId })
    if (result.status === 'failed') this.store.notify(job.user_id, 'job', `${job.kind === 'review' ? '审核' : '任务'} ${jobId} 失败：${redact(result.error ?? job.error ?? '未知原因')}`, this.store.getJob(jobId)?.error_code ?? null)
    if (result.status === 'succeeded' || result.status === 'failed') {
      // #353: a success has no retry behind it, so its mail is decided here; a
      // failure waits for the retry decision below.
      if (result.status === 'succeeded') void this.sendJobEmail(job, result)
      void sendNotificationWebhook(this.config, `job.${result.status}`, {
        text: `${job.kind} job ${job.id} ${result.status}`,
        jobId: job.id,
        repoId: job.repo_id,
        kind: job.kind,
        trigger: job.trigger,
        status: result.status,
        prUrl: prUrl,
        issueUrl: issueUrl,
        summary: redact(result.summary ?? job.summary ?? ''),
        error: redact(result.error ?? job.error ?? ''),
      })
    }
    const repo = this.store.getRepo(job.repo_id)
    if (repo !== undefined && repo.job_budget_cny > 0) {
      const jobCostCny = this.store.usageForJob(jobId) * this.config.quota.usdCny
      if (jobCostCny > repo.job_budget_cny) {
        this.store.audit(job.user_id, 'job.budget_exceeded', `${jobId}: ${jobCostCny.toFixed(4)} > ${repo.job_budget_cny}`)
        this.store.notify(job.user_id, 'quota', `任务 ${jobId} 成本 ${jobCostCny.toFixed(2)} 元，超过单任务预算 ${repo.job_budget_cny.toFixed(2)} 元。`)
      }
    }
    if (result.status === 'succeeded') {
      this.store.deleteSetting(`ops:repo_failing:${job.repo_id}`)
      this.store.resetRepoFailures(job.repo_id)
    }
    if (result.status === 'failed') {
      this.store.incrementRepoFailures(job.repo_id)
      this.checkRepeatedFailures(job)
      // #353: the retry decision is part of the mail decision. A transient
      // failure that queued a retry is not the last word, so it sends nothing
      // and the retry's own result is the one that speaks.
      const retryScheduled = this.scheduleRetry(this.store.getJob(jobId) ?? job)
      void this.sendJobEmail(job, result, { retryPending: retryScheduled })
    }
    if (result.status === 'succeeded') {
      void this.afterSucceeded(job, prUrl ?? undefined, issueUrl ?? undefined, attribution).catch((error) => log.warn('post-job side effects failed', { trace: jobId, error: String(error) }))
      void this.autoQueueNextStage(jobId).catch((error) => log.warn('auto next stage failed', { trace: jobId, error: String(error) }))
    } else {
      void this.captureTeamStats(jobId, attribution).catch((error) => log.warn('team stats capture failed', { trace: jobId, error: String(error) }))
    }
    return true
  }

  private notePostmortem(jobId: string): void {
    try {
      const record = this.store.createPostmortemForJob(jobId)
      if (record?.escalated !== true) return
      this.store.audit(record.postmortem.user_id, 'postmortem.recurrence_escalated', `${record.recurrence.recurrence_key}: ${record.recurrence.count}`)
      void sendNotificationWebhook(this.config, 'postmortem.recurring', {
        text: `recurring ${record.postmortem.category} failure ${record.recurrence.recurrence_key} seen ${record.recurrence.count} times`,
        repoId: record.postmortem.repo_id,
        jobId,
        recurrenceKey: record.recurrence.recurrence_key,
        count: record.recurrence.count,
      })
    } catch (error) {
      log.warn('postmortem write failed', { trace: jobId, error: String(error) })
    }
  }

  private scheduleRetry(job: JobRow): boolean {
    if (job.kind !== 'iterate' && job.kind !== 'verify' && job.kind !== 'review') return false
    // A review that already recorded a score posted its verdict, so a blind retry
    // could post a second COMMENT set. `summary` is not that signal: every running
    // heartbeat writes it as the progress line (the bridge posts one after each
    // major step), so gating on it refused exactly the transient failures this
    // policy exists for. The residual case — comments posted but the terminal
    // callback lost — leaves no stored marker; it stays manual and is stated in
    // docs/architecture.md.
    if (job.kind === 'review' && job.review_score !== null) return false
    // #260: a provider refusal is not a transient stall. Retrying it burns the
    // slot against the same exhausted budget, which is what the owner observed.
    if (providerRefusalCode(job.error) !== null || (job.error_code ?? '').startsWith('PROVIDER_')) return false
    const repo = this.store.getRepo(job.repo_id)
    if (repo === undefined || repo.enabled !== 1) return false
    const failure = classifyFailure({ status: 'failed', error: job.error, kind: job.kind })
    const decision = job.kind === 'review' ? reviewRetryDecision(failure?.kind, job.retry_attempt) : retryDecision(failure?.kind, job.retry_attempt)
    if (!decision.retry) return false
    const key = `retry_pending:${job.id}`
    if (this.store.getSetting(key) !== undefined) return false
    const dueAt = new Date(Date.now() + decision.delayMs).toISOString()
    this.store.setSetting(key, JSON.stringify({
      dueAt,
      attempt: job.retry_attempt + 1,
      goal: job.goal,
      kind: job.kind,
      branch: job.branch,
      prUrl: job.pr_url,
      baseBranch: job.base_branch,
      workItemId: job.work_item_id,
      priority: job.priority,
    }))
    incCounter('fledge_retries_total', { kind: failure?.kind ?? 'unknown' }, 1, 'Scheduled retries')
    this.store.audit(job.user_id, 'job.retry_scheduled', `${job.id}: ${decision.reason}, due ${dueAt}`)
    this.store.recordJobEvent({ jobId: job.id, repoId: job.repo_id, userId: job.user_id, kind: 'job.retry_scheduled', step: job.kind, meta: `${decision.reason}; due ${dueAt}` })
    this.store.notify(job.user_id, 'job', `任务 ${job.id} 属于临时失败，将在约 ${Math.round(decision.delayMs / 60_000)} 分钟后自动重试。`)
    return true
  }

  private async releaseDueRetries(): Promise<void> {
    for (const row of this.store.listSettings('retry_pending:')) {
      const jobId = row.key.slice('retry_pending:'.length)
      let input: { dueAt: string; attempt: number; goal: string; kind: JobKind; branch: string | null; prUrl: string | null; baseBranch: string | null; workItemId: string | null; priority: number }
      try {
        input = JSON.parse(row.value) as typeof input
      } catch {
        this.store.deleteSetting(row.key)
        continue
      }
      if (Date.parse(input.dueAt) > Date.now()) continue
      const original = this.store.getJob(jobId)
      if (original === undefined) {
        this.store.deleteSetting(row.key)
        continue
      }
      const repo = this.store.getRepo(original.repo_id)
      if (repo === undefined || repo.enabled !== 1) {
        this.store.deleteSetting(row.key)
        continue
      }
      if (this.store.activeJobForRepo(repo.id) !== undefined) continue
      if (!this.userReadyForScheduling(repo.user_id) || !this.instanceReady(repo.id)) continue
      const result = await this.enqueue(repo, 'schedule', input.goal, input.kind, {
        ...(input.branch === null ? {} : { branch: input.branch }),
        ...(input.prUrl === null ? {} : { prUrl: input.prUrl }),
        ...(input.baseBranch === null ? {} : { baseBranch: input.baseBranch }),
        ...(input.workItemId === null ? {} : { workItemId: input.workItemId }),
        priority: input.priority,
        retryAttempt: input.attempt,
        retryOf: original.id,
        // #353: the retry is released as a scheduled run, so it has to carry
        // the original row's mark. Without it a person's run that failed
        // transiently mails nothing: the failure waits for the retry, and the
        // retry's success would take the scheduled side.
        ownerStarted: original.owner_started === 1,
      })
      if (result.ok) {
        this.store.deleteSetting(row.key)
        this.store.audit(repo.user_id, 'job.retry_started', `${original.id} -> ${result.job?.id ?? ''}`)
        this.store.recordJobEvent({ jobId: original.id, repoId: repo.id, userId: repo.user_id, kind: 'job.retry_started', step: original.kind, meta: result.job?.id ?? null })
        log.info('retry started', { trace: original.id, retry: result.job?.id })
      } else if (result.code !== 'JOB_ACTIVE' && result.code !== 'INSTANCE_NOT_READY') {
        this.store.deleteSetting(row.key)
        this.store.audit(repo.user_id, 'job.retry_dropped', `${original.id}: ${result.code ?? (result.error === undefined ? 'unknown' : redact(result.error))}`)
      }
    }
  }

  private checkRepeatedFailures(job: JobRow): void {
    const key = `ops:repo_failing:${job.repo_id}`
    const recent = this.store.listJobsForRepo(job.repo_id, 3)
    if (recent.length < 3 || !recent.every((entry) => entry.status === 'failed')) return
    const repo = this.store.getRepo(job.repo_id)
    const label = repo === undefined ? job.repo_id : `${repo.upstream_owner || repo.owner}/${repo.upstream_name || repo.name}`
    if (repo !== undefined && repo.auto_iterate === 1) {
      this.store.updateRepo(repo.id, { auto_iterate: 0 })
      this.store.audit(job.user_id, 'repo.auto_paused', `${label}: 3 consecutive failures`)
    }
    if (this.store.getSetting(key) !== undefined) return
    this.store.setSetting(key, nowIso())
    this.store.notify(job.user_id, 'job', `${label} 连续 3 个任务失败，自动迭代已暂停；请检查 bridge、GitHub 凭据和模型额度后手动重新开启。`)
    this.store.audit(job.user_id, 'ops.repeated_failures', `${label}: 3 consecutive failures`)
    void sendNotificationWebhook(this.config, 'repo.repeated_failures', { text: `${label}: 3 consecutive job failures; auto-iterate paused`, repoId: job.repo_id, jobId: job.id })
  }

  private async refreshRepoAccess(repo: RepoRow): Promise<RepoRow | undefined> {
    const user = this.store.userById(repo.user_id)
    if (user === undefined || user.status !== 'approved') return undefined
    const owner = repo.upstream_owner || repo.owner
    const name = repo.upstream_name || repo.name
    try {
      let prepared: Awaited<ReturnType<typeof prepareRepo>>
      let effectivePermission: string
      if (repo.installation_id !== null) {
        const installationToken = await this.githubApp.installationToken(repo.installation_id)
        prepared = await prepareRepoWithInstallation(installationToken, owner, name, user.login, this.config.github.apiBase)
        effectivePermission = 'none'
        if (user.github_token_enc !== null) {
          try {
            effectivePermission = await repoPermissionWithToken(decryptSecret(user.github_token_enc, this.config.tokenEncryptionKey), owner, name, this.config.github.apiBase)
          } catch (error) {
            log.warn('role recheck user permission failed', { repo: repo.id, error: String(error) })
          }
        }
      } else {
        const token = await repoGithubToken(repo, this.config, this.githubApp, this.store)
        prepared = await prepareRepo(token, owner, name, user.login, this.config.github.apiBase)
        effectivePermission = prepared.permission
      }
      const allowed = effectivePermission === 'admin' || effectivePermission === 'maintain' ? ['maintainer', 'developer'] : ['developer']
      const currentRole = repo.repo_role === 'maintainer' || repo.repo_role === 'developer' ? repo.repo_role : null
      const downgraded = currentRole === 'maintainer' && !allowed.includes('maintainer')
      const nextRole = downgraded ? 'developer' : repo.repo_role
      this.store.updateRepo(repo.id, {
        upstream_owner: prepared.upstream.owner,
        upstream_name: prepared.upstream.name,
        fork_owner: prepared.fork.owner,
        fork_name: prepared.fork.name,
        upstream_default_branch: prepared.upstream.defaultBranch,
        fork_default_branch: prepared.fork.defaultBranch,
        is_fork: prepared.isFork ? 1 : 0,
        fork_created: prepared.forkCreated ? 1 : 0,
        permission: effectivePermission,
        repo_role: nextRole,
        auto_merge: downgraded ? 0 : repo.auto_merge,
        role_checked_at: nowIso(),
        can_review: prepared.canReview ? 1 : 0,
        can_create_issue: prepared.canCreateIssue ? 1 : 0,
        reviewer_enabled: nextRole === 'maintainer' && prepared.canReview && repo.reviewer_enabled === 1 ? 1 : 0,
        upstream_html_url: prepared.upstream.htmlUrl,
        fork_html_url: prepared.fork.htmlUrl,
      })
      this.store.audit(repo.user_id, 'repo.refreshed', `${repo.owner}/${repo.name} permission=${effectivePermission} role=${nextRole ?? 'none'}${downgraded ? ' downgraded' : ''} auto=role-recheck`)
      return this.store.getRepo(repo.id)
    } catch (error) {
      log.warn('role recheck failed', { repo: repo.id, error: String(error) })
      return undefined
    }
  }

  private roleFresh(repo: RepoRow, maxAgeMs = 6 * 60 * 60 * 1_000): boolean {
    if (repo.role_checked_at === null) return false
    const at = Date.parse(repo.role_checked_at)
    return Number.isFinite(at) && Date.now() - at <= maxAgeMs
  }

  // The base a job's pull request must target, using the same fallback as
  // enqueue/followUp: the job's recorded base branch, else the repo target
  // branch, else the upstream default.
  private expectedBaseBranch(repo: RepoRow, job: JobRow): string {
    if (job.base_branch !== null && job.base_branch !== '') return job.base_branch
    return repo.target_branch !== '' ? repo.target_branch : (repo.upstream_default_branch || repo.default_branch)
  }

  private async pathGuardFor(
    client: GithubClient,
    owner: string,
    name: string,
    number: number,
    job: JobRow,
    repo: RepoRow,
    reportedFiles: number,
  ): Promise<PathGuardResult> {
    const allow = job.plan_allow_paths ?? repo.allow_paths
    const deny = job.plan_deny_paths ?? repo.deny_paths
    if (splitPathPatterns(allow).length === 0 && splitPathPatterns(deny).length === 0) {
      return { ok: true, checkedAt: nowIso(), allow: [], deny: [], files: [], violations: [], checkedFiles: 0, reportedFiles, truncated: false }
    }
    const listed = await client.listPullRequestFiles(owner, name, number, reportedFiles)
    // `listed.complete` is the client's own answer about the walk: with no
    // reported count its `files.length` equals what it fetched, so passing only
    // the count would turn an unfinished list into a clean one.
    return checkPathGuard(listed.files.map((file) => file.filename), allow, deny, undefined, reportedFiles > 0 ? reportedFiles : listed.files.length, listed.complete)
  }

  private async ruleChangePaths(
    job: JobRow,
    client: GithubClient,
    owner: string,
    name: string,
    number: number,
    reportedFiles: number,
    knownFiles: string[],
  ): Promise<string[]> {
    // A job that never loaded a rule context cannot have a repository rule to
    // protect, so it must not pay an extra changed-file request.
    if (this.store.getJobContext(job.id) === undefined) return []
    if (knownFiles.length > 0) return knownFiles.filter(isRuleChange)
    const listed = await client.listPullRequestFiles(owner, name, number, reportedFiles)
    return listed.files.map((file) => file.filename).filter(isRuleChange)
  }

  // A truncated walk and a protected-path violation are different refusals. A
  // notification that names the path when the list was merely cut off accuses
  // the change of something it did not do, so the phrase follows `truncated`.
  private static pathGuardRefusal(guard: PathGuardResult): string {
    return guard.truncated ? '改动的文件列表不完整，无法确认路径约束' : '改动了受保护路径'
  }

  // The reason line carried into the audit record, the notification and the
  // merge block when the guard refused: named files, or the truncation itself.
  private static pathGuardDetail(guard: PathGuardResult): string {
    const violations = guard.violations.map((violation) => `${violation.file}: ${violation.reason}`).join('; ')
    if (violations !== '') return violations.slice(0, 1000)
    if (guard.truncated) {
      const reported = guard.reportedFiles > guard.checkedFiles ? ` of ${guard.reportedFiles}` : ''
      return `incomplete changed-file list: checked ${guard.checkedFiles}${reported}`
    }
    return 'path guard refused the change without naming a file'
  }

  async verifyPullRequest(job: JobRow, prUrl: string): Promise<{ ok: boolean; message?: string }> {
    const repo = this.store.getRepo(job.repo_id)
    if (repo === undefined) return { ok: false, message: '仓库不存在。' }
    const parsed = parsePrUrl(repo, prUrl, this.config.github.apiBase)
    if (!parsed.ok) return { ok: false, message: parsed.reason }
    const { owner, name, number } = parsed.ref
    try {
      const token = await repoGithubToken(repo, this.config, this.githubApp, this.store)
      const client = new GithubClient(token, this.config.github.apiBase)
      const pr = await client.getPullRequest(owner, name, number)
      const checks = await client.listCheckRuns(owner, name, pr.headSha)
      const combined = await client.getCombinedStatus(owner, name, pr.headSha)
      const reviews = await client.listReviews(owner, name, number)
      const latest = new Map<string, string>()
      for (const review of reviews.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))) {
        if (review.user !== '') latest.set(review.user, review.state)
      }
      const changesRequested = [...latest.values()].includes('CHANGES_REQUESTED')
      const approvals = [...latest.values()].filter((state) => state === 'APPROVED').length
      const failing = checks.filter((run) => run.status === 'completed' && !['success', 'neutral', 'skipped'].includes(run.conclusion ?? '')).map((run) => run.name)
      const pending = checks.filter((run) => run.status !== 'completed').map((run) => run.name)
      const claimedTest = parseEvidenceJson(job.evidence_json)?.testGreen !== undefined
      const testEvidence = evaluateTestEvidence(claimedTest, checks)
      const reasons: string[] = []
      if (pr.merged) reasons.push('PR is already merged.')
      else if (pr.state !== 'open') reasons.push(`PR is ${pr.state}.`)
      if (pr.draft) reasons.push('PR is a draft.')
      if (checks.length === 0) reasons.push('No check runs.')
      if (failing.length > 0) reasons.push(`Failing checks: ${failing.join(', ')}`)
      if (pending.length > 0) reasons.push(`Pending checks: ${pending.join(', ')}`)
      if (combined.count > 0 && combined.state !== 'success') reasons.push(`Commit status is ${combined.state}.`)
      if (changesRequested) reasons.push('Changes requested.')
      if (testEvidence.state === 'contradicted') reasons.push('Test evidence is contradicted by the check runs.')
      // #134: the job claims a green test, and no check run produced one — the
      // test job was skipped or neutral, or no check is named as a test job. The
      // panel must not say "Verified", and the gate must not merge on the claim:
      // both read this snapshot, so the refusal is recorded here, once.
      else if (testEvidence.claimed && testEvidence.state === 'unverified' && checks.length > 0) reasons.push('Test evidence is claimed but no test check passed.')
      const verification: VerificationResult = {
        ok: reasons.length === 0,
        checkedAt: nowIso(),
        sha: pr.headSha,
        prState: pr.state,
        draft: pr.draft,
        mergeableState: pr.mergeableState,
        checks: { total: checks.length, green: checks.length - failing.length - pending.length, failing, pending },
        combinedStatus: combined.state,
        reviews: { changesRequested, approvals },
        testEvidence,
        reasons,
      }
      const guard = await this.pathGuardFor(client, owner, name, number, job, repo, pr.changedFiles)
      const rulePaths = await this.ruleChangePaths(job, client, owner, name, number, pr.changedFiles, guard.files)
      if (rulePaths.length > 0) {
        const acknowledged = this.store.getSetting(`rule_change_ack:${job.id}:${pr.headSha}`) !== undefined
        verification.ruleChange = { paths: rulePaths, acknowledged }
        if (!acknowledged) reasons.push('Pull request changes Fledge rules or skills; a maintainer must acknowledge the rule change.')
        verification.reasons = reasons
        verification.ok = reasons.length === 0
      }
      this.store.updateJob(job.id, { verification_json: JSON.stringify(verification), path_guard_json: JSON.stringify(guard) })
      if (!guard.ok) {
        incCounter('fledge_path_guard_blocked_total', {}, 1, 'Pull requests blocked by path guard')
        const detail = Jobs.pathGuardDetail(guard)
        this.store.audit(job.user_id, 'job.path_guard_violation', `${job.id}: ${detail}`)
        this.store.event('job_path_guard_violation', { userId: job.user_id, repoId: job.repo_id, jobId: job.id, meta: detail })
        this.store.notify(job.user_id, 'job', `任务 ${job.id} ${Jobs.pathGuardRefusal(guard)}：${detail}`)
      }
      if (!verification.ok) {
        incCounter('fledge_verification_failed_total', {}, 1, 'Pull request verification failures')
        this.store.audit(job.user_id, 'job.verification_failed', `${job.id}: ${verification.reasons.join('; ').slice(0, 500)}`)
        this.store.event('job_verification_failed', { userId: job.user_id, repoId: job.repo_id, jobId: job.id, meta: verification.reasons.join('|').slice(0, 400) })
      }
      const problems = [...verification.reasons, ...guard.violations.map((violation) => `${violation.file}: ${violation.reason}`)]
      return { ok: verification.ok && guard.ok, ...(problems.length === 0 ? {} : { message: problems.join('; ') }) }
    } catch (error) {
      log.warn('pull request verification failed', { trace: job.id, prUrl, error: String(error) })
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  async recheck(jobId: string): Promise<{ ok: boolean; message?: string }> {
    const job = this.store.getJob(jobId)
    if (job === undefined) return { ok: false, message: '任务不存在。' }
    if (job.pr_url === null) return { ok: false, message: '这个任务还没有 PR。' }
    return this.verifyPullRequest(job, job.pr_url)
  }

  // The adversarial pass runs only on the automatic path: a maintainer merging by
  // hand has read the change and owns that decision. It is a fresh model context
  // over the packet, so its verdict can block the merge without ever seeing the
  // author's summary or claimed test output. A missing pass never blocks: Fledge
  // does not invent a risk, and only a concrete one stops the call below.
  private async adversarialPass(
    job: JobRow,
    client: GithubClient,
    owner: string,
    name: string,
    pr: { number: number; headSha: string; base: string; changedFiles: number },
    checks: Array<{ name: string; status: string; conclusion: string | null }>,
  ): Promise<{ block: { file: string; line: number } | null; reused: boolean; refusal: string | null }> {
    const record = (status: string, detail: Record<string, unknown>): void => {
      this.store.recordJobEvent({
        jobId: job.id,
        repoId: job.repo_id,
        userId: job.user_id,
        kind: 'job.adversarial',
        step: status,
        meta: JSON.stringify(detail).slice(0, 4000),
      })
    }
    // One pass per tip. Auto-merge reconciliation re-reads a blocked PR every
    // few minutes, so a stored verdict for this same head sha is reused instead
    // of paying for the same review again; a new commit is what asks for a new
    // one, and that is exactly the "until resolved" the gate means. `reused` is
    // returned so the caller records the refusal once per tip: the audit row and
    // the notification belong to the first sighting, not to every pass.
    // `Store.listJobEvents` answers newest-first (`ORDER BY id DESC`), so the
    // first match is the verdict for the newest tip; reversing it would read the
    // first tip's verdict forever and never reuse a later one.
    const previous = this.store.listJobEvents(job.id).find((event) => event.kind === 'job.adversarial' && event.step !== 'skipped' && event.step !== 'unavailable')
    if (previous !== undefined) {
      try {
        const stored = JSON.parse(previous.meta ?? '') as { tipSha?: unknown; verdict?: unknown; status?: unknown; reason?: unknown }
        if (stored.tipSha === pr.headSha && stored.verdict !== null && typeof stored.verdict === 'object') {
          // A refusal re-read from the record still blocks, and still says it was
          // a refusal: the notification must not present a fake file:line as a
          // risk the model named.
          const refusal = stored.status === 'incomplete' && typeof stored.reason === 'string' && stored.reason.trim() !== '' ? stored.reason : null
          return { block: adversarialMergeBlock({ verdict: stored.verdict as AdversarialVerdict }), reused: true, refusal }
        }
      } catch {}
    }
    const model = this.adversarialModel
    if (model === null && this.config.llm.key === '') {
      record('skipped', { status: 'skipped', reason: 'platform model is not configured' })
      return { block: null, reused: false, refusal: null }
    }
    const branch = await client.getBranch(owner, name, pr.base).catch(() => null)
    const baseSha = job.base_sha ?? branch?.sha ?? ''
    if (baseSha === '') {
      record('skipped', { status: 'skipped', reason: 'base sha is unknown' })
      return { block: null, reused: false, refusal: null }
    }
    const listed = await client.listPullRequestFiles(owner, name, pr.number, pr.changedFiles).catch((error) => {
      record('unavailable', { status: 'unavailable', reason: String(error).slice(0, 300) })
      return null
    })
    if (listed === null) return { block: null, reused: false, refusal: null }
    // #556: a refusal names what it could not read and records the tip, so the
    // next reconcile of the same tip reads the refusal instead of paying for a
    // second model call. The stored verdict is risk-shaped because that is the
    // shape the reuse path above reads; the reason carries the truth.
    const refuse = (reason: string, target: string, detail: Record<string, unknown>): { block: { file: string; line: number }; reused: boolean; refusal: string } => {
      record('incomplete', {
        status: 'incomplete',
        tipSha: pr.headSha,
        reason,
        ...detail,
        verdict: { kind: 'risk', file: target, line: 0, failureMode: reason, repro: 'open the pull request files page and read the file named in the refusal', checks: [] },
        target: `${target}:0`,
      })
      this.store.audit(job.user_id, 'job.adversarial_incomplete', `${job.id}: ${reason}`)
      return { block: { file: target, line: 0 }, reused: false, refusal: reason }
    }
    if (!listed.complete) {
      // The listing is the input to the review. A pass over the files it did
      // reach, presented as a pass over the change, is the fail-open this card
      // closes: it answers about a subset it was never told about.
      return refuse(
        `the changed-file list is truncated: ${listed.files.length} of ${pr.changedFiles} files were listed, so the rest were not read`,
        '(changed-file list)',
        { listed: listed.files.length, reported: pr.changedFiles },
      )
    }
    // A file that arrives without a patch is unread, and an unread file outside
    // the asset allowlist is a refusal. This runs before the empty-diff branch:
    // a pull request whose every file is patch-less used to reach that branch and
    // skip with no block at all. A 100 %-similarity rename is the one patch-less
    // shape that is not unread — the API sends no hunks for it because there are
    // none — but a pure path move is also how a change is disabled without a diff
    // to read, so it keeps its own list and the nothing-readable branch refuses
    // while it is non-empty. Otherwise the asset skip below would release it.
    const isHunklessRename = (file: { status: string; additions: number; deletions: number }): boolean =>
      file.status === 'renamed' && file.additions === 0 && file.deletions === 0
    const renames = listed.files.filter(isHunklessRename).map((file) => file.filename)
    const unread = listed.files
      .filter((file) => (typeof file.patch !== 'string' || file.patch === '') && !isHunklessRename(file))
      .map((file) => file.filename)
    const unreadBeyondAssets = unread.filter((filename) => !adversarialAssetExempt(filename))
    if (unreadBeyondAssets.length > 0) {
      const named = unreadBeyondAssets.slice(0, 10).join(', ')
      return refuse(
        `a changed file arrived without a patch, so the pass could not read it: ${named}${unreadBeyondAssets.length > 10 ? ` and ${unreadBeyondAssets.length - 10} more` : ''}`,
        unreadBeyondAssets[0]!,
        { unread: unreadBeyondAssets.slice(0, 50) },
      )
    }
    const readable = listed.files.filter((file) => typeof file.patch === 'string' && file.patch !== '')
    if (readable.length === 0) {
      if (renames.length > 0 || unread.length === 0) {
        return refuse('the changed-file list reports no readable file, so there was nothing to review', '(changed-file list)', {})
      }
      // The one skip that survives: every unread file is an asset inside the
      // allowlist, so there is no text to send and nothing a model could read.
      // The assets are still named in the record — this merges as "unread", not
      // as "reviewed".
      record('skipped', { status: 'skipped', reason: 'every changed file is an unread binary asset inside the allowlist', unread: unread.slice(0, 50) })
      return { block: null, reused: false, refusal: null }
    }
    // The cut is taken here, at the same point the packet applies, so the pass
    // can name the files it left out. Then it stops instead of skipping the big
    // file: a gap in the middle of a diff reads as if the omitted file was never
    // part of the change.
    let diff = ''
    const omittedFiles: string[] = []
    let omittedBytes = 0
    for (const [index, file] of readable.entries()) {
      const entry = `diff --git a/${file.filename} b/${file.filename}\n${file.patch}`
      const candidate = diff === '' ? entry : `${diff}\n${entry}`
      if (candidate.length <= MAX_DIFF_CHARS) {
        diff = candidate
        continue
      }
      // Keep the part that fits so the model still sees a change, and count the
      // rest as unread. An oversized first file would otherwise leave an empty
      // diff and no honest way to name what was dropped.
      diff = candidate.slice(0, MAX_DIFF_CHARS)
      omittedFiles.push(file.filename)
      omittedBytes += candidate.length - MAX_DIFF_CHARS
      for (const later of readable.slice(index + 1)) {
        omittedBytes += `diff --git a/${later.filename} b/${later.filename}\n${later.patch}\n`.length
        omittedFiles.push(later.filename)
      }
      break
    }
    const packet = assembleAdversarialPacket({
      baseSha,
      tipSha: pr.headSha,
      diff,
      truncated: omittedFiles.length > 0,
      omittedFiles,
      omittedBytes,
      verifier: `checks at ${pr.headSha}: ${checks.map((run) => `${run.name}=${run.conclusion ?? run.status}`).join(', ')}`,
      policy: [
        'every check must be green at the tip',
        `minimum review score ${this.config.autoMerge.minReviewScore}`,
        'a T2 or T3 change needs a PASS at the same tip',
      ],
    })
    // #556: a cut diff is a refusal the packet alone decides. The model is still
    // asked so the record carries its answer, but the refusal is taken from the
    // cut, not from the answer: letting an outage of the model decide is the same
    // fail-open this card closes, reached through the one carve-out that stays.
    // The prompt still carries the caveat, because a model asked about a partial
    // diff must not report it as a whole one.
    const refuseTruncated = (detail: { model: string; promptHash: string; checks: string[]; outage: string | null }): { block: { file: string; line: number }; reused: boolean; refusal: string } => {
      const reason = `the diff was truncated at ${MAX_DIFF_CHARS} characters: ${packet.omittedBytes} bytes in ${packet.omittedFiles.length} file(s) were not read${detail.outage === null ? '' : ', and the model could not be asked'}`
      const target = packet.omittedFiles[0] ?? '(diff cut)'
      record('incomplete', {
        status: 'incomplete',
        tipSha: pr.headSha,
        reason,
        truncated: true,
        omittedFiles: packet.omittedFiles.slice(0, 50),
        omittedBytes: packet.omittedBytes,
        model: detail.model,
        promptHash: detail.promptHash,
        ...(detail.outage === null ? {} : { outage: detail.outage }),
        verdict: { kind: 'risk', file: target, line: 0, failureMode: reason, repro: 'open the pull request files page and read the files named in the refusal', checks: detail.checks },
        target: `${target}:0`,
      })
      this.store.audit(job.user_id, 'job.adversarial_incomplete', `${job.id}: ${reason}`)
      return { block: { file: target, line: 0 }, reused: false, refusal: reason }
    }
    let review: AdversarialReview
    try {
      review = await runAdversarialReview({
        packet,
        model: model ?? openAiAdversarialModel({
          baseUrl: this.config.llm.baseUrl,
          key: this.config.llm.key,
          model: this.config.llm.model,
        }),
        modelId: this.config.llm.model,
      })
    } catch (error) {
      if (packet.truncated) {
        return refuseTruncated({ model: this.config.llm.model, promptHash: adversarialPrompt(packet).hash, checks: [], outage: String(error).slice(0, 300) })
      }
      record('unavailable', { status: 'unavailable', reason: String(error).slice(0, 300) })
      return { block: null, reused: false, refusal: null }
    }
    if (packet.truncated) {
      // The model was told the diff is partial; the block does not depend on it
      // answering well. A cut diff is not a reviewed diff, and recording it as
      // `skipped` (what this used to do) let the merge proceed.
      return refuseTruncated({
        model: review.model,
        promptHash: review.promptHash,
        checks: review.verdict.kind === 'none' ? review.verdict.checks : [],
        outage: null,
      })
    }
    const block = adversarialMergeBlock(review)
    record(review.verdict.kind, {
      ...review,
      target: block === null ? null : `${block.file}:${block.line}`,
      // #556 review finding 2: in a mixed change an allowlisted asset is left out
      // of the packet, and the record has to name it — otherwise the docs' "is
      // recorded as unread" is only true for the all-asset case.
      ...(unread.length === 0 ? {} : { unread: unread.slice(0, 50) }),
    })
    if (block !== null) {
      this.store.audit(job.user_id, 'job.adversarial_risk', `${job.id}: ${block.file}:${block.line}`)
    } else if (review.verdict.kind === 'invalid') {
      this.store.audit(job.user_id, 'job.adversarial_rejected', `${job.id}: ${review.verdict.reason}`)
    }
    return { block, reused: false, refusal: null }
  }

  private async tryMerge(job: JobRow, prUrl: string, manual: boolean): Promise<{ ok: boolean; message?: string }> {
    if (job.kind !== 'iterate') return { ok: false, message: '只有 iterate 任务可以合并。' }
    let repo = this.store.getRepo(job.repo_id)
    if (repo === undefined) return { ok: false, message: '仓库不存在。' }
    if (repo.repo_role !== 'maintainer') return { ok: false, message: '只有 maintainer 可以合并。' }
    if (!manual && repo.auto_merge !== 1) return { ok: false, message: '自动合并未开启。' }
    // #507: the reviewer's signal has to reach the merge path. A low score or a
    // changes_requested work item blocks the automatic merge; a maintainer can
    // override it explicitly, and that override is audited.
    const linkedItem = job.work_item_id === null ? this.store.findWorkItemByPrUrl(repo.id, prUrl) : this.store.getWorkItem(job.work_item_id)
    const review = linkedItem === undefined
      ? undefined
      : this.store.listJobsForRepo(repo.id, 50).find((entry) =>
          entry.kind === 'review' && entry.status === 'succeeded' && entry.work_item_id === linkedItem.id && entry.review_score !== null,
        )
    const reviewBlock = reviewMergeBlock({
      state: linkedItem?.state,
      score: review?.review_score ?? null,
      minScore: this.config.autoMerge.minReviewScore,
    })
    if (reviewBlock !== null) {
      const detail = reviewBlock.kind === 'changes_requested'
        ? 'work item changes_requested'
        : `review ${reviewBlock.score} < ${reviewBlock.minScore}`
      if (!manual) {
        this.store.audit(job.user_id, 'job.merge_skipped', `${job.id}: review gate ${detail}`)
        return {
          ok: false,
          message: reviewBlock.kind === 'changes_requested'
            ? '审核要求修改，自动合并已阻止。'
            : `最新审核分 ${reviewBlock.score} 低于 ${reviewBlock.minScore}，自动合并已阻止。`,
        }
      }
      this.store.audit(job.user_id, 'job.merge_review_override', `${job.id}: ${detail}`)
    }
    if (!manual) {
      // Defence in depth for the automatic path: the job must be the newest
      // iterate job for this PR and it must have succeeded. A caller that
      // forgets the per-PR rule cannot reopen the merge-before-the-fix hole.
      const newest = this.store.newestIterateJobByPrUrl(job.user_id, prUrl)
      if (newest === undefined || newest.id !== job.id || newest.status !== 'succeeded') {
        const state = newest === undefined ? 'no iterate job' : `${newest.id} is ${newest.status}`
        this.store.audit(job.user_id, 'job.merge_skipped', `${job.id}: newest iterate job for this PR is ${state}`)
        return { ok: false, message: '这个 PR 的最新 iterate 任务还没有成功。' }
      }
    }
    if (!this.roleFresh(repo)) {
      const refreshed = await this.refreshRepoAccess(repo)
      if (refreshed === undefined || refreshed.repo_role !== 'maintainer') {
        this.store.audit(job.user_id, 'job.merge_skipped', `${job.id}: stale role check`)
        return { ok: false, message: 'GitHub 权限已过期，请刷新仓库。' }
      }
      repo = refreshed
      if (!manual && repo.auto_merge !== 1) return { ok: false, message: '自动合并未开启。' }
    }
    const parsed = parsePrUrl(repo, prUrl, this.config.github.apiBase)
    if (!parsed.ok) {
      this.store.audit(job.user_id, 'job.merge_skipped', `${job.id}: ${parsed.reason}`)
      return { ok: false, message: 'PR 链接不属于本仓库。' }
    }
    const { owner, name, number } = parsed.ref
    try {
      const token = await repoGithubToken(repo, this.config, this.githubApp, this.store)
      const client = new GithubClient(token, this.config.github.apiBase)
      const pr = await client.getPullRequest(owner, name, number)
      if (!manual) {
        // Auto-merge may only touch the pull request this job produced. A
        // callback secret is handed to a bridge agent, so "some green PR in
        // this repository" is not enough proof of provenance.
        if (pr.head !== job.branch) {
          this.store.audit(job.user_id, 'job.merge_skipped', `${job.id}: head ${pr.head} is not this job's branch ${job.branch ?? '(none)'}`)
          return { ok: false, message: 'PR 的分支不是本任务的分支。' }
        }
        const expectedBase = this.expectedBaseBranch(repo, job)
        if (pr.base !== expectedBase) {
          this.store.audit(job.user_id, 'job.merge_skipped', `${job.id}: base ${pr.base} is not ${expectedBase}`)
          return { ok: false, message: 'PR 的目标分支不是本任务的基线分支。' }
        }
      }
      if (pr.merged) {
        this.store.updateJobsPrState(prUrl, 'merged')
        return { ok: false, message: 'PR 已合并。' }
      }
      if (pr.state !== 'open' || pr.draft) return { ok: false, message: 'PR 不是 open 状态。' }
      const guard = await this.pathGuardFor(client, owner, name, number, job, repo, pr.changedFiles)
      this.store.updateJob(job.id, { path_guard_json: JSON.stringify(guard) })
      const changedRules = await this.ruleChangePaths(job, client, owner, name, number, pr.changedFiles, guard.files)
      if (changedRules.length > 0 && this.store.getSetting(`rule_change_ack:${job.id}:${pr.headSha}`) === undefined) {
        this.store.audit(job.user_id, 'job.merge_skipped', `${job.id}: rule change needs acknowledgement (${changedRules.length} paths)`)
        this.store.notify(job.user_id, 'job', `任务 ${job.id} 的 PR 修改了 Fledge 规则或技能，maintainer 确认后才能合并。`)
        return { ok: false, message: 'PR 修改了 Fledge 规则或技能，需要 maintainer 先确认。' }
      }
      if (!guard.ok) {
        incCounter('fledge_path_guard_blocked_total', {}, 1, 'Pull requests blocked by path guard')
        const detail = Jobs.pathGuardDetail(guard)
        this.store.audit(job.user_id, 'job.merge_skipped', `${job.id}: path guard ${detail}`)
        this.store.notify(job.user_id, 'job', `任务 ${job.id} 的 PR ${Jobs.pathGuardRefusal(guard)}，已阻止合并：${detail}`)
        return { ok: false, message: guard.truncated ? `改动的文件列表不完整，无法确认路径约束：${detail}` : `改动包含受保护路径：${detail}` }
      }
      if (pr.mergeable === false || ['blocked', 'dirty', 'behind', 'unknown'].includes(pr.mergeableState)) {
        this.store.audit(job.user_id, 'job.merge_skipped', `${job.id}: PR ${number} is ${pr.mergeableState}`)
        return { ok: false, message: `PR 当前不可合并（${pr.mergeableState}）。` }
      }
      const checks = await client.listCheckRuns(owner, name, pr.headSha)
      if (checks.length === 0) {
        this.store.audit(job.user_id, 'job.merge_skipped', `${job.id}: no check runs`)
        return { ok: false, message: 'PR 还没有 check runs。' }
      }
      if (checks.some((run) => run.status !== 'completed' || !['success', 'neutral', 'skipped'].includes(run.conclusion ?? ''))) {
        this.store.audit(job.user_id, 'job.merge_skipped', `${job.id}: checks are not green`)
        return { ok: false, message: 'PR 检查还没有全绿。' }
      }
      // #134 D3: the panel and this gate must read the same row the same way. The
      // sweep above tolerates `neutral`/`skipped` for every check — that is #79's
      // `ci-ok` question, not this one — but a job that claims a green test and
      // has no passing test check is refused here, before the merge call, under
      // the same evidence rule the panel applies. This is the gate that actually
      // merges, so the refusal the snapshot records needs a reader here too.
      const claimedTest = parseEvidenceJson(job.evidence_json)?.testGreen !== undefined
      if (claimedTest && evaluateTestEvidence(true, checks).state !== 'verified') {
        this.store.audit(job.user_id, 'job.merge_skipped', `${job.id}: claimed test evidence is not verified`)
        return { ok: false, message: 'PR 声称有测试证据，但没有通过的测试 check。' }
      }
      const combined = await client.getCombinedStatus(owner, name, pr.headSha)
      if (combined.count > 0 && combined.state !== 'success') {
        this.store.audit(job.user_id, 'job.merge_skipped', `${job.id}: commit status is ${combined.state}`)
        return { ok: false, message: `commit status 是 ${combined.state}。` }
      }
      const reviews = await client.listReviews(owner, name, number)
      const latest = new Map<string, string>()
      for (const review of reviews.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))) {
        if (review.user !== '') latest.set(review.user, review.state)
      }
      if ([...latest.values()].includes('CHANGES_REQUESTED')) {
        this.store.audit(job.user_id, 'job.merge_skipped', `${job.id}: changes requested`)
        return { ok: false, message: 'PR 还有 changes requested。' }
      }
      if (repo.require_protection === 1) {
        const protection = await client.getBranchProtection(owner, name, pr.base)
        if (protection === null || !protection.protected) {
          this.store.audit(job.user_id, 'job.merge_skipped', `${job.id}: branch protection unavailable`)
          return { ok: false, message: '读不到 branch protection。' }
        }
        if (protection.requiredChecks.length > 0) {
          const passing = new Set(checks.filter((run) => run.status === 'completed' && ['success', 'neutral', 'skipped'].includes(run.conclusion ?? '')).map((run) => run.name))
          if (!protection.requiredChecks.every((context) => passing.has(context))) {
            this.store.audit(job.user_id, 'job.merge_skipped', `${job.id}: required checks missing`)
            return { ok: false, message: '缺少 required checks。' }
          }
        }
        if (protection.requiredApprovals > 0) {
          const approvals = [...latest.values()].filter((state) => state === 'APPROVED').length
          if (approvals < protection.requiredApprovals) {
            this.store.audit(job.user_id, 'job.merge_skipped', `${job.id}: required approvals missing`)
            return { ok: false, message: '缺少 required approvals。' }
          }
        }
      }
      // #382: the last gate before the merge call is an independent read of the
      // same diff. It sees the packet and the verifier, never the author's
      // summary, and a concrete risk stops an automatic merge until a later run
      // clears it. A maintainer merging by hand keeps that decision.
      if (!manual) {
        const adversarial = await this.adversarialPass(job, client, owner, name, pr, checks)
        if (adversarial.block !== null) {
          // One tip, one refusal. A reused verdict means this refusal was recorded
          // and announced when the pass first ran; recording it again on every
          // reconcile pass would grow the audit trail 1,2,3,4 and notify the same
          // maintainer about the same commit every few minutes.
          const where = `${adversarial.block.file}:${adversarial.block.line}`
          // A refusal is not a risk the model named: it says the pass could not
          // read the change. Same block, different sentence — a `:0` locator
          // announced as a concrete risk is a report that invents evidence.
          const refusal = adversarial.refusal
          if (!adversarial.reused) {
            this.store.audit(job.user_id, 'job.merge_adversarial_blocked', `${job.id}: ${refusal === null ? where : `incomplete: ${refusal.slice(0, 300)}`}`)
            this.store.notify(job.user_id, 'job', refusal === null
              ? `任务 ${job.id} 的独立对抗式审核指出了具体风险 ${where}，自动合并已阻止。`
              : `任务 ${job.id} 的独立对抗式审核未能读完整改动（${refusal}），自动合并已阻止。`)
          }
          return {
            ok: false,
            message: refusal === null
              ? `独立对抗式审核指出具体风险：${where}，自动合并已阻止。`
              : `独立对抗式审核未能读完整改动：${refusal}，自动合并已阻止。`,
          }
        }
      }
      const requestedMethod = repo.merge_method === 'merge' || repo.merge_method === 'rebase' ? repo.merge_method : 'squash'
      const merged = await client.mergePullRequest(owner, name, number, { sha: pr.headSha, mergeMethod: requestedMethod })
      if (merged.merged) {
        const workItem = job.work_item_id === null ? undefined : this.store.getWorkItem(job.work_item_id)
        if (workItem !== undefined) {
          this.store.updateWorkItem(workItem.id, { state: 'merged', pr_state: 'merged', merged_at: nowIso(), merge_commit: merged.sha ?? null })
        }
        incCounter('fledge_merges_total', { result: 'merged' }, 1, 'Pull request merge results')
        this.store.updateJobsPrState(prUrl, 'merged')
        this.store.audit(job.user_id, manual ? 'job.manually_merged' : 'job.auto_merged', `${job.id}: PR ${number} ${merged.sha ?? ''}`)
        this.store.event('job_auto_merged', { userId: job.user_id, repoId: job.repo_id, jobId: job.id, meta: `pr=${number}` })
        this.store.recordJobEvent({ jobId: job.id, repoId: job.repo_id, userId: job.user_id, kind: 'job.merged', step: `pr=${number}`, meta: merged.sha ?? null })
        return { ok: true, message: '已合并。' }
      }
      this.store.audit(job.user_id, 'job.merge_skipped', `${job.id}: ${merged.message ?? 'merge rejected'}`)
      return { ok: false, message: merged.message ?? 'GitHub 拒绝了合并。' }
    } catch (error) {
      this.store.audit(job.user_id, 'job.merge_failed', `${job.id}: ${String(error).slice(0, 300)}`)
      log.warn('merge failed', { trace: job.id, pr: number, error: String(error) })
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  private async verifyAndMaybeMerge(jobId: string): Promise<void> {
    const current = this.store.getJob(jobId)
    if (current === undefined || current.pr_url === null) return
    await this.verifyPullRequest(current, current.pr_url)
    // #390: only a work type whose contract allows it may hand its PR to the
    // maintainer-enabled auto-merge; a dependency, security or docs job must not
    // inherit iterate's eligibility.
    if (current.kind === 'iterate' && workTypeMayAutoMerge(current.work_type)) await this.maybeAutoMerge(current, current.pr_url)
  }

  async reconcilePr(repo: RepoRow, prUrl: string): Promise<void> {
    const job = this.store.latestJobByPrUrl(repo.user_id, prUrl)
    if (job === undefined) return
    await this.verifyAndMaybeMerge(job.id)
  }

  async reconcileAutoMerge(): Promise<void> {
    let candidates = 0
    for (const repo of this.store.listAutoMergeRepos()) {
      if (repo.repo_role !== 'maintainer') continue
      // One row per PR: only the newest iterate job for that PR may merge, and
      // only when it succeeded. A queued, running, failed, cancelled or paused
      // follow-up therefore holds the PR back instead of being skipped over to
      // an older succeeded row.
      for (const job of this.store.listNewestPrJobsForRepo(repo.id, 20)) {
        if (job.pr_url === null || job.pr_state === 'merged' || job.pr_state === 'closed') continue
        if (job.status !== 'succeeded') continue
        const key = `merge_reconcile:${job.id}`
        const last = this.store.getSetting(key)
        const lastAt = last === undefined ? 0 : Date.parse(last)
        if (Number.isFinite(lastAt) && Date.now() - lastAt < this.config.autoMerge.reconcileMinutes * 60_000) continue
        this.store.setSetting(key, nowIso())
        candidates += 1
        await this.verifyAndMaybeMerge(job.id)
        this.store.audit(job.user_id, 'merge.reconciled', job.id)
      }
    }
    setGauge('fledge_auto_merge_candidates', candidates, {}, 'Auto-merge candidates checked this pass')
  }

  private async maybeAutoMerge(job: JobRow, prUrl: string): Promise<void> {
    await this.tryMerge(job, prUrl, false)
  }

  async mergeCleanPrs(repoId: string): Promise<{ merged: string[]; skipped: Array<{ jobId: string; message: string; reason: 'job-state' | 'gate' }> }> {
    const repo = this.store.getRepo(repoId)
    if (repo === undefined) return { merged: [], skipped: [] }
    const merged: string[] = []
    const skipped: Array<{ jobId: string; message: string; reason: 'job-state' | 'gate' }> = []
    for (const job of this.store.listNewestPrJobsForRepo(repoId, 10)) {
      if (job.pr_url === null) continue
      if (job.status !== 'succeeded') {
        skipped.push({ jobId: job.id, message: `未合并：这个 PR 的最新任务状态是 ${job.status}。`, reason: 'job-state' })
        continue
      }
      const result = await this.manualMerge(repo, job)
      if (result.ok) merged.push(job.id)
      else skipped.push({ jobId: job.id, message: result.message ?? 'skipped', reason: 'gate' })
    }
    return { merged, skipped }
  }

  async manualMerge(repo: RepoRow, job: JobRow): Promise<{ ok: boolean; message?: string }> {
    if (job.repo_id !== repo.id) return { ok: false, message: '任务不属于这个仓库。' }
    if (job.pr_url === null) return { ok: false, message: '这个任务没有 PR。' }
    return this.tryMerge(job, job.pr_url, true)
  }

  private async resolveHeadSha(repo: RepoRow, prUrl: string): Promise<string | undefined> {
    // Same single definition as the merge path: a URL that is not this
    // repository's own pull request never causes a GitHub call.
    const parsed = parsePrUrl(repo, prUrl, this.config.github.apiBase)
    if (!parsed.ok) {
      log.warn('ignoring follow-up PR URL', { repo: repo.id, reason: parsed.reason })
      return undefined
    }
    try {
      const token = await repoGithubToken(repo, this.config, this.githubApp, this.store)
      const client = new GithubClient(token, this.config.github.apiBase)
      const pr = await client.getPullRequest(parsed.ref.owner, parsed.ref.name, parsed.ref.number)
      return pr.headSha
    } catch (error) {
      log.warn('could not resolve PR head', { repo: repo.id, prUrl, error: String(error) })
      return undefined
    }
  }


  // #359: a plan nobody approves must not hold the repository forever. The pass
  // is deliberately narrow: it reuses the terminal `closed` state and records the
  // reason on the work item, so WORK_ITEM_STATES and WORK_ITEM_TRANSITIONS stay
  // untouched and `closed -> triaged` remains the reopening path. One reminder
  // before the deadline, one expiry after it, each guarded by a settings key so a
  // second tick is a no-op.
  async expirePlans(): Promise<number> {
    const nowMs = Date.now()
    const expiryMs = this.config.plan.expiryDays * 86_400_000
    const reminderMs = Math.max(0, expiryMs - this.config.plan.reminderDays * 86_400_000)
    // Read once, from the earlier of the two thresholds: the pass then decides
    // per row whether it is a reminder or an expiry.
    const rows = this.store.unapprovedPlanJobs(new Date(nowMs - Math.min(expiryMs, reminderMs)).toISOString())
    let expired = 0
    for (const job of rows) {
      const finished = job.finished_at === null ? Number.NaN : Date.parse(job.finished_at)
      if (!Number.isFinite(finished)) continue
      const age = nowMs - finished
      if (age < reminderMs) continue
      const repo = this.store.getRepo(job.repo_id)
      const label = repo === undefined ? job.repo_id : `${repo.owner}/${repo.name}`
      const deadline = new Date(finished + expiryMs).toISOString().slice(0, 10)
      if (age < expiryMs) {
        const key = `plan_reminded:${job.id}`.slice(0, 300)
        if (this.store.getSetting(key) !== undefined) continue
        this.store.setSetting(key, nowIso())
        this.notifyPlan(job, `计划 ${job.id}（${label}）将在 ${deadline} 过期：请批准、拒绝或重新创建计划。`, 'plan.reminder')
        continue
      }
      const key = `plan_expired:${job.id}`.slice(0, 300)
      if (this.store.getSetting(key) !== undefined) continue
      this.store.setSetting(key, nowIso())
      const item = job.work_item_id === null ? undefined : this.store.getWorkItem(job.work_item_id)
      // `merged` and `closed` are terminal: an item that already ended is not
      // reopened by an expiry, it is only recorded. Nothing is notified for it
      // either — the pass did not end that item, so "已过期关闭" would name a close
      // it never performed (#408).
      const terminal = item !== undefined && (item.state === 'merged' || item.state === 'closed')
      if (item !== undefined && !terminal) {
        this.store.updateWorkItem(item.id, { state: 'closed', closed_reason: 'plan_expired' })
      }
      this.store.audit(job.user_id, 'job.plan_expired', `${job.id}: ${label} unapproved for ${this.config.plan.expiryDays} days${item === undefined ? '' : ` item=${item.id}`}`)
      if (!terminal) this.notifyPlan(job, `计划 ${job.id}（${label}）在 ${deadline} 前未获批准，已过期关闭；重新创建计划可以继续。`, 'plan.expired')
      expired += 1
    }
    return expired
  }

  // One reminder and one expiry each write exactly one notification and one
  // webhook call; the settings keys above are what make the pass idempotent.
  private notifyPlan(job: JobRow, message: string, code: string): void {
    this.store.notify(job.user_id, 'job', message, code)
    void sendNotificationWebhook(this.config, code, { text: message, repoId: job.repo_id, jobId: job.id })
  }

  private async releaseAllPendingFollowups(): Promise<void> {
    const repoIds = new Set<string>()
    for (const row of this.store.listSettings('pending_followup:')) {
      const repoId = row.key.split(':')[1]
      if (repoId !== undefined && repoId !== '') repoIds.add(repoId)
    }
    for (const repoId of repoIds) await this.releasePendingFollowups(repoId)
  }

  private async releasePendingFollowups(repoId: string): Promise<void> {
    if (this.followUpLocks.has(repoId)) return
    this.followUpLocks.add(repoId)
    try {
      await this.releasePendingFollowupsLocked(repoId)
    } finally {
      this.followUpLocks.delete(repoId)
    }
  }

  private async releasePendingFollowupsLocked(repoId: string): Promise<void> {
    const prefix = `pending_followup:${repoId}:`
    for (const row of this.store.listSettings(prefix)) {
      this.store.deleteSetting(row.key)
      let input: { prUrl: string; branch: string; baseBranch?: string; reason: string; headSha: string; instruction?: string }
      try {
        input = JSON.parse(row.value) as typeof input
      } catch {
        continue
      }
      const repo = this.store.getRepo(repoId)
      if (repo === undefined) continue
      const result = await this.followUp(repo, input)
      if (!result.ok && result.code === 'JOB_ACTIVE') this.store.setSetting(row.key, row.value)
      if (!result.ok) log.warn('pending follow-up not queued', { repo: repoId, code: result.code, error: result.error })
      else log.info('pending follow-up queued', { repo: repoId, trace: result.job?.id })
    }
  }

  private async autoQueueNextStage(jobId: string): Promise<void> {
    const job = this.store.getJob(jobId)
    if (job === undefined || job.pr_url === null) return
    const repo = this.store.getRepo(job.repo_id)
    if (repo === undefined) return
    if (job.kind === 'iterate' && repo.stage_mode !== 'off') {
      let testSession = ''
      try {
        testSession = this.instances?.bridgeFor(repo.id).team.test ?? ''
      } catch {
        testSession = ''
      }
      if (testSession !== '') {
        const result = await this.enqueue(repo, 'schedule', `Verify PR ${job.pr_url} (branch ${job.branch ?? 'unknown'}) with the Test role.`, 'verify', {
          ...(job.branch === null ? {} : { branch: job.branch }),
          prUrl: job.pr_url,
          ...(job.work_item_id === null ? {} : { workItemId: job.work_item_id }),
        })
        if (result.ok) {
          this.store.audit(job.user_id, 'verify.auto_queued', `${job.id} -> ${result.job?.id ?? ''}`)
          return
        }
      }
    }
    if (job.kind === 'iterate' || job.kind === 'verify') await this.autoQueueReview(jobId)
  }

  private async autoQueueReview(jobId: string): Promise<void> {
    const job = this.store.getJob(jobId)
    if (job === undefined || job.kind !== 'iterate' || job.pr_url === null) return
    const repo = this.store.getRepo(job.repo_id)
    if (repo === undefined || repo.reviewer_enabled !== 1 || repo.can_review !== 1) return
    if (this.store.activeJobForRepo(repo.id) !== undefined) return
    const result = await this.enqueue(repo, 'schedule', undefined, 'review', job.work_item_id === null ? {} : { workItemId: job.work_item_id })
    if (result.ok) this.store.audit(job.user_id, 'review.auto_queued', `${job.id} -> ${result.job?.id ?? ''}`)
  }

  private async afterSucceeded(job: JobRow, prUrl: string | undefined, issueUrl: string | undefined, claimed: Attribution | null): Promise<void> {
    const observed = await this.captureTeamStats(job.id, claimed).catch(() => null)
    await this.postAutomationComment(job, { prUrl, issueUrl }, observed ?? claimed)
  }

  private async captureTeamStats(jobId: string, claimed: Attribution | null = null): Promise<Attribution | null> {
    if (this.instances === undefined || this.config.flybot.instanceImage === '') return null
    const job = this.store.getJob(jobId)
    if (job === undefined) return null
    try {
      const state = await this.instances.teamState(job.repo_id, 20_000)
      const stats = state.bots.map((bot) => ({
        role: bot.role,
        label: bot.label,
        calls: bot.calls,
        activity: bot.activity,
        tool: bot.tool,
        step: bot.step,
        lastActivityAt: bot.lastActivityAt,
      }))
      const observed = observedAttribution(stats)
      this.store.updateJob(jobId, { team_stats_json: JSON.stringify(stats), ...(observed === null ? {} : { attribution_json: JSON.stringify(observed) }) })
      this.store.event('team_stats', { userId: job.user_id, repoId: job.repo_id, jobId })
      for (const entry of stats.filter((stat) => stat.calls > 0)) {
        this.store.recordJobEvent({
          jobId,
          repoId: job.repo_id,
          userId: job.user_id,
          kind: 'team.role',
          role: entry.role,
          step: entry.step,
          meta: JSON.stringify({ calls: entry.calls, tool: entry.tool, activity: entry.activity, label: entry.label, lastActivityAt: entry.lastActivityAt }),
        })
      }
      if (observed !== null && claimed !== null) {
        this.store.event('team_attribution_grounded', { userId: job.user_id, repoId: job.repo_id, jobId, meta: `claimed=${Object.values(claimed).join(',')};observed=${Object.values(observed).join(',')}`.slice(0, 500) })
      }
      if (job.kind === 'iterate') {
        const active = stats.filter((entry) => entry.calls > 0).map((entry) => entry.role)
        if (active.length === 1 && active[0] === 'lead') {
          const repo = this.store.getRepo(job.repo_id)
          const label = repo === undefined ? job.repo_id : `${repo.upstream_owner || repo.owner}/${repo.upstream_name || repo.name}`
          this.store.notify(job.user_id, 'team', `${label} 的本次任务只有 Lead 参与，其他团队角色没有实际介入。`)
          this.store.event('team_participation_low', { userId: job.user_id, repoId: job.repo_id, jobId, meta: 'lead-only' })
          log.warn('team participation low', { trace: jobId, repo: job.repo_id, roles: active })
        }
      }
      return observed
    } catch (error) {
      log.warn('team stats capture failed', { trace: jobId, error: String(error) })
      return null
    }
  }

  // #357: the per-job budget used to be an after-the-spend alert. With `pause`
  // or `cancel` it stops the job here, at the checkpoint that first sees a
  // recorded cost, and the terminal callback that follows cannot revive it
  // because a paused or cancelled job answers terminal reports with a 409.
  private async enforceJobBudget(job: JobRow, repo: RepoRow | undefined): Promise<void> {
    if (repo === undefined || repo.job_budget_cny <= 0) return
    const action = repo.job_budget_action
    if (action !== 'pause' && action !== 'cancel') return
    // No ledger row is an unknown cost, not a zero one: a provider error
    // deducts nothing, and reading that as "fits the budget" would be a lie.
    if (this.store.usageCountForJob(job.id) === 0) {
      const key = `job_budget_unknown:${job.id}`
      if (this.store.getSetting(key) === undefined) {
        this.store.setSetting(key, nowIso())
        this.store.audit(job.user_id, 'job.budget_unknown', `${job.id}: no recorded cost at this checkpoint`)
        this.store.recordJobEvent({ jobId: job.id, repoId: job.repo_id, userId: job.user_id, kind: 'job.budget_unknown', step: job.kind, meta: 'no cost row yet' })
      }
      return
    }
    const costCny = this.store.usageForJob(job.id) * this.config.quota.usdCny
    if (!(costCny > repo.job_budget_cny)) return
    const cancel = action === 'cancel'
    const code = cancel ? 'JOB_BUDGET_CANCELLED' : 'JOB_BUDGET_PAUSED'
    const reason = `${code}: 单任务成本 ${costCny.toFixed(2)} 元已超过预算 ${repo.job_budget_cny.toFixed(2)} 元。${cancel ? '提高单任务预算后重新开始任务。' : '提高单任务预算后从断点恢复，或重新开始任务。'}`
    this.store.audit(job.user_id, cancel ? 'job.budget_cancelled' : 'job.budget_paused', `${job.id}: ${costCny.toFixed(4)} > ${repo.job_budget_cny}`)
    this.store.notify(job.user_id, 'quota', `任务 ${job.id} 因单任务预算${cancel ? '取消' : '暂停'}：已用 ${costCny.toFixed(2)} 元，预算 ${repo.job_budget_cny.toFixed(2)} 元。提高预算或重新开始任务。`, code)
    if (cancel) await this.cancelJob(job.id, reason)
    else await this.pauseJob(job.id, reason)
  }

  private async sendJobEmail(job: JobRow, result: { status: 'succeeded' | 'failed' | 'quota_exhausted'; prUrl?: string | null; issueUrl?: string | null; reviewScore?: number; summary?: string; error?: string }, options: { retryPending?: boolean } = {}): Promise<void> {
    if (result.status === 'quota_exhausted') return
    const user = this.store.userById(job.user_id)
    if (user === undefined || user.email_job_updates !== 1) return
    const email = notifyEmail(user)
    if (email === '') return
    const repo = this.store.getRepo(job.repo_id)
    if (repo === undefined) return
    // #353: the per-job mail used to be unconditional, which is what flooded the
    // inbox. The rule lives in `lib/emailPolicy.ts`; the store owns the window.
    const windowKey = `job_email_last_failure:${repo.id}`.slice(0, 300)
    const storedWindow = this.store.getSetting(windowKey)
    const storedAt = storedWindow === undefined ? Number.NaN : Date.parse(storedWindow)
    const decision = jobEmailDecision({
      status: result.status,
      trigger: job.trigger,
      ownerStarted: job.owner_started === 1,
      retryPending: options.retryPending === true,
      successEmailEnabled: user.email_job_success === 1,
      lastFailureMailAtMs: Number.isFinite(storedAt) ? storedAt : null,
      nowMs: Date.now(),
      cooldownMinutes: this.config.mail.jobEmailCooldownMinutes,
    })
    // A success closes the window even when it sends nothing: the repository is
    // healthy again, so the next failure is news rather than the same incident.
    if (decision.clearWindow && storedWindow !== undefined) this.store.deleteSetting(windowKey)
    if (!decision.send) return
    const context = {
      repo: `${repo.upstream_owner || repo.owner}/${repo.upstream_name || repo.name}`,
      jobId: job.id,
      kind: job.kind,
      teamUrl: `${this.config.baseUrl}/repos/${repo.id}/jobs/${job.id}`,
      issueUrl: result.issueUrl === undefined ? job.issue_url : result.issueUrl,
      prUrl: result.prUrl === undefined ? job.pr_url : result.prUrl,
      summary: redact(result.summary ?? job.summary ?? ''),
      error: redact(result.error ?? job.error ?? ''),
      reviewScore: result.reviewScore ?? job.review_score,
    }
    try {
      const template = decision.template === 'success' ? jobSucceededEmail(user, context) : jobFailedEmail(user, context)
      await this.mailer.send({ to: email, ...template })
      // Only a failure opens the window; the success path already cleared it.
      if (decision.template === 'failure') this.store.setSetting(windowKey, nowIso())
    } catch (error) {
      log.warn('job email failed', { trace: job.id, error: String(error) })
    }
  }

  async followUp(repo: RepoRow, input: { prUrl: string; branch: string; baseBranch?: string; reason: string; headSha: string; instruction?: string }): Promise<EnqueueResult> {
    const baseBranch = input.baseBranch ?? (repo.target_branch !== '' ? repo.target_branch : (repo.upstream_default_branch || repo.default_branch))
    if (!isValidBranchName(input.branch) || input.branch === baseBranch || input.branch === repo.upstream_default_branch || input.branch === repo.default_branch) {
      return { ok: false, error: 'follow-up 分支不能是目标分支。', code: 'BRANCH_INVALID' }
    }
    // The fingerprint sits near the prefix so the 300-char bound can never
    // truncate it away: a truncated key would merge two requests again.
    const fingerprint = followUpFingerprint(input.reason, input.instruction)
    const key = `followup:${repo.id}:${fingerprint}:${input.prUrl}:${input.headSha}`.slice(0, 300)
    if (this.store.getSetting(key) !== undefined) return { ok: false, error: '这个失败已经跟进过', code: 'DUPLICATE_FOLLOWUP' }
    const activeJob = this.store.activeJobForRepo(repo.id)
    if (activeJob !== undefined) {
      if (activeJob.kind === 'review') {
        const pendingKey = `pending_followup:${repo.id}:${fingerprint}:${input.prUrl}:${input.headSha}`.slice(0, 300)
        this.store.setSetting(pendingKey, JSON.stringify(input))
        return { ok: false, error: '审核结束后会自动跟进', code: 'JOB_ACTIVE' }
      }
      return { ok: false, error: '这个仓库已有任务在运行', code: 'JOB_ACTIVE' }
    }
    this.store.setSetting(key, nowIso())
    // #251: one block, and none at all when the review carried no body, so a
    // review without a comment produces exactly the goal it produced before.
    const instruction = reviewInstructionLine(input.instruction)
    const goal = [
      `Follow-up on the existing pull request ${input.prUrl} (branch ${input.branch}).`,
      `Reason: ${input.reason}.`,
      ...(instruction === '' ? [] : [instruction]),
      'Continue on the same branch and update the existing PR. Do not open a second PR or create a new issue.',
      'Make the smallest correct fix, add or adjust tests, run the relevant checks, and callback with the branch and PR URL.',
    ].join('\n')
    const result = await this.enqueue(repo, 'followup', goal, 'iterate', { branch: input.branch, prUrl: input.prUrl, baseBranch: input.baseBranch })
    if (!result.ok) this.store.deleteSetting(key)
    return result
  }

  async notifyOpsAlerts(): Promise<number> {
    const alerts = this.store.alerts({ usdCny: this.config.quota.usdCny })
    const current = new Set<string>()
    let sent = 0
    for (const alert of alerts) {
      const key = `ops_alert_notified:${alert.kind}:${alert.repoId ?? ''}:${alert.jobId ?? ''}:${alert.prUrl ?? ''}`.slice(0, 300)
      current.add(key)
      const repo = alert.repoId === undefined ? undefined : this.store.getRepo(alert.repoId)
      const user = repo === undefined ? undefined : this.store.userById(repo.user_id)
      if (user === undefined || user.status !== 'approved') continue
      const previous = this.store.getSetting(key)
      const previousAt = previous === undefined ? 0 : Date.parse(previous)
      if (Number.isFinite(previousAt) && Date.now() - previousAt < this.config.ops.alertCooldownMinutes * 60_000) continue
      this.store.notify(user.id, 'ops', alert.message)
      this.store.event('ops_alert_notified', { userId: user.id, repoId: alert.repoId ?? null, jobId: alert.jobId ?? null, meta: `${alert.kind}:${alert.level}` })
      this.store.setSetting(key, nowIso())
      sent += 1
      void sendNotificationWebhook(this.config, 'ops.alert', {
        text: alert.message,
        kind: alert.kind,
        level: alert.level,
        repoId: alert.repoId ?? null,
        jobId: alert.jobId ?? null,
        prUrl: alert.prUrl ?? null,
      })
    }
    for (const row of this.store.listSettings('ops_alert_notified:')) {
      if (!current.has(row.key)) this.store.deleteSetting(row.key)
    }
    setGauge('fledge_ops_alerts_open', alerts.length, {}, 'Open operational alerts')
    return sent
  }

  private async notifyQuestions(): Promise<void> {
    if (this.instances === undefined || this.config.flybot.instanceImage === '' || this.questionBusy) return
    this.questionBusy = true
    try {
      for (const job of this.store.listActiveJobs()) {
        const repo = this.store.getRepo(job.repo_id)
        if (repo === undefined) continue
        const user = this.store.userById(job.user_id)
        if (user === undefined || user.status !== 'approved') continue
        let state
        try {
          state = await this.instances.teamState(repo.id, 10_000)
        } catch {
          continue
        }
        for (const question of state.questions) {
          if (question.id === '' || question.question === '') continue
          const key = `question_notified:${question.sessionId}:${question.id}`
          if (this.store.getSetting(key) !== undefined) continue
          this.store.setSetting(key, nowIso())
          this.store.notify(user.id, 'job', `${repo.owner}/${repo.name} 团队提问：${question.question}`)
          void sendNotificationWebhook(this.config, 'question', {
            text: `${repo.owner}/${repo.name}: ${question.question}`,
            repoId: repo.id,
            jobId: job.id,
            question: question.question,
            detail: question.detail,
            options: question.options,
          })
          if (user.email_job_updates !== 1) continue
          const email = notifyEmail(user)
          if (email === '') continue
          try {
            await this.mailer.send({
              to: email,
              ...jobAttentionEmail(user, {
                repo: `${repo.upstream_owner || repo.owner}/${repo.upstream_name || repo.name}`,
                question: question.question,
                detail: question.detail,
                options: question.options,
                teamUrl: `${this.config.baseUrl}/repos/${repo.id}#inbox`,
              }),
            })
          } catch (error) {
            log.warn('question email failed', { trace: job.id, error: String(error) })
          }
        }
      }
    } finally {
      this.questionBusy = false
    }
  }


  private digestClock(): { date: string; hour: number } {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.config.digest.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date())
    const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? ''
    return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) }
  }

  private digestTime(value: Date): string {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: this.config.digest.timeZone,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(value)
  }

  private async buildDigest(user: UserRow, repos: RepoRow[], date: string): Promise<DigestInput> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString()
    const jobs = this.store.listJobsSince(user.id, since)
    const quota = quotaView(user, this.config)
    const nextRuns: Array<{ repo: string; when: string }> = []
    const questions: Array<{ repo: string; question: string }> = []
    const teamLinks: Array<{ repo: string; url: string }> = []
    for (const repo of repos) {
      const label = `${repo.upstream_owner || repo.owner}/${repo.upstream_name || repo.name}`
      teamLinks.push({ repo: label, url: `${this.config.baseUrl}/repos/${repo.id}#inbox` })
      if (repo.auto_iterate === 1) {
        const last = repo.last_run_at === null ? Number.NaN : Date.parse(repo.last_run_at)
        const next = Number.isFinite(last) ? new Date(last + Math.min(repo.interval_minutes, this.config.runner.workCooldownMinutes) * 60_000) : new Date()
        nextRuns.push({ repo: label, when: next.getTime() <= Date.now() ? '等待调度' : this.digestTime(next) })
      }
      if (this.instances === undefined || this.config.flybot.instanceImage === '') continue
      try {
        const state = await this.instances.teamState(repo.id, 15_000)
        for (const question of state.questions) {
          if (question.question !== '') questions.push({ repo: label, question: question.question })
        }
      } catch {
        // Instance may be stopped; the digest still reports the rest.
      }
    }
    return {
      date,
      jobs: jobs.map((job) => {
        const repo = repos.find((entry) => entry.id === job.repo_id)
        return {
          repo: repo === undefined ? job.repo_id : `${repo.upstream_owner || repo.owner}/${repo.upstream_name || repo.name}`,
          kind: job.kind,
          status: job.status,
          summary: job.summary ?? job.error ?? '',
          prUrl: job.pr_url,
          issueUrl: job.issue_url,
          reviewScore: job.review_score,
          costUsd: job.cost_usd,
        }
      }),
      usedCny: this.store.usageSince(user.id, since) * this.config.quota.usdCny,
      unlimited: quota.unlimited,
      remainingCny: quota.remainingCny,
      nextRuns,
      questions,
      teamLinks,
    }
  }

  private async maybeSendDigests(): Promise<void> {
    const clock = this.digestClock()
    if (clock.hour < this.config.digest.hour) return
    for (const user of this.store.listUsers('approved')) {
      if (user.email_daily_digest !== 1) continue
      const email = notifyEmail(user)
      if (email === '') continue
      const repos = this.store.listRepos(user.id)
      if (repos.length === 0) continue
      const key = `digest_sent:${user.id}:${clock.date}`
      if (this.store.getSetting(key) !== undefined) continue
      this.store.setSetting(key, nowIso())
      let replyKey: string | undefined
      try {
        const digest = await this.buildDigest(user, repos, clock.date)
        let replyAddress: string | undefined
        if (this.config.inboundEmailSecret !== '') {
          const token = randomToken(16)
          replyKey = `email_reply:${token}`
          this.store.setSetting(replyKey, `${user.id}:${repos[0]!.id}:${Date.now()}`)
          replyAddress = replyAddressFor(this.config.mail.from, token)
          digest.replyAddress = replyAddress
        }
        await this.mailer.send({ to: email, ...dailyDigestEmail(user, digest), ...(replyAddress === undefined ? {} : { replyTo: replyAddress }) })
        log.info('daily digest sent', { user: user.login, date: clock.date })
      } catch (error) {
        this.store.deleteSetting(key)
        if (replyKey !== undefined) this.store.deleteSetting(replyKey)
        log.warn('daily digest failed', { user: user.login, error: String(error) })
      }
    }
  }

  private async postAutomationComment(job: JobRow, result: { prUrl?: string; issueUrl?: string }, attribution: Attribution | null): Promise<void> {
    if (job.kind === 'review' || job.trigger === 'followup' || result.prUrl === undefined) return
    const match = /\/pull\/(\d+)(?:[/?#]|$)/.exec(result.prUrl)
    if (match === null) return
    const repo = this.store.getRepo(job.repo_id)
    if (repo === undefined) return
    const instance = this.store.getRepoInstance(job.repo_id)
    const team = instance === undefined ? null : parseTeam(instance.team_json)?.team
    const owner = repo.upstream_owner || repo.owner
    const name = repo.upstream_name || repo.name
    const number = Number(match[1])
    const teamLabel = team ?? `${owner}/${name}`
    const journey = attributionSentence(attribution)
    // #390: the registry decides whether this work type may merge; the repo's
    // auto-merge setting is permission, not eligibility.
    const autoMergeEnabled = repo.repo_role === 'maintainer' && repo.auto_merge === 1 && job.kind === 'iterate' && workTypeMayAutoMerge(job.work_type)
    // #358: a fallback means the repository's primary did not answer, so the pull
    // request names the model that produced the work instead of implying the
    // configured default did.
    const modelRun = parseModelRun(job.model_json)
    const modelLine = modelRun === null || modelRun.model === null
      ? []
      : [`- Model: ${modelRun.model.label}${modelRun.attempts.length === 0 ? '' : ` (tried ${modelRun.attempts.map((entry) => `${entry.label} ${entry.status}`).join(', ')})`}`]
    const providerParts = [job.provider_label, job.provider_region, job.provider_model]
      .filter((part): part is string => part !== null && part !== '')
      .map((part) => part.replace(/[\r\n]+/g, ' ').slice(0, 120))
    const providerLine = providerParts.length === 0 ? [] : [`- Provider: ${providerParts.join(' · ')}`]
    const body = [
      '<details>',
      `<summary>Fledge automation · ${teamLabel} · job <code>${job.id}</code> (${job.trigger}, ${job.kind})</summary>`,
      '',
      journey === '' ? `Produced by the ${teamLabel} team.` : `Automated run: ${journey}.`,
      '',
      autoMergeEnabled ? 'The maintainer enabled auto-merge for this repository; Fledge may merge only after checks pass and no changes are requested.' : 'Fledge does not merge by default; a human must review and merge.',
      '',
      `- Issue: ${result.issueUrl ?? 'none'}`,
      ...modelLine,
      ...providerLine,
      `- Fledge job: ${this.config.baseUrl}/repos/${job.repo_id}/jobs/${job.id}`,
      '</details>',
    ]
    try {
      const token = await repoGithubToken(repo, this.config, this.githubApp, this.store)
      const client = new GithubClient(token, this.config.github.apiBase)
      await client.comment(owner, name, number, body.join('\n'))
      log.info('automation comment posted', { trace: job.id, pr: number })
    } catch (error) {
      log.warn('automation comment failed', { trace: job.id, pr: number, error: String(error) })
    }
  }

  async handleCallback(jobId: string, secret: string, payload: CallbackPayload): Promise<{ ok: boolean; status?: number; error?: string; duplicate?: boolean }> {
    const job = this.store.getJob(jobId)
    if (job === undefined) return { ok: false, status: 404, error: 'job not found' }
    if (!safeEqual(sha256Hex(secret), job.callback_hash)) return { ok: false, status: 401, error: 'bad callback secret' }
    // Serialised per job inside this process; the guarded terminal transition in
    // applyCallback covers a second process.
    return this.withJobLock(jobId, () => this.applyCallback(jobId, payload))
  }

  private async applyCallback(jobId: string, payload: CallbackPayload): Promise<{ ok: boolean; status?: number; error?: string; duplicate?: boolean }> {
    const job = this.store.getJob(jobId)
    if (job === undefined) return { ok: false, status: 404, error: 'job not found' }
    const status = payload.status
    if (status !== 'succeeded' && status !== 'failed' && status !== 'running') return { ok: false, status: 400, error: 'invalid status' }
    const repoRow = this.store.getRepo(job.repo_id)
    // A callback link is stored only when it belongs to this job's repository.
    // prOrigin() derives that origin from the row (recorded html_url first, else
    // the configured API base), so no host is written down here. An absent field
    // leaves the column alone; a present value that cannot be placed is null.
    const repoLink = (value: unknown, kind: 'pull' | 'issues'): string | null | undefined => {
      if (typeof value !== 'string') return undefined
      // The callback contract is https-only, and a value longer than the column
      // bound cannot be stored intact.
      if (repoRow === undefined || value.length > 500 || !value.startsWith('https://')) return null
      const parsed = kind === 'pull'
        ? parsePrUrl(repoRow, value, this.config.github.apiBase)
        : parseIssueUrl(repoRow, value, this.config.github.apiBase)
      return parsed.ok ? value : null
    }
    const branch = typeof payload.branch === 'string' ? payload.branch.slice(0, 300) : undefined
    const prUrl = repoLink(payload.prUrl, 'pull')
    const issueUrl = repoLink(payload.issueUrl, 'issues')
    const reviewScore = typeof payload.reviewScore === 'number' && Number.isFinite(payload.reviewScore) ? Math.max(0, Math.min(100, Math.round(payload.reviewScore))) : undefined
    const summary = progressSummary(payload.summary)
    const error = typeof payload.error === 'string' ? redact(payload.error).slice(0, 2000) : undefined
    const attribution = parseAttribution(payload.attribution)
    const evidence = parseEvidence(payload.evidence)
    const checkpoint = typeof payload.checkpoint === 'string' ? redact(payload.checkpoint.trim()).slice(0, 4000) : undefined
    if (branch !== undefined && (!isValidBranchName(branch) || branch === job.base_branch)) {
      return { ok: false, status: 400, error: 'invalid branch' }
    }
    const followUps: ReviewFollowUp[] = job.kind === 'review' && Array.isArray(payload.followUps)
      ? payload.followUps.flatMap((entry) => {
          if (entry === null || typeof entry !== 'object') return []
          const value = entry as Record<string, unknown>
          const prUrl = repoLink(value.prUrl, 'pull')
          const branch = typeof value.branch === 'string' ? value.branch.trim().slice(0, 300) : ''
          if (prUrl === null || prUrl === undefined || branch === '') return []
          return [{
            prUrl,
            branch,
            ...(typeof value.baseBranch === 'string' ? { baseBranch: value.baseBranch.slice(0, 300) } : {}),
            ...(typeof value.headSha === 'string' ? { headSha: value.headSha.slice(0, 100) } : {}),
            ...(typeof value.reason === 'string' ? { reason: value.reason.slice(0, 300) } : {}),
          }]
        }).slice(0, 10)
      : []
    const fingerprint = terminalFingerprint({ status, branch, prUrl, issueUrl, reviewScore, evidence, attribution, followUps })
    // A finished job answers a replay with the same fingerprint as a no-op and
    // any other terminal report as a conflict; see docs/decisions/0004.
    if (job.status !== 'queued' && job.status !== 'running') {
      if (job.callback_fingerprint !== null && job.callback_fingerprint === fingerprint) return { ok: true, duplicate: true }
      return { ok: false, status: 409, error: 'job already finished' }
    }
    // A terminal report after the hard timeout cannot finalise the job; the reaper
    // owns that decision, so a late success does not rewrite a timed-out run.
    if (status !== 'running' && this.pastHardTimeout(job)) return { ok: false, status: 409, error: 'job timed out' }
    // A queued job has no dispatched worker yet, so a heartbeat may not promote it.
    if (status === 'running' && job.status !== 'running') return { ok: false, status: 409, error: 'job not dispatched' }
    const revoke = (): void => {
      const row = this.store.findApiToken(job.platform_token_hash ?? '')
      if (row !== undefined) this.store.revokeApiToken(row.id, row.user_id)
    }
    // #513: discovery is issue-only. The prompt says so, but the callback is the
    // boundary that actually protects the repository from a timer-produced PR.
    if (job.kind === 'discover' && (branch !== undefined || (prUrl !== undefined && prUrl !== null))) {
      const message = 'DISCOVERY_PR_FORBIDDEN: discovery may create one issue, not a branch or PR.'
      this.store.audit(job.user_id, 'job.discovery_pr_forbidden', `${jobId}: branch=${branch ?? '-'} pr=${prUrl ?? '-'}`)
      if (status === 'running') return { ok: false, status: 400, error: message }
      this.finish(jobId, { status: 'failed', error: message, issueUrl }, revoke, attribution, evidence, fingerprint)
      return { ok: false, status: 422, error: message }
    }
    // #390: triage is the work type that may not touch the repository. The prompt
    // says so; this is the boundary that enforces it.
    if (job.kind === 'triage' && (branch !== undefined || (prUrl !== undefined && prUrl !== null))) {
      const message = 'TRIAGE_PR_FORBIDDEN: triage may not create a branch, a pull request or a merge.'
      this.store.audit(job.user_id, 'job.triage_pr_forbidden', `${jobId}: branch=${branch ?? '-'} pr=${prUrl ?? '-'}`)
      if (status === 'running') return { ok: false, status: 400, error: message }
      this.finish(jobId, { status: 'failed', error: message, issueUrl }, revoke, attribution, evidence, fingerprint)
      return { ok: false, status: 422, error: message }
    }
    // #390: the triage report is the job's whole output, so a success without one
    // is not a success. It is checked before the generic evidence gate because a
    // prose summary is exactly what this replaces.
    const triage = job.kind === 'triage' ? parseTriage(payload.triage) : null
    if (job.kind === 'triage' && status === 'succeeded' && triage === null) {
      const message = 'TRIAGE_UNVERIFIED: the triage report is missing or malformed.'
      this.store.event('job_triage_unverified', { userId: job.user_id, repoId: job.repo_id, jobId })
      this.store.audit(job.user_id, 'job.triage_unverified', jobId)
      this.finish(jobId, { status: 'failed', error: message, errorCode: 'TRIAGE_UNVERIFIED' }, revoke, attribution, evidence, fingerprint)
      return { ok: false, status: 422, error: message }
    }
    // #390 review: the board is rendered as live links on the job page, so every
    // link in it has to name an issue of this repository. `parseTriage` can only
    // check the scheme; the repository's own parser is what knows the origin, and
    // a board that points a reader at any host is a phishing surface, not a report.
    const triageLinks = triage === null ? [] : [...triage.items.map((item) => item.url), ...(triage.next === null ? [] : [triage.next.url])]
    if (job.kind === 'triage' && status === 'succeeded' && triageLinks.some((url) => repoLink(url, 'issues') === null)) {
      const message = 'TRIAGE_UNVERIFIED: the triage board links an issue that is not in this repository.'
      this.store.event('job_triage_unverified', { userId: job.user_id, repoId: job.repo_id, jobId })
      this.store.audit(job.user_id, 'job.triage_unverified', `${jobId}: foreign link`)
      this.finish(jobId, { status: 'failed', error: message, errorCode: 'TRIAGE_UNVERIFIED' }, revoke, attribution, evidence, fingerprint)
      return { ok: false, status: 422, error: message }
    }
    // Only a callback that will be acted on may refresh the stall window.
    this.store.touchJobCallback(jobId)
    if (status === 'running') {
      this.store.updateJob(jobId, {
        status: 'running',
        started_at: job.started_at ?? nowIso(),
        ...(branch === undefined ? {} : { branch }),
        ...(prUrl === undefined ? {} : { pr_url: prUrl }),
        ...(issueUrl === undefined ? {} : { issue_url: issueUrl }),
        ...(reviewScore === undefined ? {} : { review_score: reviewScore }),
        ...(summary === undefined ? {} : { summary }),
        ...(attribution === null ? {} : { attribution_json: JSON.stringify(attribution) }),
        ...(evidence === null ? {} : { evidence_json: JSON.stringify(evidence) }),
        ...(checkpoint === undefined ? {} : { checkpoint }),
      })
      this.store.recordJobEvent({
        jobId,
        repoId: job.repo_id,
        userId: job.user_id,
        kind: 'job.progress',
        step: job.kind,
        ...(summary === undefined ? {} : { meta: summary }),
      })
      // #357: a checkpoint is the earliest place a recorded cost exists without
      // a second model call, so it is where a pause/cancel budget acts.
      await this.enforceJobBudget(job, repoRow)
      return { ok: true }
    }
    if (status === 'succeeded') {
      const stageMode = parseStageMode(repoRow?.stage_mode) ?? 'off'
      const stage = checkStage(stageMode, job.kind, evidence, attribution, reviewScore)
      if (!stage.ok) {
        const detail = stage.errors.join('；')
        const meta = `stage:${stageMode}:${stage.errors.join('|')}`.slice(0, 500)
        this.store.event('stage_evidence_missing', { userId: job.user_id, repoId: job.repo_id, jobId, meta })
        this.store.recordJobEvent({ jobId, repoId: job.repo_id, userId: job.user_id, kind: 'stage.missing', step: job.kind, meta })
        this.store.audit(job.user_id, stageMode === 'enforced' ? 'job.stage_missing' : 'job.stage_missing_shadow', `${jobId}: ${detail}`.slice(0, 600))
        if (stageMode === 'enforced') {
          const message = `STAGE_EVIDENCE_MISSING: ${detail}`
          this.store.notify(job.user_id, 'job', `${job.kind} 任务 ${jobId} 缺少阶段证据：${detail}`)
          this.finish(jobId, { status: 'failed', branch, prUrl, issueUrl, summary, error: message, errorCode: 'STAGE_EVIDENCE_MISSING' }, revoke, attribution, evidence, fingerprint)
          return { ok: false, status: 422, error: message }
        }
      }
      // #390: a typed work type fails closed when its own evidence is absent. The
      // iterate type keeps the stage gate above as its rule, so this second gate
      // only covers the work types that declare a different contract; it is not a
      // second opinion on the same rule.
      if (job.work_type !== 'iterate') {
        const missing = missingWorkTypeEvidence(job.work_type, evidence)
        if (missing.length > 0) {
          const detail = missing.map((key) => `evidence.${key}`).join(', ')
          const message = `WORK_TYPE_UNVERIFIED: ${job.work_type} 缺少证据：${detail}`
          this.store.event('work_type_evidence_missing', { userId: job.user_id, repoId: job.repo_id, jobId, meta: `${job.work_type}:${missing.join('|')}`.slice(0, 400) })
          this.store.audit(job.user_id, 'job.work_type_unverified', `${jobId}: ${job.work_type} ${detail}`.slice(0, 600))
          this.finish(jobId, { status: 'failed', branch, prUrl, issueUrl, summary, error: message, errorCode: 'WORK_TYPE_UNVERIFIED' }, revoke, attribution, evidence, fingerprint)
          return { ok: false, status: 422, error: message }
        }
      }
    }
    const claimed = this.finish(jobId, { status, branch, prUrl, issueUrl, reviewScore, summary, error }, revoke, attribution, evidence, fingerprint)
    if (!claimed) {
      // Another delivery won the transition while this one was in flight.
      const latest = this.store.getJob(jobId)
      if (latest !== undefined && latest.callback_fingerprint !== null && latest.callback_fingerprint === fingerprint) return { ok: true, duplicate: true }
      return { ok: false, status: 409, error: 'job already finished' }
    }
    if (checkpoint !== undefined) this.store.updateJob(jobId, { checkpoint })
    if (status === 'succeeded' && followUps.length > 0) {
      await this.queueReviewFollowUps(job, followUps)
      await this.releasePendingFollowups(job.repo_id)
    }
    if (status === 'succeeded' && job.kind === 'triage' && triage !== null) {
      // The board is the record, and its first row is what the scheduler can pick
      // up: a work item for the proposal is the same path discovery already uses.
      this.store.updateJob(jobId, { triage_json: JSON.stringify(triage) })
      const next = triage.next
      if (next !== null) {
        const priority = triage.items.find((item) => item.issue === next.issue)?.priority ?? 0
        const existing = this.store.findWorkItemByIssueUrl(job.repo_id, next.url)
        if (existing === undefined) {
          this.store.createWorkItem({ id: randomId('work'), repoId: job.repo_id, userId: job.user_id, title: next.title, issueUrl: next.url, state: 'proposed', priority })
        } else if (existing.state !== 'closed' && existing.state !== 'merged') {
          this.store.updateWorkItem(existing.id, { priority })
        }
        this.store.audit(job.user_id, 'job.triage_proposal', `${jobId}: #${next.issue} -> work item`)
      }
    }
    if (status === 'succeeded' && job.work_item_id !== null) {
      const item = this.store.getWorkItem(job.work_item_id)
      if (item !== undefined && job.kind === 'scope') this.store.updateWorkItem(item.id, { state: 'assigned' })
      if (item !== undefined && job.kind === 'verify') this.store.updateWorkItem(item.id, { state: 'in_review' })
    }
    if (status === 'succeeded' && job.kind === 'review' && job.work_item_id !== null) {
      const item = this.store.getWorkItem(job.work_item_id)
      if (item !== undefined) {
        const outcome = followUps.length > 0 || (reviewScore !== undefined && reviewScore < 80) ? 'changes_requested' : 'approved'
        this.store.updateWorkItem(item.id, { state: outcome })
        this.store.audit(job.user_id, 'work_item.review_outcome', `${item.id}: ${outcome} score=${reviewScore ?? '-'}`)
      }
    }
    if (status === 'succeeded') await this.verifyAndMaybeMerge(jobId)
    return { ok: true }
  }

  private jobLocks = new Map<string, Promise<void>>()

  private async withJobLock<T>(jobId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.jobLocks.get(jobId) ?? Promise.resolve()
    const current = previous.then(run, run)
    const tail = current.then(() => undefined, () => undefined)
    this.jobLocks.set(jobId, tail)
    try {
      return await current
    } finally {
      if (this.jobLocks.get(jobId) === tail) this.jobLocks.delete(jobId)
    }
  }

  private pastHardTimeout(job: JobRow): boolean {
    const startedAt = Date.parse(job.started_at ?? job.created_at)
    if (!Number.isFinite(startedAt)) return false
    return startedAt + this.config.runner.timeoutMinutes * 60_000 < Date.now()
  }

  private async queueReviewFollowUps(job: JobRow, followUps: ReviewFollowUp[]): Promise<void> {
    const repo = this.store.getRepo(job.repo_id)
    if (repo === undefined) return
    let index = 0
    for (const follow of followUps) {
      const headSha = follow.headSha ?? await this.resolveHeadSha(repo, follow.prUrl) ?? job.id
      const input = {
        prUrl: follow.prUrl,
        branch: follow.branch,
        ...(follow.baseBranch === undefined ? {} : { baseBranch: follow.baseBranch }),
        reason: follow.reason ?? 'review requested changes',
        headSha,
        // #251: carried explicitly. An optional field left out of this object is
        // not a type error, it is a silent loss for every follow-up parked behind
        // a review job.
        ...(follow.instruction === undefined ? {} : { instruction: follow.instruction }),
      }
      const key = `pending_followup:${repo.id}:${job.id}:${index}`.slice(0, 300)
      this.store.setSetting(key, JSON.stringify(input))
      index += 1
    }
  }

  async credential(jobId: string, secret: string): Promise<{
    ok: boolean
    status?: number
    token?: string
    owner?: string
    name?: string
    defaultBranch?: string
    upstream?: RepoRef
    fork?: RepoRef
    isFork?: boolean
    permission?: string
    repoRole?: string | null
    autoMerge?: boolean
    canReview?: boolean
    canCreateIssue?: boolean
    error?: string
  }> {
    const job = this.store.getJob(jobId)
    if (job === undefined) return { ok: false, status: 404, error: 'job not found' }
    if (!safeEqual(sha256Hex(secret), job.callback_hash)) return { ok: false, status: 401, error: 'bad credential secret' }
    if (job.status !== 'queued' && job.status !== 'running') return { ok: false, status: 409, error: 'job already finished' }
    const repo = this.store.getRepo(job.repo_id)
    if (repo === undefined) return { ok: false, status: 404, error: 'repo not found' }
    try {
      // #390 review: the credential is what the model holds, so the read-only
      // property of triage has to be in the token, not only in the callback. A
      // triage run is refused rather than given a token that can write.
      const token = job.kind === 'triage'
        ? await triageReadOnlyToken(repo, this.githubApp)
        : await repoGithubToken(repo, this.config, this.githubApp, this.store)
      const baseBranch = job.base_branch ?? repo.upstream_default_branch ?? repo.default_branch
      const upstream: RepoRef = {
        owner: repo.upstream_owner || repo.owner,
        name: repo.upstream_name || repo.name,
        defaultBranch: baseBranch,
        htmlUrl: repo.upstream_html_url ?? `https://github.com/${repo.owner}/${repo.name}`,
      }
      const fork: RepoRef = {
        owner: repo.fork_owner || repo.owner,
        name: repo.fork_name || repo.name,
        defaultBranch: repo.fork_default_branch || repo.default_branch,
        htmlUrl: repo.fork_html_url ?? `https://github.com/${repo.owner}/${repo.name}`,
      }
      return {
        ok: true,
        token,
        owner: upstream.owner,
        name: upstream.name,
        defaultBranch: baseBranch,
        upstream,
        fork,
        isFork: repo.is_fork === 1,
        permission: repo.permission,
        repoRole: repo.repo_role,
        autoMerge: job.kind === 'iterate' && workTypeMayAutoMerge(job.work_type) && repo.repo_role === 'maintainer' && repo.auto_merge === 1,
        canReview: repo.can_review === 1,
        canCreateIssue: repo.can_create_issue === 1,
      }
    } catch (error) {
      // A triage run that cannot be narrowed does not run at all, and says why.
      if (error instanceof ReadOnlyTokenUnavailable) {
        this.store.audit(job.user_id, 'job.triage_token_unavailable', jobId)
        return { ok: false, status: 403, error: error.message }
      }
      return { ok: false, status: 500, error: 'credential unavailable' }
    }
  }

  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return
    this.ticking = true
    try {
      await this.tickOnce()
    } finally {
      this.ticking = false
    }
  }

  // Durable dispatcher: claim queued jobs up to the running cap. The inline
  // path in enqueue() stays the default; QUEUE_DISPATCH turns this on.
  private async dispatchQueued(): Promise<void> {
    const worker = `worker:${process.pid}`
    const leaseMs = 5 * 60_000
    for (;;) {
      if (this.store.countRunningJobs() >= this.config.runner.maxActiveJobs) return
      const job = this.store.claimQueuedJob(worker, leaseMs)
      if (job === undefined) return
      await this.dispatchClaimed(job, worker)
    }
  }

  private async dispatchClaimed(job: JobRow, worker: string): Promise<void> {
    const kind = job.kind as JobKind
    const repo = this.store.getRepo(job.repo_id)
    const user = this.store.userById(job.user_id)
    const revoke = (): void => {
      const row = job.platform_token_hash === null ? undefined : this.store.findApiToken(job.platform_token_hash)
      if (row !== undefined) this.store.revokeApiToken(row.id, row.user_id)
    }
    const fail = (error: string, errorCode?: FailureCode): void => {
      this.finish(job.id, { status: 'failed', error, errorCode }, revoke)
    }
    if (repo === undefined) return fail('仓库不存在')
    if (user === undefined || user.status !== 'approved') return fail('用户不可用')
    if (repo.enabled !== 1) return fail('这个仓库已停用', 'REPO_DISABLED')
    if (repo.repo_role !== 'maintainer' && repo.repo_role !== 'developer') return fail('请先选择你在这个仓库的角色。')
    if (kind === 'review' && repo.repo_role !== 'maintainer') return fail('只有 maintainer 可以运行审核任务。')
    if (job.callback_secret_enc === null || job.platform_token_enc === null) {
      return fail('任务缺少调度密钥，无法派发。')
    }
    let callbackSecret: string
    let platformToken: string
    try {
      callbackSecret = decryptSecret(job.callback_secret_enc, this.config.tokenEncryptionKey)
      platformToken = decryptSecret(job.platform_token_enc, this.config.tokenEncryptionKey)
    } catch (error) {
      return fail(`任务密钥无法解密：${String(error)}`)
    }
    const platformFunded = user.own_llm_base_url === null || user.own_llm_base_url === '' || user.own_llm_key_enc === null
    if (platformFunded && quotaView(user, this.config).exhausted) {
      this.finish(job.id, { status: 'quota_exhausted', error: '平台额度已用完，请在 Settings → Model 配置自己的模型 API。' }, revoke)
      await this.quotaNotifier.notify(user)
      return
    }

    let flybot: { url: string; token: string; sessionId: string; role: 'chief' | 'lead' | 'reviewer' | 'product' | 'test'; leadName: string } | undefined
    if (this.config.flybot.instanceImage !== '') {
      if (this.instances === undefined) return fail('FlyBot 实例管理器未配置')
      try {
        await this.instances.ensurePlaybook(repo.id).catch((error) => {
          log.warn('team playbook not refreshed', { repo: repo.id, error: String(error) })
        })
        await this.instances.refreshTeam(repo.id).catch((error) => log.warn('team session refresh before dispatch failed', { repo: repo.id, error: String(error) }))
        const bridge = this.instances.bridgeFor(repo.id)
        const assignment = await this.instances.applyBotModels(repo.id).catch((error) => {
          log.warn('bot model check before dispatch failed', { repo: repo.id, error: String(error) })
          return { updated: 0, skipped: ['model-check'] }
        })
        if (assignment.skipped.length > 0) {
          return fail(`机器人模型未就绪：${assignment.skipped.join(', ')}；请在仓库设置里重新应用模型。`)
        }
        const reviewer = kind === 'review' ? bridge.team.reviewer : null
        const role: 'chief' | 'lead' | 'reviewer' | 'product' | 'test' = kind === 'review'
          ? 'reviewer'
          : kind === 'scope'
            ? 'product'
            : kind === 'verify'
              ? 'test'
              : bridge.team.chief !== '' ? 'chief' : 'lead'
        const sessionId = kind === 'review'
          ? (reviewer ?? '')
          : kind === 'scope'
            ? bridge.team.product
            : kind === 'verify'
              ? bridge.team.test
              : bridge.team.chief !== '' ? bridge.team.chief : bridge.team.lead
        flybot = { url: bridge.url, token: bridge.token, sessionId, role, leadName: `${bridge.team.team} Lead` }
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
    }

    const baseBranch = job.base_branch ?? (repo.target_branch !== '' ? repo.target_branch : (repo.upstream_default_branch || repo.default_branch))
    let rules: RepoRules | undefined
    if (this.runner.name === 'flybot') {
      const loaded = await this.loadRules(repo, baseBranch, job.base_sha)
      if (!loaded.ok) return fail(loaded.error)
      rules = loaded.rules
    }
    this.store.updateJob(job.id, {
      status: 'running',
      started_at: nowIso(),
      lease_owner: worker,
      lease_until: addMinutes(5),
    })
    this.startLeaseHeartbeat(job.id, worker, 5 * 60_000)
    observeHistogram('fledge_job_queue_seconds', Math.max(0, (Date.now() - Date.parse(job.created_at)) / 1000), { kind }, 'Time from enqueue to dispatch')
    this.store.recordJobEvent({ jobId: job.id, repoId: repo.id, userId: user.id, kind: 'job.running', step: kind })
    if (kind === 'review') this.store.updateRepo(repo.id, { last_review_status: 'running' })
    else this.store.updateRepo(repo.id, { last_status: 'running' })

    const upstream: RepoRef = {
      owner: repo.upstream_owner || repo.owner,
      name: repo.upstream_name || repo.name,
      defaultBranch: baseBranch,
      htmlUrl: repo.upstream_html_url ?? `https://github.com/${repo.owner}/${repo.name}`,
    }
    const fork: RepoRef = {
      owner: repo.fork_owner || repo.owner,
      name: repo.fork_name || repo.name,
      defaultBranch: repo.fork_default_branch || repo.default_branch,
      htmlUrl: repo.fork_html_url ?? `https://github.com/${repo.owner}/${repo.name}`,
    }
    // #100: same binding as the inline dispatch — one logger per claimed job,
    // handed to the runner so the queued path names its job the same way.
    const jobLog = log.with({ trace: job.id })
    try {
      const result = await this.runner.run({
        job,
        log: jobLog,
        repo,
        user,
        kind,
        goal: job.goal,
        upstream,
        fork,
        isFork: repo.is_fork === 1,
        permission: repo.permission,
        repoRole: repo.repo_role === 'maintainer' || repo.repo_role === 'developer' ? repo.repo_role : null,
        autoMerge: kind === 'iterate' && workTypeMayAutoMerge(job.work_type) && repo.repo_role === 'maintainer' && repo.auto_merge === 1,
        canReview: repo.can_review === 1,
        canCreateIssue: repo.can_create_issue === 1,
        callback: { url: `${this.config.baseUrl}/api/jobs/${job.id}/callback`, secret: callbackSecret },
        credential: { url: `${this.config.baseUrl}/api/jobs/${job.id}/credential`, secret: callbackSecret },
        platform: { baseUrl: `${this.config.baseUrl}/v1`, model: this.config.llm.model, token: platformToken },
        ...(flybot === undefined ? {} : { flybot }),
        ...(rules === undefined ? {} : { rules }),
        timeoutMinutes: this.config.runner.timeoutMinutes,
      })
      if (result.status === 'running') return
      this.finish(job.id, {
        status: result.status === 'succeeded' ? 'succeeded' : 'failed',
        branch: result.branch,
        prUrl: result.prUrl,
        issueUrl: result.issueUrl,
        reviewScore: result.reviewScore,
        summary: result.summary,
        error: result.error,
      }, revoke)
    } catch (error) {
      revoke()
      const message = String(error instanceof Error ? error.message : error)
      const startCode: FailureCode = providerRefusalCode(message) ?? 'BRIDGE_ERROR'
      this.store.updateJob(job.id, { status: 'failed', error: redact(message).slice(0, 1000), error_code: startCode, finished_at: nowIso() })
      this.store.releaseJobLease(job.id)
      this.clearLeaseHeartbeat(job.id)
      if (kind === 'review') this.store.updateRepo(repo.id, { last_review_at: nowIso(), last_review_status: 'failed' })
      else this.store.updateRepo(repo.id, { last_status: 'failed' })
      this.store.notify(user.id, 'job', `${kind === 'review' ? '审核' : '任务'} ${job.id} 启动失败：${redact(message)}`, startCode)
      this.store.audit(user.id, 'job.failed', `${job.id}: ${redact(message).slice(0, 300)}`)
      jobLog.error('queued job start failed', { error: message })
    }
  }

  private startLeaseHeartbeat(jobId: string, owner: string, leaseMs: number): void {
    this.clearLeaseHeartbeat(jobId)
    const timer = setInterval(() => {
      if (!this.store.renewJobLease(jobId, owner, leaseMs)) this.clearLeaseHeartbeat(jobId)
    }, Math.max(1000, Math.floor(leaseMs / 5)))
    timer.unref()
    this.leaseTimers.set(jobId, timer)
  }

  private clearLeaseHeartbeat(jobId: string): void {
    const timer = this.leaseTimers.get(jobId)
    if (timer !== undefined) {
      clearInterval(timer)
      this.leaseTimers.delete(jobId)
    }
  }

  private atCapacity(): boolean {
    const active = this.config.runner.queueDispatch ? this.store.countRunningJobs() : this.store.countActiveJobs()
    return active >= this.config.runner.maxActiveJobs
  }

  // #260: a job that goes silent has two very different causes. A session that
  // ran and stopped heartbeating is a stall; a session whose turn ended without
  // a single model call never started work, and the usual reason is the provider
  // refusing the call. `state` is the only surface that tells them apart (it
  // carries per-session call counts), so it is read once, bounded, and only when
  // the job is already about to be failed.
  private stallRoleLabels(kind: string): string[] {
    // `state` names a session by its role key, the label is for display.
    if (kind === 'review') return ['reviewer']
    if (kind === 'scope') return ['product']
    if (kind === 'verify') return ['test']
    return ['chief', 'lead']
  }

  private async stalledWithoutModelCall(job: JobRow): Promise<boolean> {
    if (this.instances === undefined) return false
    const instance = this.store.getRepoInstance(job.repo_id)
    if (instance === undefined || instance.status !== 'ready') return false
    const started = Date.parse(job.started_at ?? job.created_at)
    if (!Number.isFinite(started)) return false
    let state
    try {
      state = await this.instances.teamState(job.repo_id, 5_000)
    } catch (error) {
      log.warn('stall evidence unavailable', { trace: job.id, error: String(error) })
      return false
    }
    const labels = this.stallRoleLabels(job.kind)
    return state.timeline.some((entry) =>
      entry.kind === 'ended' && labels.includes(entry.role) && entry.calls === 0 && entry.at >= started)
  }

  private async tickOnce(): Promise<void> {
    const handled = new Set<string>()
    setGauge('fledge_jobs_active', this.store.countActiveJobs(), {}, 'Active jobs')
    setGauge('fledge_jobs_queued', this.store.listQueuedJobs().length, {}, 'Queued jobs')
    setGauge('fledge_queue_depth', this.store.countQueuedJobs(), {}, 'Queued jobs waiting for a worker')
    const stalledBefore = addMinutes(-this.config.runner.stallMinutes)
    for (const job of this.store.stalledRunningJobs(stalledBefore)) {
      handled.add(job.id)
      const revoke = (): void => {
        const row = job.platform_token_hash === null ? undefined : this.store.findApiToken(job.platform_token_hash)
        if (row !== undefined) this.store.revokeApiToken(row.id, row.user_id)
      }
      // #260: before calling a silent job a stall, read the instance state once
      // (bounded). A role session whose turn ended with zero model calls never
      // started one, and that is a provider refusal, not a heartbeat stall.
      const noModelCall = await this.stalledWithoutModelCall(job)
      this.finish(job.id, {
        status: 'failed',
        error: noModelCall
          ? '任务失败：实例里的会话在派发后没有发起任何模型调用（供应商额度或限流拒绝了这次调用）。'
          : `任务停滞：超过 ${this.config.runner.stallMinutes} 分钟没有心跳。`,
        errorCode: noModelCall ? 'PROVIDER_CALL_NEVER_STARTED' : 'JOB_STALLED',
      }, revoke)
    }
    const staleBefore = addMinutes(-this.config.runner.timeoutMinutes)
    const queuedStaleBefore = this.config.runner.queueDispatch ? addMinutes(-this.config.runner.timeoutMinutes) : addMinutes(-10)
    const staleJobs = [...this.store.staleQueuedJobs(queuedStaleBefore), ...this.store.staleRunningJobs(staleBefore)].filter((job) => !handled.has(job.id))
    for (const job of staleJobs) {
      const revoke = (): void => {
        const row = job.platform_token_hash === null ? undefined : this.store.findApiToken(job.platform_token_hash)
        if (row !== undefined) this.store.revokeApiToken(row.id, row.user_id)
      }
      this.finish(job.id, { status: 'failed', error: job.status === 'queued' ? '任务排队超时未启动' : '任务超时未回报', errorCode: 'JOB_TIMEOUT' }, revoke)
    }
    for (const job of this.store.expiredLeaseJobs(nowIso())) {
      if (handled.has(job.id)) continue
      handled.add(job.id)
      const revoke = (): void => {
        const row = job.platform_token_hash === null ? undefined : this.store.findApiToken(job.platform_token_hash)
        if (row !== undefined) this.store.revokeApiToken(row.id, row.user_id)
      }
      incCounter('fledge_lease_expired_total', { kind: job.kind }, 1, 'Jobs whose worker lease expired')
      this.finish(job.id, { status: 'failed', error: '任务租约过期：worker 未续约。', errorCode: 'JOB_LEASE_EXPIRED' }, revoke)
    }
    this.store.deleteExpiredJobTokens()
    if (Date.now() - this.lastPruneAt > 60 * 60 * 1_000) {
      this.lastPruneAt = Date.now()
      this.store.pruneOldData()
    }
    if (this.config.env !== 'test' && this.instances !== undefined) {
      await this.instances.healthSweep().catch((error) => log.warn('instance health sweep failed', { error: String(error) }))
    }
    // #283: one read per tick, after the cleanup above (stale jobs, expired
    // leases, token pruning, instance health) and before anything that creates,
    // dispatches or merges work. `releaseAllPendingFollowups`, `releaseDueRetries`,
    // `reconcileAutoMerge`, the queue dispatch and both scheduling loops are all
    // below this line on purpose; the notification passes are below it too, so a
    // stopped platform sends no digest or question mail either. The drain step sits
    // here because the stop's own drain is bounded: this is the pass that finishes
    // it, and it runs before the return rather than after it.
    const stopped = this.platformStop()
    if (stopped !== null) {
      await this.completeStoppedDrain(stopped).catch((error) => log.warn('platform drain pass failed', { error: String(error) }))
      return
    }
    await this.expirePlans().catch((error) => log.warn('plan expiry pass failed', { error: String(error) }))
    await this.releaseAllPendingFollowups().catch((error) => log.warn('pending follow-up recovery failed', { error: String(error) }))
    await this.releaseDueRetries().catch((error) => log.warn('due retry release failed', { error: String(error) }))
    await this.reconcileAutoMerge().catch((error) => log.warn('auto-merge reconcile failed', { error: String(error) }))
    await this.notifyQuestions().catch((error) => log.warn('question notification pass failed', { error: String(error) }))
    await this.notifyOpsAlerts().catch((error) => log.warn('ops alert pass failed', { error: String(error) }))
    await this.maybeSendDigests().catch((error) => log.warn('daily digest pass failed', { error: String(error) }))
    if (this.config.runner.queueDispatch) {
      await this.dispatchQueued().catch((error) => log.warn('queue dispatch failed', { error: String(error) }))
    }
    if (this.atCapacity()) return
    for (const listed of this.store.listReviewRepos()) {
      if (this.atCapacity()) break
      let repo = listed
      if (!this.roleFresh(repo)) {
        const refreshed = await this.refreshRepoAccess(repo)
        if (refreshed === undefined) continue
        repo = refreshed
      }
      if (repo.repo_role !== 'maintainer') continue
      if (!this.userReadyForScheduling(repo.user_id)) continue
      if (!this.instanceReady(repo.id)) continue
      if (this.store.activeJobForRepo(repo.id) !== undefined) continue
      if (!this.dueReview(repo)) continue
      const result = await this.enqueue(repo, 'schedule', undefined, 'review')
      if (!result.ok && result.code === 'QUOTA_EXHAUSTED') break
      log.info('scheduled review', {
        repo: `${repo.owner}/${repo.name}`,
        ok: result.ok,
        trace: result.job?.id,
        ...(result.ok ? {} : { code: result.code, error: result.error }),
      })
    }
    for (const listed of this.store.listAutoRepos()) {
      if (this.atCapacity()) break
      let repo = listed
      if (repo.auto_merge === 1 && repo.repo_role === 'maintainer' && !this.roleFresh(repo)) {
        const refreshed = await this.refreshRepoAccess(repo)
        if (refreshed !== undefined) repo = refreshed
      }
      if (repo.repo_role !== 'maintainer' && repo.repo_role !== 'developer') continue
      if (!this.userReadyForScheduling(repo.user_id)) continue
      if (!this.instanceReady(repo.id)) continue
      if (this.store.activeJobForRepo(repo.id) !== undefined) continue
      const recent = this.store.listJobsForRepo(repo.id, 6)
      const next = decideNextJob({
        repo,
        now: Date.now(),
        lastRunAt: repo.last_run_at,
        // #478: a work item may start after the short cooldown, not after the
        // repository's legacy interval. The interval is only an upper bound.
        intervalMinutes: Math.min(repo.interval_minutes, this.config.runner.workCooldownMinutes),
        lastDurationMs: lastDurationMs(recent),
        failureStreak: failureStreak(recent),
        openWork: this.store.listOpenWorkItems(repo.id),
        reviewerEnabled: repo.reviewer_enabled === 1,
        reviewDue: this.dueReview(repo),
        lastDiscoverAt: this.store.getSetting(`discover:${repo.id}`),
        discoverIntervalMinutes: Math.max(MIN_DISCOVERY_INTERVAL_MINUTES, repo.interval_minutes),
      })
      if (next.kind === 'none') {
        // #478: an empty backlog is not a reason to create a job. Keep the
        // repository idle and do not advance last_run_at, so a newly created
        // work item is picked up after the short cooldown.
        if (next.reason === 'idle' && repo.last_status !== 'idle') {
          this.store.updateRepo(repo.id, { last_status: 'idle' })
          log.info('scheduled idle', { repo: `${repo.owner}/${repo.name}` })
        }
        continue
      }
      const result = next.kind === 'review'
        ? await this.enqueue(repo, 'schedule', undefined, 'review', { workItemId: next.workItemId, prUrl: next.prUrl })
        : next.kind === 'discover'
          ? await this.enqueue(repo, 'schedule', undefined, 'discover')
          : await this.enqueue(repo, 'followup', undefined, 'iterate', {
              workItemId: next.workItemId,
              ...(next.prUrl === undefined ? {} : { prUrl: next.prUrl }),
              ...(next.branch === undefined ? {} : { branch: next.branch }),
            })
      if (!result.ok && result.code === 'QUOTA_EXHAUSTED') break
      log.info('scheduled job', {
        repo: `${repo.owner}/${repo.name}`,
        ok: result.ok,
        kind: next.kind,
        trace: result.job?.id,
        ...(result.ok ? {} : { code: result.code, error: result.error }),
      })
    }
  }

  private userReadyForScheduling(userId: string): boolean {
    return this.store.userById(userId)?.status === 'approved'
  }

  private instanceReady(repoId: string): boolean {
    if (this.config.flybot.instanceImage === '') return true
    return this.store.getRepoInstance(repoId)?.status === 'ready'
  }

  private workDue(repo: RepoRow): boolean {
    if (repo.last_run_at === null) return true
    const last = Date.parse(repo.last_run_at)
    if (!Number.isFinite(last)) return true
    const cooldown = Math.min(repo.interval_minutes, this.config.runner.workCooldownMinutes)
    return Date.now() - last >= Math.max(15, cooldown) * 60_000
  }

  private discoverDue(repo: RepoRow): boolean {
    const at = this.store.getSetting(`discover:${repo.id}`)
    if (at === undefined || at === null || at === '') return true
    const last = Date.parse(at)
    if (!Number.isFinite(last)) return true
    return Date.now() - last >= Math.max(MIN_DISCOVERY_INTERVAL_MINUTES, repo.interval_minutes) * 60_000
  }

  private dueReview(repo: RepoRow): boolean {
    if (repo.last_review_at === null) return true
    const last = Date.parse(repo.last_review_at)
    if (!Number.isFinite(last)) return true
    return Date.now() - last >= Math.max(15, repo.review_interval_minutes) * 60_000
  }

  // #265: the preview-trial sweep runs on its own clock rather than inside the
  // job tick, which can be skipped while a dispatch is in flight. The first
  // scheduled run is one interval after boot; an operator who needs it now runs
  // `npm run trial:sweep`.
  async runTrialSweep(now: Date = new Date()): Promise<TrialSweepResult> {
    const result = await sweepExpiredTrials(this.store, this.mailer, this.config, { now })
    if (result.rejected.length > 0) log.info('preview trials ended', { rejected: result.rejected.length, emailed: result.emailed })
    return result
  }

  start(): void {
    if (this.timer !== null) return
    this.stopped = false
    this.timer = setInterval(() => {
      this.tick().catch((error) => log.error('scheduler tick failed', { error: String(error) }))
    }, 60_000)
    this.timer.unref()
    this.trialTimer = setInterval(() => {
      void this.runTrialSweep().catch((error) => log.error('trial sweep failed', { error: String(error) }))
    }, 3_600_000)
    this.trialTimer.unref()
    void this.tick().catch((error) => log.error('scheduler first tick failed', { error: String(error) }))
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    if (this.trialTimer !== null) clearInterval(this.trialTimer)
    this.trialTimer = null
  }

  async drain(timeoutMs: number): Promise<void> {
    this.stop()
    const deadline = Date.now() + Math.max(0, timeoutMs)
    while (this.store.countActiveJobs() > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    if (this.store.countActiveJobs() > 0) log.warn('shutdown grace expired with active jobs', { active: this.store.countActiveJobs() })
  }
}

