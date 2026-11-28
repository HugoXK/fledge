import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import fastifyCookie from '@fastify/cookie'
import fastifyFormbody from '@fastify/formbody'
import fastifyStatic from '@fastify/static'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { Config } from './config.js'
import { assertProductionConfig } from './config.js'
import { openStore, type GateSessionRow, type JobRow, type ProjectMemoryVersionRow, type RepoRow, type ScheduleRow, type Store, type UserRow, type WorkflowFailureStatus } from './db.js'
import { RETENTION_IDLE_TABLES } from '../scripts/lib/retention.mjs'
import { createAnnotatedTag, parseVersion, releasePreflight, releaseRefusals } from './releases/release.js'
import { reconcileRelease, trackingUpdate } from './releases/tracking.js'
import { collectReleaseNotes, releaseNotesSourceJson, type ReleaseNotes } from './releases/notes.js'
import { organiseReleaseNotes, readReleaseNotesSkill } from './releases/notesSkill.js'
import { readReleaseReadiness } from './releases/readiness.js'
import { AnalysisTokenUnavailable, analyzeReleaseRun, mintAnalysisToken, releaseAnalysisJson } from './releases/analysis.js'
import { currentStrategySections } from './strategy/sources.js'
import { parseStrategySections, strategyRefusal } from './strategy/bundle.js'
import { strategyPage, type JobStrategyView } from './views/strategy.js'
import { releaseReadinessPage } from './views/releaseReadiness.js'
import { GithubOAuth } from './auth/github.js'
import { oauthConfigured, tokenLoginEnabled } from './auth/login.js'
import { isAdminRole, requireAdmin, requireApproved, requireSuperAdmin, requireViewer, Sessions, type Viewer } from './auth/session.js'
import { dedupeRepoNames, instanceLimitRefusal, repoLimitRefusal, type LimitRefusal } from './lib/limits.js'
import { isTrialFilter } from './lib/trials.js'
import { createMailer, type Mailer } from './email/mailer.js'
import { approvedEmail, errorReportMail, feedbackMail, rejectedEmail, testEmail } from './email/templates.js'
import { attemptLeadDelivery, publicIssueDraft, retryPendingLeadDeliveries, verifyTriageToken } from './feedback/lead.js'
import { triageProblems } from './feedback/lifecycle.js'
import { notifyFeedbackReporter, notifyReleasedFeedback } from './feedback/notify.js'
import { notifyEmail } from './email/recipient.js'
import { authenticateApiToken } from './lib/apiToken.js'
import { registerGateway } from './gateway/gateway.js'
import { assertSafeModelUrl, normalizeDataPolicyUrl, normalizeProviderRegion } from './gateway/modelUrl.js'
import { assertSafeNotificationWebhook } from './lib/webhook.js'
import { quotaView } from './gateway/quota.js'
import { parseAttributionJson } from './lib/attribution.js'
import { decisionWithAnswer, jobIdFromQuestionId, jobQuestionId, storedDecision } from './lib/uncertainty.js'
import { failureBreakdown } from './lib/failure.js'
import { fetchFailureLog, logFailureReason } from './actions/workflowLog.js'
import { parseVerification } from './lib/verification.js'
import { cachedRouterProbe } from './lib/routerHealth.js'
import { registerIncidentRoute } from './lib/incidentRoute.js'
import { queryText } from './lib/queryText.js'
import { changeStoryAttribution, readChangeStory, type ChangeStory } from './lib/changeStory.js'
import { DEFAULT_TRIAGE_GOAL, Jobs } from './jobs/service.js'
import { parseIssueUrl, parsePrUrl } from './jobs/prUrl.js'
import { createRunner, type Runner } from './jobs/runner.js'
import { log } from './lib/log.js'
import type { PriorityLevel } from './lib/priority.js'
import { decisionKindLabel, isDecisionKind } from './lib/taskDecision.js'
import fastifyRateLimit from '@fastify/rate-limit'
import { rateLimitKey, RateLimiter, RouteLimiters } from './lib/rateLimit.js'
import { decryptSecret, encryptSecret, randomId, randomToken, redact, safeEqual, sha256Hex } from './lib/secrets.js'
import { expiryFromDays, GATEWAY_SCOPE, isTokenScope, JOBS_READ_SCOPE, patExpiryDays } from './lib/tokens.js'
import { AGREEMENT_VERSION, agreementHashFor } from './users/agreements.js'
import { addMinutes, nowIso } from './lib/time.js'
import { parseEvidenceJson } from './lib/evidence.js'
import { isLocale, LOCALE_COOKIE, localizeMessage, resolveLocale, translator, type Locale, type Translate } from './i18n.js'
import { decodeFlash, encodeFlash, FLASH_COOKIE, readRedirectMessage } from './lib/flash.js'
import { DISCOVERY_INTERVALS, REVIEW_INTERVALS, intervalSubmissionAccepted, normalizeInterval } from './lib/intervals.js'
import { JOB_FILTER_STATUSES, parseJobFilters } from './lib/jobFilters.js'
import { isValidBranchName } from './lib/branches.js'
import { allowedRepoRoles, parseRepoRole, roleAllowed } from './lib/repoRole.js'
import { isWorkItemState, MAINTAINER_ONLY_STATES, WORK_ITEM_TRANSITIONS, type WorkItemState } from './lib/workItems.js'
import { parseStageMode } from './lib/stages.js'
import { issuePriority, issueState, shouldTriage } from './lib/issueIntake.js'
import { parseIssueCommand, parseMentionTrigger, type IssueCommandInput, type MentionTriggerInput } from './lib/issueCommands.js'
import { classifyReviewAuthor, type ReviewAuthor } from './lib/revisionBudget.js'
import { untrustedAuditDetail, untrustedIssueGoal, untrustedMeta, type UntrustedText } from './lib/untrusted.js'
import { scanUntrusted, UNTRUSTED_EVENT_KIND } from './lib/firewall.js'
import { VERSION } from './version.js'
import { clearGauge, incCounter, observeHistogram, renderMetrics, setGauge } from './lib/metrics.js'
import { publishBackupMetrics } from './lib/backupMetrics.js'
import { automationHealth } from './jobs/automationHealth.js'
import { readReleaseStatus } from './lib/releaseStatus.js'
import { previewRelease, previewAndDispatch, type ReleaseDispatchPreview } from './lib/releaseDispatch.js'
import {
  deploymentFromRow,
  deploymentHealth,
  deploymentReadiness,
  environmentState,
  latestReleaseFromStatus,
  parsePromotionForm,
  parseRollbackForm,
  redactCommand,
  type DeploymentRow,
  type DriftAssessment,
  type EnvironmentCurrent,
} from './lib/deployments.js'
import { configureOtel, endSpan, shutdownOtel, startSpan, type SpanHandle } from './lib/otel.js'
import { configureGithubBudget } from './lib/githubBudget.js'
import { normalizeReviewInstruction } from './lib/followUpInstruction.js'
import { parsePreviewQuery, previewSchedule, type PreviewResult } from './schedules/preview.js'
import { intervalFieldText, scheduleConsole } from './schedules/console.js'
import { nextTime } from './schedules/next.js'
import { scheduleFromRow } from './schedules/tick.js'
import { DAILY_RUNS_MAX, parseDailyRuns, utcDayEnd, utcDayStart } from './schedules/budget.js'
import { Approvals } from './users/approval.js'
import {
  adminPage,
  adminSupportPage,
  adminDeleteUserPage,
  adminTrialsPage,
  adminSearchPage,
  adminWebhooksPage,
  adminNotificationsPage,
  adminDeploymentsPage,
  approvalPage,
  dashboardPage,
  landingPage,
  messagePage,
  applyPage,
  applicationStatusPage,
  repoPage,
  teamPage,
  jobPage,
  metricsPage,
  appReposPage,
  workspacePage,
  searchPage,
  schedulePage,
  scheduleConsolePage,
  agentWorkspacePage,
  settingsPage,
  inboxSection,
  jobAttribution,
  errorPage,
  type InboxQuestion,
  type ScheduledNext,
} from './views/pages.js'
import { productPage } from './views/product.js'
import { loopCsv } from './metrics/product.js'
import { PRODUCT_PUSH_KEY, pushProductLoopWebhook } from './metrics/productWebhook.js'
import { withDensity } from './views/layout.js'
import type { PullTip } from './views/reviewMerge.js'
import { gatePage } from './views/gate.js'
import { planHash, validateGatePlan, type GatePlan } from './gates/plan.js'
import { decidePlan, planDecisionOutcome, type PlanDecisionJob, type PlanDecisionOutcome } from './lib/planDecision.js'
import { applyGatePlan } from './gates/apply.js'
import { memoryMissingPage, memoryPage } from './views/memory.js'
import { rulesOverridesPage } from './views/rules.js'
import { ciGatePage } from './views/ciGate.js'
import { reportCiGate } from './lib/ciGate.js'
import { isRulePath, MAX_RULE_FILE_BYTES } from './rules.js'
import { AGENT_NOTE_LIMIT, audienceVisible, canDecideProposal, MEMORY_DOCUMENT_VERIFICATION, memoryDigest, parseAgentNoteInput, parseMemoryInput, proposalDecisionStatus, proposalDecisionVerification, searchMemories, visibleMemories } from './lib/memory.js'
import { documentRefusal, fileBlobSha, isAncestorStatus, isDocumentPath, type DocumentProof } from './lib/memoryDocument.js'
import { DENSITY_COOKIE, isDensity, resolveDensity } from './views/density.js'
import { THEME_COOKIE, isTheme, resolveTheme, withTheme } from './views/theme.js'
import { GithubClient, GithubError, parseRepoInput, prepareRepo, prepareRepoWithInstallation, repoPermissionWithToken } from './repos/github.js'
import { revertMatchOf } from './lib/deliveryOutcome.js'
import { checkWebhookSignature, GithubApp, webhookSecretSlot } from './repos/app.js'
import { repoGithubToken } from './repos/token.js'
import { InstanceManager } from './flybot/instances.js'
import { playbookFor, playbookTextHash, teamLabelFor } from './flybot/playbook.js'
import { dshCookie, proxyWorkspaceHttp, proxyWorkspaceUpgrade } from './flybot/workspace.js'
import { managementActor } from './management/actor.js'
import { ManagementService, type CommandOutcome, type ManagementCode } from './management/service.js'
import type { JobKind } from './jobs/runner.js'
import { identityPrincipalId, listEffectiveScopes, platformCapabilitiesForRole, resolveUserActor, type Capability } from './identity/authorization.js'

export interface BuildOptions {
  config: Config
  store?: Store
  mailer?: Mailer
  runner?: Runner
  startScheduler?: boolean
  // Injected by tests that drive the route with a fake live-session controller;
  // production always builds its own.
  instances?: InstanceManager
  // Injected by tests that need a GithubApp with a process age or a stubbed
  // measurement; production always builds its own.
  githubApp?: GithubApp
}

export interface BuiltApp {
  app: FastifyInstance
  store: Store
  jobs: Jobs
  sessions: Sessions
  instances: InstanceManager
  // #758: the measured clock skew lives on the App client, and /readyz reports it.
  // Exposed so a test can force one measurement instead of faking the route.
  githubApp: GithubApp
  close: () => Promise<void>
}

// #940: one conversion from a saved schedule row to what the repository page and
// the dashboard card render (#688 keeps them on one string). A paused row (#932)
// keeps its expression and its repository stays enabled, so the row alone would
// hand both surfaces an instant the worker skips and never makes up.
function scheduledNextFor(row: ScheduleRow): ScheduledNext {
  const schedule = scheduleFromRow(row)
  if (schedule === null) return { kind: 'unreadable', at: null }
  if (row.status === 'paused') return { kind: 'paused', at: null }
  return { kind: schedule.kind, at: nextTime(schedule, Date.now()) }
}

// #1104: "this account can run on a model of its own" is read once and shared,
// because the dashboard checklist and the job dispatcher must answer it the same
// way (`platformFundedFor`). A provider row alone is not an own model — a
// repository has to select one. This is the account-level facts for the
// checklist; the quota banner asks the per-repository question below, because one
// own-model repository does not unpause another repository the platform pays for.
function ownModelConfigured(store: Store, user: UserRow, repos: RepoRow[]): boolean {
  const legacyOwnModel =
    user.own_llm_base_url !== null &&
    user.own_llm_base_url !== '' &&
    user.own_llm_key_enc !== null
  return legacyOwnModel || repos.some((repo) => store.listRepoModelSelection(repo.id).length > 0)
}

// #1104 review: the quota pauses a repository, not an account. The banner is the
// only notice a paused repository gets, so it asks whether any repository of this
// account still runs on the platform model — a mixed account keeps it even though
// `ownModelConfigured` is true for its own-model repository.
function hasPlatformFundedRepo(store: Store, user: UserRow, repos: RepoRow[]): boolean {
  return repos.some((repo) => store.platformFundedFor(user, repo.id))
}

// #1104 test regression: `repos.some(...)` alone answers "false" for an account
// with no repository at all, which would hide the banner from the state every
// account starts in. The per-repository answer only suppresses the notice when a
// model of the account's own is configured; otherwise nothing has been chosen
// yet, so a spent platform quota still has something to pause.
function platformQuotaPausesSomething(store: Store, user: UserRow, repos: RepoRow[], ownModel: boolean): boolean {
  return !ownModel || hasPlatformFundedRepo(store, user, repos)
}

function httpError(statusCode: number, message: string, code = 'REQUEST_FAILED'): Error {
  return Object.assign(new Error(message), { statusCode, code })
}

// #540 finding 3: the per-comment marker answers "was this comment handled?", and
// a marker that only ever says "yes" is a tombstone — a process killed between the
// marker and the command receipt left a comment that no later delivery would ever
// answer. The marker is a claim instead: `claimed:<iso>` from the moment the
// delivery starts until the answer reaches the issue, then `done:<iso>`. A claim
// older than the delivery row's own five-minute lease is retakeable, and a failed
// delivery releases its claim at once (see `releaseIssueCommandClaim`), so a
// comment can always be retried. Retaking is safe because the writes it repeats
// are fenced elsewhere — the command receipt answers a replay, and `enqueue`
// refuses a second active job — so the claim never carried "queue exactly once".
const ISSUE_COMMAND_CLAIM_MS = 5 * 60_000

function readIssueCommandMarker(raw: string | undefined): { state: 'claimed' | 'done'; at: number } | undefined {
  if (raw === undefined) return undefined
  const separator = raw.indexOf(':')
  if (separator > 0) {
    const state = raw.slice(0, separator)
    if (state === 'claimed' || state === 'done') {
      const at = Date.parse(raw.slice(separator + 1))
      return { state, at: Number.isFinite(at) ? at : 0 }
    }
  }
  // A marker written before this slice carries no state, so all it can prove is
  // that a delivery started. Read as a lapsed claim: a redelivery replays the
  // receipt it may already have, which is why re-answering it is safe.
  return { state: 'claimed', at: 0 }
}

// A delivery that threw before it answered hands its claim back, so the redelivery
// GitHub sends is not told the comment was handled. This runs on the webhook
// failure path, which is where the delivery row is marked failed for the same
// reason and with the same lease.
function releaseIssueCommandClaim(store: Store, body: Record<string, unknown>): void {
  const parsed = parseIssueCommand(body)
  if (parsed === null) return
  const key = `issue_command:${parsed.commentId}`
  if (readIssueCommandMarker(store.getSetting(key))?.state === 'claimed') store.deleteSetting(key)
}

// #231 review: a refused enqueue answers with the job service's code, and the
// banner builds the sentence from it, so a refusal reaches an English reader in
// English. The detail a refusal names (a missing target branch) travels after a
// colon; the service's text stays the fallback for a refusal that carries no code.
function refusalValue(result: { code?: string; detail?: string; error?: string }, fallback: string): string {
  const code = result.code ?? ''
  const text = result.error ?? fallback
  // A discussed refusal travels as `CODE:payload`. The code lets the banner build
  // a sentence in the reader's language where the table has one; the payload is
  // the refusal's own parameter (the branch, the limit, the models) or, for a code
  // with no sentence yet, the sentence the service wrote, which the banner then
  // translates through the dictionary it used before #231.
  if (code === '') return text
  const detail = result.detail ?? ''
  return `${code}:${detail !== '' ? detail : text}`
}

// #360 review: the pause/cancel reply is built from the stop's own outcome, so it
// never claims a send that did not happen. `sent` absent means no attempt was made
// (a queued job, or no live-session controller in queue-dispatch mode), `false`
// means the bridge call failed, and the counts are what `stopSessions` reported.
function describeJobStop(result: { sent?: boolean; stopped?: number; requested?: number }): string {
  if (result.sent === undefined) return 'no live session was reachable to stop'
  if (result.sent !== true) return 'the stop could not be delivered'
  const stopped = result.stopped ?? 0
  const requested = result.requested ?? 0
  if (stopped > 0 && requested > 0) return `stopped ${stopped} session(s) and requested a stop for ${requested} at the next safe point`
  if (stopped > 0) return `stopped ${stopped} session(s)`
  if (requested > 0) return `requested a stop for ${requested} session(s) at the next safe point`
  return 'no live session was reachable to stop'
}

// #392: the public read API's page size. A query string cannot refuse a caller
// here — the contract names exactly three auth answers — so a value outside
// 1..100 is clamped instead of rejected, and a missing or unparsable value takes
// the documented default.
function jobPageLimit(value: string | undefined): number {
  if (value === undefined) return 50
  // `Number('')` is 0, so an empty value would otherwise mean the smallest page
  // rather than the default; only a non-empty, finite number is honoured.
  const parsed = value.trim() === '' ? Number.NaN : Number(value)
  if (!Number.isInteger(parsed)) return 50
  return Math.min(100, Math.max(1, parsed))
}

// #433 slice 2: the strategy block is a read of rows the job already carries plus
// one earlier row of the same repository — no GitHub call and no bundle lookup
// that could go missing. A job with no recorded hash renders "no strategy
// recorded", which is what a row from before the columns means.
function jobStrategyView(store: Store, repoId: string, job: JobRow): JobStrategyView {
  const previousRow = job.strategy_hash === null ? undefined : store.previousStrategyJob(repoId, job.id)
  const previous = previousRow === undefined || previousRow.strategy_hash === null
    ? undefined
    : {
      jobId: previousRow.id,
      hash: previousRow.strategy_hash,
      version: previousRow.strategy_version,
      sections: parseStrategySections(previousRow.strategy_json),
    }
  return {
    hash: job.strategy_hash,
    version: job.strategy_version,
    sections: parseStrategySections(job.strategy_json),
    ...(previous === undefined ? {} : { previous }),
  }
}

// The item contract, in one place: these ten fields and nothing else. The row
// carries a callback hash, a platform token hash and a callback secret, so this
// mapper is the boundary that keeps them out of the response.
function jobSummary(job: JobRow): {
  id: string
  kind: string
  status: string
  repo: string
  createdAt: string
  finishedAt: string | null
  prUrl: string | null
  issueUrl: string | null
  reviewScore: number | null
  costUsd: number
} {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    repo: job.repo_id,
    createdAt: job.created_at,
    finishedAt: job.finished_at,
    prUrl: job.pr_url,
    issueUrl: job.issue_url,
    reviewScore: job.review_score,
    costUsd: job.cost_usd,
  }
}

// The preview's query is a closed set of names, so it is read into a literal:
// a user-supplied key never becomes a property name. A loop over
// `Object.entries(query)` did, which is remote property injection (CodeQL
// `js/remote-property-injection` at this helper), and the allowlist is the same
// shape `form()` already uses below.
function queryTextOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value.slice(0, 500) : undefined
}

// #845: `error_reports.path` reaches the report mail, the `error.reported` audit
// row and `GET /api/feedback/:ref`, so it must never carry a live capability.
// `/approve/:token` puts one in the path, and the matched pattern is the only
// shape that stays useful for diagnosis and safe to store. An unmatched request
// has no pattern; the concrete path without a query string is the fallback, as
// before.
function routePattern(request: FastifyRequest): string {
  return (request.routeOptions?.url ?? request.url.split('?')[0] ?? '/').slice(0, 500)
}

function previewQuery(request: FastifyRequest): Record<string, string | undefined> {
  const query = (request.query as Record<string, unknown> | undefined) ?? {}
  return {
    mode: queryTextOf(query.mode),
    cron: queryTextOf(query.cron),
    every: queryTextOf(query.every),
    every_amount: queryTextOf(query.every_amount),
    every_unit: queryTextOf(query.every_unit),
    // #677: the page posts one clock per panel under `<mode>_time`, so no two
    // panels can collide in one request; `time` stays for the documented API.
    time: queryTextOf(query.time),
    daily_time: queryTextOf(query.daily_time),
    weekdays_time: queryTextOf(query.weekdays_time),
    weekly_time: queryTextOf(query.weekly_time),
    monthly_time: queryTextOf(query.monthly_time),
    weekday: queryTextOf(query.weekday),
    month_day: queryTextOf(query.month_day),
    timezone: queryTextOf(query.timezone),
    from: queryTextOf(query.from),
    start_at: queryTextOf(query.start_at),
    end_at: queryTextOf(query.end_at),
    count: queryTextOf(query.count),
  }
}

const FORM_KEY = /^[A-Za-z0-9_-]{1,80}$/

function form(request: FastifyRequest): Record<string, string> {
  const body = (request.body ?? {}) as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(body)) {
    if (FORM_KEY.test(key) && typeof value === 'string') out[key] = value
  }
  return out
}

// #540: a failed command carries either one of the contract's own codes (lower
// case) or the admission refusal an operation's service returned (`REPO_DISABLED`,
// `BRANCH_MISSING`). The first is answered here in both languages; the second is
// handed to the banner table that already speaks it, parameter and all, so moving
// a route behind the contract does not downgrade its refusal.
const MANAGEMENT_CODE = /^[a-z][a-z0-9_]*$/

function managementFailure(t: Translate, outcome: { code: string; message: string; detail?: string }, fallback: string): string {
  if (!MANAGEMENT_CODE.test(outcome.code)) {
    return refusalValue({ code: outcome.code, detail: outcome.detail, error: outcome.message }, fallback)
  }
  return managementRefusal(t, outcome.code, fallback)
}

// #540: the management codes are stable identifiers, so the sentence a person
// reads is chosen here, once, in both languages. The last line is the caller's
// own sentence: "the cancel failed" is wrong on a pause, and a code we have not
// taught this switch yet must not borrow another operation's words.
function managementRefusal(t: Translate, code: string, fallback: string): string {
  switch (code) {
    case 'management_revision_conflict':
      return t('页面上的内容在你打开之后已经变化，请重新打开这一页后再操作。', 'This changed after you opened the page; reopen it before acting.')
    case 'repo_role_not_allowed':
      return t('你的 GitHub 权限不允许选择这个角色。', 'Your GitHub permission does not allow this role.')
    case 'idempotency_conflict':
      return t('这个请求已经用不同的内容提交过，已拒绝。请刷新页面后重试。', 'That request was already submitted with different content; reload the page and try again.')
    case 'command_in_progress':
      return t('这个操作还在处理中，请刷新页面查看结果。', 'This action is still being processed; reload to see the result.')
    case 'management_unknown':
      // #540 slice 5: the external write did not answer, so the honest sentence
      // is "not confirmed, submit again to check" — never "it failed".
      return t('这一步没有收到确认，结果未知。请再次提交同一个操作，系统会先核对再决定是否重发。', 'This step was not confirmed, so the result is unknown. Submit the same action again and it will check before resending.')
    case 'authorization_revoked':
      return t('你已经没有执行这个操作的权限。', 'You no longer have permission for this action.')
    case 'job_not_cancellable':
      return t('这个任务已经结束。', 'This job has already finished.')
    case 'job_not_pausable':
      return t('这个任务已经结束，不能再暂停。', 'This job has already finished and cannot be paused.')
    case 'job_not_resumable':
      return t('只有已暂停的任务可以恢复。', 'Only a paused job can be resumed.')
    case 'job_not_retryable':
      return t('这个任务现在不能重试。', 'This job cannot be retried right now.')
    case 'invalid_arguments':
      return t('请求的内容不完整，无法执行。', 'The request is missing something this action needs.')
    case 'work_item_not_found':
      return t('工作项不存在。', 'The work item does not exist.')
    case 'job_not_found':
      return t('任务不存在。', 'The job does not exist.')
    case 'actor_not_allowed':
      return t('请求里不能包含身份或权限字段。', 'A request may not carry identity or permission fields.')
    case 'unknown_operation':
      return t('不支持的操作。', 'Unsupported operation.')
    default:
      return fallback
  }
}

// #540: a command form renders the revision it saw and a fresh key. A page cached
// before those fields existed still acts once: it has no key to replay, so the
// server mints one for that request, and the current revision stands in for the
// one it could not render. One rule for every adapter.
function commandParts(body: Record<string, string>, currentRevision: number): { expectedRevision: number; idempotencyKey: string } {
  const rendered = Number.parseInt(body.expected_revision ?? '', 10)
  const expectedRevision = Number.isFinite(rendered) && rendered >= 1 ? rendered : currentRevision
  const idempotencyKey = body.idempotency_key !== undefined && body.idempotency_key !== '' ? body.idempotency_key : randomId('cmd')
  return { expectedRevision, idempotencyKey }
}

// A succeeded command names what it wrote. A create says `jobId`; a resume or a
// retry says the job it queued. Anything else is a contract bug, so the caller
// falls back to the page it came from rather than inventing a link.
function commandJobId(outcome: CommandOutcome): string | null {
  if (!outcome.ok) return null
  const jobId = outcome.result.jobId
  return typeof jobId === 'string' && jobId !== '' ? jobId : null
}

function formList(request: FastifyRequest, key: string): string[] {
  const body = (request.body ?? {}) as Record<string, unknown>
  const value = body[key]
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string')
  if (typeof value === 'string' && value !== '') return [value]
  return []
}

const LOCAL_ORIGIN = 'http://fledge.local'

// A `next=` or `returnTo` value may only leave as a path on this site. The check
// runs on the parsed result, not on the input: `/..//evil.com` is an ordinary
// path before parsing and `//evil.com` after it, and `reply.redirect()` would
// emit that as a protocol-relative Location.
export function safeLocalPath(value: string | undefined, fallback: string): string {
  if (value === undefined || !value.startsWith('/')) return fallback
  let url: URL
  try {
    url = new URL(value, LOCAL_ORIGIN)
  } catch {
    return fallback
  }
  // A path-only URL never changes origin, so this rejects `//host` and `https://host`.
  if (url.origin !== LOCAL_ORIGIN) return fallback
  // One leading slash, so nothing a client could read as a host survives folding.
  if (!url.pathname.startsWith('/') || url.pathname.startsWith('//')) return fallback
  return `${url.pathname}${url.search}${url.hash}`
}

// #555: a page that just came out of a save already carries `notice=`, and a
// Referer keeps it (only the fragment is dropped). Appending a second key makes
// the query parse as an array, `queryText()` refuses a non-string, and the
// console then shows nothing at all. Setting the key replaces the stale message
// instead of stacking a second one next to it.
function withMessageParam(page: string, key: 'notice' | 'error', message: string): string {
  const url = new URL(page, LOCAL_ORIGIN)
  url.searchParams.set(key, message)
  return `${url.pathname}${url.search}${url.hash}`
}

function bearerSecret(request: FastifyRequest): string {
  const header = String(request.headers.authorization ?? '')
  if (header.slice(0, 7).toLowerCase() !== 'bearer ') return ''
  return header.slice(7).trim().slice(0, 512)
}

function viewOf(viewer: { user: UserRow; csrfToken: string; preview?: boolean }): { user: UserRow; csrfToken: string; preview?: boolean } {
  return { user: viewer.user, csrfToken: viewer.csrfToken, preview: viewer.preview }
}

function htmlPage(reply: FastifyReply, status: number, page: string): FastifyReply {
  return reply.code(status).type('text/html; charset=utf-8').send(page)
}

// #543: the read-only gate API returns the stored plan itself, not only its
// hash, so the later gate-PR slice and a person see the same bytes the human
// confirmed.
function gateSessionView(row: GateSessionRow): Record<string, unknown> {
  let plan: unknown = null
  try {
    plan = JSON.parse(row.plan_json)
  } catch {
    // A row whose JSON cannot be read is returned with `plan: null`; the status
    // and hash are still the stored record, and the page shows the refusal.
    plan = null
  }
  return {
    id: row.id,
    repoId: row.repo_id,
    status: row.status,
    baseSha: row.base_sha,
    plan,
    planHash: row.plan_hash,
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at,
    prUrl: row.pr_url,
    branch: row.branch,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function testOwnModel(baseUrl: string, key: string, model: string): Promise<void> {
  let response: Response
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch (error) {
    throw new Error(`连接失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`模型服务返回 HTTP ${response.status}：${text.slice(0, 200)}`)
  }
}

// A pending applicant whose newest approval-mail attempt failed and whose
// approval_sent_at is still empty: the admin has no mail to act on.
function approvalMailFailed(user: UserRow, failures: Map<string, string>): boolean {
  const failedAt = failures.get(user.id)
  if (failedAt === undefined) return false
  if (user.approval_sent_at === null) return true
  return failedAt > user.approval_sent_at
}

// #634: a form field the page did not post is absent, not an empty hash; only a
// posted value can be compared with the stored plan.
function planShownHash(value: string | undefined): string | null {
  const shown = (value ?? '').trim()
  return shown === '' ? null : shown
}

// #634: the plan decision reads the packet from the job row it is about, so both
// doors hand the shared function the same five values and cannot drift.
function planDecisionJob(job: JobRow): PlanDecisionJob {
  return {
    id: job.id,
    summary: job.summary,
    evidenceJson: job.evidence_json,
    baseSha: job.base_sha,
    approvedAt: job.plan_approved_at,
    rejectedAt: job.plan_rejected_at,
  }
}

export async function buildApp(options: BuildOptions): Promise<BuiltApp> {
  const { config } = options
  assertProductionConfig(config)
  await assertSafeNotificationWebhook(config)
  const store = options.store ?? openStore(config.dbPath)
  store.ensureSuperadmin(config.github.adminLogin)
  const orphans = store.cleanupOrphans()
  if (orphans.retries + orphans.followups + orphans.jobEvents + orphans.instances > 0) {
    log.info('orphan cleanup', orphans)
  }
  const mailer = options.mailer ?? createMailer(config)
  const runner = options.runner ?? createRunner(config)
  const oauth = new GithubOAuth(config)
  const sessions = new Sessions(store, config)
  const approvals = new Approvals(store, config, mailer)
  const instances = options.instances ?? new InstanceManager(store, config)
  if (options.instances === undefined && options.startScheduler !== false && config.env !== 'test' && config.flybot.instanceImage !== '') {
    void instances.healthSweep().catch((error) => log.warn('startup instance health sweep failed', { error: String(error) }))
  }
  const githubApp = options.githubApp ?? new GithubApp(config)
  const jobs = new Jobs(store, config, runner, mailer, instances, githubApp)
  // #540: one contract behind the console writes that have migrated — the job
  // cancel, pause, create, resume and retry forms. Settings, releases and member
  // grants still call their services directly and migrate one operation at a time.
  const management = new ManagementService(store, jobs)

  // #540 slice 2 (rest): the create adapter. The route keeps the checks that are
  // reads — the plan is approved, the work item is open — and hands the write to
  // one command, so idempotency, the revision fence and the audit are not copied
  // into eight routes.
  const runCreate = async (
    request: FastifyRequest,
    viewer: Viewer,
    repo: RepoRow,
    args: { kind: JobKind; goal?: string; workItemId?: string; prUrl?: string; priority?: number },
  ): Promise<CommandOutcome> => {
    const parts = commandParts(form(request), management.revisionOf('project', repo.id))
    // #671: the store is what makes this the database resolver — the tenant the
    // receipt is scoped by and the live capabilities — so the console cannot
    // build two kinds of actor for one repository.
    const actor = managementActor({ store, userId: viewer.user.id, repo, channel: 'web', requestId: request.id })
    const commandArgs: Record<string, unknown> = { kind: args.kind }
    if (args.goal !== undefined) commandArgs.goal = args.goal
    if (args.workItemId !== undefined) commandArgs.workItemId = args.workItemId
    if (args.prUrl !== undefined) commandArgs.prUrl = args.prUrl
    if (args.priority !== undefined) commandArgs.priority = args.priority
    return management.run(actor, {
      operation: 'task.create',
      target: { projectId: repo.id },
      arguments: commandArgs,
      expectedRevision: parts.expectedRevision,
      idempotencyKey: parts.idempotencyKey,
    })
  }

  // Resume and retry are fenced on the source job's revision, not the project's:
  // the page that offered the button rendered one job, and it is that job that
  // must not have moved on.
  const runJobOperation = async (
    request: FastifyRequest,
    viewer: Viewer,
    repo: RepoRow,
    jobId: string,
    operation: 'task.resume' | 'task.retry',
  ): Promise<CommandOutcome> => {
    const parts = commandParts(form(request), management.revisionOf('job', jobId))
    const actor = managementActor({ store, userId: viewer.user.id, repo, channel: 'web', requestId: request.id })
    return management.run(actor, {
      operation,
      target: { projectId: repo.id, jobId },
      arguments: {},
      expectedRevision: parts.expectedRevision,
      idempotencyKey: parts.idempotencyKey,
    })
  }
  // #708: every mutating route names its class here. One limiter per class,
  // each route with its own bucket, all budgets from config so a deployment
  // tightens a window with an env change. `apiLimiter` stays separate: it paces
  // machine callers (webhooks, bridge callbacks) at a wider window than a form.
  const limits = new RouteLimiters(config.rateLimit)
  const apiLimiter = new RateLimiter(120, 60_000)
  // #708: one refusal for a limited mutation — the same bilingual page the
  // sign-in routes already returned, never a bare status a form post cannot
  // explain.
  const refuseTooMany = (request: FastifyRequest, reply: FastifyReply) =>
    htmlPage(reply, 429, errorPage(config, request.viewer ?? null, 429, '请求过多', '请稍后再试。', request.locale))
  // #460 review: the destructive actions below are rate-limited as well as
  // re-authenticated, through `@fastify/rate-limit` (registered `global: false`
  // below) so the limit is visible to callers and to CodeQL's Fastify model
  // rather than hidden in a helper no analyzer follows. The key stays the client
  // address through rateLimitKey, never a value the caller can mint; 60 a minute
  // leaves room for an admin working through a batch of approvals while still
  // stopping a loop, a resubmitting page or a stolen cookie. #708 left these two
  // numbers alone on purpose: they keep the window they had.
  const destructiveLimit = {
    max: 60,
    timeWindow: 60_000,
    keyGenerator: (request: FastifyRequest): string => rateLimitKey(request),
  }
  // #786: user feedback and a public error-report button are not destructive,
  // so they get their own tighter buckets; the plugin shape is the one CodeQL's
  // Fastify model can see, and the key stays the normalized client address.
  const ERROR_REPORT_CONSENT_VERSION = '2026-11-15'
  const feedbackLimit = {
    max: 5,
    timeWindow: 60 * 60_000,
    keyGenerator: (request: FastifyRequest): string => rateLimitKey(request),
  }
  const errorReportLimit = {
    max: 10,
    timeWindow: 60 * 60_000,
    keyGenerator: (request: FastifyRequest): string => rateLimitKey(request),
  }

  // #708: the destructive class budget, read from config, for the routes that
  // take the class after the eight that keep their literal window. Same key
  // generator, so the ceiling is still a property of the route and the address.
  const destructiveClassLimit = {
    max: config.rateLimit.destructive.max,
    timeWindow: config.rateLimit.destructive.windowMs,
    keyGenerator: (request: FastifyRequest): string => rateLimitKey(request),
  }

  const app = Fastify({
    logger: false,
    // Only the hops configured in TRUST_PROXY may add X-Forwarded-For; the
    // caller-supplied left end of that header never becomes request.ip. The
    // default is loopback (the direct-nginx path); a bridge network names its
    // gateway there instead. See docs/deploy.md.
    trustProxy: config.trustProxy,
    bodyLimit: 20 * 1024 * 1024,
    routerOptions: { ignoreTrailingSlash: true },
  })
  configureOtel(config.otel)
  configureGithubBudget(config.github.requestsPerMinute)
  const otelSpans = new WeakMap<FastifyRequest, SpanHandle>()
  app.addHook('onResponse', async (request, reply) => {
    const span = otelSpans.get(request)
    if (span !== undefined) endSpan(span, reply.statusCode >= 500 ? 'ERROR' : 'OK', reply.statusCode >= 500 ? `HTTP ${reply.statusCode}` : undefined, { status: reply.statusCode })
    const route = request.routeOptions?.url ?? 'unknown'
    const method = request.method
    incCounter('fledge_http_requests_total', { method, route, status: reply.statusCode }, 1, 'HTTP requests')
    observeHistogram('fledge_http_request_seconds', reply.elapsedTime / 1000, { method, route }, 'HTTP request duration')
  })
  await app.register(fastifyCookie)
  await app.register(fastifyFormbody)
  await app.register(fastifyStatic, { root: join(process.cwd(), 'public'), prefix: '/assets/', decorateReply: false })
  // `global: false`: only the routes that name `config.rateLimit` are limited.
  await app.register(fastifyRateLimit, { global: false })

  // #472 slice 2: the message a redirect used to put in the address bar is
  // read before any handler runs, so a handler reads it from the request and
  // never from the query. The cookie is cleared by the first HTML response that
  // renders it; a JSON, asset or redirect response leaves it for the next page.
  const flashCookie = { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: config.baseUrl.startsWith('https://') }
  app.addHook('onRequest', async (request) => {
    request.viewer = sessions.read(request) ?? undefined
    request.locale = resolveLocale(request)
    request.flash = decodeFlash(request.cookies[FLASH_COOKIE])
    // #845: a trace attribute is shipped to the exporter, so it takes the same
    // route pattern as `error_reports.path` for the same reason.
    otelSpans.set(request, startSpan('http.request', { method: request.method, path: routePattern(request) }))
  })

  app.addHook('preParsing', async (request, _reply, payload) => {
    const path = request.url.split('?')[0] ?? ''
    if (path !== '/api/github/webhook' && !(path.startsWith('/repos/') && path.includes('/workspace/app/'))) return payload
    const chunks: Buffer[] = []
    for await (const chunk of payload) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    const raw = Buffer.concat(chunks)
    ;(request as FastifyRequest & { rawBody?: Buffer }).rawBody = raw
    return Readable.from(raw)
  })

  app.addHook('onSend', async (request, reply, payload) => {
    // #472 slice 2: one seam turns every redirect banner into a one-shot
    // cookie, so the 150-odd redirect sites keep their call shape and no route
    // can invent a second delivery channel. A message that arrives here is
    // removed from Location before the browser sees it.
    if (reply.statusCode >= 300 && reply.statusCode < 400) {
      const flashed = readRedirectMessage(String(reply.getHeader('location') ?? ''))
      if (flashed !== undefined) {
        reply.header('location', flashed.location)
        reply.setCookie(FLASH_COOKIE, encodeFlash(flashed.state), { ...flashCookie, maxAge: 120 })
      }
    }
    reply.header('x-content-type-options', 'nosniff')
    reply.header('referrer-policy', 'strict-origin-when-cross-origin')
    reply.header('x-frame-options', 'DENY')
    if (request.url.startsWith('/auth/') || request.url.startsWith('/approve/')) reply.header('cache-control', 'no-store')
    if (!request.url.startsWith('/v1') && !request.url.startsWith('/api/')) {
      reply.header(
        'content-security-policy',
        "default-src 'self'; connect-src 'self' https://mcp.deepwiki.com; img-src 'self' https://avatars.githubusercontent.com data:; style-src 'self' 'unsafe-inline'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      )
    }
    if (config.baseUrl.startsWith('https://')) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains')
    // #473: the density is request state, so the rendered document is completed
    // here rather than in a page builder that has no request. Only an HTML body
    // is touched; every JSON, CSS and text response passes through unchanged.
    // #657: the theme is request state for the same reason, and it runs after
    // the density rewrite so both attributes survive on the one `<html>` tag.
    if (typeof payload === 'string' && String(reply.getHeader('content-type') ?? '').startsWith('text/html')) {
      if (request.flash !== undefined && reply.statusCode < 300) reply.clearCookie(FLASH_COOKIE, flashCookie)
      return withTheme(withDensity(payload, resolveDensity(request)), resolveTheme(request))
    }
    return payload
  })

  const csrfGuard = (request: FastifyRequest) => {
    const viewer = requireViewer(request)
    if (!sessions.verifyCsrf(request, viewer)) throw httpError(403, '表单已过期，请刷新页面后重试。', 'CSRF_FAILED')
    return viewer
  }

  const approvedCsrfGuard = (request: FastifyRequest) => {
    const viewer = csrfGuard(request)
    if (viewer.user.status !== 'approved') throw httpError(403, '账号正在等待审批。', 'NOT_APPROVED')
    return viewer
  }

  // #457: a user may not create repositories or FlyBot instances without a
  // ceiling; the refusal carries a stable code and is audited, and it happens
  // before anything is created so no half-built repo or container is left.
  const refuseLimit = (
    request: FastifyRequest,
    reply: FastifyReply,
    viewer: Viewer,
    refusal: LimitRefusal,
    back: string,
  ): FastifyReply => {
    const t = translator(request.locale ?? 'zh')
    store.audit(viewer.user.id, 'limit.refused', `${refusal.code} used=${refusal.used} cap=${refusal.cap}`)
    const message = refusal.code === 'REPO_LIMIT'
      ? t(
        `仓库数量已达上限（${refusal.used}/${refusal.cap}）。请先移除一个仓库，或请管理员调整上限。`,
        `Repository limit reached (${refusal.used}/${refusal.cap}). Remove a repository or ask an admin to raise the limit.`,
      )
      : t(
        `工作区数量已达上限（${refusal.used}/${refusal.cap}）。请先停止或移除一个工作区，或请管理员调整上限。`,
        `Workspace limit reached (${refusal.used}/${refusal.cap}). Stop or remove a workspace, or ask an admin to raise the limit.`,
      )
    const joiner = back.includes('?') ? '&' : '?'
    return reply.redirect(`${back}${joiner}error=${encodeURIComponent(message)}&code=${refusal.code}`)
  }

  const repoCapRefusal = (viewer: Viewer): LimitRefusal | null => repoLimitRefusal({
    used: store.countReposForUser(viewer.user.id),
    cap: config.limits.reposPerUser,
    admin: isAdminRole(viewer.user.role),
  })

  // #457 review: the instance ceiling has to see an add that will provision, not
  // only the explicit provision route. `extra` is how many instances the caller
  // is about to create; `excludeRepoId` is the repository whose own row (stopped
  // or not) must not count against its restart.
  const instanceCapRefusal = (viewer: Viewer, extra = 1, excludeRepoId = ''): LimitRefusal | null => instanceLimitRefusal({
    usedForUser: store.countRepoInstancesForUser(viewer.user.id, excludeRepoId),
    capForUser: config.limits.instancesPerUser,
    usedGlobal: store.countRepoInstances(excludeRepoId),
    capGlobal: config.limits.instancesGlobal,
    admin: isAdminRole(viewer.user.role),
    extra,
  })


  // A stolen session cookie must not be enough for a destructive write: those
  // ask for a GitHub confirmation inside the configured window. On refusal the
  // action is audited and the browser is sent through /auth/github/reauthorize,
  // which refreshes this session in place so the form keeps its CSRF token.
  const recentAuthFresh = (viewer: { recentAuthAt: string | null }): boolean => {
    if (viewer.recentAuthAt === null) return false
    const at = Date.parse(viewer.recentAuthAt)
    return !Number.isNaN(at) && Date.now() - at <= config.recentAuthMinutes * 60_000
  }

  const requireRecentAuth = (
    request: FastifyRequest,
    reply: FastifyReply,
    viewer: Viewer,
    action: string,
    backOverride?: string,
  ): boolean => {
    if (recentAuthFresh(viewer)) return false
    const path = request.url.split('?')[0] ?? ''
    store.audit(viewer.user.id, 'recent_auth_required', `${action} ${path}`)
    let back = backOverride ?? ''
    if (back === '') {
      const referer = String(request.headers.referer ?? '')
      back = referer.startsWith('/') ? referer : ''
      if (back === '' && referer !== '') {
        try {
          const url = new URL(referer)
          back = `${url.pathname}${url.search}`
        } catch {
          back = ''
        }
      }
    }
    const t = translator(request.locale ?? 'zh')
    const notice = t(
      `这个操作需要重新用 GitHub 确认身份（${config.recentAuthMinutes} 分钟内有效），确认后请再次提交。`,
      `This action needs a fresh GitHub confirmation (valid for ${config.recentAuthMinutes} minutes). Submit it again after confirming.`,
    )
    const target = withMessageParam(safeLocalPath(back, '/dashboard'), 'notice', notice)
    reply.redirect(`/auth/github/reauthorize?next=${encodeURIComponent(target)}`)
    return true
  }

  // #105: a repository is shared with its active members. The connection owner
  // stays the maintainer of last resort; a member row carries `maintainer`,
  // `developer` or `viewer`. Reads are open to every active member, writes need
  // developer or better, and repository settings need maintainer. A non-member
  // and a missing repository answer the same 404 so an id does not leak.
  // `maintainOnly` also covers the destructive and lifecycle routes: the role
  // and settings forms write the same `repo_role`/`auto_merge` columns, and
  // delete, release, enable/disable, the workspace controls and the model apply
  // are settings in effect. A developer keeps the work routes (`/work`,
  // `/run`, `/plan`, `/triage`, `/review` and job actions), never the ones that
  // can destroy the connection or change who may use it.
  const ownedRepo = (request: FastifyRequest, id: string, mutating = false, maintainOnly = false) => {
    const viewer = mutating ? approvedCsrfGuard(request) : requireApproved(request)
    const repo = store.getRepo(id)
    const role = repo === undefined
      ? null
      : repo.user_id === viewer.user.id
        ? 'maintainer'
        : store.memberRoleFor(repo.id, viewer.user.id)
    if (repo === undefined || role === null) throw httpError(404, '仓库不存在。', 'REPO_NOT_FOUND')
    if (mutating && role === 'viewer') {
      throw httpError(403, '只读成员不能修改这个仓库。', 'A viewer cannot change this repository.')
    }
    if (maintainOnly && role !== 'maintainer') {
      throw httpError(403, '只有维护者可以修改仓库设置。', 'Only a maintainer can change repository settings.')
    }
    return { viewer, repo, role }
  }

  // #543: a plan carries the SHA it was analysed at. Resolving the default
  // branch here is opportunistic: a read-only GET when a token is available, and
  // an absent SHA when GitHub is unreachable. An absent result accepts the plan
  // (its baseSha is still required and stored); a mismatch refuses the stale plan.
  const resolveGateBaseSha = async (repo: RepoRow): Promise<string | null> => {
    try {
      const token = await repoGithubToken(repo, config, githubApp, store)
      if (token === '') return null
      const owner = repo.upstream_owner || repo.owner
      const name = repo.upstream_name || repo.name
      const branch = repo.target_branch || repo.upstream_default_branch || repo.default_branch
      const found = await new GithubClient(token, config.github.apiBase).getBranch(owner, name, branch)
      return found === null ? null : found.sha.toLowerCase()
    } catch (error) {
      log.warn('gate base sha resolution failed', { repo: repo.id, error: String(error) })
      return null
    }
  }

  const gateMaintainerRefusal = (reply: FastifyReply, request: FastifyRequest): FastifyReply => {
    const t = translator(request.locale ?? 'zh')
    return reply.code(403).send({
      error: {
        type: 'MAINTAINER_ONLY',
        message: t('只有维护者可以提出或确认门禁计划。', 'Only a maintainer may propose or confirm a gate plan.'),
      },
    })
  }

  const inboxCache = new Map<string, { at: number; questions: InboxQuestion[] }>()
  const inboxForUser = async (userId: string, repos: RepoRow[]): Promise<InboxQuestion[]> => {
    const cached = inboxCache.get(userId)
    if (cached !== undefined && Date.now() - cached.at < 5_000) return cached.questions
    const ready = repos.filter((repo) => store.getRepoInstance(repo.id)?.status === 'ready')
    const settled = await Promise.allSettled(ready.map(async (repo) => {
      const state = await instances.teamState(repo.id, 4_000)
      const repoLabel = `${repo.upstream_owner || repo.owner}/${repo.upstream_name || repo.name}`
      return state.questions
        .filter((question) => question.id !== '' && question.question !== '')
        .map((question) => ({ repoId: repo.id, repoLabel, ...question }))
    }))
    const teamQuestions = settled
      .flatMap((result) => result.status === 'fulfilled' ? result.value : [])
    // #381: a paused job that raised a decision is a question in the same list,
    // marked with the job as its source. It does not need a live instance: the
    // job is waiting on the person, not on a bot session.
    const jobQuestions: InboxQuestion[] = []
    for (const repo of repos) {
      const repoLabel = `${repo.upstream_owner || repo.owner}/${repo.upstream_name || repo.name}`
      for (const job of store.listJobDecisionsForRepo(repo.id, 10)) {
        const decision = storedDecision(job.decision_json)
        if (decision === null || decision.answer !== null) continue
        jobQuestions.push({
          id: jobQuestionId(job.id),
          sessionId: '',
          question: decision.question,
          detail: decision.why,
          options: decision.options,
          multiSelect: false,
          repoId: repo.id,
          repoLabel,
          source: 'job',
          jobId: job.id,
        })
      }
    }
    const questions = [...jobQuestions, ...teamQuestions].slice(0, 20)
    inboxCache.set(userId, { at: Date.now(), questions })
    return questions
  }

  const localizedJobs = (jobs: JobRow[], locale: Locale): JobRow[] => jobs.map((job) => ({
    ...job,
    summary: job.summary === null ? null : localizeMessage(locale, job.summary) ?? job.summary,
    error: job.error === null ? null : localizeMessage(locale, job.error) ?? job.error,
  }))

  // #373 slice 1: the job page's "Why this change" block reads the pull request
  // body and the changed-file totals. One read per job with a 60 s bound, the
  // same shape as `inboxCache` above: a page refresh must not spend a GitHub
  // request, and a job without a pull request spends none at all.
  const changeStoryTtlMs = 60_000
  const changeStoryCache = new Map<string, { at: number; story: ChangeStory; tip: PullTip | null }>()
  // #264: the review/merge card needs the pull request's current tip to compare
  // against the tip the stored verdict names. It rides on this same read: a page
  // that already reads the pull request for the change story must not spend a
  // second request on the tip.
  const pullSnapshotFor = async (repo: RepoRow, job: JobRow): Promise<{ story: ChangeStory | undefined; tip: PullTip | null }> => {
    if (job.pr_url === null || job.pr_url === '') return { story: undefined, tip: null }
    const cached = changeStoryCache.get(job.id)
    if (cached !== undefined && Date.now() - cached.at < changeStoryTtlMs) return { story: cached.story, tip: cached.tip }
    // #793: which model and role did the work is on the job row, so it is read
    // here rather than from the pull request body. The row can be read even when
    // GitHub cannot, which is why every branch below carries it.
    const attribution = changeStoryAttribution({
      modelJson: job.model_json,
      attributionJson: job.attribution_json,
      // #1190: the record decides whether the claim was observed, and the same
      // reconstruction the job page uses keeps a pre-#1186 row honest.
      groundJson: job.attribution_ground_json,
      teamStatsJson: job.team_stats_json,
    })
    const parsed = parsePrUrl(repo, job.pr_url, config.github.apiBase)
    let story: ChangeStory
    let tip: PullTip | null = null
    if (!parsed.ok) {
      story = readChangeStory({ body: null, totals: null, diffState: 'unreadable', attribution })
    } else {
      try {
        const token = await repoGithubToken(repo, config, githubApp, store)
        const client = new GithubClient(token, config.github.apiBase)
        const pr = await client.getPullRequest(parsed.ref.owner, parsed.ref.name, parsed.ref.number)
        const diff = await client.pullRequestDiffTotals(parsed.ref.owner, parsed.ref.name, parsed.ref.number, pr.changedFiles)
        story = readChangeStory({ body: pr.body, totals: diff.totals, diffState: diff.complete ? 'ok' : 'capped', attribution })
        tip = { headSha: pr.headSha, state: pr.state, draft: pr.draft, mergeableState: pr.mergeableState }
      } catch (error) {
        // A read that failed is a fact the block reports, not a reason to fail
        // the page: the evidence below it is what the maintainer came for.
        log.warn('change story read failed', { repo: repo.id, job: job.id, error: error instanceof Error ? error.message : String(error) })
        story = readChangeStory({ body: null, totals: null, diffState: 'unreadable', attribution })
      }
    }
    if (changeStoryCache.size >= 200) {
      for (const [key, entry] of changeStoryCache) if (Date.now() - entry.at >= changeStoryTtlMs) changeStoryCache.delete(key)
    }
    changeStoryCache.set(job.id, { at: Date.now(), story, tip })
    return { story, tip }
  }

  const requireAdvanced = (viewer: { user: UserRow; preview?: boolean }): void => {
    if (viewer.user.role !== 'superadmin' || viewer.preview === true) throw httpError(403, '仅超级管理员可访问实时团队页面。', 'SUPERADMIN_ONLY')
  }

  const startSession = (user: UserRow, request: FastifyRequest, reply: FastifyReply): void => {
    if (user.status === 'approved') instances.ensureUserDir(user.id)
    const raw = sessions.start(user.id, request)
    const sessionHash = sha256Hex(raw)
    sessions.setCookies(reply, raw, { sessionHash, user, csrfToken: sessions.csrfFor(sessionHash), recentAuthAt: new Date().toISOString() })
    sessions.setPreview(reply, false)
  }


  app.server.on('upgrade', (request, socket, head) => {
    const match = /^\/repos\/([^/]+)\/workspace\/app\/(.*)$/.exec(request.url ?? '')
    if (match === null) return
    const fail = (status: string): void => {
      try { socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`) } catch {}
      socket.destroy()
    }
    const raw = /(?:^|; )fledge_session=([^;]+)/.exec(String(request.headers.cookie ?? ''))?.[1]
    if (raw === undefined) return fail('401 Unauthorized')
    const session = store.getSession(sha256Hex(decodeURIComponent(raw)))
    if (session === undefined) return fail('401 Unauthorized')
    const user = store.userById(session.user_id)
    const repo = store.getRepo(decodeURIComponent(match[1] ?? ''))
    if (user === undefined || user.status !== 'approved' || repo === undefined || repo.user_id !== user.id) return fail('403 Forbidden')
    const instance = store.getRepoInstance(repo.id)
    if (instance === undefined || instance.status !== 'ready') return fail('409 Conflict')
    void dshCookie(instance).then((cookie) => {
      proxyWorkspaceUpgrade(request, socket as import('node:net').Socket, head, instance, match[2] ?? '', cookie)
    }).catch(() => fail('502 Bad Gateway'))
  })

  // #236: `/healthz` names the live commit, so it answers to the same credential
  // `/metrics` uses — otherwise an unauthenticated caller can ask "is the security
  // fix deployed yet?" and get a fact instead of a guess, which is a deploy-timing
  // oracle. The token is read from the Authorization header and nowhere else: a
  // `?token=` value ends up in proxy access logs, browser history and Referer
  // headers, and a probe URL is committed to config files. safeEqual keeps the
  // compare constant time so a wrong token cannot be recovered byte by byte.
  const diagnosticsAccess = (request: FastifyRequest): 'bearer' | 'loopback' | 'denied' => {
    // #127: request.ip is the peer the configured proxy saw (TRUST_PROXY), so a
    // client-supplied X-Forwarded-For can no longer make a public peer look local.
    const loopback = request.ip === '127.0.0.1' || request.ip === '::1' || request.ip === '::ffff:127.0.0.1'
    const header = String(request.headers.authorization ?? '')
    const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
    if (config.metrics.token === '') {
      // No token configured: the loopback fallback is a development and test
      // convenience only. assertProductionConfig refuses an empty METRICS_TOKEN in
      // production, so this branch is unreachable there; the check stays as a
      // second line of defence for a config assembled without that assertion.
      return config.env === 'production' || !loopback ? 'denied' : 'loopback'
    }
    return safeEqual(bearer, config.metrics.token) ? 'bearer' : 'denied'
  }

  app.get('/metrics', async (request, reply) => {
    if (!apiLimiter.take(`metrics:${rateLimitKey(request)}`)) return reply.code(429).send({ error: 'too many requests' })
    if (diagnosticsAccess(request) === 'denied') {
      return config.metrics.token === ''
        ? reply.code(403).send({ error: 'metrics are loopback-only without METRICS_TOKEN' })
        : reply.code(401).send({ error: 'metrics token required' })
    }
    // #758: a scrape publishes the last measured skew, and removes the series
    // when there is none, so the alert rule cannot fire on a stale number and a
    // dashboard cannot show a 0 that was never measured.
    const skewSeconds = githubApp.clockSkewSeconds()
    if (skewSeconds === null) clearGauge('fledge_clock_skew_seconds')
    else setGauge('fledge_clock_skew_seconds', skewSeconds, {}, 'Seconds the process clock is ahead of GitHub time')
    // #693: the backup and drill facts are files on the host. The scrape is the
    // one reader that runs without somebody opening /admin, so the same two
    // readers publish them here; the ops-alert pass reads them a second time for
    // the page nobody is looking at.
    publishBackupMetrics({
      dir: config.backup.dir,
      drillPath: join(config.dataDir, 'backup-drill.json'),
      expectedHours: config.backup.expectedIntervalHours,
    })
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(renderMetrics())
  })

  // #183: the build names itself, so a deploy can be checked rather than guessed.
  // #236: `commit`/`builtAt` are for the operator, not the public — they are served
  // only on the `/metrics` credential above, because a live commit between a
  // security fix merging and being deployed answers "is it live yet?". The public
  // answer keeps `ok`/`service`/`version`/`time`, and the identity keys are absent
  // rather than `unknown`: `unknown` means "this build carries no stamp", so reusing
  // it for "not authorised" would make an unstamped production build and a denied
  // caller indistinguishable. The status stays 200 for every caller — a liveness
  // probe must never be refused.
  app.get('/healthz', async (request) => {
    const publicAnswer = {
      ok: true,
      service: 'fledge',
      version: VERSION,
      time: new Date().toISOString(),
    }
    if (diagnosticsAccess(request) === 'denied') return publicAnswer
    // #466: `current`/`previous`/`none` says which secret slot the verifier is
    // using, from the same pair the verifier reads, so a half-finished rotation
    // is visible to the operator. It is never a value and never a fingerprint.
    return { ...publicAnswer, commit: config.build.commit, builtAt: config.build.builtAt, webhookSecretSlot: webhookSecretSlot(config.githubApp) }
  })

  app.get('/readyz', async (_request, reply) => {
    try {
      store.db.prepare('SELECT 1').get()
    } catch {
      return reply.code(503).send({ ok: false, db: false })
    }
    const instances = store.listRepoInstances()
    const ready = instances.filter((entry) => entry.status === 'ready').length
    const failed = instances.filter((entry) => entry.status === 'failed').length
    // #758 slice 2: readiness fails on a measured clock outside the threshold, so
    // a monitor that reads only the status code stops seeing a "healthy" instance
    // whose every stored time is 28 minutes ahead. `not-configured` stays 200 (a
    // deployment with no App is not a clock verdict), and so does `unknown` while
    // the process is young or the last reading is merely stale: a GitHub outage
    // is not a clock verdict either. #1028: a configured App that has been up for
    // a whole reuse window and has never measured once is a different `unknown` —
    // the guard never ran there, so it fails until a measurement succeeds. The
    // object keeps `source` and adds `state` and `thresholdSeconds`, so a reader
    // can tell "no number" from "a number that is too far".
    const clock = githubApp.clockState()
    const clockUnverified = githubApp.clockUnverified()
    // #282: the model router is reported beside the database, instance and clock
    // fields rather than in front of them, so a router outage can never hide a
    // database or instance failure. With no `MODEL_ROUTER_URL` the field is
    // absent and this response is byte-identical to the one before the probe
    // existed: a deployment without a router cannot be made unready here.
    //
    // Readiness fails on an unreachable router or on one whose every key is
    // capped — not on `state` alone, because `mode: rate` means at least one key
    // is cooling, which is still a serving router. A single-key cooldown is a
    // detail for the operator and never a site outage.
    const router = config.router.url === '' ? null : await cachedRouterProbe(config)
    const routerReady = router === null || (router.state !== 'unreachable' && !router.allKeysCapped)
    const body = {
      ok: clock.state !== 'fail' && !clockUnverified && routerReady,
      db: true,
      instances: { ready, failed, total: instances.length },
      clock: { ...clock, source: 'github' },
      ...(router === null ? {} : { router: { state: router.state, latencyMs: router.latencyMs } }),
    }
    return body.ok ? body : reply.code(503).send(body)
  })

  app.get('/lang/:locale', async (request, reply) => {
    const requested = String((request.params as Record<string, string>).locale)
    if (!isLocale(requested)) return htmlPage(reply, 404, errorPage(config, request.viewer === undefined ? null : viewOf(request.viewer), 404, '页面不存在', '你访问的页面不存在。', request.locale))
    const next = queryText(request, 'next')
    const safeNext = safeLocalPath(next, '/')
    reply.setCookie(LOCALE_COOKIE, requested, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.baseUrl.startsWith('https://'),
      maxAge: 365 * 86_400,
    })
    return reply.redirect(safeNext)
  })

  // #473: the table density is saved the way the language is, because the rows
  // are rendered on the server — a client-side flip would paint the comfortable
  // layout first and then collapse it. An unknown mode is a 404, never a silent
  // default, and `next` goes through the same same-origin contract as `/lang`.
  app.get('/density/:mode', async (request, reply) => {
    const requested = String((request.params as Record<string, string>).mode)
    if (!isDensity(requested)) return htmlPage(reply, 404, errorPage(config, request.viewer === undefined ? null : viewOf(request.viewer), 404, '页面不存在', '你访问的页面不存在。', request.locale))
    reply.setCookie(DENSITY_COOKIE, requested, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.baseUrl.startsWith('https://'),
      maxAge: 365 * 86_400,
    })
    return reply.redirect(safeLocalPath(queryText(request, 'next'), '/'))
  })

  // #657: the palette is saved the way the language and the density are, because
  // it is painted by the response — a client-side flip would show the other
  // palette first. An unknown mode is a 404, never a silent default, and `next`
  // goes through the same same-origin contract as `/lang` and `/density`.
  app.get('/theme/:mode', async (request, reply) => {
    const requested = String((request.params as Record<string, string>).mode)
    if (!isTheme(requested)) return htmlPage(reply, 404, errorPage(config, request.viewer === undefined ? null : viewOf(request.viewer), 404, '页面不存在', '你访问的页面不存在。', request.locale))
    reply.setCookie(THEME_COOKIE, requested, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.baseUrl.startsWith('https://'),
      maxAge: 365 * 86_400,
    })
    return reply.redirect(safeLocalPath(queryText(request, 'next'), '/'))
  })

  app.get('/', async (request, reply) => {
    const viewer = request.viewer
    const locale: Locale = request.locale ?? 'zh'
    if (viewer !== undefined) {
      if (viewer.user.status === 'approved') return reply.redirect('/dashboard')
      if (viewer.user.status === 'onboarding') return reply.redirect('/apply')
      return reply.redirect('/apply/status')
    }
    return reply.type('text/html').send(landingPage(config, null, config.env !== 'production' && config.devLogin.login !== '', locale))
  })

  app.get('/auth/dev', async (request, reply) => {
    if (config.env === 'production' || config.devLogin.login === '') {
      return htmlPage(reply, 404, errorPage(config, request.viewer ?? null, 404, '页面不存在', 'Dev 登录没有开启。', request.locale))
    }
    const user = store.upsertGithubUser({
      id: randomId('usr'),
      githubId: -1,
      login: config.devLogin.login,
      name: 'Dev Login',
      email: 'dev@example.com',
      avatarUrl: null,
      isAdmin: false,
      isSuperAdmin: config.devLogin.admin,
      initialQuotaCny: config.quota.initialCny,
    })
    if (user.status !== 'approved') store.setUserStatus(user.id, 'approved', 'dev-login')
    startSession(store.userById(user.id)!, request, reply)
    store.audit(user.id, 'login.dev', 'DEV_LOGIN_LOGIN')
    store.event('login', { userId: user.id, meta: 'dev' })
    return reply.redirect('/dashboard')
  })

  app.post('/auth/token', async (request, reply) => {
    if (!tokenLoginEnabled(config)) {
      const t = translator(request.locale ?? 'zh')
      return htmlPage(reply, 403, errorPage(config, request.viewer ?? null, 403, 'OAuth 已启用', '这个部署已经启用 GitHub OAuth，请使用 GitHub 登录。', request.locale, { href: '/auth/github', label: t('使用 GitHub 登录', 'Sign in with GitHub') }))
    }
    if (!limits.take('login', `token:${rateLimitKey(request)}`)) return htmlPage(reply, 429, errorPage(config, request.viewer ?? null, 429, '请求过多', '请稍后再试。', request.locale))
    const token = (form(request).token ?? '').trim()
    if (token === '') return htmlPage(reply, 400, messagePage(config, '缺少 token', '请填写一个 GitHub token。', request.viewer === undefined ? null : viewOf(request.viewer), request.locale))
    let profile
    try {
      profile = await oauth.profile(token)
    } catch (error) {
      log.warn('github token login failed', { error: String(error) })
      return htmlPage(reply, 401, messagePage(config, 'GitHub token 无效', '无法用这个 token 读取 GitHub 身份，请检查权限或重新生成。', request.viewer === undefined ? null : viewOf(request.viewer), request.locale))
    }
    const isSuperAdmin = profile.login.toLowerCase() === config.github.adminLogin.toLowerCase()
    const user = store.upsertGithubUser({
      id: randomId('usr'),
      githubId: profile.id,
      login: profile.login,
      name: profile.name,
      email: profile.email,
      avatarUrl: profile.avatarUrl,
      isAdmin: false,
      isSuperAdmin,
      initialQuotaCny: config.quota.initialCny,
    })
    store.audit(user.id, 'login.github-token', `@${profile.login}`)
    store.event('login', { userId: user.id, meta: 'github-token' })
    startSession(user, request, reply)
    if (user.status === 'approved') return reply.redirect('/dashboard')
    if (user.status === 'onboarding') return reply.redirect('/apply')
    return reply.redirect('/apply/status')
  })

  app.get('/auth/github', async (request, reply) => {
    if (!limits.take('login', `login:${rateLimitKey(request)}`)) return htmlPage(reply, 429, errorPage(config, request.viewer ?? null, 429, '请求过多', '请稍后再试。', request.locale))
    if (!oauthConfigured(config)) {
      return htmlPage(reply, 503, errorPage(config, request.viewer ?? null, 503, 'GitHub OAuth 未配置', '请先在 .env 设置 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET。', request.locale))
    }
    const state = randomToken(32)
    store.createOAuthState(sha256Hex(state), addMinutes(20), safeLocalPath(queryText(request, 'next'), '/dashboard'))
    return reply.redirect(oauth.authorizeUrl(state))
  })

  app.get('/auth/github/reauthorize', async (request, reply) => {
    const viewer = requireApproved(request)
    if (!limits.take('login', `reauth:${viewer.user.id}`)) return htmlPage(reply, 429, errorPage(config, request.viewer ?? null, 429, '请求过多', '请稍后再试。', request.locale))
    if (!oauthConfigured(config)) return reply.redirect('/settings?error=' + encodeURIComponent('GitHub OAuth 未配置。'))
    const state = randomToken(32)
    store.createOAuthState(sha256Hex(state), addMinutes(20), safeLocalPath(queryText(request, 'next'), '/dashboard'))
    const scopes = [...new Set(`${config.github.scopes} repo`.split(/\s+/).filter(Boolean))].join(' ')
    return reply.redirect(oauth.authorizeUrl(state, scopes))
  })

  app.get('/auth/github/callback', async (request, reply) => {
    if (!limits.take('login', `callback:${rateLimitKey(request)}`)) return htmlPage(reply, 429, errorPage(config, request.viewer ?? null, 429, '请求过多', '请稍后再试。', request.locale))
    const query = request.query as Record<string, string | undefined>
    const code = query.code ?? ''
    const state = query.state ?? ''
    const invalidLink = () => {
      const t = translator(request.locale ?? 'zh')
      return htmlPage(reply, 400, errorPage(
        config,
        request.viewer ?? null, 400,
        '登录链接已失效',
        '这个 GitHub 登录链接已失效或已经被使用。请重新登录；如果是在微信/QQ 内置浏览器打开，请改用 Safari 或 Chrome。',
        request.locale,
        { href: '/auth/github', label: t('重新登录', 'Sign in again') },
      ))
    }
    if (code === '' || state === '') return invalidLink()
    const oauthState = store.consumeOAuthState(sha256Hex(state))
    if (oauthState === undefined) return invalidLink()
    let profile
    let token
    let oauthScopes = ''
    try {
      const exchanged = await oauth.exchangeCode(code)
      token = exchanged.token
      oauthScopes = exchanged.scopes
      profile = await oauth.profile(token)
    } catch (error) {
      log.warn('github login failed', { error: String(error) })
      const t = translator(request.locale ?? 'zh')
      return htmlPage(reply, 400, errorPage(config, request.viewer ?? null, 400, 'GitHub 登录失败', '无法完成 GitHub 登录，请重试。', request.locale, { href: '/auth/github', label: t('重新登录', 'Sign in again') }))
    }
    const isSuperAdmin = profile.login.toLowerCase() === config.github.adminLogin.toLowerCase()
    const user = store.upsertGithubUser({
      id: randomId('usr'),
      githubId: profile.id,
      login: profile.login,
      name: profile.name,
      email: profile.email,
      avatarUrl: profile.avatarUrl,
      isAdmin: false,
      isSuperAdmin,
      initialQuotaCny: config.quota.initialCny,
    })
    store.setUserGithubToken(user.id, encryptSecret(token, config.tokenEncryptionKey), oauthScopes)
    store.audit(user.id, 'login.github', `@${profile.login}`)
    store.event('login', { userId: user.id, meta: 'github' })
    // A re-authentication from /auth/github/reauthorize arrives with the session
    // it is refreshing; keeping that session keeps the form's CSRF token valid.
    const refreshing = request.viewer !== undefined && request.viewer.user.id === user.id
    if (refreshing) sessions.markRecentAuth(request)
    else startSession(user, request, reply)
    if (user.status === 'approved') return reply.redirect(oauthState.redirect_to === null ? '/dashboard' : safeLocalPath(oauthState.redirect_to, '/dashboard'))
    if (user.status === 'onboarding') return reply.redirect('/apply')
    return reply.redirect('/apply/status')
  })

  app.post('/auth/logout', async (request, reply) => {
    const viewer = csrfGuard(request)
    sessions.destroy(request)
    sessions.clearCookies(reply)
    store.audit(viewer.user.id, 'logout')
    return reply.redirect('/')
  })

  app.get('/pending', async (request, reply) => {
    const viewer = requireViewer(request)
    if (viewer.user.status === 'approved') return reply.redirect('/dashboard')
    if (viewer.user.status === 'onboarding') return reply.redirect('/apply')
    return reply.redirect('/apply/status')
  })

  app.get('/apply', async (request, reply) => {
    const viewer = requireViewer(request)
    if (viewer.user.status === 'approved') return reply.redirect('/dashboard')
    if (viewer.user.status !== 'onboarding') return reply.redirect('/apply/status')
    return reply.type('text/html').send(
      applyPage({ config, locale: request.locale ?? 'zh', viewer: viewOf(viewer), notice: request.flash?.notice?.text, error: request.flash?.error?.text }),
    )
  })

  app.post('/apply', async (request, reply) => {
    const viewer = csrfGuard(request)
    if (viewer.user.status !== 'onboarding') return reply.redirect('/apply/status')
    const body = form(request)
    const signature = (body.signature ?? '').trim()
    if (signature.toLowerCase() !== viewer.user.login.toLowerCase()) {
      throw httpError(400, '签名必须与你的 GitHub 登录名一致。', 'BAD_SIGNATURE')
    }
    if (body.disclaimer !== '1' || body.security !== '1') {
      throw httpError(400, '请逐项勾选免责声明和信息安全承诺。', 'AGREEMENT_REQUIRED')
    }
    const submitted = store.submitApplication(viewer.user.id, {
      name: signature,
      disclaimerVersion: AGREEMENT_VERSION,
      securityVersion: AGREEMENT_VERSION,
      agreementHash: agreementHashFor(request.locale ?? 'zh'),
      ip: request.ip,
      userAgent: String(request.headers['user-agent'] ?? '').slice(0, 300),
    })
    if (!submitted) return reply.redirect('/apply/status')
    const updated = store.userById(viewer.user.id)!
    store.audit(viewer.user.id, 'application.submitted', `queue #${store.queuePosition(viewer.user.id) ?? '?'}`)
    store.event('application_submitted', { userId: viewer.user.id })
    const position = store.queuePosition(updated.id)
    try {
      await approvals.request(updated)
    } catch (error) {
      log.error('approval request mail failed', { user: updated.login, error: String(error) })
    }
    try {
      await approvals.acknowledge(updated, position)
    } catch (error) {
      log.warn('application acknowledgement failed', { user: updated.login, error: String(error) })
    }
    return reply.redirect(`/apply/status?notice=${encodeURIComponent('申请已提交，正在排队。')}`)
  })

  app.get('/apply/status', async (request, reply) => {
    const viewer = requireViewer(request)
    if (viewer.user.status === 'approved') return reply.redirect('/dashboard')
    if (viewer.user.status === 'onboarding') return reply.redirect('/apply')
    if (viewer.user.status === 'pending' && viewer.user.approval_sent_at === null) {
      // This page refreshes every 10 seconds, so a failing retry must not write an
      // audit row each time; the failure marker comes from the submit attempt and
      // from an admin resend, which do audit.
      void approvals
        .request(viewer.user, { auditFailure: false })
        .catch((error) => log.warn('approval mail retry failed', { user: viewer.user.login, error: String(error) }))
    }
    return reply.type('text/html').send(
      applicationStatusPage({
        config,
        locale: request.locale ?? 'zh',
        viewer: viewOf(viewer),
        position: store.queuePosition(viewer.user.id),
        total: store.pendingTotal(),
        notice: request.flash?.notice?.text,
        error: request.flash?.error?.text,
        mailFailed: approvalMailFailed(viewer.user, store.approvalMailFailures()),
      }),
    )
  })

  app.get('/api/application', async (request, reply) => {
    const viewer = requireViewer(request)
    reply.header('cache-control', 'no-store')
    return {
      status: viewer.user.status,
      login: viewer.user.login,
      position: store.queuePosition(viewer.user.id),
      pending: store.pendingTotal(),
      submittedAt: viewer.user.application_submitted_at,
      reviewedAt: viewer.user.reviewed_at,
    }
  })

  // #541: the first read of the identity rows. It describes the caller's own
  // capabilities and never selects a token, a key or any other secret column.
  app.get('/api/auth/me', async (request, reply) => {
    const viewer = requireApproved(request)
    reply.header('cache-control', 'no-store')
    const actor = resolveUserActor(store, viewer.user.id, { channel: 'api', requestId: request.id })
    const roleRank: Record<string, number> = { viewer: 1, developer: 2, maintainer: 3 }
    const byProject = new Map<string, { tenantId: string | null; role: string | null; capabilities: Set<Capability> }>()
    for (const scope of listEffectiveScopes(store, viewer.user.id)) {
      if (scope.projectId === null) continue
      let entry = byProject.get(scope.projectId)
      if (entry === undefined) {
        entry = { tenantId: scope.tenantId, role: scope.role, capabilities: new Set<Capability>() }
        byProject.set(scope.projectId, entry)
      }
      if (entry.tenantId === null) entry.tenantId = scope.tenantId
      if (scope.role !== null && (entry.role === null || (roleRank[scope.role] ?? 0) > (roleRank[entry.role] ?? 0))) entry.role = scope.role
      for (const capability of scope.capabilities) entry.capabilities.add(capability)
    }
    const projects = [...byProject.entries()]
      .map(([projectId, entry]) => {
        const repo = store.getRepo(projectId)
        return {
          id: projectId,
          repoId: projectId,
          tenantId: entry.tenantId,
          role: entry.role,
          owner: repo?.owner ?? null,
          name: repo?.name ?? null,
          fullName: repo === undefined ? null : `${repo.owner}/${repo.name}`,
          capabilities: [...entry.capabilities].sort(),
        }
      })
      .sort((left, right) => (left.fullName ?? left.id).localeCompare(right.fullName ?? right.id))
    return {
      user: {
        id: viewer.user.id,
        login: viewer.user.login,
        name: viewer.user.name,
        role: viewer.user.role,
        status: viewer.user.status,
      },
      tenantIds: [...new Set(projects.map((project) => project.tenantId).filter((tenantId): tenantId is string => tenantId !== null))].sort(),
      platformCapabilities: [...platformCapabilitiesForRole(viewer.user.role)].sort(),
      capabilities: [...actor.capabilities].sort(),
      projects,
    }
  })

  app.get('/dashboard', async (request, reply) => {
    const viewer = requireApproved(request)
    const view = viewOf(viewer)
    const windowDays = queryText(request, 'window') === '30' ? 30 : 7
    const since = new Date(Date.now() - windowDays * 86_400_000).toISOString()
    const personal = store.personalMetrics(viewer.user.id, since)
    const alerts = store.alerts({ userId: viewer.user.id, usdCny: config.quota.usdCny, automationIdleMinutes: config.ops.automationIdleAlertMinutes, instancesManaged: config.flybot.instanceImage !== '' })
    const perPage = 10
    const allRepos = store.listRepos(viewer.user.id)
    // #232: the job filters are read from the query on every request and applied
    // in SQL, so the URL, the count and the page always describe the same list.
    const jobFilter = parseJobFilters(
      { repo: queryText(request, 'repo'), status: queryText(request, 'status'), kind: queryText(request, 'kind'), priority: queryText(request, 'priority') },
      allRepos.map((repo) => repo.id),
    )
    // #105: the dashboard lists shared repositories too, so its total counts
    // what this viewer can see rather than what they own.
    const reposTotal = store.countReposForViewer(viewer.user.id)
    const jobsTotal = store.countJobsForUser(viewer.user.id, jobFilter)
    const pageNumber = (name: string, total: number): number => {
      const pages = Math.max(1, Math.ceil(total / perPage))
      const n = Number(queryText(request, name))
      return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), pages) : 1
    }
    const reposPage = pageNumber('reposPage', reposTotal)
    const jobsPage = pageNumber('jobsPage', jobsTotal)
    const repos = store.listReposPage(viewer.user.id, perPage, (reposPage - 1) * perPage)
    const jobs = store.listJobsPageForUser(viewer.user.id, perPage, (jobsPage - 1) * perPage, jobFilter)
    // #230 review: the dashboard headline is the account's newest job. The table
    // above is one page of a filtered list, so its first row is not that job.
    const latestJob = store.listJobsPageForUser(viewer.user.id, 1, 0)[0]
    const questions = await inboxForUser(viewer.user.id, allRepos)
    const firstJob = store.firstJobForUser(viewer.user.id)
    // #227: the checklist state is read from the database on this request, never
    // from a cookie, so a second tab or a fresh browser sees the same step.
    // #734: the checklist describes the account, not the job table. `jobsTotal`
    // carries the current filter for the table; the checklist must not read it.
    const setupJobsTotal = store.countJobsForUser(viewer.user.id)
    // #732: a provider row is not an own model until a repository selects it (or
    // the legacy user-level model is set). The gateway and the bridge both read
    // the repository selection, so the checklist must use the same answer.
    const providerConfigured = store
      .listModelProviders(viewer.user.id)
      .some((provider) => store.listProviderModels(provider.id).length > 0)
    const setupQuota = quotaView(viewer.user, config)
    const platformAvailable =
      config.llm.baseUrl !== '' &&
      config.llm.key !== '' &&
      !setupQuota.exhausted
    const setup = {
      repos: reposTotal,
      roleChosen: allRepos.some((repo) => repo.repo_role !== null),
      providerConfigured,
      modelConfigured: ownModelConfigured(store, viewer.user, allRepos),
      platformAvailable,
      platformQuotaRemainingCny: setupQuota.remainingCny,
      platformQuotaUnlimited: setupQuota.unlimited,
      platformQuotaComfortCny: config.quota.comfortCny,
      instanceReady: allRepos.some((repo) => store.getRepoInstance(repo.id)?.status === 'ready'),
      jobs: setupJobsTotal,
      firstJobStatus: firstJob?.status ?? null,
      firstPrUrl: firstJob?.pr_url ?? null,
      repoHref: allRepos[0] === undefined ? null : `/repos/${allRepos[0].id}`,
    }
    // #564: open work, an active job and a ready instance decide when a
    // repository runs again, and none of them is on RepoRow.
    // #688: a repository that has saved a schedule row is answered by the planner,
    // so its answer travels with the facts instead of being re-derived from the
    // interval rule the card used to apply to every repository.
    const nextRunFacts = allRepos.map((repo) => {
      const scheduleRow = store.scheduleForRepo(repo.id)
      return {
        repoId: repo.id,
        openWork: store.listOpenWorkItems(repo.id).length > 0,
        activeJob: store.activeJobForRepo(repo.id) !== undefined,
        instanceReady: store.getRepoInstance(repo.id)?.status === 'ready',
        // #723: the worker only considers an enabled repository (`listAutoRepos`
        // is `WHERE enabled = 1 AND auto_iterate = 1`), so a paused repository
        // must not travel with a planner answer the card would treat as runnable.
        ...(scheduleRow === undefined || repo.enabled !== 1 ? {} : { scheduledNext: scheduledNextFor(scheduleRow) }),
      }
    })
    // #655: the home answers "what needs me now?" once per repository, so it
    // reads each repository's own newest runs instead of the paged table slice;
    // a failure in the eleventh repository is still the first thing to fix.
    const decisionJobs = allRepos.flatMap((repo) => store.listJobsForRepo(repo.id, 5))
    return reply.type('text/html').send(
      dashboardPage({
        config,
        locale: request.locale ?? 'zh',
        viewer: view,
        repos,
        jobs,
        latestJob,
        setup,
        // #1104 test regression: with no repository and no own model the account is
        // in its starting state, so the spent platform quota still has a banner.
        platformFunded: platformQuotaPausesSomething(store, viewer.user, allRepos, setup.modelConfigured),
        reposPage,
        reposTotal,
        jobsPage,
        jobsTotal,
        jobFilter,
        repoOptions: allRepos.map((repo) => ({ id: repo.id, label: `${repo.upstream_owner || repo.owner}/${repo.upstream_name || repo.name}` })),
        allRepos,
        nextRunFacts,
        decisionJobs,
        queued: store.listQueuedJobs(),
        questions,
        personal,
        windowDays,
        alerts,
        // #1198: the dashboard reads the same clock verdict admission reads, so
        // a console opened during a `fail` says why Run now is refused before the
        // user presses it. `readyz` and the refusal sentence are unchanged.
        clock: githubApp.clockState(),
        notifications: store.listNotifications(viewer.user.id),
        actions: store.listActions(viewer.user.id),
        notice: request.flash?.notice?.text,
        error: request.flash?.error?.text,
      }),
    )
  })

  app.get('/api/read/metrics', async (request, _reply) => {
    const viewer = requireApproved(request)
    const windowDays = queryText(request, 'window') === '30' ? 30 : 7
    const since = new Date(Date.now() - windowDays * 86_400_000).toISOString()
    if (viewer.user.role === 'superadmin' && viewer.preview !== true) {
      return {
        windowDays,
        since,
        product: store.productMetrics(since),
        delivery: store.deliveryMetrics(since),
        daily: store.dailyMetrics(since),
        team: store.teamMetrics(since),
        repoCosts: store.repoCostMetrics(since),
        modelCosts: store.modelCostMetrics(since),
        alerts: store.alerts({ usdCny: config.quota.usdCny, automationIdleMinutes: config.ops.automationIdleAlertMinutes, instancesManaged: config.flybot.instanceImage !== '' }),
      }
    }
    return { windowDays, since, personal: store.personalMetrics(viewer.user.id, since), alerts: store.alerts({ userId: viewer.user.id, usdCny: config.quota.usdCny, automationIdleMinutes: config.ops.automationIdleAlertMinutes, instancesManaged: config.flybot.instanceImage !== '' }) }
  })

  // #392: the first token-authenticated read route. It sits outside the session
  // surface on purpose — an `flg_` token with `jobs:read` is the only way in —
  // and it answers with the gateway's three shapes through the shared
  // authenticator, so the two surfaces cannot disagree about what a token is.
  app.get('/api/v1/jobs', async (request, reply) => {
    if (!apiLimiter.take(`api-v1-jobs:${rateLimitKey(request)}`)) return reply.code(429).send({ error: { type: 'rate_limited', message: 'Too many API requests' } })
    const auth = authenticateApiToken(request, store, JOBS_READ_SCOPE)
    if (auth.kind === 'unauthorized') return reply.code(401).send({ error: { type: 'invalid_api_key', message: 'Missing or invalid Fledge API token' } })
    if (auth.kind === 'forbidden') return reply.code(403).send({ error: { type: 'insufficient_scope', message: 'This Fledge API token is not allowed to read jobs' } })
    const cursorId = queryText(request, 'cursor')
    let after: { createdAt: string; rowid: number } | null = null
    if (cursorId !== undefined) {
      // An id that is not one of the caller's jobs is not a cursor. Answering the
      // first page again would silently repeat rows the caller already has.
      const resolved = store.jobCursorForUser(auth.user.id, cursorId)
      if (resolved === undefined) {
        return reply.code(400).send({ error: { type: 'invalid_cursor', message: 'cursor must be the id of one of your own jobs' } })
      }
      after = resolved
    }
    const limit = jobPageLimit(queryText(request, 'limit'))
    // One extra row decides `next_cursor` without a second query, and the extra
    // row is not returned.
    const rows = store.listJobsForUserAfter(auth.user.id, limit + 1, after)
    const page = rows.slice(0, limit)
    const last = page[page.length - 1]
    return { data: page.map(jobSummary), next_cursor: rows.length > limit && last !== undefined ? last.id : null }
  })

  app.get('/console', async (request, reply) => {
    const viewer = requireApproved(request)
    const repos = store.listRepos(viewer.user.id)
    const questions = await inboxForUser(viewer.user.id, repos)
    return reply.type('text/html').send(
      workspacePage({
        config,
        locale: request.locale ?? 'zh',
        viewer: viewOf(viewer),
        repos,
        jobs: store.listJobs(viewer.user.id),
        jobsTotal: store.countJobsForUser(viewer.user.id),
        activeJobs: store.listActiveJobsForUser(viewer.user.id).length,
        questions,
        // #1104 review: the console reads the same rule the dashboard does, so
        // its quota banner does not tell an own-model account that its jobs
        // stopped, does not hide the pause from a mixed account, and keeps the
        // notice for an account that has chosen no model and connected nothing.
        platformFunded: platformQuotaPausesSomething(store, viewer.user, repos, ownModelConfigured(store, viewer.user, repos)),
        notice: request.flash?.notice?.text,
        error: request.flash?.error?.text,
      }),
    )
  })

  // #362: the query is anchored on `viewer.user.id`, so an unknown `repo` is dropped
  // and never answered; `kind` is applied as given, so an unknown kind matches nothing.
  app.get('/search', async (request, reply) => {
    const viewer = requireApproved(request)
    const repos = store.listRepos(viewer.user.id)
    const clip = (name: string, max: number): string => (queryText(request, name) ?? '').trim().slice(0, max)
    const day = (name: string): string => {
      const value = clip(name, 10)
      return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ''
    }
    const [status, kind, repo] = [clip('status', 30), clip('kind', 30), clip('repo', 64)]
    const [from, to] = [day('from'), day('to')]
    const filters = {
      q: clip('q', 200),
      repo: repos.some((row) => row.id === repo) ? repo : '',
      // #568: the same list the control renders, so a status the form offers can never be dropped here.
      status: (JOB_FILTER_STATUSES as string[]).includes(status) ? status : '',
      kind,
      from: from === '' ? '' : `${from}T00:00:00.000Z`, to: to === '' ? '' : `${to}T23:59:59.999Z`,
    }
    return reply.type('text/html').send(searchPage({
      config,
      locale: request.locale ?? 'zh',
      viewer: viewOf(viewer),
      repos,
      filters: { q: filters.q, repo: filters.repo, status: filters.status, kind: filters.kind, from, to },
      // An empty query is not a listing: it is the same empty state with a next step.
      results: filters.q === '' ? null : store.searchOwned(viewer.user.id, filters, 20),
      cap: 20,
      notice: request.flash?.notice?.text,
      error: request.flash?.error?.text,
    }))
  })

  // #544, second slice: the planner's first surface a person can reach. The page
  // and the JSON below take the same query names and call the same planner, so
  // what a maintainer reads on the page is what an integration would get.
  app.get('/api/schedule/preview', async (request, reply) => {
    requireApproved(request)
    const t = translator(request.locale ?? 'zh')
    const parsed = parsePreviewQuery(previewQuery(request), Date.now(), t)
    if (!parsed.ok) return reply.code(400).send({ error: parsed.reason })
    const preview = previewSchedule(parsed.request, t)
    if (!preview.ok) return reply.code(400).send({ error: preview.reason })
    return preview
  })

  app.get('/schedule', async (request, reply) => {
    const viewer = requireApproved(request)
    const locale = request.locale ?? 'zh'
    const t = translator(locale)
    const query = previewQuery(request)
    // #1058: the interval panel has no zone control, so a zone can only reach this
    // mode from a hand-written URL. It stays on `query` so the form echoes back the
    // value it was given — removing it here replaced the maintainer's zone with the
    // default in the select, a rewrite of the submitted form — and only the planner
    // input drops it, because the interval rule refuses a zone by name in both
    // shapes and the page must not pass one its form cannot produce.
    const planned = query.mode === 'interval' ? { ...query, timezone: undefined } : query
    // No query at all is the empty form, not a refusal: opening the page should
    // not look like an error.
    const asked = Object.values(query).some((value) => value !== undefined)
    const parsed = asked ? parsePreviewQuery(planned, Date.now(), t) : null
    let preview: Extract<PreviewResult, { ok: true }> | null = null
    let error: string | undefined
    if (parsed !== null) {
      if (!parsed.ok) {
        error = parsed.reason
      } else {
        const result = previewSchedule(parsed.request, t)
        if (result.ok) preview = result
        else error = result.reason
      }
    }
    const mode = query.mode ?? (query.cron !== undefined ? 'custom' : query.every !== undefined ? 'interval' : 'daily')
    const page = schedulePage({
      config,
      locale: request.locale ?? 'zh',
      viewer: viewOf(viewer),
      form: {
        mode,
        cron: query.cron ?? '',
        everyAmount: query.every_amount ?? (query.every === undefined ? '15' : (query.every.replace(/[^0-9].*$/, '') || '15')),
        everyUnit: query.every_unit ?? (query.every === undefined ? 'm' : (query.every.slice(-1) || 'm')),
        // The mode's own field first: the page names each panel's clock after
        // its mode, and `time` is the API's single name (#677).
        time: query[`${mode}_time`] ?? query.time ?? '09:00',
        weekday: query.weekday ?? '1',
        monthDay: query.month_day ?? '1',
        timezone: query.timezone ?? '',
        startAt: query.start_at ?? '',
        endAt: query.end_at ?? '',
        from: query.from ?? '',
        count: query.count ?? '5',
      },
      preview,
      error,
    })
    return htmlPage(reply, error === undefined ? 200 : 400, page)
  })

  // #544 slice 3A/3B, the console: the page a maintainer reads, and the write
  // that makes `saveSchedule` reachable in the product at all. Once the row
  // exists it owns the repository's cadence, so this route is the only door to it.
  app.get('/repos/:id/schedule', async (request, reply) => {
    const { viewer, repo, role } = ownedRepo(request, String((request.params as Record<string, string>).id))
    const locale = request.locale ?? 'zh'
    const t = translator(locale)
    const row = store.scheduleForRepo(repo.id)
    const now = Date.now()
    const state = scheduleConsole({
      repoId: repo.id,
      row,
      // #544: today's repository row, so the frozen authorization the occurrence
      // recorded can be shown against what the repository says now.
      repo,
      occurrences: store.listScheduleOccurrences(repo.id, 20),
      // #1055: the success is read at any age, not searched for in the window
      // above — a schedule skipped twenty times after a good run still has one.
      lastSucceeded: store.newestSucceededDispatch(repo.id),
      now,
      jobStatus: (jobId) => store.getJob(jobId)?.status ?? null,
      // #544: the delivery fact is the state of the notification the newest run's
      // job queued, read from the outbox rather than assumed unknown. A job that
      // queued nothing answers empty, which the console prints as `none`.
      jobDeliveries: (jobId) => store.notificationsForJob(jobId),
      // #544 slice 6: the same count function the worker charges with, read over
      // today's UTC day — the worker charges the *instant's* day, so a catch-up
      // run can spend a past day while this fact answers "how much of today is
      // used". A repository with no schedule row read no count, which is unknown.
      ...(row === undefined ? {} : { runsToday: store.countScheduleDispatchesBetween(row.id, utcDayStart(now), utcDayEnd(now)) }),
    })
    const refused = queryText(request, 'refused')
    const instant = (value: number | null | undefined): string => (value === null || value === undefined ? '' : new Date(value).toISOString())
    return reply.type('text/html').send(scheduleConsolePage({
      config,
      locale,
      viewer: viewOf(viewer),
      repo,
      state,
      // #903: the role the viewer holds decides which controls the page offers.
      role,
      // #544 slice 8: the run-now form carries a key rendered once, so a double
      // click is one command and a fresh page is a new one.
      runNowKey: randomId('cmd'),
      form: {
        cron: row?.expression ?? '',
        every: row?.every_ms === null || row?.every_ms === undefined ? '' : intervalFieldText(row.every_ms),
        timezone: row?.timezone ?? '',
        startAt: instant(row?.start_at),
        endAt: instant(row?.end_at),
        misfire: row?.misfire ?? 'skip',
        // Minutes, because a person thinks in minutes and the stored column is
        // milliseconds. Empty means no bound, which is the old behaviour.
        grace: row?.grace_ms === null || row?.grace_ms === undefined ? '' : String(Math.round(row.grace_ms / 60_000)),
        dailyRuns: row?.daily_runs === null || row?.daily_runs === undefined ? '' : String(row.daily_runs),
      },
      ...(queryText(request, 'saved') === undefined ? {} : { notice: t('排期已保存。', 'The schedule is saved.') }),
      ...(queryText(request, 'ran') === undefined ? {} : { notice: t('已立即开始一次运行。', 'One run has started now.') }),
      ...(queryText(request, 'removed') === undefined ? {} : { notice: t('排期已删除，仓库回到旧的自动间隔。', 'The schedule was deleted; the repository is back on the legacy interval.') }),
      ...(queryText(request, 'paused') === undefined ? {} : { notice: t('排期已暂停：期间走过的时刻记为 skipped，不会补跑。', 'The schedule is paused: instants that pass are recorded as skipped and are not made up.') }),
      ...(queryText(request, 'resumed') === undefined ? {} : { notice: t('排期已恢复，从下一个时刻开始运行。', 'The schedule is resumed and runs from the next instant.') }),
      ...(refused === undefined ? {} : { error: refused }),
    }))
  })

  // The form is the same query shape the preview takes, so the console and the
  // preview cannot disagree about what a legal schedule is. A refusal comes back
  // as a reason naming the field, and nothing is written.
  app.post('/repos/:id/schedule', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const back = `/repos/${repo.id}/schedule`
    const body = form(request)
    const t = translator(request.locale ?? 'zh')
    const parsed = parsePreviewQuery({
      cron: String(body.cron ?? '').trim(),
      every: String(body.every ?? '').trim(),
      timezone: String(body.timezone ?? '').trim(),
      start_at: String(body.start_at ?? '').trim(),
      end_at: String(body.end_at ?? '').trim(),
    }, Date.now(), t)
    if (!parsed.ok) return reply.redirect(`${back}?refused=${encodeURIComponent(parsed.reason)}`)
    const schedule = parsed.request.schedule
    const existing = store.scheduleForRepo(repo.id)
    // #544 slice 5: the misfire policy and its grace bound are part of the
    // schedule a person saves, not a column only a migration could write. `skip`
    // is the default and an empty grace field means no bound, so a form that
    // predates these fields keeps the behaviour it had.
    const misfire = body.misfire === 'once' ? 'once' : 'skip'
    const graceRaw = String(body.grace ?? '').trim()
    const graceMinutes = graceRaw === '' ? null : Number(graceRaw)
    // #1053: the sentence below says integer, so a fractional field is refused
    // rather than rounded into a bound the person never typed.
    if (graceMinutes !== null && (!Number.isInteger(graceMinutes) || graceMinutes < 0 || graceMinutes > 10_080)) {
      return reply.redirect(`${back}?refused=${encodeURIComponent(t('宽限时间必须是 0 到 10080 分钟之间的整数。', 'The grace bound must be an integer between 0 and 10080 minutes.'))}`)
    }
    // #544 slice 6: an absent field keeps the stored limit, so a form that
    // predates the budget cannot silently clear it. An explicit empty field is
    // unbounded, which is the behaviour every schedule had.
    const dailyRunsField = body.daily_runs
    const parsedDailyRuns = dailyRunsField === undefined
      ? ({ ok: true, dailyRuns: undefined } as const)
      : parseDailyRuns(String(dailyRunsField))
    if (!parsedDailyRuns.ok) {
      const message = parsedDailyRuns.reason === 'not-an-integer'
        ? t('每日运行上限必须是大于 0 的整数。', 'The daily run limit must be a whole number greater than 0.')
        : t(`每日运行上限必须在 1 到 ${DAILY_RUNS_MAX} 之间。`, `The daily run limit must be between 1 and ${DAILY_RUNS_MAX}.`)
      return reply.redirect(`${back}?refused=${encodeURIComponent(message)}`)
    }
    store.saveSchedule({
      id: existing?.id ?? randomId('sch'),
      repoId: repo.id,
      kind: schedule.kind,
      expression: schedule.kind === 'cron' ? schedule.expression : null,
      everyMs: schedule.kind === 'interval' ? schedule.everyMs : null,
      timezone: schedule.kind === 'cron' ? schedule.timezone : null,
      startAt: schedule.startAt,
      endAt: schedule.endAt,
      misfire,
      graceMs: graceMinutes === null ? null : Math.round(graceMinutes) * 60_000,
      dailyRuns: parsedDailyRuns.dailyRuns,
    })
    const label = schedule.kind === 'cron'
      ? `${schedule.expression} ${schedule.timezone}`
      : `every ${intervalFieldText(schedule.everyMs)}`
    store.audit(viewer.user.id, 'schedule.saved', `${repo.id}: ${label}`)
    return reply.redirect(`${back}?saved=1`)
  })

  // #544 slice 8: Run now is one explicit occurrence. The key the page rendered
  // makes a double click the same command; the recurrence cursor is untouched,
  // so "run this now" never moves when the schedule next fires.
  app.post('/repos/:id/schedule/run-now', async (request, reply) => {
    // #903: `ownedRepo` has already answered the role question — it refuses a
    // viewer and resolves the connection owner as the maintainer of last resort.
    // Running now is work, so the actor's role is the rule; `repo.repo_role` is a
    // declaration about Fledge's access to the upstream and is NULL on a
    // repository connected today, which is why reading it locked the owner out.
    const { repo, role } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const back = `/repos/${repo.id}/schedule`
    const t = translator(request.locale ?? 'zh')
    const result = await jobs.runScheduleNow(repo, form(request).command_key, role)
    if (!result.ok) {
      // #1047: the refusal travels as its code and parameter, so the banner
      // builds the sentence in the console's language instead of echoing the
      // Chinese-only sentence the job service wrote.
      const message = result.code === 'schedule_missing'
        ? t('这个仓库还没有排期。', 'This repository has no schedule yet.')
        : refusalValue({ code: result.code, detail: result.detail, error: result.message }, t('这次运行没有开始。', 'The run did not start.'))
      return reply.redirect(`${back}?refused=${encodeURIComponent(message)}`)
    }
    return reply.redirect(`${back}?ran=${encodeURIComponent(result.jobId ?? '')}`)
  })

  // #544 slice 9: pausing is a decision about the schedule, not an edit of it, so
  // it has its own route and its own audit action. Both are maintainer-only:
  // stopping or restarting the cadence a repository agreed to is a
  // settings-level act, while a viewer may still read the console. Pausing an
  // already paused schedule writes nothing the second time, so a double submit
  // does not move the instant the paused window started.
  app.post('/repos/:id/schedule/pause', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true, true)
    const back = `/repos/${repo.id}/schedule`
    const t = translator(request.locale ?? 'zh')
    const existing = store.scheduleForRepo(repo.id)
    if (existing === undefined) {
      return reply.redirect(`${back}?refused=${encodeURIComponent(t('这个仓库还没有排期。', 'This repository has no schedule yet.'))}`)
    }
    const row = store.setScheduleStatus(repo.id, 'paused', Date.now())
    if (row !== undefined && existing.status !== 'paused') {
      store.audit(viewer.user.id, 'schedule.pause', `${repo.id}: ${existing.kind} ${existing.expression ?? `${String(existing.every_ms)}ms`}`)
    }
    return reply.redirect(`${back}?paused=1`)
  })

  // Resuming is the same write in the other direction; it does not create an
  // occurrence or move the cursor, so a resume cannot itself cause a run.
  app.post('/repos/:id/schedule/resume', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true, true)
    const back = `/repos/${repo.id}/schedule`
    const t = translator(request.locale ?? 'zh')
    const existing = store.scheduleForRepo(repo.id)
    if (existing === undefined) {
      return reply.redirect(`${back}?refused=${encodeURIComponent(t('这个仓库还没有排期。', 'This repository has no schedule yet.'))}`)
    }
    const row = store.setScheduleStatus(repo.id, 'active', Date.now())
    if (row !== undefined && existing.status === 'paused') {
      store.audit(viewer.user.id, 'schedule.resume', `${repo.id}: ${existing.kind} ${existing.expression ?? `${String(existing.every_ms)}ms`}`)
    }
    return reply.redirect(`${back}?resumed=1`)
  })

  // Deleting the row hands the repository back to its legacy interval; it does
  // not stop the repository, so the audit says which schedule stopped owning it.
  app.post('/repos/:id/schedule/remove', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const existing = store.scheduleForRepo(repo.id)
    if (existing !== undefined) {
      store.deleteSchedule(repo.id)
      store.audit(viewer.user.id, 'schedule.removed', `${repo.id}: ${existing.kind} ${existing.expression ?? `${String(existing.every_ms)}ms`}`)
    }
    return reply.redirect(`/repos/${repo.id}/schedule?removed=1`)
  })

  app.get('/repos', async (_request, reply) => {
    return reply.redirect('/dashboard#add-repo')
  })

  app.get('/auth/github/app/install', async (request, reply) => {
    const viewer = requireApproved(request)
    if (config.githubApp.slug === '') return reply.redirect(`/repos/new?error=${encodeURIComponent('GitHub App 未配置。')}`)
    const state = randomToken(16)
    store.setSetting(`github_app_state:${state}`, `${viewer.user.id}:${Date.now()}`)
    return reply.redirect(`https://github.com/apps/${encodeURIComponent(config.githubApp.slug)}/installations/new?state=${encodeURIComponent(state)}`)
  })

  app.get('/auth/github/app/callback', async (request, reply) => {
    const query = request.query as Record<string, unknown>
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (typeof value === 'string') params.set(key, value)
    }
    return reply.redirect(`/auth/github/app/installed${params.size === 0 ? '' : `?${params.toString()}`}`)
  })

  app.get('/auth/github/app/installed', async (request, reply) => {
    const viewer = requireApproved(request)
    if (!githubApp.configured) return reply.redirect(`/repos/new?error=${encodeURIComponent('GitHub App 未配置。')}`)
    let installationId = Number(queryText(request, 'installation_id'))
    if (!Number.isFinite(installationId) || installationId <= 0) {
      const bound = store.listInstallations(viewer.user.id)
      if (bound.length === 1) return reply.redirect(`/repos/new?installation=${bound[0]!.installation_id}`)
      if (bound.length > 1) return reply.redirect('/repos/new')
      try {
        const all = await githubApp.listInstallations()
        const now = Date.now()
        const candidates = all.filter((candidate) => {
          const existing = store.getInstallation(candidate.id)
          if (existing !== undefined && existing.user_id !== viewer.user.id) return false
          if (candidate.account.type === 'User' && candidate.account.login.toLowerCase() === viewer.user.login.toLowerCase()) return true
          const sender = store.getSetting(`installation_sender:${candidate.id}`)
          if (sender === undefined) return false
          const [login = '', at = '0'] = sender.split(':')
          return login.toLowerCase() === viewer.user.login.toLowerCase() && now - Number(at) < 24 * 60 * 60_000
        })
        if (candidates.length === 1) {
          const candidate = candidates[0]!
          store.saveInstallation({ installationId: candidate.id, userId: viewer.user.id, accountLogin: candidate.account.login, accountType: candidate.account.type })
          return reply.redirect(`/repos/new?installation=${candidate.id}`)
        }
      } catch (error) {
        log.warn('github app install fallback failed', { user: viewer.user.login, error: String(error) })
      }
      return reply.redirect(`/repos/new?error=${encodeURIComponent('安装回调缺少 installation_id；请在 GitHub App 设置的 Setup URL 指向 /auth/github/app/installed，或从已安装列表重新选择仓库。')}`)
    }
    let installation
    try {
      installation = await githubApp.getInstallation(installationId)
    } catch (error) {
      log.warn('github app installation lookup failed', { installationId, error: String(error) })
    }
    if (installation === undefined || installation === null) return reply.redirect(`/repos/new?error=${encodeURIComponent('找不到这个 GitHub App 安装。')}`)
    let stateOk = true
    const state = queryText(request, 'state') ?? ''
    if (state !== '') {
      const value = store.getSetting(`github_app_state:${state}`)
      const [userId = '', at = '0'] = value === undefined ? [] : value.split(':')
      stateOk = userId === viewer.user.id && Date.now() - Number(at) < 10 * 60_000
      store.deleteSetting(`github_app_state:${state}`)
    }
    if (!stateOk) return reply.redirect(`/repos/new?error=${encodeURIComponent('安装状态已过期，请重新从工作区发起安装。')}`)
    const existing = store.getInstallation(installationId)
    if (existing !== undefined && existing.user_id !== viewer.user.id) {
      return reply.redirect(`/repos/new?error=${encodeURIComponent('这个安装已经绑定到另一个 Fledge 用户。')}`)
    }
    let owned = false
    {
      const sender = store.getSetting(`installation_sender:${installationId}`)
      if (sender !== undefined) {
        const [login = '', at = '0'] = sender.split(':')
        if (login.toLowerCase() === viewer.user.login.toLowerCase() && Date.now() - Number(at) < 24 * 60 * 60_000) owned = true
      }
    }
    if (!owned && viewer.user.github_token_enc !== null) {
      try {
        const token = decryptSecret(viewer.user.github_token_enc, config.tokenEncryptionKey)
        const installations = await new GithubClient(token, config.github.apiBase).listUserInstallations()
        owned = installations.some((entry) => entry.id === installationId)
      } catch (error) {
        log.warn('github app user installation check failed', { user: viewer.user.login, error: String(error) })
      }
    }
    if (!owned) owned = installation.account.type === 'User' && installation.account.login.toLowerCase() === viewer.user.login.toLowerCase()
    if (!owned) return reply.redirect(`/repos/new?error=${encodeURIComponent('这个安装不属于当前 GitHub 用户；请用安装它的账号登录。')}`)
    store.saveInstallation({ installationId, userId: viewer.user.id, accountLogin: installation.account.login, accountType: installation.account.type })
    store.audit(viewer.user.id, 'github_app.installed', `${installationId} @${installation.account.login}`)
    store.event('github_app_installed', { userId: viewer.user.id, meta: `@${installation.account.login}` })
    return reply.redirect(`/repos/new?installation=${installationId}`)
  })

  app.get('/repos/new', async (request, reply) => {
    const viewer = requireApproved(request)
    if (!githubApp.configured) return reply.redirect(`/dashboard?error=${encodeURIComponent('GitHub App 未配置；仍可使用 PAT 接入。')}#add-repo`)
    const installations = store.listInstallations(viewer.user.id)
    const raw = Number(queryText(request, 'installation'))
    const installationId = Number.isFinite(raw) && raw > 0 ? raw : undefined
    let repos
    let error = request.flash?.error?.text
    if (installationId !== undefined) {
      const owned = store.getInstallation(installationId)
      if (owned === undefined || owned.user_id !== viewer.user.id) throw httpError(404, '安装不存在。', 'INSTALLATION_NOT_FOUND')
      try {
        repos = await githubApp.installationRepos(installationId)
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause)
      }
    }
    // #1099: the picker has to tell a repository this workspace already holds
    // from a fresh one; the set lives here, so the view is told rather than left
    // to re-read the store.
    const connected = new Map(store.listRepos(viewer.user.id).map((repo) => [`${repo.owner}/${repo.name}`.toLowerCase(), repo.id]))
    return reply.type('text/html').send(appReposPage({
      config,
      locale: request.locale ?? 'zh',
      viewer: viewOf(viewer),
      installations,
      installationId,
      repos,
      connected,
      notice: request.flash?.notice?.text,
      error,
    }))
  })

  app.post('/repos/app', async (request, reply) => {
    const viewer = approvedCsrfGuard(request)
    if (!githubApp.configured) return reply.redirect(`/dashboard?error=${encodeURIComponent('GitHub App 未配置。')}#add-repo`)
    const body = (request.body ?? {}) as Record<string, unknown>
    const installationId = Number(body.installation)
    const installation = store.getInstallation(installationId)
    if (installation === undefined || installation.user_id !== viewer.user.id) throw httpError(404, '安装不存在。', 'INSTALLATION_NOT_FOUND')
    const rawSelected = body.repo
    const selected = (Array.isArray(rawSelected) ? rawSelected : [rawSelected]).filter((value): value is string => typeof value === 'string' && value.includes('/'))
    if (selected.length === 0) return reply.redirect(`/repos/new?installation=${installationId}&error=${encodeURIComponent('请选择至少一个仓库。')}`)
    const goal = (typeof body.goal === 'string' ? body.goal : '').slice(0, 4000)
    const autoIterate = body.auto === '1'
    const interval = normalizeInterval(typeof body.interval === 'string' ? body.interval : undefined, 1440)
    const review = body.review === '1'
    const reviewInterval = normalizeInterval(typeof body.reviewInterval === 'string' ? body.reviewInterval : undefined, 1440)
    let available
    try {
      available = await githubApp.installationRepos(installationId)
    } catch (error) {
      return reply.redirect(`/repos/new?installation=${installationId}&error=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`)
    }
    const byName = new Map(available.map((repo) => [repo.fullName.toLowerCase(), repo]))
    // #457 review: the selection is counted once per repository. A repeated
    // value ("o/a" and "O/A") would otherwise inflate both the repository
    // arithmetic below and the instance count those additions would provision.
    const chosen = dedupeRepoNames(selected)
    const fresh = chosen.filter((fullName) => {
      const info = byName.get(fullName)
      return info !== undefined && store.getRepoByOwnerName(viewer.user.id, info.owner, info.name) === undefined
    })
    // `extra` is what this request would add: a selection that exactly fills the
    // last free slots is allowed, and one with nothing fresh to create
    // (extra 0) is never refused because it would create nothing.
    const refusal = repoLimitRefusal({
      used: store.countReposForUser(viewer.user.id),
      cap: config.limits.reposPerUser,
      admin: isAdminRole(viewer.user.role),
      extra: fresh.length,
    })
    if (refusal !== null) return refuseLimit(request, reply, viewer, refusal, `/repos/new?installation=${installationId}`)
    // Every fresh repository is provisioned below, so the instance ceiling has
    // to be consulted for all of them before the first create: refusing later
    // would leave repositories added with no instance, or a running instance
    // past the ceiling.
    if (config.flybot.instanceImage !== '') {
      const instanceRefusal = instanceCapRefusal(viewer, fresh.length)
      if (instanceRefusal !== null) return refuseLimit(request, reply, viewer, instanceRefusal, `/repos/new?installation=${installationId}`)
    }
    const added: string[] = []
    for (const fullName of chosen) {
      const repoInfo = byName.get(fullName)
      if (repoInfo === undefined) continue
      if (store.getRepoByOwnerName(viewer.user.id, repoInfo.owner, repoInfo.name) !== undefined) continue
      try {
        const token = await githubApp.installationToken(installationId)
        const prepared = await prepareRepoWithInstallation(token, repoInfo.owner, repoInfo.name, installation.account_login, config.github.apiBase)
        const userToken = viewer.user.github_token_enc === null ? '' : decryptSecret(viewer.user.github_token_enc, config.tokenEncryptionKey)
        let userPermission = 'none'
        if (userToken !== '') {
          try {
            userPermission = await repoPermissionWithToken(userToken, repoInfo.owner, repoInfo.name, config.github.apiBase)
          } catch (error) {
            log.warn('user repository permission check failed', { repo: repoInfo.fullName, error: String(error) })
          }
        }
        const canMaintainPermission = userPermission === 'admin' || userPermission === 'maintain'
        const repo = store.createRepo({
          id: randomId('repo'),
          userId: viewer.user.id,
          owner: prepared.upstream.owner,
          name: prepared.upstream.name,
          defaultBranch: prepared.upstream.defaultBranch,
          tokenEnc: '',
          installationId,
          goal,
          autoIterate,
          intervalMinutes: interval,
          upstreamOwner: prepared.upstream.owner,
          upstreamName: prepared.upstream.name,
          forkOwner: prepared.fork.owner,
          forkName: prepared.fork.name,
          upstreamDefaultBranch: prepared.upstream.defaultBranch,
          forkDefaultBranch: prepared.fork.defaultBranch,
          isFork: prepared.isFork,
          forkCreated: prepared.forkCreated,
          permission: userPermission,
          canReview: prepared.canReview,
          canCreateIssue: prepared.canCreateIssue,
          reviewerEnabled: canMaintainPermission && review,
          reviewIntervalMinutes: reviewInterval,
          upstreamHtmlUrl: prepared.upstream.htmlUrl,
          forkHtmlUrl: prepared.fork.htmlUrl,
        })
        store.audit(viewer.user.id, 'repo.added', `${repo.owner}/${repo.name} app=${installationId} permission=${repo.permission}`)
        store.event('repo_connect_success', { userId: viewer.user.id, repoId: repo.id, meta: 'github-app' })
        store.recordProductEvent({ name: 'repo_connected', repoId: repo.id, subject: repo.id })
        if (config.flybot.instanceImage !== '') {
          instances.ensureUserDir(viewer.user.id)
          void instances.provision(repo).catch((error) => log.error('flybot provisioning failed', { repo: repo.id, error: String(error) }))
        }
        added.push(`${repo.owner}/${repo.name}`)
      } catch (error) {
        log.warn('github app repo add failed', { repo: repoInfo.fullName, error: String(error) })
      }
    }
    if (added.length === 0) {
      // #1099: "already connected" and "the App cannot reach it" are different
      // answers. The first is a successful selection of known repositories, so it
      // names them (the picker above links each one) instead of blaming the App.
      const alreadyConnected = chosen.filter((fullName) => {
        const info = byName.get(fullName)
        return info !== undefined && store.getRepoByOwnerName(viewer.user.id, info.owner, info.name) !== undefined
      })
      if (alreadyConnected.length === chosen.length) {
        return reply.redirect(`/repos/new?installation=${installationId}&error=${encodeURIComponent(`已经接入：${alreadyConnected.join('、')}。`)}`)
      }
      return reply.redirect(`/repos/new?installation=${installationId}&error=${encodeURIComponent('没有新增仓库；App 权限不足或仓库无法访问。')}`)
    }
    return reply.redirect(`/dashboard?notice=${encodeURIComponent(`已接入 ${added.length} 个仓库。`)}`)
  })

  app.post('/repos', async (request, reply) => {
    // #708: adding a repository provisions an instance, so it takes the
    // expensive window before anything is created.
    if (!limits.take('expensive', `repo-add:${rateLimitKey(request)}`)) return refuseTooMany(request, reply)
    const viewer = approvedCsrfGuard(request)
    const body = form(request)
    try {
      const { owner, name } = parseRepoInput(body.repo ?? '')
      const existing = store.getRepoByOwnerName(viewer.user.id, owner, name)
      if (existing !== undefined) {
        return reply.redirect(`/repos/${existing.id}?notice=${encodeURIComponent('这个仓库已经添加过了。')}`)
      }
      const refusal = repoCapRefusal(viewer)
      if (refusal !== null) return refuseLimit(request, reply, viewer, refusal, '/repos/new')
      // This add provisions an instance below when FlyBot is configured, so it
      // has to answer to the instance ceiling too — before anything is created.
      if (config.flybot.instanceImage !== '') {
        const instanceRefusal = instanceCapRefusal(viewer)
        if (instanceRefusal !== null) return refuseLimit(request, reply, viewer, instanceRefusal, '/repos/new')
      }
      store.event('repo_connect_start', { userId: viewer.user.id, meta: `${owner}/${name}` })
      const token = (body.token ?? '').trim()
      if (token === '') throw new Error('请填写 GitHub token')
      const prepared = await prepareRepo(token, owner, name, viewer.user.login, config.github.apiBase)
      const interval = normalizeInterval(body.interval, 1440)
      const reviewInterval = normalizeInterval(body.reviewInterval, 1440)
      const canMaintainPermission = prepared.permission === 'admin' || prepared.permission === 'maintain'
      const reviewerEnabled = canMaintainPermission && body.review === '1'
      const repo = store.createRepo({
        id: randomId('repo'),
        userId: viewer.user.id,
        owner: prepared.upstream.owner,
        name: prepared.upstream.name,
        defaultBranch: prepared.upstream.defaultBranch,
        tokenEnc: encryptSecret(token, config.tokenEncryptionKey),
        goal: (body.goal ?? '').slice(0, 4000),
        autoIterate: body.auto === '1',
        intervalMinutes: interval,
        upstreamOwner: prepared.upstream.owner,
        upstreamName: prepared.upstream.name,
        forkOwner: prepared.fork.owner,
        forkName: prepared.fork.name,
        upstreamDefaultBranch: prepared.upstream.defaultBranch,
        forkDefaultBranch: prepared.fork.defaultBranch,
        isFork: prepared.isFork,
        forkCreated: prepared.forkCreated,
        permission: prepared.permission,
        canReview: prepared.canReview,
        canCreateIssue: prepared.canCreateIssue,
        reviewerEnabled,
        reviewIntervalMinutes: reviewInterval,
        upstreamHtmlUrl: prepared.upstream.htmlUrl,
        forkHtmlUrl: prepared.fork.htmlUrl,
      })
      store.audit(viewer.user.id, 'repo.added', `${repo.owner}/${repo.name} fork=${repo.fork_owner}/${repo.fork_name} permission=${repo.permission} reviewer=${reviewerEnabled ? 'on' : 'off'}`)
      store.event('repo_connect_success', { userId: viewer.user.id, repoId: repo.id })
      store.recordProductEvent({ name: 'repo_connected', repoId: repo.id, subject: repo.id })
      const t = translator(request.locale ?? 'zh')
      const bits = [t('仓库已添加。', 'Repository added.')]
      if (prepared.forkCreated) bits.push(t(`已创建 fork ${prepared.fork.fullName}。`, `Created fork ${prepared.fork.fullName}.`))
      else if (prepared.isFork) bits.push(t(`使用你的 fork ${prepared.fork.fullName}。`, `Using your fork ${prepared.fork.fullName}.`))
      else bits.push(t('这是你自己的仓库，无需 fork。', 'You own this repository; no fork is needed.'))
      if (!canMaintainPermission) bits.push(t('你在上游没有 admin/maintain 权限，只能选择 developer。', 'You do not have admin/maintain permission on the upstream, so you can only choose developer.'))
      else bits.push(t('你在这个上游可以选择 maintainer 或 developer；审核角色可在设置里启用。', 'You can choose maintainer or developer for this upstream; enable the reviewer role in settings.'))
      if (config.flybot.instanceImage !== '') {
        instances.ensureUserDir(viewer.user.id)
        void instances.provision(repo).catch((error) => log.error('flybot provisioning failed', { repo: repo.id, error: String(error) }))
        bits.push(t('工作区初始化中。', 'Workspace is initializing.'))
      }
      return reply.redirect(`/repos/${repo.id}?notice=${encodeURIComponent(bits.join(' '))}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // The dashboard renders this slot only inside `#add-repo` (`#472` slice 3),
      // so the redirect has to land with the dialog open.
      return reply.redirect(`/dashboard?error=${encodeURIComponent(message)}#add-repo`)
    }
  })

  // #543 slice 1: answer whether this repository's own CI gates a merge. Read
  // only — workflows, protection and the commits that landed are read from
  // GitHub; nothing is created, committed or opened on the user's repository.
  app.get('/repos/:id/ci-gate', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id))
    const token = await repoGithubToken(repo, config, githubApp, store)
    if (token === '') throw httpError(400, '这个仓库没有可用的 GitHub token。', 'REPO_TOKEN_MISSING')
    const client = new GithubClient(token, config.github.apiBase)
    const branch = repo.default_branch
    const entries = await client.listDirectory(repo.owner, repo.name, '.github/workflows', branch)
    const workflows: Array<{ path: string; content: string }> = []
    for (const entry of (entries ?? []).filter((item) => item.type === 'file' && /\.ya?ml$/i.test(item.name)).slice(0, 20)) {
      const file = await client.getContentAtRef(repo.owner, repo.name, entry.path, branch)
      if (file !== null && file.type === 'file') workflows.push({ path: entry.path, content: file.content.slice(0, 100_000) })
    }
    const gate = await client.getBranchProtection(repo.owner, repo.name, branch)
    // A window, not a sample: one page of the newest merged pull requests, then
    // the ones merged inside the reported window. The merge commit is the commit
    // that landed, so its check runs are the evidence for that landing.
    const since = Date.now() - 14 * 24 * 60 * 60 * 1000
    const mergedPulls: Array<{ number: number; mergedAt: string; conclusions: string[] }> = []
    for (const pull of (await client.listMergedPullRequests(repo.owner, repo.name, 1)).filter((item) => Date.parse(item.mergedAt) >= since).slice(0, 10)) {
      const conclusions = pull.mergeCommitSha === null
        ? []
        : (await client.listCheckRuns(repo.owner, repo.name, pull.mergeCommitSha)).map((run) => run.conclusion ?? 'running')
      mergedPulls.push({ number: pull.number, mergedAt: pull.mergedAt, conclusions })
    }
    const report = reportCiGate({ repo: `${repo.owner}/${repo.name}`, defaultBranch: branch, workflows, gate, mergedPulls })
    return htmlPage(reply, 200, ciGatePage({ config, locale: request.locale ?? 'zh', viewer: viewOf(viewer), repo, report }))
  })

  app.get('/repos/:id', async (request, reply) => {
    // #380 review finding: the page and the revoke route must read the same
    // actor role. The connection's `repo_role` is a declaration about the
    // upstream, not about who is looking, so it cannot decide either side.
    const { viewer, repo, role } = ownedRepo(request, String((request.params as Record<string, string>).id))
    const jobsTotal = store.countJobsForRepo(repo.id)
    const jobsPage = Math.min(Math.max(1, Math.floor(Number(queryText(request, 'jobsPage')) || 1)), Math.max(1, Math.ceil(jobsTotal / 10)))
    const questions = (await inboxForUser(viewer.user.id, store.listRepos(viewer.user.id))).filter((question) => question.repoId === repo.id)
    const workState = queryText(request, 'workState')
    const instance = store.getRepoInstance(repo.id)
    // #361: two fixed windows, both read from the same rows the delivery card
    // already reads. The route computes the cut-offs; the read model decides
    // what each number means, including when a window has no review at all.
    const trendSince = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString()
    const reviewTrend = { week: store.reviewTrend(repo.id, trendSince(7)), month: store.reviewTrend(repo.id, trendSince(30)) }
    // #371: one window for the ledger card; the card itself prints — where a
    // fact was never recorded rather than a zero.
    const deliveryOutcomes = store.listDeliveryOutcomes(repo.id, trendSince(90))
    // #697: the two budget scopes this page can set, each with the spend it is
    // compared against. Both read the same rolling 30-day window the repository
    // budget already uses, and both are USD-billed only.
    const budgetWindow = trendSince(30)
    const budgetPrincipal = identityPrincipalId(repo.user_id)
    const repositoryScopeRow = store.getBudgetScope('repository', repo.id)
    const principalScopeRow = store.getBudgetScope('principal', budgetPrincipal)
    const budgetScopes = [
      {
        kind: 'repository' as const,
        label: `${repo.owner}/${repo.name}`,
        capCny: repositoryScopeRow?.cap_cny ?? 0,
        spentCny: store.repoUsageSince(repo.id, budgetWindow) * config.quota.usdCny,
        action: repositoryScopeRow?.action ?? 'alert',
        unknownCount: store.repoUnknownCountSince(repo.id, budgetWindow),
      },
      {
        kind: 'principal' as const,
        label: `@${store.userById(repo.user_id)?.login ?? repo.user_id}`,
        capCny: principalScopeRow?.cap_cny ?? 0,
        spentCny: store.principalUsageSince(repo.user_id, budgetWindow) * config.quota.usdCny,
        action: principalScopeRow?.action ?? 'alert',
        unknownCount: store.principalUnknownCountSince(repo.user_id, budgetWindow),
      },
    ]
    const repoModels = store.listRepoModelSelection(repo.id)
    const scheduleRow = store.scheduleForRepo(repo.id)
    let chiefMessages
    if ((viewer.user.role !== 'superadmin' || viewer.preview === true) && instance?.status === 'ready') {
      chiefMessages = await instances.chiefTranscript(repo.id).catch((error) => {
        log.warn('chief transcript failed', { repo: repo.id, error: String(error) })
        return []
      })
    }
    const planDeadlineCutoff = new Date(Date.now() - config.plan.expiryDays * 86_400_000).toISOString()
    const pendingPlan = store.pendingPlanJob(repo.id, planDeadlineCutoff)
    const workItems = store.listWorkItems(repo.id)
    // #540: each create form carries its own key, because two different forms on
    // one page are different requests and one key for both would read as a
    // conflict. The revision is the project's, so a page rendered before another
    // create is refused rather than queueing a second job beside it.
    const fields = (): { revision: number; idempotencyKey: string } => ({
      revision: management.revisionOf('project', repo.id),
      idempotencyKey: randomId('cmd'),
    })
    const commands: Record<string, { revision: number; idempotencyKey: string }> = {
      run: fields(),
      plan: fields(),
      review: fields(),
      triage: fields(),
      // #540 slice 4: the settings form is fenced on the repository's own
      // revision, not the project's — a job queued elsewhere must not invalidate
      // a settings save, and a policy written from another tab must.
      settings: { revision: management.revisionOf('repo', repo.id), idempotencyKey: randomId('cmd') },
    }
    for (const item of workItems) {
      commands[`work-run:${item.id}`] = fields()
      commands[`work-scope:${item.id}`] = fields()
      commands[`work-verify:${item.id}`] = fields()
    }
    // #540 slice 6 / #264: the per-PR merge command moved to the job page's
    // review/merge card, which renders the same revision + key on the surface
    // that carries the evidence. The repository page lists the pull requests and
    // links to that card instead of holding a second merge control.
    const prJobs = store.listPrJobsForRepo(repo.id, 10)
    return reply.type('text/html').send(
      repoPage({
        config,
        locale: request.locale ?? 'zh',
        viewer: viewOf(viewer),
        recentAuthAt: viewer.recentAuthAt,
        repo,
        canMaintain: role === 'maintainer',
        // #1255: the same verdict admission reads, so the page with Run now and
        // the next-run line says why both are refused instead of letting the
        // redirect's `?error=` be the first mention of it.
        clock: githubApp.clockState(),
        // #1118: the text the Lead is sent for this repository, hashed, so the page
        // names the record's value and not only its version.
        playbookTextHash: playbookTextHash(playbookFor('lead', teamLabelFor(repo.upstream_name), repo.goal)),
        releases: store.listReleasesForRepo(repo.id),
        instance,
        usage: {
          repos: store.countReposForUser(viewer.user.id),
          reposCap: config.limits.reposPerUser,
          instances: store.countRepoInstancesForUser(viewer.user.id),
          instancesCap: config.limits.instancesPerUser,
        },
        jobs: store.listJobsPageForRepo(repo.id, 10, (jobsPage - 1) * 10),
        queued: store.listQueuedJobs(),
        prJobs,
        workItems,
        // #379: the repository page lists every state the ledger can hold. These
        // are the ids jobs reported, not GitHub's alert store.
        securityFindings: store.listSecurityFindings(repo.id),
        // #380: the owner path for revoking a recorded source; the page renders
        // it only for a maintainer.
        skillSources: store.listSkillBundleSources(repo.id),
        commands,
        // #359: the page names the deadline and the way out, so an ignored plan
        // is a visible decision with a date rather than a silent wait.
        ...(pendingPlan === undefined || pendingPlan.finished_at === null ? {} : {
          pendingPlan: {
            jobId: pendingPlan.id,
            deadline: new Date(Date.parse(pendingPlan.finished_at) + config.plan.expiryDays * 86_400_000).toISOString().slice(0, 10),
          },
        }),
        ...(workState !== undefined && isWorkItemState(workState) ? { workState } : {}),
        reviewTrend,
        deliveryOutcomes,
        // #544: a repository with a schedule row is answered by the planner, not
        // by the legacy interval rule the page computed for every repository.
        // #723: `enabled` answers before the row does, so a paused repository
        // keeps the `disabled` sentence the page already has instead of a
        // planner instant the worker will never run.
        ...(scheduleRow === undefined || repo.enabled !== 1 ? {} : { scheduledNext: scheduledNextFor(scheduleRow) }),
        workflowFailures: store.listWorkflowFailuresForRepo(repo.id, 10),
        postmortems: store.listPostmortemsForRepo(repo.id, { openOnly: true }),
        recurrences: store.listPostmortemRecurrences(repo.id),
        models: store.listUserProviderModels(repo.user_id),
        providers: store.listModelProviders(repo.user_id),
        repoModelIds: repoModels.map((model) => model.id),
        repoBotModels: store.listRepoBotModels(repo.id),
        repoDefaultModelId: repoModels.find((model) => model.is_default === 1)?.id ?? '',
        repoSpendCny: store.repoUsageSince(repo.id, budgetWindow) * config.quota.usdCny,
        budgetScopes,
        questions,
        chiefMessages,
        activeJob: store.activeJobForRepo(repo.id) !== undefined,
        jobsPage,
        jobsTotal,
        notice: request.flash?.notice?.text,
        error: request.flash?.error?.text,
        // #471: the refusal names the field it refused; the value rides the
        // existing redirect and is read only beside an error, so a hand-typed
        // `?field=` with no refusal marks nothing.
        errorField: request.flash?.error === undefined ? undefined : queryText(request, 'field'),
        // #546: the release form is on this page, so its outcome has to land here
        // too — a refusal the maintainer cannot see reads as a click that did
        // nothing, and a success that is not confirmed is indistinguishable from
        // one that never ran. #472 slice 3: the outcome now rides in the one-shot
        // flash (its own slot, so it stays beside the form instead of becoming a
        // top-of-page notice); a hand-typed query parameter renders nothing.
        releaseRefused: request.flash?.outcome?.key === 'refused' ? request.flash.outcome.text : undefined,
        releaseTagged:
          request.flash?.outcome?.key === 'tagged' || request.flash?.outcome?.key === 'retagged'
            ? request.flash.outcome.text
            : undefined,
        releaseRetagged: request.flash?.outcome?.key === 'retagged' ? '1' : undefined,
        releaseChecked: request.flash?.outcome?.key === 'checked' ? request.flash.outcome.text : undefined,
      }),
    )
  })

  // #539: project memory. This slice is one repository page — a bounded search,
  // an exact-version read and a revision-fenced write. The reader's role is the
  // repository's chosen role, so an administrator acting as a developer reads the
  // developer view; a write for a role the actor cannot act as is refused before
  // the store sees it.
  app.get('/repos/:id/memory', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id))
    const role = parseRepoRole(repo.repo_role)
    const entries = store.listMemoriesForRepo(repo.id)
    const query = queryText(request, 'q') ?? ''
    const search = searchMemories(entries, query, role)
    const locale = request.locale ?? 'zh'
    const key = queryText(request, 'key')
    let detail
    let versions: ProjectMemoryVersionRow[] = []
    if (key !== undefined) {
      const entry = visibleMemories(entries, role).find((row) => row.key === key)
      if (entry === undefined) {
        return htmlPage(reply, 404, memoryMissingPage({ config, locale, viewer: viewOf(viewer), repo }))
      }
      // A revision carries its own audience: the entry may have moved to a
      // wider audience, but an old revision written for another role stays
      // outside this reader's audience and is neither listed nor rendered.
      versions = store.listMemoryVersions(entry.id).filter((row) => audienceVisible(row.audience, role))
      const rawRevision = queryText(request, 'rev')
      const wanted = rawRevision === undefined ? entry.revision : Number(rawRevision)
      const version = Number.isInteger(wanted) ? store.getMemoryVersion(entry.id, wanted) : undefined
      if (version === undefined || !audienceVisible(version.audience, role)) {
        return htmlPage(reply, 404, memoryMissingPage({ config, locale, viewer: viewOf(viewer), repo }))
      }
      detail = { entry, version, historical: version.revision !== entry.revision }
    }
    const conflict = queryText(request, 'conflict')
    const refused = queryText(request, 'refused')
    return reply.type('text/html').send(memoryPage({
      config,
      locale,
      viewer: viewOf(viewer),
      repo,
      role,
      search,
      ...(detail === undefined ? {} : { detail }),
      versions,
      query,
      saved: queryText(request, 'saved') !== undefined,
      unchanged: queryText(request, 'unchanged') !== undefined,
      ...(conflict === undefined ? {} : { conflictRevision: Number(conflict) }),
      ...(refused === undefined ? {} : { refused }),
    }))
  })

  // #546 slice 1: the read-only readiness answer. Every call behind this route
  // is a GET on the repository the actor already owns; the page creates no tag,
  // no Release and asks for no token beyond the installation token it holds.
  app.get('/repos/:id/release-readiness', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id))
    const owner = repo.upstream_owner || repo.owner
    const name = repo.upstream_name || repo.name
    const defaultBranch = repo.upstream_default_branch || repo.default_branch
    let readiness = null as Awaited<ReturnType<typeof readReleaseReadiness>>
    let error: string | undefined
    try {
      const token = await repoGithubToken(repo, config, githubApp, store)
      if (token === '') {
        error = '没有可用的 GitHub 安装令牌。 / No GitHub installation token is available.'
      } else {
        readiness = await readReleaseReadiness(new GithubClient(token, config.github.apiBase), { owner, name, defaultBranch })
        if (readiness === null) error = `默认分支 ${defaultBranch} 读不到。 / The default branch ${defaultBranch} could not be read.`
      }
    } catch (cause) {
      // A GitHub read that fails is reported on the page as "no answer", never
      // as a ready or a refused repository: the page must not invent a verdict.
      error = `GitHub 读取失败：${cause instanceof Error ? cause.message : String(cause)} / the GitHub read failed`
      log.warn('release readiness read failed', { repo: repo.id, error: String(cause) })
    }
    return reply.type('text/html').send(releaseReadinessPage({
      config,
      locale: request.locale ?? 'zh',
      viewer: viewOf(viewer),
      repoId: repo.id,
      repoLabel: `${owner}/${name}`,
      readiness,
      ...(error === undefined ? {} : { error }),
      // #472: the tag route reports through the flash, so the sentence is read
      // once from the cookie and never from a query string the address bar keeps.
      ...(request.flash?.notice?.text === undefined ? {} : { notice: request.flash.notice.text }),
      ...(request.flash?.error?.text === undefined ? {} : { refused: request.flash.error.text }),
    }))
  })

  // #546 slice 5: the draft body may be organised by the repository's own
  // release-notes skill. The skill is read through the loader #609 merged — one
  // reader, no second `.agents/skills` walk — at the exact commit the release
  // row pinned, so a moving default branch or a pull request head cannot change
  // what a shipped release says. The model call goes through this process's own
  // metered gateway with a short-lived repository token, so the spend is counted
  // by the same quota code as job work instead of a direct provider call.
  const completeNotesWithGateway = async (user: UserRow, repo: RepoRow, prompt: string): Promise<string> => {
    const raw = `flg_${randomToken(32)}`
    const tokenId = `tok_${randomToken(8)}`
    store.createApiToken({
      id: tokenId,
      userId: user.id,
      kind: 'release-notes',
      name: `release-notes:${repo.id}`,
      tokenHash: sha256Hex(raw),
      prefix: raw.slice(0, 8),
      repoId: repo.id,
      expiresAt: addMinutes(15),
    })
    try {
      const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${raw}` },
        body: JSON.stringify({
          model: config.llm.model,
          messages: [
            { role: 'system', content: 'You organise release notes for one repository release. You may reorder, group and reword only the sources you are given; you never add a source, a link or a claim about anything outside them.' },
            { role: 'user', content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(120_000),
      })
      if (!response.ok) throw new Error(`the model gateway answered ${response.status}`)
      const payload = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> }
      const content = payload.choices?.[0]?.message?.content
      if (typeof content !== 'string') throw new Error('the model gateway answered without a message body')
      return content
    } finally {
      // One call, one token: the row is revoked whether the gateway answered or
      // not, so a failed release never leaves a credential behind.
      store.revokeApiToken(tokenId, user.id)
    }
  }

  // Every fallback — no skill, a refused skill, a refused gateway call, an answer
  // naming a source outside the range — returns #720's built-in body untouched,
  // and names that path for the page. A range read failure still returns null so
  // the draft keeps its placeholder sentence rather than losing the Release.
  const releaseNotesFor = async (
    user: UserRow,
    repo: RepoRow,
    client: GithubClient,
    owner: string,
    name: string,
    previousTag: string | null,
    targetSha: string,
    tagName: string,
  ): Promise<ReleaseNotes | null> => {
    let notes: ReleaseNotes
    try {
      notes = await collectReleaseNotes(client, { owner, name, previousTag, targetSha })
    } catch (cause) {
      log.warn('release notes range read failed', { repo: repo.id, tag: tagName, error: String(cause) })
      return null
    }
    const read = await readReleaseNotesSkill(client, owner, name, targetSha)
    return await organiseReleaseNotes({
      notes,
      read,
      commit: targetSha,
      complete: (prompt) => completeNotesWithGateway(user, repo, prompt),
    })
  }

  // #546 slice 2: the tag action behind the readiness page. The page is a
  // prediction and this route is the authority, so the default branch head is
  // read again immediately before the write: the form carries the head it was
  // rendered with, and a branch that moved is a refusal rather than a tag on a
  // tree the maintainer never saw on that page. Slice boundary: the annotated tag
  // only — no Release object and no draft notes, which are slice 3.
  // #433 slice 1: the strategy a repository is on, and one write that freezes the
  // current strategy as a new candidate. The page carries the candidate version it
  // rendered; the store compares it under one transaction, so a second tab cannot
  // replace a candidate that landed in between. `stable` and `canary` are read and
  // shown but never written here: promotion is a later slice with a human decision.
  app.get('/repos/:id/strategy', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id))
    const pointers = store.strategyPointers(repo.id)
    const bundles = store.listStrategyBundles(repo.id)
    return reply.type('text/html').send(strategyPage({
      config,
      locale: request.locale ?? 'zh',
      viewer: viewOf(viewer),
      repoId: repo.id,
      repoLabel: `${repo.upstream_owner || repo.owner}/${repo.upstream_name || repo.name}`,
      pointers,
      bundles,
      ...(request.flash?.notice?.text === undefined ? {} : { notice: request.flash.notice.text }),
      ...(request.flash?.error?.text === undefined ? {} : { refused: request.flash.error.text }),
    }))
  })

  app.post('/repos/:id/strategy', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const back = `/repos/${repo.id}/strategy`
    const fail = (message: string) => reply.redirect(`${back}?error=${encodeURIComponent(message)}`)
    const ok = (message: string) => reply.redirect(`${back}?notice=${encodeURIComponent(message)}`)
    if (repo.repo_role !== 'maintainer') return fail('只有上游仓库的 maintainer 可以冻结策略。 / Only a maintainer of the upstream repository can freeze a strategy')
    const body = form(request)
    if (body.confirm !== '1') return fail('冻结候选需要确认。 / the candidate must be confirmed')
    const base = Number(String(body.base ?? '').trim())
    if (!Number.isInteger(base) || base < 0) return fail('页面没有带上它渲染时的候选版本；请重新读取策略页。 / the page did not carry the candidate version it rendered; re-read the strategy page')
    const assembled = currentStrategySections(store, repo)
    // A frozen family (evaluator, evidence, CI, merge gate, auth, gateway,
    // capability) is refused before the store is asked to write anything.
    if (!assembled.ok) return fail(strategyRefusal(assembled))
    const frozen = store.freezeStrategyCandidate({ repoId: repo.id, sections: assembled.sections, createdBy: viewer.user.login, expectedBase: base })
    if (!frozen.ok) {
      return fail(`策略在上次读取后已经变化：页面显示 base v${String(frozen.base)}，仓库当前候选是 v${String(frozen.candidate)}；没有冻结任何内容。请重新读取策略页后再冻结。 / the candidate moved since this page was read: the page showed base v${String(frozen.base)} and the repository is on candidate v${String(frozen.candidate)}; nothing was frozen. Re-read the strategy page and freeze again`)
    }
    store.audit(viewer.user.id, 'strategy.frozen', `${repo.id}: v${String(frozen.version)} ${frozen.hash.slice(0, 12)}`)
    // The content was already a bundle, so no row was written — but the candidate
    // moved onto it, which is what the button froze. The notice says the pointer
    // moved rather than "nothing was written".
    if (frozen.duplicate) return ok(`当前策略已经冻结为 v${String(frozen.version)}（${frozen.hash.slice(0, 12)}）；候选指针已改指该版本，没有写入新的 bundle。 / the current strategy is already frozen as v${String(frozen.version)} (${frozen.hash.slice(0, 12)}); the candidate now points at it and no new bundle was written`)
    return ok(`已冻结候选 v${String(frozen.version)}（${frozen.hash.slice(0, 12)}）；stable 未改动。 / froze candidate v${String(frozen.version)} (${frozen.hash.slice(0, 12)}); stable was not changed`)
  })

  // #893: this route writes the same ref as the release POST below, through the
  // same preflight, so it takes the same two guards. The maintainer check answers
  // first because it is the permission boundary; a maintainer whose session has
  // not confirmed recently is asked to confirm before any version, head or token
  // is read.
  app.post('/repos/:id/release-readiness/tag', { config: { rateLimit: destructiveClassLimit } }, async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const back = `/repos/${repo.id}/release-readiness`
    const fail = (message: string) => reply.redirect(`${back}?error=${encodeURIComponent(message)}`)
    if (repo.repo_role !== 'maintainer') return fail('只有上游仓库的 maintainer 可以打标签。 / Only a maintainer of the upstream repository can tag it')
    if (requireRecentAuth(request, reply, viewer, 'repo.release.tag', back)) return reply
    const body = form(request)
    const version = String(body.version ?? '').trim()
    const headSha = String(body.head ?? '').trim().toLowerCase()
    if (!/^[0-9a-f]{40}$/.test(headSha)) return fail('the page did not carry a full 40-character head; re-read the readiness page and try again')
    if (body.confirm !== '1') return fail('the tag must be confirmed; a tag is never moved or deleted')
    const owner = repo.upstream_owner || repo.owner
    const name = repo.upstream_name || repo.name
    const defaultBranch = repo.upstream_default_branch || repo.default_branch
    const token = await repoGithubToken(repo, config, githubApp, store)
    if (token === '') return fail('没有可用的 GitHub 安装令牌。 / No GitHub installation token is available')
    const client = new GithubClient(token, config.github.apiBase)
    // The write is one call away, so this read is now, not when the page was built.
    const branch = await client.getBranch(owner, name, defaultBranch)
    if (branch === null) return fail(`默认分支 ${defaultBranch} 读不到，没有打标签。 / the default branch ${defaultBranch} could not be read; nothing was tagged`)
    const nowSha = branch.sha.toLowerCase()
    if (nowSha !== headSha) return fail(releaseRefusals.branchMoved(headSha, nowSha))
    const plan = await releasePreflight(client, { owner, name, defaultBranch, requestedVersion: version, targetSha: headSha })
    if (!plan.ok) {
      const reason = plan.suggestion === undefined ? plan.message : `${plan.message}; the next legal version is ${plan.suggestion}`
      return fail(reason)
    }
    const created = await createAnnotatedTag(client, { owner, name, plan })
    if (!created.ok) return fail(created.message)
    // The tag exists from here on, so the audit records it even if the row below
    // cannot be written: the page must never claim no tag while one is visible.
    const recorded = store.recordRelease({ repoId: repo.id, userId: viewer.user.id, version: plan.version, tagName: plan.tagName, targetSha: plan.targetSha, tagObjectSha: created.tagObjectSha, previousTag: plan.previousTag, actor: viewer.user.login })
    store.audit(viewer.user.id, 'release.tagged', `${repo.id}: ${plan.tagName}@${plan.targetSha}`)
    if (recorded === undefined) return fail(`tag ${plan.tagName} was created, but its release record could not be updated; Fledge moved nothing`)
    // No reconcile: observing the run and preparing a draft Release is slice 3,
    // and this route writes nothing beyond the tag and its row.
    return reply.redirect(`${back}?notice=${encodeURIComponent(`tag ${plan.tagName} created on ${plan.targetSha.slice(0, 12)}; nothing else was written`)}`)
  })

  // #546: a maintainer-supplied version and a confirmed full SHA. The preflight
  // is read-only; only a plan that passes every check reaches the tag write, and
  // the tag is annotated and created through the repository's installation token.
  // #893: publishing a release writes a tag ref, and a tag push runs the
  // workflows in the tagged tree. It therefore carries the destructive class
  // budget — `destructiveClassLimit` is that class read from config, the shape
  // #708 added so the ceiling is an operator setting rather than a literal, and
  // it defaults to the same 60 a minute as `destructiveLimit` — and it proves
  // presence with `requireRecentAuth` before it resolves a token or compares a
  // single tag.
  app.post('/repos/:id/release', { config: { rateLimit: destructiveClassLimit } }, async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true, true)
    const body = form(request)
    const version = String(body.version ?? '').trim()
    const targetSha = String(body.sha ?? '').trim().toLowerCase()
    const back = `/repos/${repo.id}?release=1`
    if (requireRecentAuth(request, reply, viewer, 'repo.release', back)) return reply
    if (!/^[0-9a-f]{40}$/.test(targetSha)) return reply.redirect(`${back}&refused=${encodeURIComponent('confirm the full 40-character commit SHA')}`)
    if (body.confirm !== '1') return reply.redirect(`${back}&refused=${encodeURIComponent('the release must be confirmed')}`)
    const owner = repo.upstream_owner || repo.owner
    const name = repo.upstream_name || repo.name
    const token = await repoGithubToken(repo, config, githubApp, store)
    const client = new GithubClient(token, config.github.apiBase)
    const plan = await releasePreflight(client, { owner, name, defaultBranch: repo.upstream_default_branch || repo.default_branch, requestedVersion: version, targetSha })
    if (!plan.ok) {
      // The suggestion is the whole value of the not-higher refusal: the page is
      // the only place a maintainer reads it, so it travels in the same string.
      const reason = plan.suggestion === undefined ? plan.message : `${plan.message}; the next legal version is ${plan.suggestion}`
      return reply.redirect(`${back}&refused=${encodeURIComponent(reason)}`)
    }
    const created = await createAnnotatedTag(client, { owner, name, plan })
    if (!created.ok) return reply.redirect(`${back}&refused=${encodeURIComponent(created.message)}`)
    // The tag exists from here on, so the audit records it even if the row below
    // cannot be written. A name that already has a row is a re-tag: the row is
    // updated to the new SHAs and the page says so, rather than claiming no tag
    // was created while the audit says one was.
    const retagged = store.releaseByTag(repo.id, plan.tagName) !== undefined
    const recorded = store.recordRelease({ repoId: repo.id, userId: viewer.user.id, version: plan.version, tagName: plan.tagName, targetSha: plan.targetSha, tagObjectSha: created.tagObjectSha, previousTag: plan.previousTag, actor: viewer.user.login })
    store.audit(viewer.user.id, 'release.tagged', `${repo.id}: ${plan.tagName}@${plan.targetSha}`)
    if (recorded === undefined) return reply.redirect(`${back}&refused=${encodeURIComponent(`tag ${plan.tagName} was created, but its release record could not be updated; Fledge moved nothing`)}`)
    // The run may not exist yet; the first observation is still recorded, and
    // the check route repeats it later. A failed check never turns a created tag
    // into a refusal. The recorded draft pointer travels into the reconcile: on a
    // re-tag the row still owns the Release it prepared, and without the pointer
    // that Release would be misread as someone else's.
    try {
      const tracked = await reconcileRelease(client, {
        owner,
        name,
        tagName: plan.tagName,
        targetSha: plan.targetSha,
        prerelease: plan.prerelease,
        draftReleaseId: recorded.draft_release_id === null ? null : Number(recorded.draft_release_id),
        // #546 slice 3: the draft body is the release range. A read failure keeps
        // the draft with its placeholder body instead of losing the Release.
        notes: () => releaseNotesFor(viewer.user, repo, client, owner, name, plan.previousTag, plan.targetSha, plan.tagName),
      })
      store.updateReleaseTracking(recorded.id, trackingUpdate(tracked, {
        draftReleaseId: recorded.draft_release_id,
        draftUrl: recorded.draft_url,
      }))
      if (tracked.status === 'draft_created' && tracked.notes !== null) {
        store.updateReleaseNotes(recorded.id, releaseNotesSourceJson(tracked.notes))
      }
    } catch (error) {
      log.warn('release run check after tag failed', { repo: repo.id, tag: plan.tagName, error: String(error) })
    }
    if (retagged) return reply.redirect(`${back}&tagged=${encodeURIComponent(plan.tagName)}&retagged=1`)
    return reply.redirect(`${back}&tagged=${encodeURIComponent(plan.tagName)}`)
  })

  // #546: the read/reconcile surface. It observes the tag's workflow run again
  // and may prepare a draft Release; it never publishes, reruns, deletes or moves
  // anything, and the owner's maintainer role is the precondition.
  app.post('/repos/:id/releases/:releaseId/check', async (request, reply) => {
    const params = request.params as Record<string, string>
    const { viewer, repo } = ownedRepo(request, String(params.id), true)
    const back = `/repos/${repo.id}?release=1`
    if (repo.repo_role !== 'maintainer') {
      return reply.redirect(`${back}&error=${encodeURIComponent('只有 maintainer 可以检查发布工作流。')}`)
    }
    const release = store.releaseById(String(params.releaseId))
    if (release === undefined || release.repo_id !== repo.id) throw httpError(404, '发布记录不存在。', 'RELEASE_NOT_FOUND')
    const owner = repo.upstream_owner || repo.owner
    const name = repo.upstream_name || repo.name
    const token = await repoGithubToken(repo, config, githubApp, store)
    const client = new GithubClient(token, config.github.apiBase)
    // The range starts at the tag recorded when the tag was written; a stored
    // value that no longer parses is treated as a first release rather than as an
    // unreadable page, because the draft itself is still the deliverable.
    const previousTag = (() => {
      if (release.preflight_json === null) return null
      try {
        const parsed = JSON.parse(release.preflight_json) as { previousTag?: unknown }
        return typeof parsed.previousTag === 'string' ? parsed.previousTag : null
      } catch {
        return null
      }
    })()
    let result: Awaited<ReturnType<typeof reconcileRelease>>
    try {
      result = await reconcileRelease(client, {
        owner,
        name,
        tagName: release.tag_name,
        targetSha: release.target_sha,
        prerelease: (parseVersion(release.version)?.prerelease.length ?? 0) > 0,
        draftReleaseId: release.draft_release_id === null ? null : Number(release.draft_release_id),
        notes: () => releaseNotesFor(viewer.user, repo, client, owner, name, previousTag, release.target_sha, release.tag_name),
      })
    } catch (error) {
      log.warn('release run check failed', { repo: repo.id, tag: release.tag_name, error: String(error) })
      return reply.redirect(`${back}&error=${encodeURIComponent('the workflow run could not be read from GitHub; no Release was created')}`)
    }
    store.updateReleaseTracking(release.id, trackingUpdate(result, {
      draftReleaseId: release.draft_release_id,
      draftUrl: release.draft_url,
    }))
    if (result.status === 'draft_created' && result.notes !== null) {
      store.updateReleaseNotes(release.id, releaseNotesSourceJson(result.notes))
    }
    store.audit(viewer.user.id, 'release.checked', `${repo.id}: ${release.tag_name} ${result.status}`)
    return reply.redirect(`${back}&checked=${encodeURIComponent(result.message)}`)
  })

  // #546 slice 4: the optional run analysis. A maintainer asks for the failed
  // logs of the run this release recorded. The read runs on a read-only
  // installation token that is revoked when it ends, the excerpt is redacted
  // before it is cut, and the result is stored beside the tracking fields: this
  // route never publishes, never reruns and never changes a release state.
  app.post('/repos/:id/releases/:releaseId/analyze', async (request, reply) => {
    const params = request.params as Record<string, string>
    const { viewer, repo } = ownedRepo(request, String(params.id), true)
    const back = `/repos/${repo.id}?release=1`
    if (repo.repo_role !== 'maintainer') {
      return reply.redirect(`${back}&error=${encodeURIComponent('只有 maintainer 可以分析发布运行。')}`)
    }
    const release = store.releaseById(String(params.releaseId))
    if (release === undefined || release.repo_id !== repo.id) throw httpError(404, '发布记录不存在。', 'RELEASE_NOT_FOUND')
    if (release.run_id === null) {
      return reply.redirect(`${back}&error=${encodeURIComponent('这条发布记录还没有对应的工作流运行，先点“检查工作流”。')}`)
    }
    const owner = repo.upstream_owner || repo.owner
    const name = repo.upstream_name || repo.name
    // #546 review finding 1: the mint belongs to the module, not to the route.
    // A row whose recorded run is green or still running is refused by
    // analyzeReleaseRun before it asks for a credential; minting here would spend
    // a read-only token on every such POST and expire it unused. The module calls
    // this only after its own check, and the one refusal that comes back through
    // the call is the installation refusal, which is a sentence on the page.
    let result: Awaited<ReturnType<typeof analyzeReleaseRun>>
    try {
      result = await analyzeReleaseRun({
        owner,
        name,
        run: {
          id: Number(release.run_id),
          attempt: release.run_attempt ?? 1,
          // The row keeps the conclusion, not the run's live status: a null
          // conclusion is a run that has not finished, which the analysis refuses.
          status: release.conclusion === null ? 'in_progress' : 'completed',
          conclusion: release.conclusion,
        },
        mint: () => mintAnalysisToken({ installation_id: repo.installation_id, name }, githubApp),
        client: (token) => new GithubClient(token, config.github.apiBase),
      })
    } catch (error) {
      if (error instanceof AnalysisTokenUnavailable) return reply.redirect(`${back}&error=${encodeURIComponent(error.message)}`)
      throw error
    }
    if (!result.ok) {
      store.audit(viewer.user.id, 'release.analysis_refused', `${repo.id}: ${release.tag_name} ${result.code}`)
      return reply.redirect(`${back}&error=${encodeURIComponent(result.message)}`)
    }
    store.updateReleaseAnalysis(release.id, releaseAnalysisJson(result, new Date().toISOString()))
    store.audit(viewer.user.id, 'release.analyzed', `${repo.id}: ${release.tag_name} run ${release.run_id} jobs=${String(result.jobs.length)}`)
    const revoked = result.tokenRevoked ? '' : '; the read-only token could not be revoked and is recorded as such'
    return reply.redirect(`${back}&notice=${encodeURIComponent(`run ${release.run_id}: ${String(result.jobs.length)} failed job(s) analysed${revoked}`)}`)
  })

  app.post('/repos/:id/memory', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const role = parseRepoRole(repo.repo_role)
    const values = form(request)
    // The page of a document-owned entry replaces the verification select with a
    // hidden field carrying the stored value, because the store's fence refuses
    // any write that does not echo it. The parser accepts that echo only when the
    // row it targets already holds the document proof, so a typed `document` on
    // any other write is still refused.
    const targetedKey = typeof values.key === 'string' ? values.key.trim() : ''
    const targeted = store.getMemory(repo.id, targetedKey)
    const parsed = parseMemoryInput(values, {
      role,
      allowedRoles: allowedRepoRoles(repo.permission),
      documentOwned: targeted?.document_path != null,
    })
    if (!parsed.ok) {
      return reply.redirect(`/repos/${repo.id}/memory?refused=${encodeURIComponent(parsed.refused)}`)
    }
    const input = parsed.value
    // #1070: a write may ask to be owned by a repository document. The proof is
    // read here, from GitHub, and only a complete one reaches the store: the PR
    // merged, onto the default branch, its merge commit on the live default
    // branch, and the same blob at the path in both places. The refusal names the
    // one fact that failed, and a refused write changes nothing.
    const documentPathRaw = typeof values.document_path === 'string' ? values.document_path.trim() : ''
    const documentPrRaw = typeof values.document_pr === 'string' ? values.document_pr.trim() : ''
    const wantsDocument = documentPathRaw !== '' || documentPrRaw !== ''
    let documentPath: string | null = null
    let documentPr: number | null = null
    if (wantsDocument) {
      if (!isDocumentPath(documentPathRaw)) {
        return reply.redirect(`/repos/${repo.id}/memory?refused=document_path_invalid`)
      }
      const prNumber = Number(documentPrRaw)
      if (documentPrRaw === '' || !Number.isInteger(prNumber) || prNumber <= 0) {
        return reply.redirect(`/repos/${repo.id}/memory?refused=document_pr_invalid`)
      }
      const token = await repoGithubToken(repo, config, githubApp, store)
      if (token === '') return reply.redirect(`/repos/${repo.id}/memory?refused=document_unavailable`)
      let proof: DocumentProof
      try {
        const client = new GithubClient(token, config.github.apiBase)
        const pull = await client.getPullRequest(repo.owner, repo.name, prNumber)
        const mergeCommitSha = pull.merged ? pull.mergeCommitSha ?? '' : ''
        const ancestor = mergeCommitSha === ''
          ? false
          : isAncestorStatus((await client.compareCommits(repo.owner, repo.name, mergeCommitSha, repo.default_branch)).status)
        const mergeBlob = mergeCommitSha === ''
          ? null
          : await client.getContentAtRef(repo.owner, repo.name, documentPathRaw, mergeCommitSha)
        const liveBlob = await client.getContentAtRef(repo.owner, repo.name, documentPathRaw, repo.default_branch)
        proof = {
          path: documentPathRaw,
          pr: prNumber,
          merged: pull.merged,
          base: pull.base,
          defaultBranch: repo.default_branch,
          mergeCommitSha,
          ancestor,
          mergeBlobSha: fileBlobSha(mergeBlob),
          liveBlobSha: fileBlobSha(liveBlob),
        }
      } catch (error) {
        // A PR that does not exist (or that this token cannot read) is the same
        // answer as a bad number; anything else is the API being unavailable, and
        // neither is a promotion.
        if (error instanceof GithubError && error.status === 404) {
          return reply.redirect(`/repos/${repo.id}/memory?refused=document_pr_invalid`)
        }
        return reply.redirect(`/repos/${repo.id}/memory?refused=document_unavailable`)
      }
      const refused = documentRefusal(proof)
      if (refused !== null) {
        return reply.redirect(`/repos/${repo.id}/memory?key=${encodeURIComponent(input.key)}&refused=${refused}`)
      }
      documentPath = documentPathRaw
      documentPr = prNumber
    }
    // An entry outside the actor's audience is not a write target. Refuse it
    // before the revision fence so a hidden key is not a revision oracle, and use
    // the same refusal an update to a missing entry gives.
    const current = targeted
    if (current !== undefined && !audienceVisible(current.audience, role)) {
      return reply.redirect(`/repos/${repo.id}/memory?refused=memory_not_found`)
    }
    const result = store.writeMemory({
      repoId: repo.id,
      key: input.key,
      kind: input.kind,
      status: input.status,
      verification: documentPath === null ? input.verification : MEMORY_DOCUMENT_VERIFICATION,
      audience: input.audience,
      scope: input.scope,
      body: input.body,
      digest: memoryDigest(input.body),
      sourcesJson: input.sourcesJson,
      actorType: 'human',
      actorId: viewer.user.id,
      sourceJobId: null,
      documentPath,
      documentPr,
      reason: input.reason,
      expectedRevision: input.expectedRevision,
    })
    if (!result.ok) {
      // A write aimed at a revision that no longer exists has no key to show, so
      // it names the refusal instead of landing on a page for an entry that is gone.
      if (result.code === 'memory_not_found') return reply.redirect(`/repos/${repo.id}/memory?refused=memory_not_found`)
      if (result.code === 'memory_document_locked') {
        return reply.redirect(`/repos/${repo.id}/memory?key=${encodeURIComponent(input.key)}&refused=memory_document_locked`)
      }
      return reply.redirect(`/repos/${repo.id}/memory?key=${encodeURIComponent(input.key)}&conflict=${result.revision}`)
    }
    const base = `/repos/${repo.id}/memory?key=${encodeURIComponent(input.key)}`
    return reply.redirect(result.noop ? `${base}&unchanged=1` : `${base}&saved=1`)
  })

  // #638 slice 1: the human half of an agent proposal. The console shows the
  // proposal with its job source; accepting is a person asserting the text, and
  // rejecting keeps the row as the record of what the agent offered. Either way
  // the agent stays the author of the entry — the revision records who decided.
  const decideMemoryProposal = (decision: 'accept' | 'reject') => async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as Record<string, string>
    const { viewer, repo } = ownedRepo(request, String(params.id), true)
    const role = parseRepoRole(repo.repo_role)
    const back = `/repos/${repo.id}/memory`
    if (role === null) return reply.redirect(`${back}?refused=role_not_allowed`)
    const key = String(params.key ?? '')
    const entry = store.getMemory(repo.id, key)
    if (entry === undefined || !audienceVisible(entry.audience, role)) return reply.redirect(`${back}?refused=memory_not_found`)
    if (!canDecideProposal(entry, role)) return reply.redirect(`${back}?key=${encodeURIComponent(key)}&refused=not_a_proposal`)
    const result = store.writeMemory({
      repoId: repo.id,
      key: entry.key,
      kind: entry.kind,
      status: proposalDecisionStatus(decision),
      verification: proposalDecisionVerification(decision),
      audience: entry.audience,
      scope: entry.scope,
      body: entry.body,
      digest: entry.digest,
      sourcesJson: entry.sources_json,
      actorType: 'human',
      actorId: viewer.user.id,
      sourceJobId: entry.source_job_id,
      reason: decision === 'accept' ? 'the maintainer accepted the agent proposal' : 'the maintainer rejected the agent proposal',
      expectedRevision: entry.revision,
    })
    if (!result.ok) return reply.redirect(`${back}?key=${encodeURIComponent(key)}&conflict=${result.revision}`)
    store.audit(viewer.user.id, decision === 'accept' ? 'memory.proposal_accepted' : 'memory.proposal_rejected', `${repo.id}: ${key}${entry.source_job_id === null ? '' : ` job=${entry.source_job_id}`}`)
    return reply.redirect(`${back}?key=${encodeURIComponent(key)}&saved=1`)
  }
  app.post('/repos/:id/memory/:key/accept', decideMemoryProposal('accept'))
  app.post('/repos/:id/memory/:key/reject', decideMemoryProposal('reject'))

  // #543 first slice: a gate plan is proposed and confirmed, and nothing is
  // written to the repository. The API is the handoff for the gate-PR slice.
  app.get('/repos/:id/gate', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id))
    return reply.type('text/html').send(gatePage({
      config,
      locale: request.locale ?? 'zh',
      viewer: viewOf(viewer),
      repo,
      canMaintain: repo.repo_role === 'maintainer',
      sessions: store.listGateSessionsForRepo(repo.id),
      notice: request.flash?.notice?.text,
      error: request.flash?.error?.text,
    }))
  })

  app.post('/repos/:id/gate/sessions', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    if (repo.repo_role !== 'maintainer') return gateMaintainerRefusal(reply, request)
    const body = (request.body ?? {}) as Record<string, unknown>
    const submitted = Object.keys(body).length === 1 && 'plan' in body ? body.plan : body
    const result = validateGatePlan(submitted)
    if (!result.ok) {
      return reply.code(400).send({ error: { type: result.code, field: result.field, message: result.message } })
    }
    const plan = result.plan
    const current = await resolveGateBaseSha(repo)
    if (current !== null && current !== plan.baseSha) {
      const t = translator(request.locale ?? 'zh')
      return reply.code(409).send({
        error: {
          type: 'STALE_BASE_SHA',
          field: 'baseSha',
          currentSha: current,
          message: t(
            `计划基于 ${plan.baseSha}，但默认分支现在是 ${current}；请重新分析后再提交。`,
            `The plan is based on ${plan.baseSha}, but the default branch is now ${current}; analyse again before submitting.`,
          ),
        },
      })
    }
    const id = randomId('gate')
    const hash = planHash(plan)
    const row = store.createGateSession({
      id,
      repoId: repo.id,
      status: 'proposed',
      baseSha: plan.baseSha,
      planJson: JSON.stringify(plan),
      planHash: hash,
    })
    store.audit(viewer.user.id, 'gate.session.created', `${repo.owner}/${repo.name} session=${id} hash=${hash}`)
    return reply.code(201).send(gateSessionView(row))
  })

  app.get('/repos/:id/gate/sessions/:sessionId', async (request, reply) => {
    const { repo } = ownedRepo(request, String((request.params as Record<string, string>).id))
    const sessionId = String((request.params as Record<string, string>).sessionId)
    const session = store.getGateSessionForRepo(repo.id, sessionId)
    if (session === undefined) {
      const t = translator(request.locale ?? 'zh')
      return reply.code(404).send({ error: { type: 'GATE_SESSION_NOT_FOUND', message: t('门禁会话不存在。', 'That gate session does not exist.') } })
    }
    return reply.send(gateSessionView(session))
  })

  app.post('/repos/:id/gate/sessions/:sessionId/confirm', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    if (repo.repo_role !== 'maintainer') return gateMaintainerRefusal(reply, request)
    const sessionId = String((request.params as Record<string, string>).sessionId)
    const session = store.getGateSessionForRepo(repo.id, sessionId)
    const t = translator(request.locale ?? 'zh')
    if (session === undefined) {
      return reply.code(404).send({ error: { type: 'GATE_SESSION_NOT_FOUND', message: t('门禁会话不存在。', 'That gate session does not exist.') } })
    }
    if (session.status !== 'proposed') {
      return reply.code(409).send({
        error: {
          type: 'SESSION_NOT_PROPOSED',
          message: t(`这个会话的状态是 ${session.status}，不能确认。`, `The session is ${session.status} and cannot be confirmed.`),
        },
      })
    }
    // The hash is recomputed from the stored plan: a row edited behind the store
    // cannot be confirmed under the hash a person saw.
    let storedHash = ''
    try {
      const stored = validateGatePlan(JSON.parse(session.plan_json))
      if (stored.ok) storedHash = planHash(stored.plan)
    } catch {
      storedHash = ''
    }
    if (storedHash === '' || storedHash !== session.plan_hash) {
      return reply.code(409).send({
        error: {
          type: 'PLAN_HASH_MISMATCH',
          message: t('存储的计划与它记录的哈希不一致，请重新提交计划。', 'The stored plan does not match its recorded hash; submit the plan again.'),
        },
      })
    }
    const confirmed = store.updateGateSession(session.id, {
      status: 'confirmed',
      confirmed_by: viewer.user.login,
      confirmed_at: nowIso(),
      plan_hash: storedHash,
    })!
    store.audit(viewer.user.id, 'gate.session.confirmed', `${repo.owner}/${repo.name} session=${session.id} hash=${storedHash}`)
    const contentType = String(request.headers['content-type'] ?? '')
    if (contentType.includes('application/x-www-form-urlencoded')) {
      return reply.redirect(`/repos/${repo.id}/gate?notice=${encodeURIComponent(t('计划已确认。还没有写入仓库。', 'The plan is confirmed. Nothing has been written to the repository yet.'))}`)
    }
    return reply.send(gateSessionView(confirmed))
  })

  // #543 second slice: a confirmed plan may be applied once. The claim below is
  // a compare-and-set on the session row, so two clicks cannot both open a pull
  // request; the loser gets a 409 and the winner records the branch and PR URL on
  // the same row. Planning and confirming still write nothing to the repository.
  app.post('/repos/:id/gate/sessions/:sessionId/create', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    if (repo.repo_role !== 'maintainer') return gateMaintainerRefusal(reply, request)
    const sessionId = String((request.params as Record<string, string>).sessionId)
    const t = translator(request.locale ?? 'zh')
    const session = store.getGateSessionForRepo(repo.id, sessionId)
    if (session === undefined) {
      return reply.code(404).send({ error: { type: 'GATE_SESSION_NOT_FOUND', message: t('门禁会话不存在。', 'That gate session does not exist.') } })
    }
    if (session.pr_url !== null) {
      return reply.code(409).send({
        error: {
          type: 'GATE_PR_ALREADY_CREATED',
          prUrl: session.pr_url,
          message: t(`这个会话已经创建了门禁 PR：${session.pr_url}`, `This session already created its gate pull request: ${session.pr_url}`),
        },
      })
    }
    if (session.status !== 'confirmed') {
      return reply.code(409).send({
        error: {
          type: 'SESSION_NOT_CONFIRMED',
          message: t(`这个会话的状态是 ${session.status}；先由维护者确认计划，才会写入仓库。`, `The session is ${session.status}; a maintainer must confirm the plan before anything is written.`),
        },
      })
    }
    const claimed = store.claimGateSession(session.id, 'confirmed', 'analyzing')
    if (claimed === undefined) {
      return reply.code(409).send({
        error: {
          type: 'SESSION_NOT_CONFIRMED',
          message: t('另一个请求正在应用这个会话，或它的状态已经改变。', 'Another request is applying this session, or its status changed.'),
        },
      })
    }
    const refused = (status: number, code: string, message: string, branch?: string): FastifyReply => {
      store.updateGateSession(session.id, {
        status: code === 'stale_base_sha' ? 'refused' : 'failed',
        error_code: code,
        ...(branch === undefined ? {} : { branch }),
      })
      store.audit(viewer.user.id, 'gate.pr.refused', `${repo.owner}/${repo.name} session=${session.id} code=${code}`)
      return reply.code(status).send({ error: { type: code, message } })
    }
    let plan: GatePlan | null = null
    try {
      const parsed = validateGatePlan(JSON.parse(claimed.plan_json))
      // The hash is recomputed from the stored plan: a row edited behind the
      // store cannot be applied under the hash the human confirmed.
      if (parsed.ok && planHash(parsed.plan) === claimed.plan_hash) plan = parsed.plan
    } catch {
      plan = null
    }
    if (plan === null) {
      return refused(409, 'plan_invalid', t('存储的计划与它记录的哈希不一致，请重新提交计划。', 'The stored plan does not match its recorded hash; submit the plan again.'))
    }
    let token = ''
    try {
      token = await repoGithubToken(repo, config, githubApp, store)
    } catch (error) {
      log.warn('gate token unavailable', { repo: repo.id, error: String(error) })
      token = ''
    }
    if (token === '') {
      // Nothing was written; put the row back to `confirmed` so the same
      // confirmation can be applied once the connection is repaired.
      store.updateGateSession(session.id, { status: 'confirmed' })
      return reply.code(409).send({
        error: {
          type: 'GITHUB_TOKEN_MISSING',
          message: t('这个仓库没有可用的 GitHub 凭据，无法创建门禁 PR。', 'This repository has no usable GitHub credential, so the gate pull request cannot be created.'),
        },
      })
    }
    const owner = repo.upstream_owner || repo.owner
    const name = repo.upstream_name || repo.name
    const baseBranch = repo.target_branch || repo.upstream_default_branch || repo.default_branch
    const applied = await applyGatePlan({
      client: new GithubClient(token, config.github.apiBase),
      owner,
      name,
      baseBranch,
      plan,
      planHash: claimed.plan_hash,
      confirmedBy: claimed.confirmed_by ?? viewer.user.login,
    })
    if (!applied.ok) {
      const status = applied.code === 'github_unavailable' || applied.code === 'write_failed' || applied.code === 'pr_failed' ? 502 : 409
      return refused(status, applied.code, applied.message, applied.branch)
    }
    const created = store.updateGateSession(session.id, {
      status: 'created',
      branch: applied.branch,
      pr_url: applied.prUrl,
      error_code: null,
    })!
    store.audit(viewer.user.id, 'gate.pr.created', `${owner}/${name} session=${session.id} branch=${applied.branch} pr=${applied.prUrl}`)
    const notice = t(
      `门禁 PR 已创建：${applied.prUrl}（${applied.files.length} 个文件）`,
      `Gate pull request created: ${applied.prUrl} (${applied.files.length} files)`,
    )
    const contentType = String(request.headers['content-type'] ?? '')
    if (contentType.includes('application/x-www-form-urlencoded')) {
      return reply.redirect(`/repos/${repo.id}/gate?notice=${encodeURIComponent(notice)}`)
    }
    return reply.code(201).send(gateSessionView(created))
  })

  // #538: console overrides for the three rule files. A repository file stays
  // the first layer, this row is the second, and the built-in behaviour is the
  // implicit third. Writes carry the revision the form rendered, so a concurrent
  // edit is refused instead of overwriting it.
  app.get('/repos/:id/rules', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id))
    if (repo.repo_role !== 'maintainer') throw httpError(403, '只有 maintainer 可以编辑规则覆盖。', 'MAINTAINER_ONLY')
    const conflictPath = queryText(request, 'conflictPath')
    const conflictRevision = Number.parseInt(queryText(request, 'conflictRevision') ?? '', 10)
    return reply.type('text/html').send(rulesOverridesPage({
      config,
      locale: request.locale ?? 'zh',
      viewer: viewOf(viewer),
      repo,
      overrides: store.listRepoRuleOverrides(repo.id),
      saved: queryText(request, 'saved'),
      cleared: queryText(request, 'cleared'),
      ...(conflictPath === undefined ? {} : { conflictPath }),
      ...(Number.isInteger(conflictRevision) ? { conflictRevision } : {}),
      refused: queryText(request, 'refused'),
    }))
  })

  app.post('/repos/:id/rules', async (request, reply) => {
    // #708: a rule override steers every later job on this repository, so it
    // takes the destructive window before the revision is read.
    if (!limits.take('destructive', `rules-save:${rateLimitKey(request)}`)) return refuseTooMany(request, reply)
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    if (repo.repo_role !== 'maintainer') throw httpError(403, '只有 maintainer 可以编辑规则覆盖。', 'MAINTAINER_ONLY')
    const body = form(request)
    const path = body.path ?? ''
    const content = body.content ?? ''
    // #983: a refused or conflicting write re-renders the page with the
    // submission instead of a 302, because the follow-up GET re-read the stored
    // row and threw the maintainer's text away. The status stays 200: the
    // refusal is the banner, not an empty box.
    const keptPage = (extra: { refused?: string; conflictPath?: string; conflictRevision?: number }) => reply
      .code(200)
      .type('text/html')
      .send(rulesOverridesPage({
        config,
        locale: request.locale ?? 'zh',
        viewer: viewOf(viewer),
        repo,
        overrides: store.listRepoRuleOverrides(repo.id),
        draftPath: path,
        draftContent: content,
        draftRevision: body.expected_revision ?? '',
        ...extra,
      }))
    if (!isRulePath(path)) return keptPage({ refused: 'path_invalid' })
    if (content.trim() === '') return keptPage({ refused: 'content_empty' })
    if (content.includes('\0')) return keptPage({ refused: 'content_invalid' })
    if (Buffer.byteLength(content) > MAX_RULE_FILE_BYTES) return keptPage({ refused: 'content_too_large' })
    const expectedRevision = Number.parseInt(body.expected_revision ?? '', 10)
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) return keptPage({ refused: 'revision_invalid' })
    const result = store.upsertRepoRuleOverride({ repoId: repo.id, path, content, updatedBy: viewer.user.id, expectedRevision })
    if (!result.ok) {
      store.audit(viewer.user.id, 'repo.rules_override_refused', `${path}: expected ${expectedRevision}, current ${result.revision}`)
      return keptPage({ conflictPath: path, conflictRevision: result.revision })
    }
    store.audit(viewer.user.id, 'repo.rules_override_saved', `${path}: revision ${result.row.revision}, ${Buffer.byteLength(content)} bytes`)
    return reply.redirect(`/repos/${repo.id}/rules?saved=${encodeURIComponent(path)}`)
  })

  // #380: the allowlist had no owner path, so a revocation could never happen in
  // production. This route only flips a source the instance already recorded —
  // it cannot invent one — and the next automatic merge reads it.
  app.post('/repos/:id/skill-source', { config: { rateLimit: destructiveLimit } }, async (request, reply) => {
    if (!limits.take('destructive', `skill-source:${rateLimitKey(request)}`)) return refuseTooMany(request, reply)
    const { viewer, repo, role } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    // #380 review finding: the actor's role, not the connection declaration. A
    // repository connected without a recorded role still has an owner, and a
    // developer member of a declared-maintainer repository is still a developer.
    if (role !== 'maintainer') throw httpError(403, '只有 maintainer 可以修改技能包来源。', 'MAINTAINER_ONLY')
    const body = form(request)
    const source = (body.source ?? '').slice(0, 200)
    const state = body.state === 'revoked' ? 'revoked' : body.state === 'allowed' ? 'allowed' : null
    if (source === '' || state === null || store.skillBundleSource(repo.id, source) === undefined) {
      return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent('未知的技能包来源。')}#repo-skill-bundles`)
    }
    store.setSkillBundleSource({ repoId: repo.id, source, state, updatedBy: viewer.user.id })
    store.audit(viewer.user.id, 'repo.skill_source', `${repo.id}: ${state} ${source}`.slice(0, 300))
    return reply.redirect(`/repos/${repo.id}?notice=${encodeURIComponent(state === 'revoked' ? '来源已撤销，已加载它的任务不能自动合并。' : '来源已允许，对之后的任务生效。')}#repo-skill-bundles`)
  })

  app.post('/repos/:id/rules/delete', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    if (repo.repo_role !== 'maintainer') throw httpError(403, '只有 maintainer 可以编辑规则覆盖。', 'MAINTAINER_ONLY')
    const body = form(request)
    const path = body.path ?? ''
    if (!isRulePath(path)) return reply.redirect(`/repos/${repo.id}/rules?refused=path_invalid`)
    const expectedRevision = Number.parseInt(body.expected_revision ?? '', 10)
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) return reply.redirect(`/repos/${repo.id}/rules?refused=revision_invalid`)
    const result = store.deleteRepoRuleOverride({ repoId: repo.id, path, expectedRevision })
    if (!result.ok) {
      store.audit(viewer.user.id, 'repo.rules_override_refused', `${path}: clear expected ${expectedRevision}, current ${result.revision}`)
      if (result.code === 'rule_override_missing') return reply.redirect(`/repos/${repo.id}/rules?refused=rule_override_missing`)
      return reply.redirect(`/repos/${repo.id}/rules?conflictPath=${encodeURIComponent(path)}&conflictRevision=${result.revision}`)
    }
    store.audit(viewer.user.id, 'repo.rules_override_cleared', path)
    return reply.redirect(`/repos/${repo.id}/rules?cleared=${encodeURIComponent(path)}`)
  })

  app.get('/repos/:id/settings', async (request, reply) => {
    const { repo } = ownedRepo(request, String((request.params as Record<string, string>).id))
    return reply.redirect(`/repos/${repo.id}#repo-settings`)
  })

  app.get('/repos/:id/team', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id))
    requireAdvanced(viewer)
    const instance = store.getRepoInstance(repo.id)
    let state
    let stateError: string | undefined
    if (instance !== undefined && instance.status === 'ready') {
      try {
        state = await instances.teamState(repo.id, 20_000)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        stateError = localizeMessage(request.locale ?? 'zh', message) ?? message
      }
    }
    const jobsTotal = store.countJobsForRepo(repo.id)
    const jobsPage = Math.min(Math.max(1, Math.floor(Number(queryText(request, 'jobsPage')) || 1)), Math.max(1, Math.ceil(jobsTotal / 10)))
    return reply.type('text/html').send(teamPage({
      config,
      locale: request.locale ?? 'zh',
      viewer: viewOf(viewer),
      repo,
      instance,
      state,
      stateError,
      jobs: store.listJobsPageForRepo(repo.id, 10, (jobsPage - 1) * 10),
      queued: store.listQueuedJobs(),
      jobsPage,
      jobsTotal,
      notice: request.flash?.notice?.text,
      error: request.flash?.error?.text,
    }))
  })

  app.get('/api/repos/:id/team', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id))
    requireAdvanced(viewer)
    try {
      const state = await instances.teamState(repo.id, 15_000)
      const t = translator(request.locale ?? 'zh')
      // #1190: the poll and the stream must agree about a marked claim, so both
      // carry the same rendered `attributionText`.
      return {
        ...state,
        jobs: localizedJobs(store.listJobsForRepo(repo.id).slice(0, 5), request.locale ?? 'zh')
          .map((job) => ({ ...job, attributionText: jobAttribution(t, job) })),
      }
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.post('/repos/:id/team/guidance', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    requireAdvanced(viewer)
    const body = form(request)
    const target = (body.target ?? '').trim()
    const text = (body.text ?? '').trim()
    try {
      await instances.sendGuidance(repo.id, target, text)
      store.audit(viewer.user.id, 'team.guidance', `${repo.owner}/${repo.name} target=${target} chars=${text.length}`)
      store.event('team_intervention', { userId: viewer.user.id, repoId: repo.id, meta: `guidance:${target}` })
      const t = translator(request.locale ?? 'zh')
      return reply.redirect(`/repos/${repo.id}/team?notice=${encodeURIComponent(t('指导意见已发送给团队。', 'Guidance sent to the team.'))}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return reply.redirect(`/repos/${repo.id}/team?error=${encodeURIComponent(message)}`)
    }
  })

  app.get('/api/repos/:id/chief/messages', async (request, reply) => {
    const { repo } = ownedRepo(request, String((request.params as Record<string, string>).id))
    const instance = store.getRepoInstance(repo.id)
    if (instance === undefined || instance.status !== 'ready') return reply.code(409).send({ error: 'FlyBot 实例尚未就绪' })
    try {
      return { messages: await instances.chiefTranscript(repo.id, 30) }
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.get('/api/repos/:id/chief/events', async (request, reply) => {
    const { repo } = ownedRepo(request, String((request.params as Record<string, string>).id))
    const instance = store.getRepoInstance(repo.id)
    if (instance === undefined || instance.status !== 'ready') return reply.code(409).send({ error: 'FlyBot 实例尚未就绪' })
    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    let closed = false
    let busy = false
    let last = ''
    let lastSignature = ''
    let heartbeat = 0
    let timer: NodeJS.Timeout | undefined
    const close = (): void => {
      if (closed) return
      closed = true
      if (timer !== undefined) clearInterval(timer)
      try { reply.raw.end() } catch {}
    }
    const send = (event: string, data: unknown): void => {
      if (!closed) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    request.raw.on('close', close)
    reply.raw.on('close', close)
    const tick = async (): Promise<void> => {
      if (closed || busy) return
      busy = true
      try {
        let signature = lastSignature
        try {
          const state = await instances.teamState(repo.id, 3_000)
          const chief = state.bots.find((bot) => bot.role === 'chief')
          signature = `${chief?.activity ?? ''}:${chief?.lastActivityAt ?? ''}:${chief?.since ?? ''}`
        } catch {
          // Fall through to the last known signature; the transcript read reports errors.
        }
        if (signature !== lastSignature || last === '') {
          lastSignature = signature
          const messages = await instances.chiefTranscript(repo.id, 30)
          const text = JSON.stringify(messages)
          if (text !== last) {
            last = text
            send('snapshot', { messages, updatedAt: new Date().toISOString() })
          }
        } else if (++heartbeat >= 15) {
          heartbeat = 0
          reply.raw.write(': ping\n\n')
        }
      } catch (error) {
        send('error', { message: error instanceof Error ? error.message : String(error) })
        close()
      } finally {
        busy = false
      }
    }
    timer = setInterval(() => void tick(), 2_000)
    await tick()
  })

  app.post('/api/repos/:id/chief/message', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const body = (request.body ?? {}) as Record<string, unknown>
    const text = (typeof body.text === 'string' ? body.text : '').trim().slice(0, 4000)
    const t = translator(request.locale ?? 'zh')
    if (text === '') return reply.code(400).send({ error: t('留言不能为空。', 'The message cannot be empty.') })
    try {
      await instances.sendGuidance(repo.id, 'chief', `[Fledge owner message]\n${text}`)
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : String(error) })
    }
    instances.clearChiefTranscript(repo.id)
    store.audit(viewer.user.id, 'team.chief_message', `${repo.owner}/${repo.name} chars=${text.length}`)
    store.event('team_intervention', { userId: viewer.user.id, repoId: repo.id, meta: 'chief-message' })
    return { ok: true }
  })

  app.post('/repos/:id/chief/message', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const text = (form(request).text ?? '').trim().slice(0, 4000)
    const t = translator(request.locale ?? 'zh')
    if (text === '') return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent(t('留言不能为空。', 'The message cannot be empty.'))}`)
    try {
      await instances.sendGuidance(repo.id, 'chief', `[Fledge owner message]\n${text}`)
    } catch (error) {
      return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`)
    }
    instances.clearChiefTranscript(repo.id)
    store.audit(viewer.user.id, 'team.chief_message', `${repo.owner}/${repo.name} chars=${text.length}`)
    store.event('team_intervention', { userId: viewer.user.id, repoId: repo.id, meta: 'chief-message' })
    return reply.redirect(`/repos/${repo.id}?notice=${encodeURIComponent(t('已发送给 Chief。', 'Sent to the Chief.'))}`)
  })

  app.post('/repos/:id/team/stop', async (request, reply) => {
    // #708: expensive — one team turn, paced before the session is read.
    if (!limits.take('expensive', `team-stop:${rateLimitKey(request)}`)) return refuseTooMany(request, reply)
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    requireAdvanced(viewer)
    const body = form(request)
    const target = (body.target ?? '').trim()
    const returnTo = safeLocalPath(body.returnTo, `/repos/${repo.id}/team`)
    const withMessage = (key: 'notice' | 'error', message: string): string =>
      `${returnTo}${returnTo.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(message)}`
    const t = translator(request.locale ?? 'zh')
    let state
    try {
      state = await instances.teamState(repo.id, 15_000)
    } catch (error) {
      return reply.redirect(withMessage('error', error instanceof Error ? error.message : String(error)))
    }
    const sessions = target === ''
      ? state.bots.filter((bot) => bot.activity === 'thinking' || bot.activity === 'working').map((bot) => bot.sessionId)
      : state.bots.filter((bot) => bot.role === target).map((bot) => bot.sessionId)
    if (sessions.length === 0) return reply.redirect(withMessage('notice', t('当前没有正在工作的角色。', 'No role is working right now.')))
    try {
      const result = await instances.stopSessions(repo.id, sessions)
      store.audit(viewer.user.id, 'team.stop', `${repo.owner}/${repo.name} hard=${result.stopped.length} soft=${result.requested.length}`)
      store.event('team_intervention', { userId: viewer.user.id, repoId: repo.id, meta: 'stop' })
      return reply.redirect(withMessage('notice', result.stopped.length > 0
        ? t(`已停止 ${result.stopped.length} 个角色；${result.requested.length} 个角色收到暂停请求。`, `Stopped ${result.stopped.length} role(s); requested a stop for ${result.requested.length}.`)
        : t(`已发送暂停请求给 ${result.requested.length} 个角色，将在下一个安全点生效。`, `Requested a stop for ${result.requested.length} role(s); it takes effect at the next safe point.`)))
    } catch (error) {
      return reply.redirect(withMessage('error', error instanceof Error ? error.message : String(error)))
    }
  })

  app.post('/repos/:id/team/answer', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const body = (request.body ?? {}) as Record<string, unknown>
    const text = (key: string): string => typeof body[key] === 'string' ? String(body[key]) : ''
    const rawSelected = body.selected
    const selected = Array.isArray(rawSelected)
      ? rawSelected.filter((value): value is string => typeof value === 'string')
      : typeof rawSelected === 'string' ? [rawSelected] : []
    const returnTo = safeLocalPath(text('returnTo'), '/console')
    const wantsJson = String(request.headers.accept ?? '').includes('application/json')
    const withMessage = (key: 'notice' | 'error', message: string): string =>
      `${returnTo}${returnTo.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(message)}`
    const fail = (message: string) => wantsJson ? reply.code(400).send({ error: message }) : reply.redirect(withMessage('error', message))
    const t = translator(request.locale ?? 'zh')
    // #381: an inbox card whose id carries the `job:` prefix is a paused job's
    // decision, not a live session. The first answer is stored on the job and
    // starts exactly one retry through `retryJob`; a second POST replays the
    // stored answer and enqueues nothing.
    const questionId = text('questionId')
    const answer = (text('custom').trim() !== '' ? text('custom').trim() : selected.join(', ')).trim()
    const decisionJobId = jobIdFromQuestionId(questionId)
    if (decisionJobId !== null) {
      if (answer === '') return fail(t('请先填写回答。', 'Write an answer first.'))
      const job = store.getJob(decisionJobId)
      if (job === undefined || job.repo_id !== repo.id) return fail(t('这个问题已经关闭。', 'This question is already closed.'))
      const decision = storedDecision(job.decision_json)
      if (decision === null) return fail(t('这个问题已经关闭。', 'This question is already closed.'))
      if (decision.answer === null) {
        // #381 review: the retry is judged first, and the answer is stored only
        // when that retry was accepted. Storing first left a refused answer on
        // the row, and an answered row is exactly what removes the card from the
        // inbox (`inboxForUser`), so an ordinary refusal — JOB_ACTIVE,
        // QUEUE_FULL, REPO_DISABLED, PLATFORM_PAUSED — dropped the person's
        // question while no retry existed, and the remaining `Resume` control
        // reopened the run without the answer.
        const retried = await jobs.retryJob(job.id, viewer.user.id, { decisionAnswer: { question: decision.question, answer } })
        if (!retried.ok) return fail(retried.error ?? t('重试失败。', 'The retry failed.'))
        store.updateJob(job.id, {
          decision_json: decisionWithAnswer(decision, { text: answer.slice(0, 1000), by: viewer.user.login, at: nowIso() }),
        })
      }
      store.audit(viewer.user.id, 'team.answer', `${repo.owner}/${repo.name} question=${questionId.slice(0, 80)}`)
      store.event('team_intervention', { userId: viewer.user.id, repoId: repo.id, meta: 'answer' })
      store.markQuestionNotificationsRead(viewer.user.id)
      inboxCache.delete(viewer.user.id)
      if (wantsJson) return { ok: true }
      return reply.redirect(withMessage('notice', t('答案已发送。', 'Answer sent.')))
    }
    try {
      await instances.answerQuestion(repo.id, text('sessionId'), questionId, selected, text('custom'))
      store.recordProductEvent({ name: 'human_action_answer', repoId: repo.id, subject: questionId })
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
    store.audit(viewer.user.id, 'team.answer', `${repo.owner}/${repo.name} question=${text('questionId').slice(0, 80)}`)
    store.event('team_intervention', { userId: viewer.user.id, repoId: repo.id, meta: 'answer' })
    store.markQuestionNotificationsRead(viewer.user.id)
    inboxCache.delete(viewer.user.id)
    if (wantsJson) return { ok: true }
    return reply.redirect(withMessage('notice', t('答案已发送。', 'Answer sent.')))
  })

  app.get('/api/repos/:id/team/events', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id))
    requireAdvanced(viewer)
    const instance = store.getRepoInstance(repo.id)
    if (instance === undefined || instance.status !== 'ready') return reply.code(409).send({ error: 'FlyBot 实例尚未就绪' })
    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    let closed = false
    let busy = false
    let last = ''
    let heartbeat = 0
    let timer: NodeJS.Timeout | undefined
    const close = (): void => {
      if (closed) return
      closed = true
      if (timer !== undefined) clearInterval(timer)
      try { reply.raw.end() } catch {}
    }
    const send = (event: string, data: unknown): void => {
      if (!closed) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    request.raw.on('close', close)
    reply.raw.on('close', close)
    const tick = async (): Promise<void> => {
      if (closed || busy) return
      busy = true
      try {
        const state = await instances.teamState(repo.id, 10_000)
        const user = store.userById(viewer.user.id) ?? viewer.user
        const quota = quotaView(user, config)
        const snapshot = {
          ...state,
          quota: {
            unlimited: quota.unlimited,
            initialCny: quota.initialCny,
            usedCny: quota.usedCny,
            remainingCny: quota.remainingCny,
            exhausted: quota.exhausted,
          },
          jobs: (() => {
            const t = translator(request.locale ?? 'zh')
            return localizedJobs(store.listJobsForRepo(repo.id, 5), request.locale ?? 'zh').map((job) => ({
              id: job.id,
              kind: job.kind,
              status: job.status,
              summary: job.summary,
              error: job.error,
              issueUrl: job.issue_url,
              prUrl: job.pr_url,
              reviewScore: job.review_score,
              attribution: parseAttributionJson(job.attribution_json),
              // #1190: the server-rendered text is what the console shows, so the
              // first tick cannot replace a marked claim with the bare seat. The
              // structured field keeps its type; the script contains no marker
              // vocabulary of its own.
              attributionText: jobAttribution(t, job),
              createdAt: job.created_at,
              finishedAt: job.finished_at,
            }))
          })(),
        }
        const text = JSON.stringify(snapshot)
        if (text !== last) {
          last = text
          send('snapshot', { ...snapshot, updatedAt: new Date().toISOString() })
        } else if (++heartbeat >= 15) {
          heartbeat = 0
          reply.raw.write(': ping\n\n')
        }
      } catch (error) {
        send('error', { message: error instanceof Error ? error.message : String(error) })
        close()
      } finally {
        busy = false
      }
    }
    timer = setInterval(() => void tick(), 1_000)
    await tick()
  })

  app.get('/api/inbox/events', async (request, reply) => {
    const viewer = requireApproved(request)
    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    let closed = false
    request.raw.on('close', () => { closed = true })
    let last = ''
    const send = (event: string, data: unknown): void => {
      if (!closed) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    const tick = async (): Promise<void> => {
      try {
        const repos = store.listRepos(viewer.user.id)
        const questions = await inboxForUser(viewer.user.id, repos)
        const signature = questions.map((question) => `${question.repoId}:${question.sessionId}:${question.id}`).sort().join('|')
        if (signature === last) {
          if (!closed) reply.raw.write(': ping\n\n')
          return
        }
        last = signature
        send('inbox', { html: inboxSection(request.locale ?? 'zh', viewOf(viewer), questions, '/console'), count: questions.length })
      } catch (error) {
        send('error', { message: error instanceof Error ? error.message : String(error) })
      }
    }
    const timer = setInterval(() => void tick(), 5_000)
    request.raw.on('close', () => clearInterval(timer))
    await tick()
  })

  app.post('/api/repos/:id/team/answer', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    requireAdvanced(viewer)
    const body = (request.body ?? {}) as Record<string, unknown>
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    const questionId = typeof body.questionId === 'string' ? body.questionId : ''
    const selected = Array.isArray(body.selected) ? body.selected.filter((value): value is string => typeof value === 'string') : []
    const custom = typeof body.custom === 'string' ? body.custom : ''
    try {
      await instances.answerQuestion(repo.id, sessionId, questionId, selected, custom)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
    store.audit(viewer.user.id, 'team.answer', `${repo.owner}/${repo.name} question=${questionId.slice(0, 80)}`)
    store.event('team_intervention', { userId: viewer.user.id, repoId: repo.id, meta: 'answer' })
    store.markQuestionNotificationsRead(viewer.user.id)
    inboxCache.delete(viewer.user.id)
    return { ok: true }
  })

  app.post('/api/repos/:id/team/stop', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    requireAdvanced(viewer)
    const body = (request.body ?? {}) as Record<string, unknown>
    const target = typeof body.target === 'string' ? body.target.trim() : ''
    let state
    try {
      state = await instances.teamState(repo.id, 15_000)
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : String(error) })
    }
    const sessions = target === ''
      ? state.bots.filter((bot) => bot.activity === 'thinking' || bot.activity === 'working').map((bot) => bot.sessionId)
      : state.bots.filter((bot) => bot.role === target).map((bot) => bot.sessionId)
    if (sessions.length === 0) return { ok: true, stopped: [], requested: [], message: '当前没有正在工作的角色。' }
    try {
      const result = await instances.stopSessions(repo.id, sessions)
      store.audit(viewer.user.id, 'team.stop', `${repo.owner}/${repo.name} hard=${result.stopped.length} soft=${result.requested.length}`)
      store.event('team_intervention', { userId: viewer.user.id, repoId: repo.id, meta: 'stop' })
      return { ok: true, ...result }
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.get('/repos/:id/jobs/:jobId', async (request, reply) => {
    const { viewer, repo, role } = ownedRepo(request, String((request.params as Record<string, string>).id))
    const job = store.getJob(String((request.params as Record<string, string>).jobId))
    if (job === undefined || job.repo_id !== repo.id) throw httpError(404, '任务不存在。', 'JOB_NOT_FOUND')
    const queued = store.listQueuedJobs()
    // #565: the queue is instance-wide, the ahead-list is the viewer's own. The
    // label map keeps the viewer's own repositories readable without naming
    // anybody else's.
    const repoLabels = new Map(store.listRepos(viewer.user.id).map((entry) => [entry.id, `${entry.upstream_owner || entry.owner}/${entry.upstream_name || entry.name}`]))
    // #373: one read of the pull request, cached per job, so the page can say
    // what the change is and not only that its checks passed.
    const pull = await pullSnapshotFor(repo, job)
    return reply.type('text/html').send(jobPage({
      config,
      locale: request.locale ?? 'zh',
      viewer: viewOf(viewer),
      repo,
      job,
      // #369: the bundle diff is against the previous job of this repository that
      // recorded one, read from the rows rather than inferred from list order.
      previousJob: store.previousJobWithBundle(repo.id, job.id) ?? null,
      // #1040: the press is gated on the actor's role, so the page that draws the
      // control reads the same role the route decides with.
      viewerRole: role === 'maintainer' || role === 'developer' || role === 'viewer' ? role : 'viewer',
      changeStory: pull.story,
      pullTip: pull.tip,
      // #264: the card's merge control is the same `task.merge` command the
      // repository page sends, carrying the revision this render saw.
      merge: { revision: management.revisionOf('job', job.id), idempotencyKey: randomId('cmd') },
      strategy: jobStrategyView(store, repo.id, job),
      queued,
      viewerActive: store.listActiveJobsForUser(viewer.user.id),
      repoLabels,
      events: store.listJobEvents(job.id, 200),
      relations: store.listTaskRelations(job.id),
      // #379: the findings whose last report was this job, so the page can name
      // where a dismissed finding was last seen when it came back.
      findings: store.listSecurityFindingsForJob(job.id),
      postmortem: store.getPostmortemForJob(job.id) ?? null,
      // #540: the cancel form carries the revision it rendered and a fresh key,
      // so a double submit replays the same receipt and a stale page conflicts.
      cancel: { revision: management.revisionOf('job', job.id), idempotencyKey: randomId('cmd') },
      pause: { revision: management.revisionOf('job', job.id), idempotencyKey: randomId('cmd') },
      // Execute starts a new job through `task.create`, which fences the project,
      // not this plan job: the form must render the revision the command compares
      // (#540 review — the plan job's own revision is 1 while the project is 2).
      execute: { revision: management.revisionOf('project', repo.id), idempotencyKey: randomId('cmd') },
      resume: { revision: management.revisionOf('job', job.id), idempotencyKey: randomId('cmd') },
      retry: { revision: management.revisionOf('job', job.id), idempotencyKey: randomId('cmd') },
      notice: request.flash?.notice?.text,
      error: request.flash?.error?.text,
    }))
  })

  // #540: the form route is an adapter over the management contract. It resolves
  // the actor, hands over the revision and key the page rendered, and turns the
  // receipt into a redirect. The cancel rules themselves live in Jobs.cancelJob.
  app.post('/repos/:id/jobs/:jobId/cancel', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const job = store.getJob(String((request.params as Record<string, string>).jobId))
    if (job === undefined || job.repo_id !== repo.id) throw httpError(404, '任务不存在。', 'JOB_NOT_FOUND')
    const t = translator(request.locale ?? 'zh')
    const parts = commandParts(form(request), management.revisionOf('job', job.id))
    const actor = managementActor({ store, userId: viewer.user.id, repo, channel: 'web', requestId: request.id })
    const outcome = await management.run(actor, {
      operation: 'task.cancel',
      target: { projectId: repo.id, jobId: job.id },
      arguments: {},
      expectedRevision: parts.expectedRevision,
      idempotencyKey: parts.idempotencyKey,
    })
    const back = `/repos/${repo.id}/jobs/${job.id}`
    if (outcome.ok) return reply.redirect(`${back}?notice=${encodeURIComponent(t('任务已取消。', 'Job cancelled.'))}`)
    return reply.redirect(`${back}?error=${encodeURIComponent(managementRefusal(t, outcome.code, t('取消失败。', 'The cancel failed.')))}&code=${outcome.code}`)
  })

  // #540 slice 2: pausing goes through the same contract as cancelling. The
  // switch decides how far — `off` is the route that existed before this slice,
  // `shadow` reserves and records the command but keeps that route, and `on`
  // runs the command and turns its receipt into the redirect.
  app.post('/repos/:id/jobs/:jobId/pause', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const job = store.getJob(String((request.params as Record<string, string>).jobId))
    if (job === undefined || job.repo_id !== repo.id) throw httpError(404, '任务不存在。', 'JOB_NOT_FOUND')
    const back = `/repos/${repo.id}/jobs/${job.id}`
    const t = translator(request.locale ?? 'zh')
    const today = async (): Promise<{ notice: string } | { error: string }> => {
      const result = await jobs.pauseJob(job.id)
      return result.ok ? { notice: t('任务已暂停。', 'Job paused.') } : { error: result.error ?? t('暂停失败。', 'The pause failed.') }
    }
    const answer = (result: { notice: string } | { error: string }) => ('notice' in result
      ? reply.redirect(`${back}?notice=${encodeURIComponent(result.notice)}`)
      : reply.redirect(`${back}?error=${encodeURIComponent(result.error)}`))

    if (config.managementService === 'off') return answer(await today())

    const parts = commandParts(form(request), management.revisionOf('job', job.id))
    const actor = managementActor({ store, userId: viewer.user.id, repo, channel: 'web', requestId: request.id })
    const envelope = {
      operation: 'task.pause',
      target: { projectId: repo.id, jobId: job.id },
      arguments: {},
      expectedRevision: parts.expectedRevision,
      idempotencyKey: parts.idempotencyKey,
    }

    if (config.managementService === 'shadow') {
      // The person keeps today's route and its sentence; the receipt records what
      // the contract would have done with the very same form, which is the point
      // of shadow — a divergence shows up in the receipt, not in the UI.
      const begun = management.begin(actor, envelope)
      const result = await today()
      // A replayed command already has its receipt, and a replay must never
      // rewrite it: the second submit of the same form runs today's route again
      // (which refuses), but the ledger keeps the success it recorded first.
      if (begun.ok && !begun.replayed) {
        management.settle(begun.receipt.id, 'notice' in result
          ? { ok: true, result: { jobId: job.id, shadow: true } }
          : { ok: false, code: 'job_not_pausable', message: 'the route refused the pause' })
      }
      return answer(result)
    }

    const outcome = await management.run(actor, envelope)
    if (outcome.ok) return answer({ notice: t('任务已暂停。', 'Job paused.') })
    return reply.redirect(`${back}?error=${encodeURIComponent(managementRefusal(t, outcome.code, t('暂停失败。', 'The pause failed.')))}&code=${outcome.code}`)
  })

  // #540 slice 2 (rest): resuming is a command. The route only resolves the job
  // and turns the receipt into a redirect; the resume itself, its refusal and its
  // audit row live in `Jobs.resumeJob`. A double submit replays the same new job.
  app.post('/repos/:id/jobs/:jobId/resume', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const job = store.getJob(String((request.params as Record<string, string>).jobId))
    if (job === undefined || job.repo_id !== repo.id) throw httpError(404, '任务不存在。', 'JOB_NOT_FOUND')
    const t = translator(request.locale ?? 'zh')
    const outcome = await runJobOperation(request, viewer, repo, job.id, 'task.resume')
    if (!outcome.ok) {
      return reply.redirect(`/repos/${repo.id}/jobs/${job.id}?error=${encodeURIComponent(managementFailure(t, outcome, t('恢复失败。', 'The resume failed.')))}&code=${outcome.code}`)
    }
    const resumed = commandJobId(outcome) ?? job.id
    return reply.redirect(`/repos/${repo.id}/jobs/${resumed}?notice=${encodeURIComponent(t('已恢复任务。', 'Job resumed.'))}`)
  })

  // The active-job check that used to sit here is `Jobs.enqueue`'s own refusal
  // (`JOB_ACTIVE`), which the banner already translates; keeping a second copy in
  // the route is exactly the duplication this contract removes.
  app.post('/repos/:id/jobs/:jobId/retry', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const job = store.getJob(String((request.params as Record<string, string>).jobId))
    if (job === undefined || job.repo_id !== repo.id) throw httpError(404, '任务不存在。', 'JOB_NOT_FOUND')
    const t = translator(request.locale ?? 'zh')
    const outcome = await runJobOperation(request, viewer, repo, job.id, 'task.retry')
    if (!outcome.ok) {
      return reply.redirect(`/repos/${repo.id}/jobs/${job.id}?error=${encodeURIComponent(managementFailure(t, outcome, t('重试失败。', 'The retry failed.')))}&code=${outcome.code}`)
    }
    const retried = commandJobId(outcome) ?? job.id
    store.recordProductEvent({ name: 'human_action_retry', repoId: repo.id, subject: job.id })
    return reply.redirect(`/repos/${repo.id}/jobs/${retried}?notice=${encodeURIComponent(t('已重新排队。', 'Queued again.'))}`)
  })

  // #639: a priority change is a claim about urgency, so the route hands the
  // level, the reason and the evidence to one service method. The ladder is the
  // closed P0..P3 set; the store moves a real change to the new level's tail and
  // leaves a running job running.
  app.post('/repos/:id/jobs/:jobId/priority', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const job = store.getJob(String((request.params as Record<string, string>).jobId))
    if (job === undefined || job.repo_id !== repo.id) throw httpError(404, '任务不存在。', 'JOB_NOT_FOUND')
    const back = `/repos/${repo.id}/jobs/${job.id}`
    if (repo.repo_role !== 'maintainer' && repo.repo_role !== 'developer') {
      return reply.redirect(`${back}?error=${encodeURIComponent('请先选择你的角色。')}`)
    }
    const t = translator(request.locale ?? 'zh')
    const body = form(request)
    const result = await jobs.setPriority(job.id, {
      level: String(body.level ?? '') as PriorityLevel,
      reason: String(body.reason ?? ''),
      evidence: String(body.evidence ?? ''),
      actorUserId: viewer.user.id,
    })
    if (!result.ok) {
      // The refusal reaches the page as text, so it is written in the request
      // locale here; the service names the code and the route owns the wording.
      const refusal = result.code === 'PRIORITY_EVIDENCE_REQUIRED'
        ? t(
          'P0/P1 需要理由（至少 12 字）和可核对的证据：链接、提交/工单 sha，或带单位的测量值。形容词不算证据。',
          'P0/P1 need a reason (at least 12 characters) and checkable evidence: a link, a commit/issue sha, or a measurement with a unit. An adjective is not evidence.',
        )
        : result.code === 'PRIORITY_LEVEL_INVALID'
          ? t('优先级别无效，请选 P0、P1、P2 或 P3。', 'That priority level is not valid; choose P0, P1, P2 or P3.')
          : (result.error ?? t('优先级修改失败。', 'The priority change failed.'))
      return reply.redirect(`${back}?error=${encodeURIComponent(refusal)}&code=${encodeURIComponent(result.code ?? '')}`)
    }
    const notice = result.changed === true
      ? t(`优先级已改为 ${result.level}。`, `Priority is now ${result.level}.`)
      : t('优先级没有变化。', 'The priority is unchanged.')
    return reply.redirect(`${back}?notice=${encodeURIComponent(notice)}`)
  })

  // #639: a relation is an explicit claim that two tasks are about one problem.
  // The route refuses a target outside this repository and hands the claim
  // standard to the service, so no title match can ever create one.
  app.post('/repos/:id/jobs/:jobId/relations', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const job = store.getJob(String((request.params as Record<string, string>).jobId))
    if (job === undefined || job.repo_id !== repo.id) throw httpError(404, '任务不存在。', 'JOB_NOT_FOUND')
    const back = `/repos/${repo.id}/jobs/${job.id}`
    if (repo.repo_role !== 'maintainer' && repo.repo_role !== 'developer') {
      return reply.redirect(`${back}?error=${encodeURIComponent('请先选择你的角色。')}`)
    }
    const t = translator(request.locale ?? 'zh')
    const body = form(request)
    const result = await jobs.relate({
      repoId: repo.id,
      sourceJobId: job.id,
      targetJobId: String(body.target_job_id ?? '').trim(),
      kind: body.kind,
      reason: body.reason ?? '',
      evidence: body.evidence ?? '',
      actorUserId: viewer.user.id,
    })
    if (!result.ok) {
      const refusal = result.code === 'RELATION_EVIDENCE_REQUIRED'
        ? t(
          '关联需要理由（至少 8 字）和可核对的证据：链接、提交/工单 sha，或带单位的测量值。',
          'A relation needs a reason (at least 8 characters) and checkable evidence: a link, a commit/issue sha, or a measurement with a unit.',
        )
        : result.code === 'RELATION_KIND_INVALID'
          ? t('关联类型无效，请选同一问题、相关或复发。', 'That relation kind is not valid; choose same problem, related or recurrence.')
          : result.code === 'relation_cross_project'
            ? t('只能关联同一仓库里的任务。', 'A relation can only join two tasks of the same repository.')
            : result.code === 'relation_same_job'
              ? t('任务不能和它自己建立关联。', 'A task cannot be related to itself.')
              : t('目标任务不存在。', 'The target task does not exist.')
      return reply.redirect(`${back}?error=${encodeURIComponent(refusal)}`)
    }
    const notice = result.created === true
      ? t('已建立关联。', 'Relation saved.')
      : t('关联已存在。', 'That relation already exists.')
    return reply.redirect(`${back}?notice=${encodeURIComponent(notice)}`)
  })

  // #639: the post-QA decision is one bounded write. The route accepts the four
  // kinds, names the refusal in the request's locale, and leaves the claim
  // standard and the repair to the service. A decision that needs no decision at
  // all is not a route: the framework default is what the page preselects.
  app.post('/repos/:id/jobs/:jobId/decision', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const job = store.getJob(String((request.params as Record<string, string>).jobId))
    if (job === undefined || job.repo_id !== repo.id) throw httpError(404, '任务不存在。', 'JOB_NOT_FOUND')
    const back = `/repos/${repo.id}/jobs/${job.id}`
    // #1113: who may decide is `ownedRepo`'s answer, the same role the job page
    // reads to draw this control (#1081), never `repo.repo_role`: that column is
    // Fledge's upstream access and stays NULL on a repository connected before any
    // role was checked, which made the page offer a form the route then refused.
    // A second refusal here can only be unreachable — the guard already answers
    // 404 for a non-member and 403 for a viewer.
    const t = translator(request.locale ?? 'zh')
    const body = form(request)
    const result = await jobs.decideNextTask({
      repoId: repo.id,
      sourceJobId: job.id,
      kind: body.kind,
      existingTaskId: String(body.existing_task_id ?? '').trim(),
      reason: body.reason ?? '',
      evidence: body.evidence ?? '',
      title: String(body.title ?? ''),
      level: body.level,
      actorUserId: viewer.user.id,
    })
    if (!result.ok) {
      // The service names the code; the route owns the sentence, so it is
      // written in the request's language rather than translated afterwards.
      const refusal = result.code === 'DECISION_KIND_INVALID'
        ? t('下一步决定无效，请选新任务、补充、相关或复发。', 'That next-step decision is not valid; choose a new task, a supplement, related or a recurrence.')
        : result.code === 'DECISION_EVIDENCE_REQUIRED'
          ? t('下一步决定需要理由（至少 8 字）和可核对的证据：链接、提交/工单 sha，或带单位的测量值。', 'A next-step decision needs a reason (at least 8 characters) and checkable evidence: a link, a commit/issue sha, or a measurement with a unit.')
          : result.code === 'DECISION_TARGET_REQUIRED'
            ? t('补充、相关或复发都要指出一个已有的任务。', 'To supplement, relate or recur, you must name an existing task.')
            : result.code === 'relation_same_job'
              ? t('任务不能和它自己建立关联。', 'A task cannot be related to itself.')
              : result.code === 'relation_cross_project'
                ? t('只能关联同一仓库里的任务。', 'A relation can only join two tasks of the same repository.')
                : t('那个已有任务不存在，或新任务还没有标题。', 'That existing task does not exist, or the new task has no title.')
      return reply.redirect(`${back}?error=${encodeURIComponent(refusal)}&code=${encodeURIComponent(result.code ?? '')}`)
    }
    const kind = isDecisionKind(result.kind) ? result.kind : 'new'
    const label = decisionKindLabel(kind, t)
    const repaired = result.repaired === true ? t('（“新任务”与已有任务 id 同时出现，已按相关处理一次。）', ' (a separate new task and an existing task id came together; it was repaired once into related.)') : ''
    const notice = t(`已记为下一步：${label}。${repaired}`, `Recorded as the next step: ${label}.${repaired}`)
    return reply.redirect(`${back}?notice=${encodeURIComponent(notice)}`)
  })

  // #1040: the red-test record is a claim, and a claim needs an answer. A
  // maintainer presses confirm or challenge here; the decision is written on the
  // job and the page reads it back. A press that cannot decide anything (no
  // record, no challenge reason, a role that cannot answer) is refused before a
  // write, and the record itself is never rewritten by the press.
  app.post('/repos/:id/jobs/:jobId/red-test', async (request, reply) => {
    const { viewer, repo, role } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const job = store.getJob(String((request.params as Record<string, string>).jobId))
    if (job === undefined || job.repo_id !== repo.id) throw httpError(404, '任务不存在。', 'JOB_NOT_FOUND')
    const back = `/repos/${repo.id}/jobs/${job.id}`
    const t = translator(request.locale ?? 'zh')
    // #1040: the actor's role, not `repo.repo_role`. That column declares what
    // access Fledge was granted upstream and stays NULL on a connected
    // repository, so reading it locked the owner out while letting a member
    // through on a repository that happened to declare itself maintainer.
    if (role !== 'maintainer') {
      return reply.redirect(`${back}?error=${encodeURIComponent(t('只有 maintainer 可以复核红测记录。', 'Only a maintainer can decide the red-test claim.'))}`)
    }
    const evidence = parseEvidenceJson(job.evidence_json)
    const record = evidence?.redTest
    if (evidence === null || record === undefined) {
      return reply.redirect(`${back}?error=${encodeURIComponent(t('这个任务没有红测记录，无法复核。', 'This job has no red-test record to decide.'))}`)
    }
    const body = form(request)
    const decision = body.decision === 'confirm' ? 'confirmed' : body.decision === 'challenge' ? 'challenged' : null
    if (decision === null) {
      return reply.redirect(`${back}?error=${encodeURIComponent(t('红测决定无效，请确认或质疑。', 'That red-test decision is not valid; confirm or challenge.'))}`)
    }
    const note = (body.note ?? '').trim().slice(0, 300)
    if (decision === 'challenged' && note.length < 8) {
      return reply.redirect(`${back}?error=${encodeURIComponent(t('质疑红测需要至少 8 个字的理由。', 'Challenging a red run needs a reason of at least 8 characters.'))}`)
    }
    const next = { ...evidence, redTestDecision: { decision, note, by: viewer.user.login, at: nowIso() } }
    store.updateJob(job.id, { evidence_json: JSON.stringify(next) })
    store.audit(viewer.user.id, `job.red_test_${decision}`, `${job.id}: ${record.signature}`)
    const message = decision === 'confirmed'
      ? t('已确认这次红测是预期的失败。', 'This red run is confirmed as the intended failure.')
      : t('已质疑这次红测，理由记在任务上。', 'This red run is challenged; the reason is recorded on the job.')
    return reply.redirect(`${back}?notice=${encodeURIComponent(message)}`)
  })

  app.post('/repos/:id/jobs/:jobId/recheck', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const job = store.getJob(String((request.params as Record<string, string>).jobId))
    if (job === undefined || job.repo_id !== repo.id) throw httpError(404, '任务不存在。', 'JOB_NOT_FOUND')
    const result = await jobs.recheck(job.id)
    store.audit(viewer.user.id, 'job.pr_rechecked', `${job.id}: ${result.ok ? 'ok' : (result.message ?? 'failed')}`)
    const key = result.ok ? 'notice' : 'error'
    const message = result.ok ? 'PR 证据与路径检查通过。' : (result.message ?? '重新检查失败。')
    return reply.redirect(`/repos/${repo.id}/jobs/${job.id}?${key}=${encodeURIComponent(message)}`)
  })

  app.post('/repos/:id/jobs/:jobId/ack-rule-change', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    if (repo.repo_role !== 'maintainer') return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent('只有 maintainer 可以确认规则变更。')}`)
    const job = store.getJob(String((request.params as Record<string, string>).jobId))
    if (job === undefined || job.repo_id !== repo.id) throw httpError(404, '任务不存在。', 'JOB_NOT_FOUND')
    const verification = parseVerification(job.verification_json)
    if (verification?.ruleChange === undefined || job.pr_url === null) {
      return reply.redirect(`/repos/${repo.id}/jobs/${job.id}?error=${encodeURIComponent('这个任务没有待确认的规则变更。')}`)
    }
    store.setSetting(`rule_change_ack:${job.id}:${verification.sha}`, nowIso())
    store.audit(viewer.user.id, 'job.rule_change_acknowledged', `${job.id}: ${verification.ruleChange.paths.join(', ').slice(0, 300)}`)
    const result = await jobs.recheck(job.id)
    const key = result.ok ? 'notice' : 'error'
    const message = result.ok ? '规则变更已确认，PR 证据检查通过。' : (result.message ?? '规则变更已确认，但 PR 仍有其他问题。')
    return reply.redirect(`/repos/${repo.id}/jobs/${job.id}?${key}=${encodeURIComponent(message)}`)
  })

  // #540 slice 6: the merge button is a command whose durable effect is on
  // GitHub. The gates and the merge call stay in `Jobs.tryMerge`; the route
  // resolves the actor, the job and the revision the page rendered, and turns the
  // receipt into a redirect. A lost answer leaves the receipt `unknown`, and
  // resubmitting the same form reconciles against the pull request first.
  app.post('/repos/:id/jobs/:jobId/merge', async (request, reply) => {
    // #708: expensive — a merge writes to the upstream repository.
    if (!limits.take('expensive', `job-merge:${rateLimitKey(request)}`)) return refuseTooMany(request, reply)
    const { viewer, repo, role } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const job = store.getJob(String((request.params as Record<string, string>).jobId))
    if (job === undefined || job.repo_id !== repo.id) throw httpError(404, '任务不存在。', 'JOB_NOT_FOUND')
    const back = `/repos/${repo.id}/jobs/${job.id}`
    const t = translator(request.locale ?? 'zh')
    const today = async (): Promise<{ notice: string } | { error: string }> => {
      if (role !== 'maintainer') return { error: t('只有 maintainer 可以合并 PR。', 'Only a maintainer can merge a pull request.') }
      const result = await jobs.manualMerge(repo, job, { actorRole: role })
      const merged = result.ok || result.alreadyMerged === true
      store.audit(viewer.user.id, 'job.merge_requested', `${job.id}: ${merged ? 'merged' : (result.message ?? 'failed')}`)
      return merged ? { notice: t('PR 已合并。', 'The pull request is merged.') } : { error: result.message ?? t('合并失败。', 'The merge failed.') }
    }
    const answer = (result: { notice: string } | { error: string }) => ('notice' in result
      ? reply.redirect(`${back}?notice=${encodeURIComponent(result.notice)}`)
      : reply.redirect(`${back}?error=${encodeURIComponent(result.error)}`))

    if (config.managementService === 'off') return answer(await today())

    const parts = commandParts(form(request), management.revisionOf('job', job.id))
    const actor = managementActor({ store, userId: viewer.user.id, repo, channel: 'web', requestId: request.id })
    const envelope = {
      operation: 'task.merge',
      target: { projectId: repo.id, jobId: job.id },
      arguments: {},
      expectedRevision: parts.expectedRevision,
      idempotencyKey: parts.idempotencyKey,
    }

    if (config.managementService === 'shadow') {
      const begun = management.begin(actor, envelope)
      const result = await today()
      // The receipt records what the contract would have done with the same form;
      // a replay never rewrites a receipt that already answered.
      if (begun.ok && !begun.replayed) {
        management.settle(begun.receipt.id, 'notice' in result
          ? { ok: true, result: { jobId: job.id, shadow: true } }
          : { ok: false, code: 'job_not_merged', message: 'the route refused the merge' })
      }
      return answer(result)
    }

    const outcome = await management.run(actor, envelope)
    if (outcome.ok) return answer({ notice: t('PR 已合并。', 'The pull request is merged.') })
    // A gate refusal is not a management code: its sentence is the reason the
    // service wrote (a stale check, a missing approval), which is what the job
    // page showed before this slice.
    const sentence = outcome.code === 'job_not_merged'
      ? (outcome.message === '' ? t('合并失败。', 'The merge failed.') : outcome.message)
      : managementFailure(t, outcome, t('合并失败。', 'The merge failed.'))
    return reply.redirect(`${back}?error=${encodeURIComponent(sentence)}&code=${outcome.code}`)
  })

  app.post('/repos/:id/jobs/:jobId/approve-plan', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const job = store.getJob(String((request.params as Record<string, string>).jobId))
    if (job === undefined || job.repo_id !== repo.id || job.kind !== 'plan' || job.status !== 'succeeded') throw httpError(404, '计划任务不存在或尚未完成。', 'PLAN_NOT_READY')
    if (repo.repo_role !== 'maintainer') return reply.redirect(`/repos/${repo.id}/jobs/${job.id}?error=${encodeURIComponent('只有 maintainer 可以批准计划。')}`)
    // #359: the deadline belongs to the plan, not to the work item's state. An
    // item that was reopened and is now `triaged` (or one that reached `merged`
    // without ever being approved) must not make a dead plan approvable again, so
    // the refusal reads the plan's own age and a new plan is the only way back.
    const planDeadline = job.finished_at === null ? Number.NaN : Date.parse(job.finished_at) + config.plan.expiryDays * 86_400_000
    if (!Number.isFinite(planDeadline) || planDeadline <= Date.now()) {
      return reply.redirect(`/repos/${repo.id}/jobs/${job.id}?error=${encodeURIComponent('计划已过期关闭，不能再批准；重新创建工作项即可生成新计划。')}`)
    }
    const body = form(request)
    const allow = (body.allowPaths ?? repo.allow_paths).trim().slice(0, 2000)
    const deny = (body.denyPaths ?? repo.deny_paths).trim().slice(0, 2000)
    // #634: the decision is one record, written by one function from both doors.
    // The form posts the hash of the packet the person read, so an edit between
    // the page and the POST is refused instead of approved.
    const outcome = decidePlan(store, {
      job: planDecisionJob(job),
      decision: 'approve',
      actor: viewer.user.id,
      at: nowIso(),
      shownHash: planShownHash(body.planHash),
      latestBaseSha: store.latestFinishedBaseSha(repo.id),
      door: 'web form',
      allowPaths: allow,
      denyPaths: deny,
      workItemId: job.work_item_id,
    })
    if (!outcome.ok) return reply.redirect(`/repos/${repo.id}/jobs/${job.id}?error=${encodeURIComponent(translator(request.locale ?? 'zh')(outcome.reason.zh, outcome.reason.en))}&code=${outcome.refusal}`)
    store.recordProductEvent({ name: 'human_action_approve', repoId: repo.id, subject: job.id })
    return reply.redirect(`/repos/${repo.id}/jobs/${job.id}?notice=${encodeURIComponent('计划已批准，可以执行。')}`)
  })

  app.post('/repos/:id/jobs/:jobId/reject-plan', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const job = store.getJob(String((request.params as Record<string, string>).jobId))
    if (job === undefined || job.repo_id !== repo.id || job.kind !== 'plan' || job.status !== 'succeeded') throw httpError(404, '计划任务不存在或尚未完成。', 'PLAN_NOT_READY')
    if (repo.repo_role !== 'maintainer') return reply.redirect(`/repos/${repo.id}/jobs/${job.id}?error=${encodeURIComponent('只有 maintainer 可以拒绝计划。')}`)
    const body = form(request)
    const outcome = decidePlan(store, {
      job: planDecisionJob(job),
      decision: 'reject',
      actor: viewer.user.id,
      at: nowIso(),
      shownHash: planShownHash(body.planHash),
      latestBaseSha: store.latestFinishedBaseSha(repo.id),
      door: 'web form',
      reason: body.reason ?? '',
      workItemId: job.work_item_id,
    })
    if (!outcome.ok) return reply.redirect(`/repos/${repo.id}/jobs/${job.id}?error=${encodeURIComponent(translator(request.locale ?? 'zh')(outcome.reason.zh, outcome.reason.en))}&code=${outcome.refusal}`)
    store.recordProductEvent({ name: 'human_action_reject', repoId: repo.id, subject: job.id })
    return reply.redirect(`/repos/${repo.id}/jobs/${job.id}?notice=${encodeURIComponent('计划已拒绝。')}`)
  })

  // #634: "ask for a revised plan" is a rejection plus a new plan job on the same
  // work item, the way `/fledge plan` queues one. A decided plan is never edited
  // in place, so the revision cannot overwrite what a person already read.
  app.post('/repos/:id/jobs/:jobId/revise-plan', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const job = store.getJob(String((request.params as Record<string, string>).jobId))
    if (job === undefined || job.repo_id !== repo.id || job.kind !== 'plan' || job.status !== 'succeeded') throw httpError(404, '计划任务不存在或尚未完成。', 'PLAN_NOT_READY')
    if (repo.repo_role !== 'maintainer') return reply.redirect(`/repos/${repo.id}/jobs/${job.id}?error=${encodeURIComponent('只有 maintainer 可以要求修改计划。')}`)
    if (job.work_item_id === null) return reply.redirect(`/repos/${repo.id}/jobs/${job.id}?error=${encodeURIComponent('这个计划没有关联工作项，无法排队新计划；请用 /fledge plan 生成。')}`)
    const body = form(request)
    const reason = (body.reason ?? '').trim().slice(0, 500)
    const decision = {
      job: planDecisionJob(job),
      decision: 'reject' as const,
      actor: viewer.user.id,
      at: nowIso(),
      shownHash: planShownHash(body.planHash),
      latestBaseSha: store.latestFinishedBaseSha(repo.id),
      door: 'web form' as const,
      reason,
      workItemId: job.work_item_id,
    }
    const t = translator(request.locale ?? 'zh')
    const refused = (outcome: Extract<PlanDecisionOutcome, { ok: false }>): ReturnType<typeof reply.redirect> => reply.redirect(`/repos/${repo.id}/jobs/${job.id}?error=${encodeURIComponent(t(outcome.reason.zh, outcome.reason.en))}&code=${outcome.refusal}`)
    // #634: this route is two writes — the rejection and the queued revision —
    // and they cannot share a transaction, because queueing runs through the
    // async management envelope. Only one of the two possible halves is
    // recoverable: a rejected plan with nothing queued is a dead end, since every
    // retry is refused `PLAN_ALREADY_DECIDED`, while a queued revision whose
    // rejection then lost a race still leaves a plan the maintainer can decide.
    // So the queue attempt goes first and the rejection is written only after it
    // succeeded, and the refusals that cost no queue work (already decided, stale
    // hash, stale base, missing reason) are still answered before it.
    const preview = planDecisionOutcome(decision)
    if (!preview.ok) return refused(preview)
    const goal = `${job.goal}\n\nA maintainer rejected the previous plan and asked for a revision: ${reason}\nProduce one concrete revised plan only; do not write code, create a branch or open a PR.`
    const queued = await runCreate(request, viewer, repo, { kind: 'plan', goal, workItemId: job.work_item_id, priority: job.priority })
    // A queue refusal (quota, JOB_ACTIVE, a disabled repository) leaves the plan
    // undecided on purpose: the press did not happen, so the maintainer must be
    // able to try again once the queue has room.
    if (!queued.ok) return reply.redirect(`/repos/${repo.id}/jobs/${job.id}?error=${encodeURIComponent(managementFailure(t, queued, t('新计划没有排队。', 'The revised plan was not queued.')))}&code=${queued.code}`)
    const outcome = decidePlan(store, decision)
    if (!outcome.ok) return refused(outcome)
    return reply.redirect(`/repos/${repo.id}/jobs/${job.id}?notice=${encodeURIComponent('计划已拒绝；修改后的计划已排队。')}`)
  })

  app.post('/repos/:id/jobs/:jobId/execute', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const job = store.getJob(String((request.params as Record<string, string>).jobId))
    if (job === undefined || job.repo_id !== repo.id || job.kind !== 'plan' || job.status !== 'succeeded') throw httpError(404, '计划任务不存在或尚未完成。', 'PLAN_NOT_READY')
    if (repo.repo_role !== 'maintainer') return reply.redirect(`/repos/${repo.id}/jobs/${job.id}?error=${encodeURIComponent('只有 maintainer 可以执行计划。')}`)
    if (job.plan_approved_at === null) return reply.redirect(`/repos/${repo.id}/jobs/${job.id}?error=${encodeURIComponent('计划尚未批准。')}`)
    const active = store.activeJobForRepo(repo.id)
    if (active !== undefined) return reply.redirect(`/repos/${repo.id}/jobs/${job.id}?error=${encodeURIComponent('这个仓库已有任务在运行。')}`)
    const allow = (job.plan_allow_paths ?? repo.allow_paths).trim()
    const deny = (job.plan_deny_paths ?? repo.deny_paths).trim()
    const goal = `${job.goal}\n\nApproved plan:\n${job.summary ?? ''}${allow === '' ? '' : `\n\nAllowed paths: ${allow}`}${deny === '' ? '' : `\nForbidden paths: ${deny}`}\nOnly modify files inside the allowed paths; never touch forbidden paths.`
    const t = translator(request.locale ?? 'zh')
    const outcome = await runCreate(request, viewer, repo, {
      kind: 'iterate',
      goal,
      ...(job.work_item_id === null ? {} : { workItemId: job.work_item_id }),
      priority: job.priority,
    })
    if (!outcome.ok) {
      return reply.redirect(`/repos/${repo.id}/jobs/${job.id}?error=${encodeURIComponent(managementFailure(t, outcome, t('执行计划失败。', 'The plan did not start.')))}&code=${outcome.code}`)
    }
    const started = commandJobId(outcome) ?? job.id
    // The route this adapter replaced linked the plan to the job it produced;
    // the receipt names only the create, so keep that link in the audit log.
    store.audit(viewer.user.id, 'job.executed', `${job.id} -> ${started}`)
    return reply.redirect(`/repos/${repo.id}/jobs/${started}?notice=${encodeURIComponent(t('已按计划开始执行。', 'Started from the approved plan.'))}`)
  })

  app.post('/repos/:id/work', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    if (repo.repo_role !== 'maintainer' && repo.repo_role !== 'developer') {
      return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent('请先选择你的角色。')}#work`)
    }
    const body = form(request)
    const title = (body.title ?? '').trim().slice(0, 200)
    if (title === '') return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent('请填写工作项标题。')}#work`)
    const detail = (body.detail ?? '').trim().slice(0, 4000)
    const rawIssue = (body.issueUrl ?? '').trim()
    const issueUrl = rawIssue.startsWith('https://github.com/') ? rawIssue.slice(0, 500) : null
    const priority = Math.max(0, Math.min(100, Math.floor(Number(body.priority) || 0)))
    const item = store.createWorkItem({ id: randomId('work'), repoId: repo.id, userId: viewer.user.id, title, detail, issueUrl, priority, state: 'proposed' })
    store.audit(viewer.user.id, 'work_item.created', `${item.id} ${repo.owner}/${repo.name} priority=${priority}`)
    return reply.redirect(`/repos/${repo.id}?notice=${encodeURIComponent('工作项已创建。')}#work`)
  })

  app.post('/repos/:id/work/:workItemId/state', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const item = store.getWorkItem(String((request.params as Record<string, string>).workItemId))
    if (item === undefined || item.repo_id !== repo.id) throw httpError(404, '工作项不存在。', 'WORK_ITEM_NOT_FOUND')
    const body = form(request)
    const state = body.state
    if (!isWorkItemState(state)) return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent('工作项状态无效。')}#work`)
    const allowed = WORK_ITEM_TRANSITIONS[item.state as WorkItemState] ?? []
    if (!allowed.includes(state)) return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent('不能从这个状态切换。')}#work`)
    if (MAINTAINER_ONLY_STATES.has(state) && repo.repo_role !== 'maintainer') {
      return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent('只有 maintainer 可以执行这个操作。')}#work`)
    }
    // #359: `closed_reason` describes one close, not the item's past. Leaving
    // `closed` clears it, or the table keeps printing "Closed - plan expired"
    // for an item that was reopened and closed by hand later.
    const patch: { state: string; closed_reason: string | null; assignee_user_id?: string; pr_state?: string; merged_at?: string; merge_commit?: string | null } = { state, closed_reason: state === 'closed' ? item.closed_reason : null }
    if (state === 'assigned' || state === 'in_progress') patch.assignee_user_id = viewer.user.id
    if (state === 'merged') {
      patch.pr_state = 'merged'
      patch.merged_at = nowIso()
    } else if (state === 'closed' && item.pr_state !== 'merged') {
      patch.pr_state = 'closed'
    }
    store.updateWorkItem(item.id, patch)
    store.audit(viewer.user.id, 'work_item.state', `${item.id} ${item.state} -> ${state}`)
    return reply.redirect(`/repos/${repo.id}?notice=${encodeURIComponent('工作项状态已更新。')}#work`)
  })

  app.post('/repos/:id/work/:workItemId/run', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const item = store.getWorkItem(String((request.params as Record<string, string>).workItemId))
    if (item === undefined || item.repo_id !== repo.id) throw httpError(404, '工作项不存在。', 'WORK_ITEM_NOT_FOUND')
    if (repo.repo_role !== 'maintainer' && repo.repo_role !== 'developer') {
      return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent('请先选择你的角色。')}#work`)
    }
    if (item.state === 'merged' || item.state === 'closed') {
      return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent('这个工作项已经结束。')}#work`)
    }
    const goal = [
      `Work item: ${item.title}`,
      item.detail === '' ? '' : item.detail,
      item.issue_url === null || item.issue_url === '' ? '' : `Issue: ${item.issue_url}`,
      'Follow the one issue, one branch, one pull request rule. Do not start unrelated work.',
    ].filter((line) => line !== '').join('\n\n')
    const kind: JobKind = repo.plan_required === 1 ? 'plan' : 'iterate'
    const t = translator(request.locale ?? 'zh')
    const outcome = await runCreate(request, viewer, repo, { kind, goal, workItemId: item.id, priority: item.priority })
    if (!outcome.ok) {
      return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent(managementFailure(t, outcome, t('工作项启动失败。', 'The work item did not start.')))}&code=${outcome.code}#work`)
    }
    const runJobId = commandJobId(outcome)
    const message = kind === 'plan' ? t('计划任务已排队。', 'Plan job queued.') : t('工作项任务已排队。', 'Work item job queued.')
    return reply.redirect(runJobId === null ? `/repos/${repo.id}?notice=${encodeURIComponent(message)}#work` : `/repos/${repo.id}/jobs/${runJobId}?notice=${encodeURIComponent(message)}`)
  })

  app.post('/repos/:id/delivery/merge-clean', async (request, reply) => {
    const { viewer, repo, role } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    if (role !== 'maintainer') return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent('只有 maintainer 可以批量合并 PR。')}#delivery`)
    const result = await jobs.mergeCleanPrs(repo.id, role)
    store.audit(viewer.user.id, 'delivery.merge_clean', `${repo.id} merged=${result.merged.length} skipped=${result.skipped.length}`)
    const jobStateSkips = result.skipped.filter((entry) => entry.reason === 'job-state').length
    const gateSkips = result.skipped.length - jobStateSkips
    // Two different reasons, two clauses: a job-state skip must not be reported
    // to the operator as a failed check or a missing protection, and the other
    // clause stays wide enough for a path-guard or a non-open PR refusal.
    const skipParts = [
      jobStateSkips === 0 ? '' : `跳过 ${jobStateSkips} 个（最新任务还没有成功）`,
      gateSkips === 0 ? '' : `跳过 ${gateSkips} 个（未通过合并检查）`,
    ].filter((part) => part !== '')
    const message = `已合并 ${result.merged.length} 个 PR${skipParts.length === 0 ? '' : `，${skipParts.join('，')}`}`
    return reply.redirect(`/repos/${repo.id}?${result.merged.length > 0 ? 'notice' : 'error'}=${encodeURIComponent(message)}#delivery`)
  })

  // #379: the two operator decisions a reported finding can receive. Both need a
  // written reason, refused here and again by the store: a dismissal with no
  // reason would read as a silent accept, and a fix with no evidence is exactly
  // the claim the ledger exists to keep honest.
  // #379: the two written decisions on a finding. Both are maintainer-only and
  // both refuse a blank reason/evidence in the route *and* in the store, because
  // a row that reads as dismissed or fixed with nothing behind it is exactly the
  // silent-accept this ledger exists to prevent.
  app.post('/repos/:id/security-findings/:findingId/dismiss', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const t = translator(request.locale ?? 'zh')
    if (repo.repo_role !== 'maintainer') return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent(t('只有 maintainer 可以处理安全发现。', 'Only a maintainer can act on a security finding.'))}#security`)
    const finding = String((request.params as Record<string, string>).findingId)
    const reason = (form(request).reason ?? '').trim().slice(0, 500)
    if (reason === '') return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent(t('忽略一条安全发现需要写明理由。', 'Dismissing a security finding needs a written reason.'))}#security`)
    if (!store.setSecurityFindingState(repo.id, finding, 'dismissed', reason)) {
      return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent(t('这条安全发现不存在。', 'That security finding does not exist.'))}#security`)
    }
    store.audit(viewer.user.id, 'security_finding.dismissed', `${repo.id}: ${finding}`.slice(0, 600))
    return reply.redirect(`/repos/${repo.id}?notice=${encodeURIComponent(t('已忽略这条安全发现；如果它再次出现，会记为回归。', 'Dismissed. If the same id appears again it is recorded as a regression.'))}#security`)
  })

  app.post('/repos/:id/security-findings/:findingId/fix', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const t = translator(request.locale ?? 'zh')
    if (repo.repo_role !== 'maintainer') return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent(t('只有 maintainer 可以处理安全发现。', 'Only a maintainer can act on a security finding.'))}#security`)
    const finding = String((request.params as Record<string, string>).findingId)
    const evidence = (form(request).evidence ?? '').trim().slice(0, 500)
    if (evidence === '') return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent(t('标记已修复需要写明证据（提交、链接或测量值）。', 'Marking a finding fixed needs evidence: a commit, a link or a measurement.'))}#security`)
    if (!store.setSecurityFindingState(repo.id, finding, 'fixed', evidence)) {
      return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent(t('这条安全发现不存在。', 'That security finding does not exist.'))}#security`)
    }
    store.audit(viewer.user.id, 'security_finding.fixed', `${repo.id}: ${finding}`.slice(0, 600))
    return reply.redirect(`/repos/${repo.id}?notice=${encodeURIComponent(t('已记录修复证据；如果同一个 id 再次出现，会记为回归。', 'Fix evidence recorded. If the same id appears again it is recorded as a regression.'))}#security`)
  })

  app.post('/repos/:id/work/:workItemId/scope', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const item = store.getWorkItem(String((request.params as Record<string, string>).workItemId))
    if (item === undefined || item.repo_id !== repo.id) throw httpError(404, '工作项不存在。', 'WORK_ITEM_NOT_FOUND')
    if (repo.repo_role !== 'maintainer' && repo.repo_role !== 'developer') return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent('请先选择你的角色。')}#work`)
    if (item.state === 'merged' || item.state === 'closed') return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent('这个工作项已经结束。')}#work`)
    const active = store.activeJobForRepo(repo.id)
    if (active !== undefined) return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent('这个仓库已有任务在运行。')}#work`)
    const goal = [`Scope work item: ${item.title}`, item.detail === '' ? '' : item.detail, item.issue_url === null ? '' : `Issue: ${item.issue_url}`, 'Product scoping only: goal, non-goals, acceptance criteria and test plan. Do not code.'].filter((line) => line !== '').join('\n\n')
    const t = translator(request.locale ?? 'zh')
    const outcome = await runCreate(request, viewer, repo, { kind: 'scope', goal, workItemId: item.id, priority: item.priority })
    if (!outcome.ok) {
      return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent(managementFailure(t, outcome, t('范围任务启动失败。', 'The scope job did not start.')))}&code=${outcome.code}#work`)
    }
    const scopeJobId = commandJobId(outcome)
    const message = t('Product 范围任务已排队。', 'Product scope job queued.')
    return reply.redirect(scopeJobId === null ? `/repos/${repo.id}?notice=${encodeURIComponent(message)}#work` : `/repos/${repo.id}/jobs/${scopeJobId}?notice=${encodeURIComponent(message)}`)
  })

  app.post('/repos/:id/work/:workItemId/verify', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const item = store.getWorkItem(String((request.params as Record<string, string>).workItemId))
    if (item === undefined || item.repo_id !== repo.id) throw httpError(404, '工作项不存在。', 'WORK_ITEM_NOT_FOUND')
    if (item.pr_url === null) return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent('这个工作项还没有 PR。')}#work`)
    if (repo.repo_role !== 'maintainer' && repo.repo_role !== 'developer') return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent('请先选择你的角色。')}#work`)
    const active = store.activeJobForRepo(repo.id)
    if (active !== undefined) return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent('这个仓库已有任务在运行。')}#work`)
    const goal = `Verify PR ${item.pr_url} with the Test role. Read the PR and branch, run the relevant tests, and report failing and passing evidence. Do not code, push or merge.`
    const t = translator(request.locale ?? 'zh')
    const outcome = await runCreate(request, viewer, repo, { kind: 'verify', goal, prUrl: item.pr_url, workItemId: item.id, priority: item.priority })
    if (!outcome.ok) {
      return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent(managementFailure(t, outcome, t('验证任务启动失败。', 'The verify job did not start.')))}&code=${outcome.code}#work`)
    }
    const verifyJobId = commandJobId(outcome)
    const message = t('Test 验证任务已排队。', 'Test verify job queued.')
    return reply.redirect(verifyJobId === null ? `/repos/${repo.id}?notice=${encodeURIComponent(message)}#work` : `/repos/${repo.id}/jobs/${verifyJobId}?notice=${encodeURIComponent(message)}`)
  })

  app.get('/repos/:id/workspace', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id))
    const instance = store.getRepoInstance(repo.id)
    return reply.type('text/html').send(agentWorkspacePage({
      config,
      locale: request.locale ?? 'zh',
      viewer: viewOf(viewer),
      repo,
      instance,
      notice: request.flash?.notice?.text,
      error: request.flash?.error?.text,
    }))
  })

  app.all('/repos/:id/workspace/app', async (request, reply) => {
    const { repo } = ownedRepo(request, String((request.params as Record<string, string>).id))
    const url = request.raw.url ?? ''
    const query = url.includes('?') ? url.slice(url.indexOf('?')) : ''
    if (!url.split('?')[0]?.endsWith('/')) return reply.redirect(`/repos/${repo.id}/workspace/app/${query}`)
    const instance = store.getRepoInstance(repo.id)
    if (instance === undefined || instance.status !== 'ready') return reply.code(409).send({ error: 'FlyBot 实例尚未就绪' })
    try {
      await proxyWorkspaceHttp(request, reply, instance, repo, '')
    } catch (error) {
      log.warn('workspace root request failed', { repo: repo.id, error: String(error) })
      if (!reply.raw.headersSent) reply.code(502).send({ error: 'Workspace proxy failed' })
    }
  })

  app.all('/repos/:id/workspace/app/*', async (request, reply) => {
    const { repo } = ownedRepo(request, String((request.params as Record<string, string>).id))
    const instance = store.getRepoInstance(repo.id)
    if (instance === undefined || instance.status !== 'ready') return reply.code(409).send({ error: 'FlyBot 实例尚未就绪' })
    const prefix = `/repos/${repo.id}/workspace/app/`
    const index = request.url.indexOf(prefix)
    const subpath = index === -1 ? '' : request.url.slice(index + prefix.length)
    try {
      await proxyWorkspaceHttp(request, reply, instance, repo, subpath)
    } catch (error) {
      log.warn('workspace request failed', { repo: repo.id, error: String(error) })
      if (!reply.raw.headersSent) reply.code(502).send({ error: 'Workspace proxy failed' })
    }
  })

  app.get('/repos/:id/:action', async (request, reply) => {
    const { repo } = ownedRepo(request, String((request.params as Record<string, string>).id))
    return reply.redirect(`/repos/${repo.id}`)
  })

  app.post('/repos/:id/run', async (request, reply) => {
    // #708: starting a job spends a model budget and a FlyBot slot, so it takes
    // the expensive window before the repository is read.
    if (!limits.take('expensive', `job-start:${rateLimitKey(request)}`)) return refuseTooMany(request, reply)
    // #105 review: this start reads the repository through `ownedRepo` like the
    // other four member-facing starts, so a developer member starts work instead
    // of getting the 404 a stranger gets.
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const t = translator(request.locale ?? 'zh')
    const outcome = await runCreate(request, viewer, repo, { kind: repo.plan_required === 1 ? 'plan' : 'iterate' })
    if (!outcome.ok) {
      return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent(managementFailure(t, outcome, t('任务启动失败。', 'The job did not start.')))}&code=${outcome.code}`)
    }
    const message = repo.plan_required === 1
      ? t('计划任务已排队；批准后才会写代码。', 'Plan job queued; code is written after you approve it.')
      : t('任务已排队。', 'Job queued.')
    return reply.redirect(`/repos/${repo.id}?notice=${encodeURIComponent(message)}`)
  })

  app.post('/repos/:id/plan', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const t = translator(request.locale ?? 'zh')
    const outcome = await runCreate(request, viewer, repo, { kind: 'plan' })
    if (!outcome.ok) {
      return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent(managementFailure(t, outcome, t('计划任务启动失败。', 'The plan job did not start.')))}&code=${outcome.code}`)
    }
    return reply.redirect(`/repos/${repo.id}?notice=${encodeURIComponent(t('计划任务已排队，不会写代码或开 PR。', 'Plan job queued; it writes no code and opens no pull request.'))}`)
  })

  // #523: triage is repository-scoped, so its start belongs on the repository
  // page behind `ownedRepo`, not on the admin console: an operator-only start
  // would leave the repository's own owner unable to triage it. The one input the
  // control accepts is an issue URL that focuses the board, and it is bound to
  // this repository here, on the input side, with the same rule the callback
  // applies — a foreign host or a foreign repository never reaches `enqueue`.
  app.post('/repos/:id/triage', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const t = translator(request.locale ?? 'zh')
    const issueInput = (form(request).issueUrl ?? '').trim()
    const issue = issueInput === '' ? undefined : parseIssueUrl(repo, issueInput, config.github.apiBase)
    if (issue !== undefined && !issue.ok) {
      store.audit(viewer.user.id, 'triage.refused', `${repo.owner}/${repo.name}: ${issueInput.slice(0, 200)}`)
      const message = t('这个 Issue 链接不属于当前仓库，分诊没有开始。', 'That issue link does not belong to this repository, so no triage job started.')
      return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent(message)}#triage`)
    }
    // #595: this goal is instruction text. Name the issue by the URL the parser
    // rebuilt from the parts it checked, never by what was pasted, so a query or
    // fragment cannot ride into the prompt as attacker-authored instructions.
    const goal = issue === undefined || !issue.ok ? undefined : `${DEFAULT_TRIAGE_GOAL}\n\nStart the board with the issue at ${issue.canonical}.`
    const outcome = await runCreate(request, viewer, repo, goal === undefined ? { kind: 'triage' } : { kind: 'triage', goal })
    const message = t('分诊任务已排队；只读，不会创建分支或 PR。', 'Triage job queued; it is read-only and opens no branch or pull request.')
    if (!outcome.ok) {
      return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent(managementFailure(t, outcome, t('分诊任务启动失败。', 'The triage job did not start.')))}&code=${outcome.code}#triage`)
    }
    // A queued triage lands on its own job page, where the work-type contract and
    // the empty board are visible without a second click.
    const triageJobId = commandJobId(outcome)
    if (triageJobId !== null) return reply.redirect(`/repos/${repo.id}/jobs/${triageJobId}?notice=${encodeURIComponent(message)}`)
    return reply.redirect(`/repos/${repo.id}?notice=${encodeURIComponent(message)}#triage`)
  })

  app.post('/repos/:id/refresh', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    try {
      const isAppRepo = repo.installation_id !== null
      const token = isAppRepo ? await githubApp.installationToken(repo.installation_id!) : await repoGithubToken(repo, config, githubApp, store)
      const prepared = isAppRepo
        ? await prepareRepoWithInstallation(token, repo.upstream_owner || repo.owner, repo.upstream_name || repo.name, viewer.user.login, config.github.apiBase)
        : await prepareRepo(token, repo.upstream_owner || repo.owner, repo.upstream_name || repo.name, viewer.user.login, config.github.apiBase)
      let effectivePermission = prepared.permission
      if (isAppRepo) {
        effectivePermission = 'none'
        const userToken = viewer.user.github_token_enc === null ? '' : decryptSecret(viewer.user.github_token_enc, config.tokenEncryptionKey)
        if (userToken !== '') {
          try {
            effectivePermission = await repoPermissionWithToken(userToken, repo.upstream_owner || repo.owner, repo.upstream_name || repo.name, config.github.apiBase)
          } catch (error) {
            log.warn('user repository permission check failed', { repo: repo.id, error: String(error) })
          }
        }
      }
      const allowed = allowedRepoRoles(effectivePermission)
      const currentRole = parseRepoRole(repo.repo_role)
      const downgraded = currentRole === 'maintainer' && !allowed.includes('maintainer')
      const nextRole = downgraded ? 'developer' : repo.repo_role
      const enableReviewer = nextRole === 'maintainer' && prepared.canReview && repo.reviewer_enabled === 1
      const protectionBranch = repo.target_branch !== '' ? repo.target_branch : (prepared.upstream.defaultBranch || repo.default_branch)
      const protection = await new GithubClient(token, config.github.apiBase)
        .getBranchProtection(prepared.upstream.owner, prepared.upstream.name, protectionBranch)
        .catch((error) => {
          log.warn('branch protection check failed', { repo: repo.id, error: String(error) })
          return null
        })
      const protectionState = protection === null ? 'unknown' : protection.protected ? 'protected' : 'unprotected'
      const protectionCheckedAt = nowIso()
      store.updateRepo(repo.id, {
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
        protection_state: protectionState,
        protection_checked_at: protectionCheckedAt,
        can_review: prepared.canReview ? 1 : 0,
        can_create_issue: prepared.canCreateIssue ? 1 : 0,
        reviewer_enabled: enableReviewer ? 1 : 0,
        upstream_html_url: prepared.upstream.htmlUrl,
        fork_html_url: prepared.fork.htmlUrl,
      })
      store.audit(viewer.user.id, 'repo.refreshed', `${repo.owner}/${repo.name} fork=${prepared.fork.owner}/${prepared.fork.name} permission=${effectivePermission} role=${nextRole ?? 'none'}${downgraded ? ' downgraded' : ''}`)
      const t = translator(request.locale ?? 'zh')
      const notice = [
        prepared.forkCreated ? t(`已创建 fork ${prepared.fork.fullName}。`, `Created fork ${prepared.fork.fullName}.`) : t('上游 / fork / 权限已重新检测。', 'Upstream, fork and permissions refreshed.'),
        downgraded ? t('GitHub 权限已变更，角色已降级为 developer，自动合并已关闭。', 'GitHub permission changed; the role was downgraded to developer and auto-merge is off.') : '',
        isAppRepo && effectivePermission !== 'admin' && effectivePermission !== 'maintain' ? t('无法确认你的 GitHub maintain 权限；如这是你自己的仓库，请重新授权 GitHub。', 'Could not confirm your GitHub maintain permission; re-authorize GitHub if this is your repository.') : '',
      ].filter((line) => line !== '').join(' ')
      return reply.redirect(`/repos/${repo.id}?notice=${encodeURIComponent(notice)}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent(message)}`)
    }
  })

  app.post('/repos/:id/instance', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true, true)
    if (config.flybot.instanceImage === '') throw httpError(400, '这个部署没有启用仓库工作区。', 'INSTANCE_DISABLED')
    // #457 review: the guard used to run before this route knew the repository
    // already had a row, so a stopped instance counted against its own restart
    // and the only way out was deleting it. Exclude the row being provisioned
    // and count only the statuses that hold a slot.
    const existing = store.getRepoInstance(repo.id)
    const refusal = instanceCapRefusal(viewer, 1, repo.id)
    if (refusal !== null) return refuseLimit(request, reply, viewer, refusal, `/repos/${repo.id}`)
    instances.ensureUserDir(viewer.user.id)
    if (existing !== undefined && existing.status !== 'ready' && !instances.isProvisioning(repo.id)) await instances.stop(repo.id)
    void instances.provision(repo).catch((error) => log.error('flybot provisioning failed', { repo: repo.id, error: String(error) }))
    return reply.redirect(`/repos/${repo.id}?notice=${encodeURIComponent(translator(request.locale ?? 'zh')('工作区初始化中。', 'Workspace is initializing.'))}`)
  })

  app.post('/repos/:id/instance/stop', { config: { rateLimit: destructiveLimit } }, async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true, true)
    if (requireRecentAuth(request, reply, viewer, 'flybot.instance.stop')) return reply
    await instances.stop(repo.id)
    await jobs.cancelRepoJobs(repo.id, 'FlyBot 实例已停止', 'BRIDGE_ERROR')
    store.audit(viewer.user.id, 'flybot.instance.stopped', `${repo.owner}/${repo.name}`)
    return reply.redirect(`/repos/${repo.id}?notice=${encodeURIComponent(translator(request.locale ?? 'zh')('工作区已停止。', 'Workspace stopped.'))}`)
  })

  app.post('/repos/:id/review', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const t = translator(request.locale ?? 'zh')
    const outcome = await runCreate(request, viewer, repo, { kind: 'review' })
    if (!outcome.ok) {
      return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent(managementFailure(t, outcome, t('审核任务启动失败。', 'The review job did not start.')))}&code=${outcome.code}`)
    }
    return reply.redirect(`/repos/${repo.id}?notice=${encodeURIComponent(t('审核任务已排队。', 'Review job queued.'))}`)
  })

  app.post('/repos/:id/role', { config: { rateLimit: destructiveClassLimit } }, async (request, reply) => {
    // #105 review: this route writes the same `repo_role` column as the settings
    // form, so it carries the settings rule.
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true, true)
    const body = form(request)
    const t = translator(request.locale ?? 'zh')
    const role = parseRepoRole(body.role)
    if (role === null) {
      return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent(t('请选择 maintainer 或 developer。', 'Choose maintainer or developer.'))}#role`)
    }
    if (!roleAllowed(repo.permission, role)) {
      return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent(t('你的 GitHub 权限不允许选择这个角色。', 'Your GitHub permission does not allow this role.'))}#role`)
    }
    // #718: this route writes the same `repo_role` column as the settings form,
    // and demoting to developer clears `auto_merge` and `reviewer_enabled`. The
    // role check above still answers first; the confirmation comes before the
    // write. The limiter half of this route belongs to #708.
    if (requireRecentAuth(request, reply, viewer, 'repo.role')) return reply
    store.updateRepo(repo.id, { repo_role: role, auto_merge: 0, reviewer_enabled: role === 'maintainer' ? repo.reviewer_enabled : 0, role_checked_at: nowIso() })
    store.audit(viewer.user.id, 'repo.role', `${repo.owner}/${repo.name} role=${role} previous=${repo.repo_role ?? 'none'}`)
    return reply.redirect(`/repos/${repo.id}?notice=${encodeURIComponent(role === 'maintainer' ? t('已选择角色：Maintainer。', 'Role selected: Maintainer.') : t('已选择角色：Developer。', 'Role selected: Developer.'))}`)
  })

  app.post('/repos/:id/settings', { config: { rateLimit: destructiveLimit } }, async (request, reply) => {
    // #105: settings decide the merge policy and the role gate, so a developer
    // member reads them but cannot write them.
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true, true)
    const body = form(request)
    const interval = normalizeInterval(body.interval, repo.interval_minutes)
    const reviewInterval = normalizeInterval(body.reviewInterval, repo.review_interval_minutes)
    const t = translator(request.locale ?? 'zh')
    // #471: a cadence is a choice, not a number to clamp. The `<select>` cannot
    // produce a value outside its options, so this refusal is only reachable from
    // a crafted POST — but it still names the field, because the page marks and
    // focuses the control the sentence is about. The value the form itself carried
    // is accepted, so a legacy row the reader did not touch stays savable.
    const refuseField = (field: string): FastifyReply =>
      reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent(t('设置没有保存。', 'The settings were not saved.'))}&field=${encodeURIComponent(field)}&code=INVALID_FIELD#repo-settings`)
    if (!intervalSubmissionAccepted(body.interval, DISCOVERY_INTERVALS, Math.max(60, repo.interval_minutes))) return refuseField('interval')
    if (!intervalSubmissionAccepted(body.reviewInterval, REVIEW_INTERVALS, normalizeInterval(repo.review_interval_minutes))) return refuseField('reviewInterval')
    const currentRole = parseRepoRole(repo.repo_role)
    const requestedRole = parseRepoRole(body.repoRole)
    const repoRole = requestedRole ?? currentRole
    if (repoRole === null) {
      return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent(t('请先选择你的角色。', 'Choose your role first.'))}#repo-settings`)
    }
    if (!roleAllowed(repo.permission, repoRole)) {
      return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent(t('你的 GitHub 权限不允许选择这个角色。', 'Your GitHub permission does not allow this role.'))}#repo-settings`)
    }
    const canMaintain = repoRole === 'maintainer'
    const autoMergeToggled = canMaintain && (body.autoMerge === '1') !== (repo.auto_merge === 1)
    if (autoMergeToggled && requireRecentAuth(request, reply, viewer, 'repo.auto_merge')) return reply
    const roleChanged = repoRole !== currentRole
    const goal = (body.goal ?? '').slice(0, 4000)
    const goalChanged = goal !== repo.goal
    const requestedBranch = (body.targetBranch ?? '').trim()
    const targetBranch = requestedBranch === '' ? (repo.upstream_default_branch || repo.default_branch) : requestedBranch
    if (!isValidBranchName(targetBranch)) {
      return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent('目标分支格式不正确。')}#repo-settings`)
    }
    // #524: the same POST writes the pre-merge policy, and the auto-merge gate
    // above left that half reachable from a stale session. `require_protection`
    // and `stage_mode` each switch off a check the merge path depends on, the
    // path lists and the target branch decide what a merge may touch, and
    // `repo_role` decides who may act. One gate for the set, so a single submit
    // writes one audit row rather than one per field.
    const policyNext: Array<[string, string | number | null, string | number]> = [
      ['require_protection', repo.require_protection, body.requireProtection === '1' ? 1 : 0],
      ['allow_paths', repo.allow_paths, (body.allowPaths ?? '').trim().slice(0, 2000)],
      ['deny_paths', repo.deny_paths, (body.denyPaths ?? '').trim().slice(0, 2000)],
      ['target_branch', repo.target_branch, targetBranch],
      ['repo_role', currentRole ?? 'none', repoRole],
      ['stage_mode', repo.stage_mode, parseStageMode(body.stageMode) ?? 'off'],
    ]
    const policyChanged = policyNext.filter(([, was, next]) => was !== next).map(([field]) => field)
    if (policyChanged.length > 0 && requireRecentAuth(request, reply, viewer, 'repo.policy')) return reply
    if (targetBranch !== repo.target_branch) {
      try {
        const token = await repoGithubToken(repo, config, githubApp, store)
        const branch = await new GithubClient(token, config.github.apiBase).getBranch(repo.upstream_owner || repo.owner, repo.upstream_name || repo.name, targetBranch)
        if (branch === null) {
          return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent('目标分支不存在或不可访问。')}#repo-settings`)
        }
      } catch (error) {
        return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent(error instanceof Error ? error.message : String(error))}#repo-settings`)
      }
    }
    // #540 slice 4: the policy set is one command. The route keeps the reads it
    // already made — the role is allowed, the target branch exists upstream, the
    // session is recent enough for a policy change — and hands the write to the
    // contract, so the revision fence, the idempotency receipt and the audit row
    // are not copied into this route a second time.
    const parts = commandParts(body, management.revisionOf('repo', repo.id))
    const outcome = await management.run(managementActor({ store, userId: viewer.user.id, repo, channel: 'web', requestId: request.id }), {
      operation: 'repo.update',
      target: { projectId: repo.id },
      arguments: {
        targetBranch,
        allowPaths: body.allowPaths ?? '',
        denyPaths: body.denyPaths ?? '',
        requireProtection: body.requireProtection === '1',
        stageMode: parseStageMode(body.stageMode) ?? 'off',
        repoRole,
      },
      expectedRevision: parts.expectedRevision,
      idempotencyKey: parts.idempotencyKey,
    })
    if (!outcome.ok) {
      return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent(managementFailure(t, outcome, t('设置没有保存。', 'The settings were not saved.')))}&code=${outcome.code}#repo-settings`)
    }
    store.updateRepo(repo.id, {
      goal,
      ...(roleChanged ? { role_checked_at: nowIso() } : {}),
      auto_merge: canMaintain && body.autoMerge === '1' ? 1 : 0,
      plan_required: body.planRequired === '1' ? 1 : 0,
      merge_method: body.mergeMethod === 'merge' || body.mergeMethod === 'rebase' ? body.mergeMethod : 'squash',
      monthly_budget_cny: Math.max(0, Math.min(10000, Number(body.monthlyBudget) || 0)),
      job_budget_cny: Math.max(0, Math.min(10000, Number(body.jobBudget) || 0)),
      job_budget_action: body.jobBudgetAction === 'pause' || body.jobBudgetAction === 'cancel' ? body.jobBudgetAction : 'alert',
      auto_iterate: body.auto === '1' ? 1 : 0,
      enabled: body.enabled === '1' ? 1 : 0,
      interval_minutes: interval,
      reviewer_enabled: canMaintain && repo.can_review === 1 && body.review === '1' ? 1 : 0,
      review_interval_minutes: reviewInterval,
    })
    // #697: the two scopes this form owns. A zero cap removes the row, so
    // "cleared" and "a cap of zero" cannot be confused, and both writes are the
    // same additive table the job checkpoint reads.
    const scopeAction = (value: string | undefined): string => (value === 'pause' || value === 'cancel' ? value : 'alert')
    store.setBudgetScope({
      kind: 'repository',
      id: repo.id,
      capCny: Math.max(0, Math.min(10000, Number(body.repoBudget) || 0)),
      action: scopeAction(body.repoBudgetAction),
    })
    store.setBudgetScope({
      kind: 'principal',
      id: identityPrincipalId(repo.user_id),
      capCny: Math.max(0, Math.min(10000, Number(body.principalBudget) || 0)),
      action: scopeAction(body.principalBudgetAction),
    })
    const policyWritten = Array.isArray(outcome.result.changed)
      ? outcome.result.changed.filter((field): field is string => typeof field === 'string')
      : []
    if (policyWritten.length > 0) {
      store.audit(viewer.user.id, 'repo.policy', `${repo.owner}/${repo.name} ${policyWritten.join(',')} by @${viewer.user.login}`)
    }
    const allowedModels = new Set(store.listUserProviderModels(viewer.user.id).map((model) => model.id))
    const requestedModels = [...new Set(formList(request, 'modelIds').filter((id) => allowedModels.has(id)))]
    const requestedDefault = (body.defaultModelId ?? '').trim()
    const effectiveDefault = requestedDefault !== '' && requestedModels.includes(requestedDefault) ? requestedDefault : requestedModels[0] ?? ''
    for (const role of ['chief', 'lead', 'product', 'test', 'security', 'reviewer', 'dev1', 'dev2']) {
      const value = (body[`botModel_${role}`] ?? '').trim()
      store.setRepoBotModel(repo.id, role, requestedModels.includes(value) ? value : null)
    }
    const currentModels = store.listRepoModelSelection(repo.id)
    const currentDefault = currentModels.find((model) => model.is_default === 1)?.id ?? ''
    const currentIds = currentModels.map((model) => model.id).sort().join(',')
    if (currentIds !== requestedModels.sort().join(',') || currentDefault !== effectiveDefault) {
      store.setRepoModelSelection(repo.id, requestedModels, effectiveDefault === '' ? null : effectiveDefault)
      store.audit(viewer.user.id, 'repo.models.changed', `${repo.owner}/${repo.name} models=${requestedModels.length} default=${effectiveDefault || 'none'}`)
    }
    const ownedProviders = new Set(store.listModelProviders(viewer.user.id).map((provider) => provider.id))
    const requestedProviders = [...new Set(formList(request, 'allowedProviderIds').filter((id) => ownedProviders.has(id)))]
    const requiredRegion = normalizeProviderRegion(body.providerRegion)
    const currentPolicy = store.repoProviderPolicy(repo.id)
    if ([...currentPolicy.allowlist].sort().join(',') !== requestedProviders.sort().join(',') || currentPolicy.requiredRegion !== requiredRegion) {
      store.setRepoProviderPolicy(repo.id, requestedProviders, requiredRegion)
      store.audit(viewer.user.id, 'repo.provider_policy.changed', `${repo.owner}/${repo.name} providers=${requestedProviders.length} region=${requiredRegion || 'any'}`)
    }
    if (repo.enabled === 1 && body.enabled !== '1') {
      await jobs.cancelRepoJobs(repo.id, '仓库已停用', 'REPO_DISABLED')
    }
    if (goalChanged) {
      await instances.ensurePlaybook(repo.id).catch((error) => {
        log.warn('team playbook not updated after goal change', { repo: repo.id, error: String(error) })
      })
    }
    store.audit(viewer.user.id, 'repo.settings', `${repo.owner}/${repo.name} role=${repoRole}${roleChanged ? ' role=changed' : ''} autoMerge=${canMaintain && body.autoMerge === '1' ? 'on' : 'off'} planRequired=${body.planRequired === '1' ? 'on' : 'off'} merge=${body.mergeMethod ?? 'squash'} protection=${body.requireProtection === '1' ? 'required' : 'optional'} budget=${body.jobBudgetAction === 'pause' || body.jobBudgetAction === 'cancel' ? body.jobBudgetAction : 'alert'} stage=${parseStageMode(body.stageMode) ?? 'off'} reviewer=${canMaintain && repo.can_review === 1 && body.review === '1' ? 'on' : 'off'}${goalChanged ? ' goal=changed' : ''} base=${targetBranch}`)
    return reply.redirect(`/repos/${repo.id}?notice=${encodeURIComponent(goalChanged ? '设置已保存；团队规则已按新目标更新。' : '设置已保存。')}#repo-settings`)
  })

  app.post('/repos/:id/models/apply', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true, true)
    // #852: a retired model is still in the selection, so applying would restart
    // the workspace onto a model its provider no longer serves. Refused by name
    // rather than deleted: the maintainer picks a live model and nothing is lost.
    const retiredSelection = store.listRepoModelSelection(repo.id).find((model) => model.retired_at !== null && model.retired_at !== undefined)
    if (retiredSelection !== undefined) {
      const t = translator(request.locale ?? 'zh')
      const on = String(retiredSelection.retired_at).slice(0, 10)
      const message = t(`模型“${retiredSelection.label}”已于 ${on} 被提供方下架，请先选择一个可用的模型再应用。`, `The model "${retiredSelection.label}" was retired by its provider on ${on}. Choose a live model before applying.`)
      return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent(message)}#repo-settings`)
    }
    try {
      const result = await instances.applyModels(repo.id)
      if (!result.ok) return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent(result.error ?? '模型应用失败。')}#repo-settings`)
      store.audit(viewer.user.id, 'repo.models.applied', repo.id)
      return reply.redirect(`/repos/${repo.id}?notice=${encodeURIComponent('模型已应用，工作区已重启。')}#repo-settings`)
    } catch (error) {
      return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent(error instanceof Error ? error.message : String(error))}#repo-settings`)
    }
  })

  app.post('/repos/:id/enable', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true, true)
    store.updateRepo(repo.id, { enabled: 1 })
    store.audit(viewer.user.id, 'repo.enabled', `${repo.owner}/${repo.name}`)
    return reply.redirect(`/repos/${repo.id}?notice=${encodeURIComponent('仓库已启用；自动迭代不会自动打开，需要时在设置里开启。')}`)
  })

  app.post('/repos/:id/disable', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true, true)
    store.updateRepo(repo.id, { enabled: 0, auto_iterate: 0 })
    await jobs.cancelRepoJobs(repo.id, '仓库已停用', 'REPO_DISABLED')
    store.audit(viewer.user.id, 'repo.disabled', `${repo.owner}/${repo.name}`)
    return reply.redirect(`/repos/${repo.id}?notice=${encodeURIComponent('仓库已停用，任务不会再运行。')}`)
  })

  app.post('/repos/:id/delete', { config: { rateLimit: destructiveLimit } }, async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true, true)
    if (requireRecentAuth(request, reply, viewer, 'repo.delete', `/repos/${repo.id}#danger`)) return reply
    const confirmName = (form(request).confirmName ?? '').trim()
    if (confirmName !== repo.name && confirmName !== `${repo.owner}/${repo.name}`) {
      return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent('请输入仓库名确认删除。')}#danger`)
    }
    for (const job of store.listActiveJobs().filter((entry) => entry.repo_id === repo.id)) {
      const token = job.platform_token_hash === null ? undefined : store.findApiToken(job.platform_token_hash)
      if (token !== undefined) store.revokeApiToken(token.id, token.user_id)
    }
    await instances.remove(repo.id)
    store.deleteRepo(repo.id)
    store.audit(viewer.user.id, 'repo.deleted', `${repo.owner}/${repo.name}`)
    return reply.redirect(`/dashboard?notice=${encodeURIComponent('仓库连接已删除；GitHub 仓库不受影响。')}`)
  })

  app.get('/settings', async (request, reply) => {
    const viewer = requireApproved(request)
    return reply.type('text/html').send(
      settingsPage({
        config,
        locale: request.locale ?? 'zh',
        viewer: viewOf(viewer),
        tokens: store.listApiTokens(viewer.user.id).filter((token) => token.kind === 'pat'),
        sessions: store.listSessions(viewer.user.id),
        currentSessionHash: viewer.sessionHash,
        providers: store.listModelProviders(viewer.user.id).map((provider) => ({ ...provider, models: store.listProviderModels(provider.id) })),
        feedback: store.listFeedbackTriageForUser(viewer.user.id, 10),
        discoveredProvider: queryText(request, 'discoveredProvider'),
        discovered: (queryText(request, 'discovered') ?? '').split(',').filter((value) => value !== ''),
        notice: request.flash?.notice?.text,
        error: request.flash?.error?.text,
      }),
    )
  })

  app.post('/settings/providers', async (request, reply) => {
    const viewer = approvedCsrfGuard(request)
    const body = form(request)
    try {
      const label = (body.label ?? '').trim().slice(0, 80)
      const baseUrl = (body.baseUrl ?? '').trim()
      const key = (body.apiKey ?? '').trim()
      if (label === '' || baseUrl === '' || key === '') throw new Error('请填写名称、Base URL 和 API Key')
      const canPrivate = config.allowPrivateModelUrls || viewer.user.allow_private_models === 1 || viewer.user.role === 'superadmin'
      const allowPrivate = canPrivate && (config.allowPrivateModelUrls || body.allowPrivate === '1')
      const safeUrl = await assertSafeModelUrl(baseUrl, allowPrivate)
      const region = normalizeProviderRegion(body.region)
      const dataPolicyUrl = normalizeDataPolicyUrl(body.dataPolicyUrl)
      const allowed = body.allowed !== '0'
      const provider = store.createModelProvider({
        id: randomId('prv'),
        userId: viewer.user.id,
        label,
        baseUrl: safeUrl,
        keyEnc: encryptSecret(key, config.tokenEncryptionKey),
        allowPrivate,
        region,
        dataPolicyUrl,
        allowed,
      })
      store.audit(viewer.user.id, 'model.provider.added', `${provider.id} ${label} private=${allowPrivate ? 'on' : 'off'} region=${region || 'any'} allowed=${allowed ? 'on' : 'off'}`)
      return reply.redirect(`/settings?notice=${encodeURIComponent('模型提供方已添加。添加模型时会由 Fledge 测试连接。')}#model-providers`)
    } catch (error) {
      return reply.redirect(`/settings?error=${encodeURIComponent(error instanceof Error ? error.message : String(error))}#model-providers`)
    }
  })

  app.post('/settings/providers/:id/update', async (request, reply) => {
    const viewer = approvedCsrfGuard(request)
    const id = String((request.params as Record<string, string>).id)
    const provider = store.modelProviderById(id, viewer.user.id)
    if (provider === undefined) return reply.code(404).send({ error: '模型提供方不存在。' })
    const body = form(request)
    try {
      const label = (body.label ?? '').trim().slice(0, 80) || provider.label
      const baseUrl = (body.baseUrl ?? '').trim() || provider.base_url
      const canPrivate = config.allowPrivateModelUrls || viewer.user.allow_private_models === 1 || viewer.user.role === 'superadmin'
      const allowPrivate = canPrivate && body.allowPrivate === '1'
      const safeUrl = await assertSafeModelUrl(baseUrl, allowPrivate)
      const key = (body.apiKey ?? '').trim() !== '' ? (body.apiKey ?? '').trim() : decryptSecret(provider.key_enc, config.tokenEncryptionKey)
      const region = body.region === undefined ? provider.region : normalizeProviderRegion(body.region)
      const dataPolicyUrl = body.dataPolicyUrl === undefined ? provider.data_policy_url : normalizeDataPolicyUrl(body.dataPolicyUrl)
      const allowed = body.allowed === undefined ? provider.allowed === 1 : body.allowed === '1'
      if (safeUrl !== provider.base_url || key !== decryptSecret(provider.key_enc, config.tokenEncryptionKey)) {
        for (const model of store.listProviderModels(provider.id)) {
          await testOwnModel(safeUrl, key, model.model)
        }
      }
      store.updateModelProvider(provider.id, viewer.user.id, {
        label,
        base_url: safeUrl,
        key_enc: encryptSecret(key, config.tokenEncryptionKey),
        allow_private: allowPrivate ? 1 : 0,
        region,
        data_policy_url: dataPolicyUrl,
        allowed: allowed ? 1 : 0,
      })
      store.audit(viewer.user.id, 'model.provider.updated', `${provider.id} ${label} private=${allowPrivate ? 'on' : 'off'} region=${region || 'any'} allowed=${allowed ? 'on' : 'off'}`)
      return reply.redirect(`/settings?notice=${encodeURIComponent('模型提供方已更新。')}#model-providers`)
    } catch (error) {
      return reply.redirect(`/settings?error=${encodeURIComponent(`提供方测试失败，未保存：${error instanceof Error ? error.message : String(error)}`)}#model-providers`)
    }
  })

  app.post('/settings/providers/:id/discover', async (request, reply) => {
    const viewer = approvedCsrfGuard(request)
    const id = String((request.params as Record<string, string>).id)
    const provider = store.modelProviderById(id, viewer.user.id)
    if (provider === undefined) return reply.code(404).send({ error: '模型提供方不存在。' })
    try {
      const key = decryptSecret(provider.key_enc, config.tokenEncryptionKey)
      const response = await fetch(`${provider.base_url.replace(/\/$/, '')}/models`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(20_000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json() as { data?: Array<{ id?: unknown }> }
      const models = Array.isArray(payload.data) ? payload.data.map((entry) => entry.id).filter((value): value is string => typeof value === 'string').slice(0, 100) : []
      if (models.length === 0) throw new Error('提供方没有返回模型')
      return reply.redirect(`/settings?discoveredProvider=${encodeURIComponent(provider.id)}&discovered=${encodeURIComponent(models.join(','))}&notice=${encodeURIComponent(`发现 ${models.length} 个模型。`)}#model-providers`)
    } catch (error) {
      return reply.redirect(`/settings?error=${encodeURIComponent(`读取模型失败：${error instanceof Error ? error.message : String(error)}`)}#model-providers`)
    }
  })

  app.post('/settings/providers/:id/models/bulk', async (request, reply) => {
    const viewer = approvedCsrfGuard(request)
    const id = String((request.params as Record<string, string>).id)
    const provider = store.modelProviderById(id, viewer.user.id)
    if (provider === undefined) return reply.code(404).send({ error: '模型提供方不存在。' })
    const requested = [...new Set(formList(request, 'models'))].slice(0, 50)
    if (requested.length === 0) return reply.redirect(`/settings?error=${encodeURIComponent('请选择至少一个模型。')}#model-providers`)
    const key = decryptSecret(provider.key_enc, config.tokenEncryptionKey)
    const existing = new Set(store.listProviderModels(provider.id).map((model) => model.model))
    let added = 0
    const failed: string[] = []
    for (const model of requested) {
      if (existing.has(model)) continue
      try {
        await testOwnModel(provider.base_url, key, model)
        store.createProviderModel({ id: randomId('pvm'), providerId: provider.id, model, label: model })
        store.audit(viewer.user.id, 'model.added', `${provider.id}/${model}`)
        added += 1
      } catch {
        failed.push(model)
      }
    }
    const message = `${added} 个模型已通过测试并保存${failed.length === 0 ? '' : `；失败：${failed.join(', ')}`}`
    return reply.redirect(`/settings?${failed.length === 0 ? 'notice' : 'error'}=${encodeURIComponent(message)}#model-providers`)
  })

  app.post('/settings/providers/:id/delete', { config: { rateLimit: destructiveClassLimit } }, async (request, reply) => {
    const viewer = approvedCsrfGuard(request)
    const id = String((request.params as Record<string, string>).id)
    const provider = store.modelProviderById(id, viewer.user.id)
    if (provider === undefined) return reply.code(404).send({ error: '模型提供方不存在。' })
    // #525: the delete removes configuration the owner may not have recorded,
    // and the lookup above only proves the provider is theirs - a stolen cookie
    // is still theirs. The actor's own scope keeps a refusal local to the owner.
    if (requireRecentAuth(request, reply, viewer, 'model.provider.remove')) return reply
    // #849: the selection rows for this provider's models disappear with it. Without
    // the flag those repositories silently fall to the platform default, which spends
    // platform quota and offers no restart, so mark them dirty before the delete.
    const affected = store.listRepos(viewer.user.id).filter((repo) =>
      store.listRepoModelSelection(repo.id).some((selection) => selection.provider_id === provider.id),
    )
    store.deleteModelProvider(id, viewer.user.id)
    for (const repo of affected) store.updateRepo(repo.id, { models_dirty: 1 })
    store.audit(viewer.user.id, 'model.provider.removed', `${id} ${provider.label}${affected.length === 0 ? '' : ` repos=${affected.length}`}`)
    const t = translator(request.locale ?? 'zh')
    const notice = affected.length === 0
      ? t('模型提供方已删除。', 'Model provider deleted.')
      : t(
        `模型提供方已删除；${affected.length} 个仓库的模型选择已失效，请重新应用模型并重启工作区。`,
        `Model provider deleted; the model selection of ${affected.length} repositories is no longer valid. Apply the models and restart the workspace again.`,
      )
    return reply.redirect(`/settings?notice=${encodeURIComponent(notice)}#model-providers`)
  })

  app.post('/settings/providers/:id/models', async (request, reply) => {
    const viewer = approvedCsrfGuard(request)
    const id = String((request.params as Record<string, string>).id)
    const provider = store.modelProviderById(id, viewer.user.id)
    if (provider === undefined) return reply.code(404).send({ error: '模型提供方不存在。' })
    const body = form(request)
    try {
      const model = (body.model ?? '').trim().slice(0, 120)
      const label = (body.label ?? '').trim().slice(0, 120) || model
      if (model === '') throw new Error('请填写模型 ID')
      const key = decryptSecret(provider.key_enc, config.tokenEncryptionKey)
      await testOwnModel(provider.base_url, key, model)
      const created = store.createProviderModel({ id: randomId('pvm'), providerId: provider.id, model, label })
      store.audit(viewer.user.id, 'model.added', `${created.id} ${provider.label}/${model}`)
      return reply.redirect(`/settings?notice=${encodeURIComponent('模型已通过连接测试并保存。')}#model-providers`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return reply.redirect(`/settings?error=${encodeURIComponent(`连接测试失败，未保存：${message}`)}#model-providers`)
    }
  })

  app.post('/settings/providers/:id/models/:modelId/delete', async (request, reply) => {
    const viewer = approvedCsrfGuard(request)
    const modelId = String((request.params as Record<string, string>).modelId)
    // #849: same silent fallback one level down — deleting a single provider model
    // drops the selections that point at it, so flag the repositories that used it.
    const affected = store.listRepos(viewer.user.id).filter((repo) =>
      store.listRepoModelSelection(repo.id).some((selection) => selection.id === modelId),
    )
    const removed = store.deleteProviderModel(modelId, viewer.user.id)
    if (!removed) return reply.code(404).send({ error: '模型不存在。' })
    for (const repo of affected) store.updateRepo(repo.id, { models_dirty: 1 })
    store.audit(viewer.user.id, 'model.removed', `${modelId}${affected.length === 0 ? '' : ` repos=${affected.length}`}`)
    const t = translator(request.locale ?? 'zh')
    const notice = affected.length === 0
      ? t('模型已删除。', 'Model deleted.')
      : t(
        `模型已删除；${affected.length} 个仓库的模型选择已失效，请重新应用模型并重启工作区。`,
        `Model deleted; the model selection of ${affected.length} repositories is no longer valid. Apply the models and restart the workspace again.`,
      )
    return reply.redirect(`/settings?notice=${encodeURIComponent(notice)}#model-providers`)
  })

  app.post('/settings/notifications', async (request, reply) => {
    const viewer = approvedCsrfGuard(request)
    const body = form(request)
    const rawEmail = (body.email ?? '').trim().slice(0, 254)
    const clear = body.clear === '1'
    if (!clear && rawEmail !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
      return reply.redirect(`/settings?error=${encodeURIComponent('通知邮箱格式不正确。')}`)
    }
    const jobUpdates = body.jobUpdates === '1'
    const dailyDigest = body.dailyDigest === '1'
    const jobSuccess = body.jobSuccess === '1'
    // #1069: the window is two `HH:MM` values in the digest timezone. A lone
    // time, an equal pair or a malformed value is refused rather than saved as
    // a silent full-day mute.
    const quietStart = (body.quietStart ?? '').trim()
    const quietEnd = (body.quietEnd ?? '').trim()
    const quietTime = /^([01][0-9]|2[0-3]):[0-5][0-9]$/
    if ((quietStart === '') !== (quietEnd === '')) {
      return reply.redirect(`/settings?error=${encodeURIComponent('安静时段需要同时填写开始和结束，或都留空。')}`)
    }
    if (quietStart !== '' && (!quietTime.test(quietStart) || !quietTime.test(quietEnd))) {
      return reply.redirect(`/settings?error=${encodeURIComponent('安静时段的时间格式不正确。')}`)
    }
    if (quietStart !== '' && quietStart === quietEnd) {
      return reply.redirect(`/settings?error=${encodeURIComponent('安静时段的开始和结束不能相同。')}`)
    }
    if (clear) store.setNotifyEmail(viewer.user.id, null)
    else if (rawEmail !== '') store.setNotifyEmail(viewer.user.id, rawEmail)
    store.setEmailJobUpdates(viewer.user.id, jobUpdates)
    store.setEmailDailyDigest(viewer.user.id, dailyDigest)
    store.setEmailJobSuccess(viewer.user.id, jobSuccess)
    store.setUserQuietHours(viewer.user.id, quietStart === '' ? null : quietStart, quietEnd === '' ? null : quietEnd)
    const saved = store.userById(viewer.user.id)
    store.audit(viewer.user.id, 'settings.email', `email=${saved?.notify_email === null || saved?.notify_email === undefined ? 'github' : 'custom'} jobs=${jobUpdates ? 'on' : 'off'} digest=${dailyDigest ? 'on' : 'off'} success=${jobSuccess ? 'on' : 'off'} quiet=${quietStart === '' ? 'off' : `${quietStart}-${quietEnd}`}`)
    if (body.action === 'test') {
      const updated = saved
      const to = updated === undefined ? '' : notifyEmail(updated)
      if (to === '') return reply.redirect(`/settings?error=${encodeURIComponent('请先填写通知邮箱。')}`)
      const key = `email_test:${viewer.user.id}`
      const last = store.getSetting(key)
      if (last !== undefined && Date.now() - Date.parse(last) < 60_000) {
        return reply.redirect(`/settings?error=${encodeURIComponent('测试邮件每分钟最多发送一次。')}`)
      }
      store.setSetting(key, new Date().toISOString())
      try {
        await mailer.send({ to, ...testEmail(viewer.user, config.baseUrl) })
        store.audit(viewer.user.id, 'settings.email.test')
        return reply.redirect(`/settings?notice=${encodeURIComponent('测试邮件已发送。')}`)
      } catch (error) {
        store.deleteSetting(key)
        return reply.redirect(`/settings?error=${encodeURIComponent(`测试邮件发送失败：${error instanceof Error ? error.message : String(error)}`)}`)
      }
    }
    return reply.redirect(`/settings?notice=${encodeURIComponent('通知设置已保存。')}`)
  })

  app.post('/feedback', { config: { rateLimit: feedbackLimit } }, async (request, reply) => {
    const viewer = approvedCsrfGuard(request)
    const body = form(request)
    const kind = body.kind === 'bug' || body.kind === 'other' ? body.kind : 'feedback'
    const message = redact((body.message ?? '').trim()).slice(0, 2000)
    const page = (body.page ?? '').trim().slice(0, 200)
    const returnTo = safeLocalPath(body.returnTo, '/settings')
    const back = (key: 'notice' | 'error', text: string): string => {
      const target = withMessageParam(returnTo, key, text)
      return returnTo.startsWith('/settings') ? `${target}#feedback` : target
    }
    if (message === '') return reply.redirect(back('error', '请填写反馈内容。'))
    const id = randomId('fb')
    const createdAt = new Date().toISOString()
    const publishConsent = body.publishConsent === '1'
    store.createFeedback({ id, userId: viewer.user.id, kind, message, page, createdAt })
    const triage = store.createFeedbackTriage({ ref: id, userId: viewer.user.id, userLogin: viewer.user.login, kind, publishConsent, createdAt })
    void attemptLeadDelivery({ store, config, instances, triage, feedback: store.feedbackById(id) }).catch((error) => log.warn('feedback lead delivery failed', { ref: id, error: redact(String(error)) }))
    store.audit(viewer.user.id, 'feedback.created', `${id} kind=${kind} chars=${message.length}`)
    const replyTo = notifyEmail(viewer.user)
    try {
      await mailer.send({
        to: config.mail.feedbackEmail,
        ...feedbackMail({ id, login: viewer.user.login, kind, message, page, createdAt }),
        ...(replyTo === '' ? {} : { replyTo }),
      })
      return reply.redirect(back('notice', '反馈已发送，谢谢。'))
    } catch (error) {
      log.error('feedback mail failed', { id, error: redact(String(error)) })
      return reply.redirect(back('error', '反馈已保存，但通知邮件发送失败；请稍后再试。'))
    }
  })

  // #786: the ref is the unguessable capability the 5xx page carries. The route
  // is deliberately usable without a session so an error on the sign-in or
  // public page can still be reported; the claim is atomic, so two clicks send
  // one mail.
  app.post('/errors/:ref/report', { config: { rateLimit: errorReportLimit } }, async (request, reply) => {
    const ref = String((request.params as Record<string, string>).ref ?? '')
    const viewer = request.viewer === undefined ? null : viewOf(request.viewer)
    if (!/^[A-Za-z0-9_-]{10,80}$/.test(ref)) {
      return htmlPage(reply, 404, errorPage(config, viewer, 404, '页面不存在', '这个报告编号不存在。', request.locale))
    }
    const report = store.errorReportByRef(ref)
    if (report === undefined) {
      return htmlPage(reply, 404, errorPage(config, viewer, 404, '页面不存在', '这个报告编号不存在。', request.locale))
    }
    const reportBody = form(request)
    if (reportBody.consent !== '1') {
      return htmlPage(reply, 400, errorPage(config, viewer, 400, '需要授权', '请先勾选“我已知晓并授权 Fledge 平台读取这些失败数据”，再提交报告。', request.locale))
    }
    if (!store.claimErrorReport(ref, ERROR_REPORT_CONSENT_VERSION)) {
      return htmlPage(reply, 200, errorPage(config, viewer, 200, '报告已发送', `这个报告（${ref}）已经发送过了，谢谢。`, request.locale))
    }
    const publishConsent = request.viewer !== undefined && reportBody.publish === '1'
    const triage = store.createFeedbackTriage({
      ref,
      userId: report.user_id,
      userLogin: report.user_login,
      kind: 'error',
      publishConsent,
      createdAt: report.created_at,
    })
    void attemptLeadDelivery({ store, config, instances, triage, error: report }).catch((error) => log.warn('error report lead delivery failed', { ref, error: redact(String(error)) }))
    try {
      await mailer.send({
        to: config.mail.feedbackEmail,
        ...errorReportMail({
          ref,
          login: report.user_login,
          method: report.method,
          path: report.path,
          statusCode: report.status_code,
          errorName: report.error_name,
          errorMessage: report.error_message,
          stack: report.error_stack,
          version: report.build_version,
          commit: report.build_commit,
          createdAt: report.created_at,
          consentVersion: ERROR_REPORT_CONSENT_VERSION,
          consentedAt: store.errorReportByRef(ref)?.consented_at ?? report.created_at,
        }),
      })
    } catch (error) {
      log.error('error report mail failed', { ref, error: redact(String(error)) })
    }
    store.audit(report.user_id, 'error.reported', `${ref} ${report.status_code} ${report.path}`)
    return htmlPage(reply, 200, errorPage(config, viewer, 200, '报告已发送', `谢谢。编号：${ref}。开发者会查看这个错误的类型、页面和时间；报告不包含你的输入、token 或请求体。`, request.locale))
  })

  const triageAuthorized = (request: FastifyRequest, ref: string): boolean => {
    const header = String(request.headers.authorization ?? '')
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
    return verifyTriageToken(config.sessionSecret, ref, token)
  }

  app.get('/api/feedback/:ref', async (request, reply) => {
    if (!apiLimiter.take(`feedback-triage:${rateLimitKey(request)}`)) return reply.code(429).send({ error: { type: 'rate_limited', message: 'Too many requests' } })
    const ref = String((request.params as Record<string, string>).ref ?? '')
    if (!triageAuthorized(request, ref)) return reply.code(401).send({ error: { type: 'invalid_triage_token', message: 'Missing or invalid triage token' } })
    const triage = store.feedbackTriageByRef(ref)
    if (triage === undefined) return reply.code(404).send({ error: { type: 'not_found', message: 'No such feedback reference' } })
    return {
      triage,
      feedback: store.feedbackById(ref) ?? null,
      error: store.errorReportByRef(ref) ?? null,
      events: store.listFeedbackEvents(ref),
      issueDraft: publicIssueDraft(triage),
    }
  })

  app.post('/api/feedback/:ref/triage', async (request, reply) => {
    if (!apiLimiter.take(`feedback-triage:${rateLimitKey(request)}`)) return reply.code(429).send({ error: { type: 'rate_limited', message: 'Too many requests' } })
    const ref = String((request.params as Record<string, string>).ref ?? '')
    if (!triageAuthorized(request, ref)) return reply.code(401).send({ error: { type: 'invalid_triage_token', message: 'Missing or invalid triage token' } })
    const triage = store.feedbackTriageByRef(ref)
    if (triage === undefined) return reply.code(404).send({ error: { type: 'not_found', message: 'No such feedback reference' } })
    const body = (request.body ?? {}) as Record<string, unknown>
    const status = typeof body.status === 'string' ? body.status.trim() : ''
    const userMessage = redact(String(body.user_message ?? '')).trim().slice(0, 1000)
    const publicSummary = redact(String(body.public_summary ?? '')).trim().slice(0, 1000)
    const issueUrl = String(body.issue_url ?? '').trim()
    const prUrl = String(body.pr_url ?? '').trim()
    const fixedVersion = String(body.fixed_version ?? '').trim()
    const problems = triageProblems({ status, userMessage, publicSummary, issueUrl, prUrl, fixedVersion, publicRepo: config.feedback.publicRepo })
    if (problems.length > 0) return reply.code(400).send({ error: { type: 'invalid_triage', message: problems.join('; ') } })
    if (fixedVersion !== '' && parseVersion(fixedVersion) === null) return reply.code(400).send({ error: { type: 'invalid_version', message: 'fixed_version must be SemVer' } })
    const unchanged = triage.status === status &&
      (triage.user_message ?? '') === userMessage &&
      (triage.public_summary ?? '') === publicSummary &&
      (triage.issue_url ?? '') === issueUrl &&
      (triage.pr_url ?? '') === prUrl &&
      (triage.fixed_version ?? '') === fixedVersion
    if (unchanged) {
      return { ok: true, status, unchanged: true, issueDraft: publicIssueDraft(triage) }
    }
    store.updateFeedbackTriage(ref, {
      status,
      user_message: userMessage === '' ? null : userMessage,
      public_summary: publicSummary === '' ? null : publicSummary,
      issue_url: issueUrl === '' ? null : issueUrl,
      pr_url: prUrl === '' ? null : prUrl,
      fixed_version: fixedVersion === '' ? null : fixedVersion,
    })
    store.addFeedbackEvent(ref, status, userMessage.slice(0, 300), 'fledge-lead')
    store.audit(triage.user_id, 'feedback.triaged', `${ref} ${status}`)
    await notifyFeedbackReporter({
      store,
      mailer,
      ref,
      userId: triage.user_id,
      status,
      userMessage,
      issueUrl: issueUrl === '' ? null : issueUrl,
      prUrl: prUrl === '' ? null : prUrl,
    })
    const updated = store.feedbackTriageByRef(ref)
    return { ok: true, status, issueDraft: updated === undefined ? null : publicIssueDraft(updated) }
  })

  app.post('/settings/tokens', { config: { rateLimit: destructiveLimit } }, async (request, reply) => {
    const viewer = approvedCsrfGuard(request)
    if (requireRecentAuth(request, reply, viewer, 'token.create')) return reply
    const body = form(request)
    const name = (body.name ?? '').trim().slice(0, 80) || 'default'
    // #355: a posted `scope` may only name a scope the code enforces, so an
    // unknown value is refused instead of being written as-is.
    const scope = (body.scope ?? '').trim() === '' ? GATEWAY_SCOPE : body.scope!.trim()
    if (!isTokenScope(scope)) return reply.redirect(`/settings?error=${encodeURIComponent('不支持这个 token 范围。')}`)
    // A token without a deadline is an operator decision, not a user choice.
    const operator = viewer.user.role === 'admin' || viewer.user.role === 'superadmin'
    const never = body.expiryDays === 'never'
    if (never && !operator) return reply.redirect(`/settings?error=${encodeURIComponent('只有管理员可以创建永不过期的 token。')}`)
    const days = patExpiryDays(body.expiryDays, config.tokens.patExpiryDays)
    const expiresAt = days === null ? null : expiryFromDays(days)
    const raw = `flg_${randomToken(32)}`
    store.createApiToken({
      id: randomId('tok'),
      userId: viewer.user.id,
      kind: 'pat',
      name,
      tokenHash: sha256Hex(raw),
      prefix: raw.slice(0, 8),
      repoId: null,
      scope,
      expiresAt,
    })
    store.audit(viewer.user.id, 'token.created', `${name} scope=${scope} expires=${expiresAt ?? 'never'}`)
    return reply.type('text/html').send(
      settingsPage({
        config,
        locale: request.locale ?? 'zh',
        viewer: viewOf(viewer),
        tokens: store.listApiTokens(viewer.user.id).filter((token) => token.kind === 'pat'),
        sessions: store.listSessions(viewer.user.id),
        currentSessionHash: viewer.sessionHash,
        providers: store.listModelProviders(viewer.user.id).map((provider) => ({ ...provider, models: store.listProviderModels(provider.id) })),
        newToken: raw,
        notice: '新 token 只显示这一次，请现在复制保存。',
      }),
    )
  })

  app.post('/settings/tokens/:id/revoke', { config: { rateLimit: destructiveLimit } }, async (request, reply) => {
    const viewer = approvedCsrfGuard(request)
    if (requireRecentAuth(request, reply, viewer, 'token.revoke')) return reply
    store.revokeApiToken(String((request.params as Record<string, string>).id), viewer.user.id)
    store.audit(viewer.user.id, 'token.revoked')
    return reply.redirect(`/settings?notice=${encodeURIComponent('Token 已撤销。')}`)
  })

  // #356: a stolen cookie otherwise stays valid for the rest of its 30 days with
  // no way to see or end it. Every route here is scoped to the viewer's own rows:
  // a hash that is not theirs deletes nothing and answers the same way a
  // non-existent one does, so the page cannot be used to probe another account.
  // Each mutation takes the same limiter window as the other mutating form posts
  // and answers the same 429 page: CSRF proves the request came from our page, it
  // does not bound how many a stolen cookie may send.
  app.post('/settings/sessions/:hash/revoke', async (request, reply) => {
    if (!limits.take('login', `session-revoke:${rateLimitKey(request)}`)) return htmlPage(reply, 429, errorPage(config, request.viewer ?? null, 429, '请求过多', '请稍后再试。', request.locale))
    const viewer = approvedCsrfGuard(request)
    const hash = String((request.params as Record<string, string>).hash)
    if (hash === viewer.sessionHash) {
      return reply.redirect(`/settings?error=${encodeURIComponent('这是当前会话。请用“轮换当前会话”换一个新 cookie，或用退出登录结束它。')}#sessions`)
    }
    if (!store.deleteSessionOfUser(viewer.user.id, hash)) {
      return reply.redirect(`/settings?error=${encodeURIComponent('这个会话不存在，或不属于你。')}#sessions`)
    }
    store.audit(viewer.user.id, 'session.revoked', `one ${hash.slice(0, 8)}…`)
    return reply.redirect(`/settings?notice=${encodeURIComponent('会话已撤销，那个 cookie 现在就会被拒绝。')}#sessions`)
  })

  app.post('/settings/sessions/revoke-others', async (request, reply) => {
    if (!limits.take('login', `session-revoke-others:${rateLimitKey(request)}`)) return htmlPage(reply, 429, errorPage(config, request.viewer ?? null, 429, '请求过多', '请稍后再试。', request.locale))
    const viewer = approvedCsrfGuard(request)
    const removed = store.deleteOtherSessions(viewer.user.id, viewer.sessionHash)
    store.audit(viewer.user.id, 'session.revoked', `others=${removed}`)
    return reply.redirect(`/settings?notice=${encodeURIComponent(removed === 0 ? '没有其他会话需要退出。' : `已退出 ${removed} 个其他会话。`)}#sessions`)
  })

  app.post('/settings/sessions/rotate', async (request, reply) => {
    if (!limits.take('login', `session-rotate:${rateLimitKey(request)}`)) return htmlPage(reply, 429, errorPage(config, request.viewer ?? null, 429, '请求过多', '请稍后再试。', request.locale))
    const viewer = approvedCsrfGuard(request)
    const raw = sessions.start(viewer.user.id, request)
    const hash = sha256Hex(raw)
    store.deleteSession(viewer.sessionHash)
    // The rotated session is a new row, so it starts recent: `sessions.start`
    // recorded `recent_auth_at` for it and the viewer has to carry the same fact.
    sessions.setCookies(reply, raw, { sessionHash: hash, user: viewer.user, csrfToken: sessions.csrfFor(hash), recentAuthAt: new Date().toISOString(), preview: viewer.preview })
    store.audit(viewer.user.id, 'session.rotated')
    return reply.redirect(`/settings?notice=${encodeURIComponent('已换成新的会话 cookie，旧 cookie 已作废。')}#sessions`)
  })

  app.post('/notifications/read', async (request, reply) => {
    const viewer = approvedCsrfGuard(request)
    store.markNotificationsRead(viewer.user.id)
    return reply.redirect('/dashboard')
  })

  // #633: the in-app row and the mail link resolve the same action id. Opening
  // either one reads the rows that carry it; the page the action points at is
  // where the decision itself is made.
  app.get('/actions/:id', async (request, reply) => {
    const viewer = requireApproved(request)
    const id = (request.params as { id?: string }).id ?? ''
    const action = store.getAction(id)
    if (action === undefined || action.user_id !== viewer.user.id) return htmlPage(reply, 404, errorPage(config, request.viewer ?? null, 404, '找不到', '这一步不存在，或不属于你。', request.locale))
    store.markActionRead(action.id)
    store.audit(viewer.user.id, 'action.opened', action.id)
    return reply.redirect(action.href)
  })

  app.post('/actions/:id/resolve', async (request, reply) => {
    const viewer = approvedCsrfGuard(request)
    const id = (request.params as { id?: string }).id ?? ''
    const action = store.getAction(id)
    if (action === undefined || action.user_id !== viewer.user.id) return htmlPage(reply, 404, errorPage(config, request.viewer ?? null, 404, '找不到', '这一步不存在，或不属于你。', request.locale))
    store.resolveAction(action.id)
    store.audit(viewer.user.id, 'action.resolved', action.id)
    return reply.redirect('/dashboard')
  })

  app.get('/admin/product', async (request, reply) => {
    const viewer = requireSuperAdmin(request)
    if (viewer.preview === true) return reply.redirect('/console')
    const windowDays = queryText(request, 'window') === '7' ? 7 : 30
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1_000).toISOString()
    return reply.type('text/html').send(productPage({
      config,
      locale: request.locale ?? 'zh',
      viewer: viewOf(viewer),
      loop: store.productLoopMetrics(since),
      windowDays,
      since,
      // #635: the receiver card reads the same two facts the push itself checks —
      // the configured URL and the day marker the last successful push wrote.
      webhook: { configured: config.productWebhookUrl !== '', lastPushAt: store.getSetting(PRODUCT_PUSH_KEY) ?? null },
      notice: queryText(request, 'notice'),
      error: queryText(request, 'error'),
    }))
  })

  // #635: the export is the page's own snapshot, not a second query, so it cannot
  // disagree with what the operator just read. It is not reachable while analytics
  // is off: the operator who switched the record off has also said these counts do
  // not exist, and a link that still answers would contradict the page.
  app.get('/admin/product.csv', async (request, reply) => {
    const viewer = requireSuperAdmin(request)
    if (viewer.preview === true) return reply.redirect('/console')
    if (!store.productAnalyticsEnabled()) {
      return htmlPage(reply, 404, errorPage(config, request.viewer ?? null, 404, '页面不存在', '回路统计已关闭，没有可导出的记录。', request.locale))
    }
    const windowDays = queryText(request, 'window') === '7' ? 7 : 30
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1_000).toISOString()
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="product-loop-${windowDays}d.csv"`)
      .send(loopCsv(store.productLoopMetrics(since), windowDays, since))
  })

  app.get('/admin/metrics', async (request, reply) => {
    const viewer = requireSuperAdmin(request)
    if (viewer.preview === true) return reply.redirect('/console')
    const windowDays = queryText(request, 'window') === '7' ? 7 : 30
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1_000).toISOString()
    return reply.type('text/html').send(metricsPage({
      config,
      locale: request.locale ?? 'zh',
      viewer: viewOf(viewer),
      metrics: store.productMetrics(since),
      team: store.teamMetrics(since),
      workItems: store.workItemMetrics(since),
      attribution: store.usageAttribution(since),
      stages: store.stageMetrics(since),
      delivery: store.deliveryMetrics(since),
      daily: store.dailyMetrics(since),
      repoCosts: store.repoCostMetrics(since),
      modelCosts: store.modelCostMetrics(since),
      currency: store.costByCurrency(since),
      alerts: store.alerts({ usdCny: config.quota.usdCny, automationIdleMinutes: config.ops.automationIdleAlertMinutes, instancesManaged: config.flybot.instanceImage !== '' }),
      windowDays,
      failures: failureBreakdown(store.failedJobsSince(since)),
      automation: automationHealth(),
      since,
      notice: request.flash?.notice?.text,
      error: request.flash?.error?.text,
    }))
  })

  // #1234: the route module owns the superadmin rule and the redacted builder.
  registerIncidentRoute(app, { store, config, clockState: () => githubApp.clockState() })

  const adminVisibleUserIds = (viewer: { user: UserRow }): string[] | null => {
    if (viewer.user.role === 'superadmin') return null
    return store.listUsers().filter((user) => user.id === viewer.user.id || user.role === 'user').map((user) => user.id)
  }

  const adminCanViewUser = (viewer: { user: UserRow; preview?: boolean }, user: UserRow): boolean => {
    if (viewer.preview === true) return false
    if (viewer.user.role === 'superadmin') return true
    return user.id === viewer.user.id || user.role === 'user'
  }

  // The admin page owns the Users section; `/admin/users` is a link/bookmark
  // from older empty states, not a page. Keep it admin-only and send it to the
  // section instead of the generic 404.
  app.get('/admin/users', async (request, reply) => {
    const viewer = requireAdmin(request)
    if (viewer.preview === true) return reply.redirect('/console')
    return reply.redirect('/admin#users')
  })

  app.get('/admin/users/:id', async (request, reply) => {
    const viewer = requireAdmin(request)
    if (viewer.preview === true) return reply.redirect('/console')
    const user = store.userById(String((request.params as Record<string, string>).id))
    if (user === undefined || !adminCanViewUser(viewer, user)) throw httpError(404, '用户不存在。', 'USER_NOT_FOUND')
    store.audit(viewer.user.id, 'admin.support_view', `user:${user.id}`)
    return reply.type('text/html').send(adminSupportPage({
      config,
      locale: request.locale ?? 'zh',
      viewer: viewOf(viewer),
      user,
      repos: store.listRepos(user.id),
      jobs: store.listJobsPageForUser(user.id, 20, 0),
      audit: store.listAuditPageForUsers([user.id], 20, 0),
      notice: request.flash?.notice?.text,
      error: request.flash?.error?.text,
    }))
  })

  app.get('/admin/trials', async (request, reply) => {
    const viewer = requireAdmin(request)
    if (viewer.preview === true) return reply.redirect('/console')
    const requested = queryText(request, 'trial') ?? ''
    return reply.type('text/html').send(adminTrialsPage({
      config,
      locale: request.locale ?? 'zh',
      viewer: viewOf(viewer),
      rows: store.trialCandidates(),
      // #690: the purge records, so a skipped or erased account is visible on the
      // page and not only in the sweep's output.
      purges: store.recentPurgeAudits(10),
      purgesGraceHours: config.trialPurgeGraceHours,
      filter: isTrialFilter(requested) ? requested : 'all',
      notice: request.flash?.notice?.text,
      error: request.flash?.error?.text,
    }))
  })

  app.get('/admin/jobs/:jobId', async (request, reply) => {
    const viewer = requireAdmin(request)
    if (viewer.preview === true) return reply.redirect('/console')
    const job = store.getJob(String((request.params as Record<string, string>).jobId))
    if (job === undefined) throw httpError(404, '任务不存在。', 'JOB_NOT_FOUND')
    const repo = store.getRepo(job.repo_id)
    const user = store.userById(job.user_id)
    if (repo === undefined || user === undefined || !adminCanViewUser(viewer, user)) throw httpError(404, '任务不存在。', 'JOB_NOT_FOUND')
    store.audit(viewer.user.id, 'admin.support_view', `job:${job.id}`)
    return reply.type('text/html').send(jobPage({
      config,
      locale: request.locale ?? 'zh',
      viewer: viewOf(viewer),
      repo,
      job,
      strategy: jobStrategyView(store, repo.id, job),
      events: store.listJobEvents(job.id, 200),
      postmortem: store.getPostmortemForJob(job.id) ?? null,
      supportMode: true,
      notice: request.flash?.notice?.text,
      error: request.flash?.error?.text,
    }))
  })

  app.get('/admin/search', async (request, reply) => {
    const viewer = requireAdmin(request)
    if (viewer.preview === true) return reply.redirect('/console')
    const userIds = adminVisibleUserIds(viewer)
    const q = (queryText(request, 'q') ?? '').slice(0, 200)
    const status = (queryText(request, 'status') ?? '').slice(0, 30)
    const kind = (queryText(request, 'kind') ?? '').slice(0, 30)
    const action = (queryText(request, 'action') ?? '').slice(0, 80)
    const from = (queryText(request, 'from') ?? '').slice(0, 20)
    const to = (queryText(request, 'to') ?? '').slice(0, 20)
    const view = queryText(request, 'view') === 'audit' ? 'audit' : 'jobs'
    const perPage = 20
    const page = (name: string, total: number): number => {
      const n = Number(queryText(request, name))
      return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), Math.max(1, Math.ceil(total / perPage))) : 1
    }
    const auditFilters = { q, action, from, to: to === '' ? '' : (to.length === 10 ? `${to}T23:59:59.999Z` : to) }
    const priority = (queryText(request, 'priority') ?? '').slice(0, 10)
    const jobFilters = { q, status, kind, priority }
    const auditTotal = store.countSearchAudit(userIds, auditFilters)
    const jobsTotal = store.countSearchJobs(userIds, jobFilters)
    const auditPage = page('auditPage', auditTotal)
    const jobsPage = page('jobsPage', jobsTotal)
    const usersById = new Map(store.listUsers().map((user) => [user.id, user.login]))
    return reply.type('text/html').send(adminSearchPage({
      config,
      locale: request.locale ?? 'zh',
      viewer: viewOf(viewer),
      jobs: store.searchJobs(userIds, jobFilters, perPage, (jobsPage - 1) * perPage),
      audit: store.searchAudit(userIds, auditFilters, perPage, (auditPage - 1) * perPage),
      usersById,
      filters: { q, status, kind, priority, action, from, to, view },
      jobsPage,
      jobsTotal,
      auditPage, auditTotal,
      perPage,
      lastJobsExport: lastExportOf(userIds, 'admin.jobs_export'),
      lastAuditExport: lastExportOf(userIds, 'admin.audit_export'),
      notice: request.flash?.notice?.text,
      error: request.flash?.error?.text,
    }))
  })

  const csvCell = (value: unknown): string => {
    const text = String(value ?? '')
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }

  // #416: a CSV that silently stopped at the row cap read as a complete document.
  // Both counts already exist (the search page uses them), so the export refuses
  // before reading rows and names the real count and the cap. The refusal keeps
  // its audit row, with the matched count instead of a row count.
  const EXPORT_ROW_CAP = 5000
  const refuseLargeExport = (request: FastifyRequest, reply: FastifyReply, viewer: ReturnType<typeof requireAdmin>, kind: 'audit' | 'jobs', matched: number): FastifyReply => {
    const locale = request.locale ?? 'zh'
    const t = translator(locale)
    store.audit(viewer.user.id, kind === 'audit' ? 'admin.audit_export' : 'admin.jobs_export', `refused=too_large matched=${matched} cap=${EXPORT_ROW_CAP}`)
    return htmlPage(reply, 400, errorPage(
      config,
      viewOf(viewer), 400,
      t('导出范围过大', 'Export too large'),
      t(
        `这个筛选匹配 ${matched} 行，而单次导出最多 ${EXPORT_ROW_CAP} 行；请缩小日期范围或加一个关键词，再导出一次。`,
        `This filter matches ${matched} rows, and one export is capped at ${EXPORT_ROW_CAP}; narrow the date range or add a keyword, then export again.`,
      ),
      locale,
      { href: '/admin/search', label: t('返回搜索', 'Back to search') },
    ))
  }

  // #459: the trail has to tie a file to its row and say how far the export
  // reached. Allow-listed filters are codes and ISO dates, so they are echoed
  // verbatim; `q` and `action` are free text (an admin may search by an address),
  // so they are recorded lossily as length plus a digest prefix and never
  // verbatim. No field may carry an address or a fragment of an exported row.
  const lossyFilter = (name: string, value: string): string => {
    const digest = createHash('sha256').update(value).digest('hex').slice(0, 8)
    return `${name}=${String(value.length)}ch#${digest}`
  }

  const exportScope = (userIds: string[] | null): string => userIds === null ? 'scope=all' : `scope=users:${String(userIds.length)}`

  const exportTrailDetail = (input: { filters: string[]; q: string; action?: string; rows: number; scope: string; sha256: string }): string => {
    const parts: string[] = []
    const echoed = input.filters.filter((value) => value !== '')
    if (echoed.length > 0) parts.push(`filters=${echoed.join(',')}`)
    if (input.q !== '') parts.push(lossyFilter('q', input.q))
    if (input.action !== undefined && input.action !== '') parts.push(lossyFilter('action', input.action))
    parts.push(`rows=${String(input.rows)}`, input.scope, `sha256=${input.sha256}`)
    return parts.join(' ')
  }

  // The cap test asserts whole bodies, so the read is paged but the document is
  // still assembled before sending: no single store call materialises the cap.
  const EXPORT_PAGE_ROWS = 500
  const assembleCsv = <T>(header: string, total: number, read: (limit: number, offset: number) => T[], line: (row: T) => string): { csv: string; rows: number } => {
    const parts: string[] = [header]
    let seen = 0
    while (seen < total) {
      const page = read(Math.min(EXPORT_PAGE_ROWS, total - seen), seen)
      if (page.length === 0) break
      for (const row of page) {
        parts.push(line(row))
        seen += 1
      }
    }
    return { csv: parts.join('\n'), rows: seen }
  }

  // The newest completed export for the viewer's scope. A refused export keeps
  // the pre-#459 `refused=too_large …` detail, so it is skipped: it has no file.
  const lastExportOf = (userIds: string[] | null, action: 'admin.audit_export' | 'admin.jobs_export'): { at: string; rows: number; scope: string; sha256: string } | null => {
    for (const row of store.searchAudit(userIds, { action }, 20, 0)) {
      const detail = row.detail ?? ''
      const rows = /(?:^|\s)rows=(\d+)(?:\s|$)/.exec(detail)
      const scope = /(?:^|\s)(scope=all|scope=users:\d+)(?:\s|$)/.exec(detail)
      const sha256 = /(?:^|\s)sha256=([0-9a-f]{64})(?:\s|$)/.exec(detail)
      if (rows !== null && scope !== null && sha256 !== null) return { at: row.at, rows: Number(rows[1]), scope: scope[1] ?? '', sha256: sha256[1] ?? '' }
    }
    return null
  }

  app.get('/admin/export/audit.csv', async (request, reply) => {
    const viewer = requireAdmin(request)
    if (viewer.preview === true) return reply.code(403).send({ error: 'preview' })
    const userIds = adminVisibleUserIds(viewer)
    const to = (queryText(request, 'to') ?? '').slice(0, 20)
    const filters = { q: (queryText(request, 'q') ?? '').slice(0, 200), action: (queryText(request, 'action') ?? '').slice(0, 80), from: (queryText(request, 'from') ?? '').slice(0, 20), to: to === '' ? '' : (to.length === 10 ? `${to}T23:59:59.999Z` : to) }
    const matched = store.countSearchAudit(userIds, filters)
    if (matched > EXPORT_ROW_CAP) return refuseLargeExport(request, reply, viewer, 'audit', matched)
    const built = assembleCsv(
      'at,user_id,action,detail',
      matched,
      (limit, offset) => store.searchAudit(userIds, filters, limit, offset),
      (row) => [row.at, row.user_id ?? '', row.action, row.detail ?? ''].map(csvCell).join(','),
    )
    store.audit(viewer.user.id, 'admin.audit_export', exportTrailDetail({
      filters: [filters.from === '' ? '' : `from=${filters.from}`, filters.to === '' ? '' : `to=${filters.to}`],
      q: filters.q,
      action: filters.action,
      rows: built.rows,
      scope: exportScope(userIds),
      sha256: createHash('sha256').update(built.csv).digest('hex'),
    }))
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="fledge-audit.csv"').send(built.csv)
  })

  app.get('/admin/export/jobs.csv', async (request, reply) => {
    const viewer = requireAdmin(request)
    if (viewer.preview === true) return reply.code(403).send({ error: 'preview' })
    const userIds = adminVisibleUserIds(viewer)
    const filters = { q: (queryText(request, 'q') ?? '').slice(0, 200), status: (queryText(request, 'status') ?? '').slice(0, 30), kind: (queryText(request, 'kind') ?? '').slice(0, 30), priority: (queryText(request, 'priority') ?? '').slice(0, 10) }
    const matched = store.countSearchJobs(userIds, filters)
    if (matched > EXPORT_ROW_CAP) return refuseLargeExport(request, reply, viewer, 'jobs', matched)
    const built = assembleCsv(
      'id,repo_id,user_id,status,kind,trigger,created_at,finished_at,pr_url,issue_url,cost_usd',
      matched,
      (limit, offset) => store.searchJobs(userIds, filters, limit, offset),
      (row) => [row.id, row.repo_id, row.user_id, row.status, row.kind, row.trigger, row.created_at, row.finished_at ?? '', row.pr_url ?? '', row.issue_url ?? '', row.cost_usd].map(csvCell).join(','),
    )
    store.audit(viewer.user.id, 'admin.jobs_export', exportTrailDetail({
      filters: [filters.status === '' ? '' : `status=${filters.status}`, filters.kind === '' ? '' : `kind=${filters.kind}`, filters.priority === '' ? '' : `priority=${filters.priority}`],
      q: filters.q,
      rows: built.rows,
      scope: exportScope(userIds),
      sha256: createHash('sha256').update(built.csv).digest('hex'),
    }))
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="fledge-jobs.csv"').send(built.csv)
  })

  app.get('/admin/webhooks', async (request, reply) => {
    const viewer = requireSuperAdmin(request)
    if (viewer.preview === true) return reply.redirect('/console')
    const status = (queryText(request, 'status') ?? '').slice(0, 20)
    const event = (queryText(request, 'event') ?? '').slice(0, 40)
    const perPage = 25
    const total = store.countWebhookDeliveries({ status, event })
    const pages = Math.max(1, Math.ceil(total / perPage))
    const page = Math.min(Math.max(1, Math.floor(Number(queryText(request, 'page')) || 1)), pages)
    return reply.type('text/html').send(adminWebhooksPage({
      config,
      locale: request.locale ?? 'zh',
      viewer: viewOf(viewer),
      deliveries: store.listWebhookDeliveries({ status, event }, perPage, (page - 1) * perPage),
      filters: { status, event },
      page,
      pages,
      total,
      notice: request.flash?.notice?.text,
      error: request.flash?.error?.text,
    }))
  })

  app.post('/admin/webhooks/:id/retry', async (request, reply) => {
    if (!apiLimiter.take(`admin-webhook-retry:${rateLimitKey(request)}`)) return reply.code(429).send({ error: 'too many requests' })
    const viewer = approvedCsrfGuard(request)
    if (viewer.user.role !== 'superadmin') throw httpError(403, '仅超级管理员可重试。', 'SUPERADMIN_ONLY')
    const id = String((request.params as Record<string, string>).id)
    const delivery = store.getWebhookDelivery(id)
    if (delivery === undefined) throw httpError(404, 'Webhook delivery 不存在。', 'WEBHOOK_NOT_FOUND')
    if (delivery.status !== 'failed') return reply.redirect('/admin/webhooks?error=' + encodeURIComponent('只有失败的 delivery 可以重试。'))
    let body: Record<string, unknown>
    try {
      body = JSON.parse(delivery.payload_json ?? '{}') as Record<string, unknown>
    } catch {
      return reply.redirect('/admin/webhooks?error=' + encodeURIComponent('这个 delivery 没有可重试的 payload。'))
    }
    store.claimWebhookDelivery(delivery.delivery_id, delivery.event, delivery.action)
    try {
      await processGithubWebhook(delivery.event, body, delivery.delivery_id)
      store.audit(viewer.user.id, 'admin.webhook_retry', `${delivery.delivery_id}: ${delivery.event}`)
      return reply.redirect('/admin/webhooks?notice=' + encodeURIComponent('Webhook 已重试。'))
    } catch (error) {
      return reply.redirect('/admin/webhooks?error=' + encodeURIComponent(`重试失败：${String(error).slice(0, 200)}`))
    }
  })

  // #544 slice 7: the notification outbox. Read-only apart from the one human
  // action the state machine has: an explicit resend, which reuses the row's
  // idempotency key and is audited. It is superadmin-only like the webhook page
  // because a resend can duplicate a delivery.
  app.get('/admin/notifications', async (request, reply) => {
    const viewer = requireSuperAdmin(request)
    if (viewer.preview === true) return reply.redirect('/console')
    const state = (queryText(request, 'state') ?? '').slice(0, 20)
    const transport = (queryText(request, 'transport') ?? '').slice(0, 20)
    const perPage = 25
    const total = store.countNotificationOutbox({ state, transport })
    const pages = Math.max(1, Math.ceil(total / perPage))
    const page = Math.min(Math.max(1, Math.floor(Number(queryText(request, 'page')) || 1)), pages)
    return reply.type('text/html').send(adminNotificationsPage({
      config,
      locale: request.locale ?? 'zh',
      viewer: viewOf(viewer),
      rows: store.listNotificationOutbox({ state, transport }, perPage, (page - 1) * perPage),
      counts: store.countNotificationsByState(),
      filters: { state, transport },
      page,
      pages,
      total,
      notice: request.flash?.notice?.text,
      error: request.flash?.error?.text,
    }))
  })

  app.post('/admin/notifications/:id/resend', async (request, reply) => {
    if (!apiLimiter.take(`admin-notification-resend:${rateLimitKey(request)}`)) return reply.code(429).send({ error: 'too many requests' })
    const viewer = approvedCsrfGuard(request)
    if (viewer.user.role !== 'superadmin') throw httpError(403, '仅超级管理员可重发。', 'SUPERADMIN_ONLY')
    const id = String((request.params as Record<string, string>).id)
    const row = store.getNotificationOutbox(id)
    if (row === undefined) throw httpError(404, '通知不存在。', 'NOTIFICATION_NOT_FOUND')
    const resent = store.resendNotification(id)
    if (!resent.requeued) {
      return reply.redirect('/admin/notifications?error=' + encodeURIComponent(row.state === 'sent' ? '已送达的通知不能重发。' : '这条通知正在发送，不能重发。'))
    }
    store.audit(viewer.user.id, 'notification.resend', `${id}: ${resent.row.transport}/${resent.row.state} attempts=${resent.row.attempts}`)
    return reply.redirect('/admin/notifications?notice=' + encodeURIComponent('通知已重新排队；重发使用同一幂等键，可能产生重复。'))
  })

  app.get('/admin', async (request, reply) => {
    const viewer = requireAdmin(request)
    if (viewer.preview === true) return reply.redirect('/console')
    const superadmin = viewer.user.role === 'superadmin'
    const allUsers = store.listUsers()
    const users = superadmin ? allUsers : allUsers.filter((user) => user.id === viewer.user.id || user.role === 'user')
    const userIds = superadmin ? null : users.map((user) => user.id)
    const activity = new Map(users.map((user) => [user.id, store.userActivity(user.id)]))
    const mailFailures = store.approvalMailFailures()
    const mailFailedUsers = new Set(users.filter((user) => approvalMailFailed(user, mailFailures)).map((user) => user.id))
    const perPage = 10
    const pageNumber = (name: string): number => {
      const n = Number(queryText(request, name))
      return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
    }
    const jobsTotal = store.countJobsForUsers(userIds)
    const auditTotal = store.countAuditForUsers(userIds)
    const jobsPages = Math.max(1, Math.ceil(jobsTotal / perPage))
    const auditPages = Math.max(1, Math.ceil(auditTotal / perPage))
    const jobsPage = Math.min(pageNumber('jobsPage'), jobsPages)
    const auditPage = Math.min(pageNumber('auditPage'), auditPages)
    let releaseDispatch: ReleaseDispatchPreview | null = null
    let releaseDispatchError = ''
    if (superadmin && config.release.dispatchToken !== '') {
      try {
        releaseDispatch = await previewRelease({
          fetch: globalThis.fetch,
          token: config.release.dispatchToken,
          repo: config.release.repo,
          workflow: config.release.workflow,
          ref: config.release.ref,
        })
      } catch (error) {
        releaseDispatchError = `GitHub preview failed: ${String(error instanceof Error ? error.message : error).slice(0, 200)}`
      }
    }
    return reply.type('text/html').send(
      adminPage({
        config,
        locale: request.locale ?? 'zh',
        viewer: viewOf(viewer),
        users,
        activity,
        mailFailedUsers,
        jobs: store.listJobsPageForUsers(userIds, perPage, (jobsPage - 1) * perPage),
        jobsPage,
        jobsTotal,
        audit: store.listAuditPageForUsers(userIds, perPage, (auditPage - 1) * perPage),
        auditPage,
        auditTotal,
        perPage,
        // #281: the effective window per class and what it would delete now, plus
        // the two tables that have no age window so the page never implies one.
        retention: [
          ...store.retentionCounts(config.retention.windows).map((row) => ({
            ...row,
            // #1008: the settings markers have no env window to configure, so
            // the row is never marked `default` — it is not a default, it is a
            // table with one window per family.
            configured: row.id === 'settingsMarkers' ? false : config.retention.configured[row.id],
          })),
          ...RETENTION_IDLE_TABLES.map((table) => ({ id: table.id, days: null, configured: false, count: null, state: table.state })),
        ],
        platformStop: jobs.platformStop(),
        superadmin,
        preview: false,
        showAudit: true,
        hideActor: !superadmin,
        notice: request.flash?.notice?.text,
        error: request.flash?.error?.text,
        // Read from the data directory; a missing or unreadable snapshot renders
        // as "not recorded" rather than failing the page.
        releaseStatus: readReleaseStatus(config.dataDir),
        releaseDispatch,
        releaseDispatchError,
      }),
    )
  })

  // #897: the superadmin one-click release action. It dispatches the existing
  // release workflow after a typed confirmation; it never tags, merges or
  // deploys. The POST re-reads the live preview so a stale form cannot dispatch
  // a release that is no longer eligible.
  app.post('/admin/release', { config: { rateLimit: destructiveClassLimit } }, async (request, reply) => {
    const t = translator(request.locale ?? 'zh')
    const viewer = requireSuperAdmin(request)
    if (viewer.preview === true) return reply.redirect('/console')
    if (!sessions.verifyCsrf(request, viewer)) throw httpError(403, '表单已过期，请刷新页面后重试。', 'CSRF_FAILED')
    if (requireRecentAuth(request, reply, viewer, 'admin.release')) return reply
    if (config.release.dispatchToken === '') {
      return reply.redirect('/admin?error=' + encodeURIComponent(t('一键发布未配置 RELEASE_DISPATCH_TOKEN。', 'One-click release is not configured: set RELEASE_DISPATCH_TOKEN.')))
    }
    let preview: ReleaseDispatchPreview
    try {
      preview = await previewRelease({
        fetch: globalThis.fetch,
        token: config.release.dispatchToken,
        repo: config.release.repo,
        workflow: config.release.workflow,
        ref: config.release.ref,
      })
    } catch (error) {
      store.audit(viewer.user.id, 'release.dispatch_failed', String(error instanceof Error ? error.message : error).slice(0, 300))
      return reply.redirect('/admin?error=' + encodeURIComponent(t(`读取发布状态失败：${String(error instanceof Error ? error.message : error).slice(0, 200)}`, `Could not read the release state: ${String(error instanceof Error ? error.message : error).slice(0, 200)}`)))
    }
    if (!preview.eligible) {
      return reply.redirect('/admin?error=' + encodeURIComponent(t(`一键发布不可用：${preview.reason}`, `One-click release is unavailable: ${preview.reason}`)))
    }
    const confirm = String((request.body as Record<string, unknown> | undefined)?.confirm ?? '').trim()
    if (confirm !== `RELEASE ${preview.nextVersion}`) {
      return reply.redirect('/admin?error=' + encodeURIComponent(t(`请准确输入 RELEASE ${preview.nextVersion} 以确认。`, `Type RELEASE ${preview.nextVersion} to confirm.`)))
    }
    store.audit(viewer.user.id, 'release.requested', `${preview.repo} v${preview.nextVersion} ${preview.mainSha}`)
    try {
      const { result } = await previewAndDispatch({
        fetch: globalThis.fetch,
        token: config.release.dispatchToken,
        repo: config.release.repo,
        workflow: config.release.workflow,
        ref: config.release.ref,
      })
      store.audit(viewer.user.id, 'release.dispatched', `${preview.repo} v${preview.nextVersion} ${result.runUrl}`)
      return reply.redirect('/admin?notice=' + encodeURIComponent(t(`已启动 v${preview.nextVersion} 发布流程：${result.runUrl}`, `Started the v${preview.nextVersion} release: ${result.runUrl}`)) + '#release')
    } catch (error) {
      store.audit(viewer.user.id, 'release.dispatch_failed', String(error instanceof Error ? error.message : error).slice(0, 300))
      return reply.redirect('/admin?error=' + encodeURIComponent(t(`发布启动失败：${String(error instanceof Error ? error.message : error).slice(0, 200)}`, `Could not start the release: ${String(error instanceof Error ? error.message : error).slice(0, 200)}`)) + '#release')
    }
  })

  // #395: the deployment read model. The latest release comes from the
  // `verify-release.mjs` snapshot this instance already reads on /admin, and the
  // running side is the recorded deployment row. Fledge never probes a host or
  // runs a deploy here; an operator records what happened and this page judges
  // the recorded facts.
  const deploymentReadModel = (): {
    release: ReturnType<typeof latestReleaseFromStatus>
    environments: Array<{ environment: string; latest: DeploymentRow | null; current: EnvironmentCurrent; drift: DriftAssessment }>
    deployments: DeploymentRow[]
    rollbacks: ReturnType<Store['listDeploymentRollbacks']>
  } => {
    const release = latestReleaseFromStatus(readReleaseStatus(config.dataDir))
    const deployments = store.listDeployments(null, 200)
    // #395 review round 2: the environment row is the newest deployment *or* a
    // rollback recorded after it, whichever actually says what production runs.
    const environments = store.listDeploymentEnvironments().map((environment) => {
      const latest = store.latestDeployment(environment) ?? null
      const rollback = store.listDeploymentRollbacks(environment, 1)[0] ?? null
      const state = environmentState(latest, rollback, release)
      return { environment, latest, current: state.current, drift: state.drift }
    })
    return { release, environments, deployments, rollbacks: store.listDeploymentRollbacks(null, 100) }
  }

  app.get('/admin/deployments', async (request, reply) => {
    const viewer = requireAdmin(request)
    if (viewer.preview === true) return reply.redirect('/console')
    const model = deploymentReadModel()
    return reply.type('text/html').send(adminDeploymentsPage({
      config,
      locale: request.locale ?? 'zh',
      viewer: viewOf(viewer),
      release: model.release,
      environments: model.environments,
      deployments: model.deployments,
      rollbacks: model.rollbacks,
      notice: request.flash?.notice?.text,
      error: request.flash?.error?.text,
    }))
  })

  app.get('/api/admin/deployments', async (request, reply) => {
    const viewer = requireAdmin(request)
    if (viewer.preview === true) throw httpError(403, '预览模式不可读取部署记录。', 'PREVIEW_READ_ONLY')
    const model = deploymentReadModel()
    return reply.send({
      release: model.release,
      environments: model.environments.map((entry) => ({
        environment: entry.environment,
        current: entry.current,
        drift: { state: entry.drift.state, alert: entry.drift.alert, summary: entry.drift.summary },
        latest: entry.latest === null ? null : {
          ...deploymentFromRow(entry.latest),
          healthz: deploymentHealth(entry.latest),
          readyz: deploymentReadiness(entry.latest),
        },
      })),
      deployments: model.deployments.map((row) => ({
        ...deploymentFromRow(row),
        healthz: deploymentHealth(row),
        readyz: deploymentReadiness(row),
      })),
      rollbacks: model.rollbacks.map((row) => ({
        id: row.id,
        environment: row.environment,
        previousDigest: row.previous_digest,
        previousCommit: row.previous_commit,
        owner: row.owner,
        command: redactCommand(row.command),
        decision: row.decision,
        verified: row.verified === 1,
        createdAt: row.created_at,
      })),
    })
  })

  app.post('/admin/deployments/promote', async (request, reply) => {
    if (!limits.take('login', `deployment-promote:${rateLimitKey(request)}`)) return htmlPage(reply, 429, errorPage(config, request.viewer ?? null, 429, '请求过多', '请稍后再试。', request.locale))
    const viewer = approvedCsrfGuard(request)
    if (!isAdminRole(viewer.user.role)) throw httpError(403, '仅管理员可以记录部署。', 'ADMIN_ONLY')
    const parsed = parsePromotionForm(form(request), viewer.user.login)
    if (!parsed.ok) return reply.redirect(`/admin/deployments?error=${encodeURIComponent(parsed.error)}`)
    const input = parsed.value
    if (!input.gateResult.ok) {
      store.audit(viewer.user.id, 'deployment.promotion_blocked', `${input.environment} v${input.version}: ${input.gateResult.blocked.join('; ')}`)
      return reply.redirect(`/admin/deployments?error=${encodeURIComponent(`Canary gate blocked the promotion: ${input.gateResult.blocked.join('; ')}`)}`)
    }
    const row = store.recordDeployment({
      environment: input.environment,
      version: input.version,
      commit: input.commit,
      imageDigest: input.imageDigest,
      deployedAt: input.deployedAt,
      operator: input.operator,
      healthz: input.healthz,
      readyz: input.readyz,
      releaseUrl: input.releaseUrl === '' ? null : input.releaseUrl,
      gate: input.gateResult,
    })
    store.audit(viewer.user.id, 'deployment.promoted', `${row.environment} v${row.version} ${row.commit_sha} ${row.image_digest}`)
    return reply.redirect(`/admin/deployments?notice=${encodeURIComponent(`Recorded ${row.environment} v${row.version} at ${row.commit_sha} after the canary gate passed.`)}`)
  })

  app.post('/admin/deployments/rollback', async (request, reply) => {
    if (!limits.take('login', `deployment-rollback:${rateLimitKey(request)}`)) return htmlPage(reply, 429, errorPage(config, request.viewer ?? null, 429, '请求过多', '请稍后再试。', request.locale))
    const viewer = approvedCsrfGuard(request)
    if (!isAdminRole(viewer.user.role)) throw httpError(403, '仅管理员可以记录回滚。', 'ADMIN_ONLY')
    const parsed = parseRollbackForm(form(request), store.listDeployments(null, 500), viewer.user.login)
    if (!parsed.ok) return reply.redirect(`/admin/deployments?error=${encodeURIComponent(parsed.error)}`)
    const input = parsed.value
    const row = store.recordDeploymentRollback({
      environment: input.environment,
      fromDeploymentId: input.fromDeploymentId,
      previousDeploymentId: input.previousDeploymentId,
      previousDigest: input.previousDigest,
      previousCommit: input.previousCommit,
      owner: input.owner,
      command: input.command,
      decision: input.decision,
      healthz: input.healthz,
      verified: input.verified,
    })
    store.audit(viewer.user.id, 'deployment.rollback_recorded', `${row.environment} to ${row.previous_digest} verified=${row.verified}`)
    const verification = row.verified === 1 ? 'the resulting /healthz matches the previous commit' : 'the resulting /healthz does not yet match the previous commit'
    return reply.redirect(`/admin/deployments?notice=${encodeURIComponent(`Recorded the ${row.decision} decision to ${row.previous_digest}; ${verification}.`)}`)
  })

  // #283: the platform emergency stop. `isAdminRole` on purpose, not
  // `requireAdmin`, and no `preview` rejection: the preview cookie is how the
  // admin panel degrades to read-only, and the one action that must still work in
  // that state is stopping everything. The recency gate still applies in preview,
  // because a read-only panel is exactly where a stale cookie must not act. The
  // stop is a persisted `settings` row, so it survives a restart, and this route
  // reports what the drain did rather than a bare "stopped".
  app.post('/admin/platform/stop', async (request, reply) => {
    // Same limiter and window as the other mutating form (`/approve/:token`), and
    // an HTML page rather than the JSON 429 the API routes send: this is a form
    // post from a browser, and a raw JSON body would replace the page.
    if (!limits.take('login', `platform-stop:${rateLimitKey(request)}`)) return htmlPage(reply, 429, errorPage(config, request.viewer ?? null, 429, '请求过多', '请稍后再试。', request.locale))
    const viewer = approvedCsrfGuard(request)
    if (!isAdminRole(viewer.user.role)) throw httpError(403, '仅管理员可以停止平台。', 'ADMIN_ONLY')
    // #525: a stop drains the fleet and cancels work that a resume cannot bring
    // back, so the admin session alone is not enough evidence of the person.
    if (requireRecentAuth(request, reply, viewer, 'flybot.platform.stop')) return reply
    const t = translator(request.locale ?? 'zh')
    const reason = (form(request).reason ?? '').trim().slice(0, 200)
    const result = await jobs.stopPlatform({ id: viewer.user.id, login: viewer.user.login }, reason)
    if (result.already) {
      const since = result.stop.at === '' ? '' : t(`，自 ${result.stop.at}`, `, since ${result.stop.at}`)
      return reply.redirect(`/admin?notice=${encodeURIComponent(t(`平台已经处于停止状态${since}；未改动。`, `The platform is already stopped${since}; nothing changed.`))}`)
    }
    const drained = t(`暂停 ${result.paused} 个任务，取消 ${result.cancelled} 个任务`, `${result.paused} job(s) paused and ${result.cancelled} cancelled`)
    const left = result.left === 0 ? '' : t(`；另有 ${result.left} 个任务超过单次上限，由下一次调度完成`, `; ${result.left} more job(s) past the single-stop bound are drained by the next tick`)
    return reply.redirect(`/admin?notice=${encodeURIComponent(t(`平台已停止：${drained}${left}。仓库没有被停用，数据没有被删除。`, `The platform is stopped: ${drained}${left}. No repository was disabled and no data was deleted.`))}`)
  })

  app.post('/admin/platform/resume', async (request, reply) => {
    if (!limits.take('login', `platform-resume:${rateLimitKey(request)}`)) return htmlPage(reply, 429, errorPage(config, request.viewer ?? null, 429, '请求过多', '请稍后再试。', request.locale))
    const viewer = approvedCsrfGuard(request)
    if (!isAdminRole(viewer.user.role)) throw httpError(403, '仅管理员可以恢复平台。', 'ADMIN_ONLY')
    const t = translator(request.locale ?? 'zh')
    const result = await jobs.resumePlatform({ id: viewer.user.id, login: viewer.user.login })
    // The operator sees what the next tick will consider before it happens; the
    // list is capped so a large platform still renders a readable banner.
    const due = result.due.length === 0
      ? t('下一次调度没有到期仓库。', 'No repository is due on the next tick.')
      : t(
          `下一次调度将考虑 ${result.due.slice(0, 10).join('、')}${result.due.length > 10 ? ` 等 ${result.due.length} 个仓库` : ''}。`,
          `The next tick will consider ${result.due.slice(0, 10).join(', ')}${result.due.length > 10 ? ` and ${result.due.length} repositories in total` : ''}.`,
        )
    const head = result.already
      ? t('平台本来没有停止；未改动。', 'The platform was not stopped; nothing changed.')
      : t('平台已恢复。', 'The platform is resumed.')
    return reply.redirect(`/admin?notice=${encodeURIComponent(`${head}${due}`)}`)
  })

  const adminStatus = async (request: FastifyRequest, reply: FastifyReply, status: 'approved' | 'rejected'): Promise<'blocked' | UserRow> => {
    const viewer = approvedCsrfGuard(request)
    if (!isAdminRole(viewer.user.role)) throw httpError(403, '仅管理员可访问。', 'ADMIN_ONLY')
    const id = String((request.params as Record<string, string>).id)
    const user = store.userById(id)
    if (user === undefined) throw httpError(404, '用户不存在。', 'USER_NOT_FOUND')
    if (user.id === viewer.user.id || user.role === 'superadmin') throw httpError(403, '不能修改这个账号。', 'ROLE_PROTECTED')
    if (viewer.user.role !== 'superadmin' && user.role !== 'user') throw httpError(404, '用户不存在。', 'USER_NOT_FOUND')
    if (requireRecentAuth(request, reply, viewer, `admin.user.${status}`)) return 'blocked'
    store.setUserStatus(user.id, status, `admin:${viewer.user.login}`)
    if (status === 'approved') instances.ensureUserDir(user.id)
    if (status === 'rejected') {
      await jobs.cancelUserJobs(user.id, '账号已被管理员停用')
      for (const instance of store.listRepoInstances().filter((entry) => entry.user_id === user.id)) {
        await instances.stop(instance.repo_id)
      }
    }
    store.audit(user.id, `admin.${status}`, `by @${viewer.user.login}`)
    try {
      const to = notifyEmail(user)
      if (to !== '') await mailer.send({ to, ...(status === 'approved' ? approvedEmail(user, config.baseUrl) : rejectedEmail(user, '')) })
    } catch (error) {
      log.warn('admin status mail failed', { user: user.login, error: String(error) })
    }
    return user
  }

  app.post('/admin/users/:id/resend-approval', async (request, reply) => {
    const viewer = approvedCsrfGuard(request)
    if (!isAdminRole(viewer.user.role)) throw httpError(403, '仅管理员可访问。', 'ADMIN_ONLY')
    const id = String((request.params as Record<string, string>).id)
    const user = store.userById(id)
    if (user === undefined || user.status !== 'pending') throw httpError(404, '用户不存在。', 'USER_NOT_FOUND')
    try {
      const result = await approvals.request(user)
      if (!result.sent) return reply.redirect(`/admin?error=${encodeURIComponent('这封邮件刚刚发送过，24 小时内不重复发送。')}`)
      return reply.redirect(`/admin?notice=${encodeURIComponent('审批邮件已重新发送。')}`)
    } catch {
      return reply.redirect(`/admin?error=${encodeURIComponent('审批邮件仍然发送失败，请检查 SMTP 配置。')}`)
    }
  })

  app.post('/admin/users/:id/approve', { config: { rateLimit: destructiveLimit } }, async (request, reply) => {
    if ((await adminStatus(request, reply, 'approved')) === 'blocked') return reply
    return reply.redirect(`/admin?notice=${encodeURIComponent('已批准。')}`)
  })

  app.post('/admin/users/:id/reject', { config: { rateLimit: destructiveLimit } }, async (request, reply) => {
    if ((await adminStatus(request, reply, 'rejected')) === 'blocked') return reply
    return reply.redirect(`/admin?notice=${encodeURIComponent('已拒绝。')}`)
  })

  app.post('/admin/users/:id/quota', { config: { rateLimit: destructiveLimit } }, async (request, reply) => {
    const viewer = approvedCsrfGuard(request)
    if (!isAdminRole(viewer.user.role)) throw httpError(403, '仅管理员可访问。', 'ADMIN_ONLY')
    if (requireRecentAuth(request, reply, viewer, 'admin.quota')) return reply
    const id = String((request.params as Record<string, string>).id)
    const user = store.userById(id)
    if (user === undefined) throw httpError(404, '用户不存在。', 'USER_NOT_FOUND')
    const superadmin = viewer.user.role === 'superadmin'
    if (!superadmin && user.id !== viewer.user.id && user.role !== 'user') throw httpError(404, '用户不存在。', 'USER_NOT_FOUND')
    if (user.role === 'superadmin' && !superadmin) throw httpError(404, '用户不存在。', 'USER_NOT_FOUND')
    const body = form(request)
    const unlimited = body.unlimited === '1'
    if (unlimited && !superadmin) return reply.redirect(`/admin?error=${encodeURIComponent('只有超级管理员可以设置不限额。')}`)
    const quota = Number(body.quota)
    if (!unlimited && (!Number.isFinite(quota) || quota < 0 || quota > 10_000)) throw httpError(400, '额度必须是 0–10000 之间的数字。', 'BAD_QUOTA')
    if (!unlimited) store.setUserQuota(id, quota)
    store.setUserQuotaUnlimited(id, unlimited)
    store.audit(id, 'admin.quota', `${unlimited ? 'unlimited' : `${quota} CNY`} by @${viewer.user.login}`)
    return reply.redirect(`/admin?notice=${encodeURIComponent(unlimited ? '额度已设为不限额。' : '额度已更新。')}`)
  })

  app.post('/admin/users/:id/private-models', async (request, reply) => {
    const viewer = approvedCsrfGuard(request)
    if (viewer.user.role !== 'superadmin') throw httpError(403, '仅超级管理员可访问。', 'SUPERADMIN_ONLY')
    const id = String((request.params as Record<string, string>).id)
    const user = store.userById(id)
    if (user === undefined || user.role === 'superadmin') throw httpError(403, '不能修改这个账号。', 'ROLE_PROTECTED')
    const allow = form(request).allow === '1'
    store.setUserAllowPrivateModels(id, allow)
    store.audit(id, 'admin.private_models', `allow=${allow} by @${viewer.user.login}`)
    return reply.redirect(`/admin?notice=${encodeURIComponent(allow ? '已允许这个用户配置 HTTP/内网模型。' : '已禁止这个用户配置 HTTP/内网模型。')}`)
  })

  app.post('/admin/users/:id/role', async (request, reply) => {
    // #708: the only route that grants `admin`, paced before the session is read.
    if (!limits.take('destructive', `admin-role:${rateLimitKey(request)}`)) return refuseTooMany(request, reply)
    const viewer = approvedCsrfGuard(request)
    if (viewer.user.role !== 'superadmin') throw httpError(403, '仅超级管理员可访问。', 'SUPERADMIN_ONLY')
    const id = String((request.params as Record<string, string>).id)
    const user = store.userById(id)
    if (user === undefined || user.id === viewer.user.id || user.role === 'superadmin') throw httpError(403, '不能修改这个账号。', 'ROLE_PROTECTED')
    const role = form(request).role
    if (role !== 'admin' && role !== 'user') throw httpError(400, '角色无效。', 'BAD_ROLE')
    // #525: a promotion is privilege escalation, so a superadmin cookie on its
    // own must not be enough. The 403 and 400 above still answer first.
    if (requireRecentAuth(request, reply, viewer, 'admin.user.role')) return reply
    store.setUserRole(id, role)
    store.audit(id, 'admin.role', `role=${user.role}->${role} by @${viewer.user.login}`)
    return reply.redirect(`/admin?notice=${encodeURIComponent(role === 'admin' ? '已设为管理员。' : '已设为用户。')}`)
  })

  // #691: account deletion. The preview is read-only; the confirm is the
  // largest destructive action on the platform. It removes repositories, jobs,
  // instances and credentials, then reuses #690's `purgeUserRows` transaction
  // with its eligibility check bypassed on purpose — the superadmin asserts the
  // account is dead. Every step is idempotent, so a failed run is retried by
  // submitting the same confirm again, and the audit row is the state.
  const accountDeleteBlocked = (viewer: Viewer, user: UserRow): 'self' | 'last_superadmin' | null => {
    // A superadmin is always a viewer's peer here, so the last-superadmin guard
    // is defence in depth: it matters if a future caller deletes by id without
    // a superadmin session in front of it.
    if (user.id === viewer.user.id) return 'self'
    if (user.role !== 'superadmin') return null
    return store.listUsers().filter((row) => row.role === 'superadmin' && row.id !== user.id).length === 0 ? 'last_superadmin' : null
  }

  app.get('/admin/users/:id/delete', async (request, reply) => {
    const viewer = requireSuperAdmin(request)
    if (viewer.preview === true) return reply.redirect('/console')
    const user = store.userById(String((request.params as Record<string, string>).id))
    if (user === undefined) throw httpError(404, '用户不存在。', 'USER_NOT_FOUND')
    return reply.type('text/html').send(adminDeleteUserPage({
      config,
      locale: request.locale ?? 'zh',
      viewer: viewOf(viewer),
      user,
      counts: {
        repos: store.listRepos(user.id).length,
        jobs: store.countJobsForUser(user.id),
        running: store.countJobsForUser(user.id, { status: 'running' }),
        queued: store.countJobsForUser(user.id, { status: 'queued' }),
        instances: store.listRepoInstances().filter((row) => row.user_id === user.id).length,
        tokens: store.listApiTokens(user.id).length,
        installations: store.listInstallations(user.id).length,
        // #846: both rows survive the account on a `SET NULL` key, so the preview
        // counts them the same way the purge does.
        errorReports: store.countErrorReportsForUser(user.id),
        feedbackTriage: store.countFeedbackTriageForUser(user.id),
      },
      blocked: accountDeleteBlocked(viewer, user),
      notice: request.flash?.notice?.text,
      error: request.flash?.error?.text,
    }))
  })

  app.post('/admin/users/:id/delete', { config: { rateLimit: destructiveLimit } }, async (request, reply) => {
    const viewer = approvedCsrfGuard(request)
    if (viewer.user.role !== 'superadmin') throw httpError(403, '仅超级管理员可访问。', 'SUPERADMIN_ONLY')
    if (viewer.preview === true) throw httpError(403, '预览模式不可删除账号。', 'PREVIEW_READ_ONLY')
    if (requireRecentAuth(request, reply, viewer, 'admin.user.delete')) return reply
    const t = translator(request.locale ?? 'zh')
    const id = String((request.params as Record<string, string>).id)
    const user = store.userById(id)
    if (user === undefined) throw httpError(404, '用户不存在。', 'USER_NOT_FOUND')
    const back = `/admin/users/${user.id}/delete`
    const blocked = accountDeleteBlocked(viewer, user)
    if (blocked === 'self') throw httpError(403, '不能删除自己的账号。', 'SELF_DELETE')
    if (blocked === 'last_superadmin') throw httpError(403, '不能删除最后一个超级管理员。', 'LAST_SUPERADMIN')
    const confirmLogin = (form(request).confirmLogin ?? '').trim()
    if (confirmLogin !== user.login) {
      return reply.redirect(`${back}?error=${encodeURIComponent(t('请输入完整的 GitHub 登录名确认删除。', 'Type the exact GitHub login to confirm the deletion.'))}`)
    }
    // Teardown order is deliberate: stop work, stop the external instances,
    // revoke credentials, then erase the rows. A failed step is named in one
    // audit row without the login, address, token or path, and the account stays
    // visible so the same confirm can be retried.
    let step = 'cancel_jobs'
    try {
      await jobs.cancelUserJobs(user.id, '账号已被超级管理员删除')
      step = 'stop_instances'
      for (const instance of store.listRepoInstances().filter((row) => row.user_id === user.id)) {
        await instances.remove(instance.repo_id)
      }
      step = 'revoke_tokens'
      for (const token of store.listApiTokens(user.id)) store.revokeApiToken(token.id, user.id)
      step = 'purge_rows'
      store.purgeUserRows(user.id, { reason: 'admin.deleted', operator: 'superadmin', action: 'admin.user.deleted' })
    } catch {
      store.audit(user.id, 'admin.user.delete_failed', JSON.stringify({ step }))
      return reply.redirect(`${back}?error=${encodeURIComponent(t(`删除在「${step}」步骤失败，账号仍在，请重试。`, `Deletion failed at the "${step}" step; the account is still here, submit the same confirmation to retry.`))}`)
    }
    return reply.redirect(`/admin?notice=${encodeURIComponent(t('账号已删除，并写入一条不含身份信息的删除记录。', 'The account is deleted, with one non-identity deletion record.'))}`)
  })

  app.post('/admin/simulation', async (request, reply) => {
    const viewer = approvedCsrfGuard(request)
    if (viewer.user.role !== 'superadmin') throw httpError(403, '仅超级管理员可访问。', 'SUPERADMIN_ONLY')
    const body = form(request)
    sessions.setPreview(reply, body.enable === '1')
    const returnTo = safeLocalPath(body.returnTo, '/admin')
    return reply.redirect(returnTo)
  })

  app.get('/approve/:token', async (request, reply) => {
    const token = String((request.params as Record<string, string>).token)
    const resolved = approvals.resolve(token)
    if (resolved === undefined) return htmlPage(reply, 404, errorPage(config, request.viewer ?? null, 404, '链接无效', '这个审批链接无效或已经过期。', request.locale))
    if (resolved.user.status !== 'pending') return reply.type('text/html').send(messagePage(config, '已经处理过', '这个申请已经处理过了。', request.viewer === undefined ? null : viewOf(request.viewer), request.locale))
    return reply.type('text/html').send(approvalPage({ config, locale: request.locale ?? 'zh', user: resolved.user, action: resolved.row.action, token }))
  })

  app.post('/approve/:token', async (request, reply) => {
    if (!limits.take('login', `approve:${rateLimitKey(request)}`)) return htmlPage(reply, 429, errorPage(config, request.viewer ?? null, 429, '请求过多', '请稍后再试。', request.locale))
    const token = String((request.params as Record<string, string>).token)
    const result = await approvals.apply(token, 'email-link')
    if (!result.ok) return htmlPage(reply, 400, messagePage(config, '无法处理', result.reason, request.viewer === undefined ? null : viewOf(request.viewer), request.locale))
    return reply.type('text/html').send(messagePage(config, result.user.status === 'approved' ? '已批准' : '已拒绝', `@${result.user.login} 的申请已${result.user.status === 'approved' ? '批准' : '拒绝'}。`, request.viewer === undefined ? null : viewOf(request.viewer), request.locale))
  })

  app.get('/api/jobs/:id/context', async (request, reply) => {
    const jobId = String((request.params as Record<string, string>).id)
    if (!apiLimiter.take(`job-context:${jobId}:${rateLimitKey(request)}`)) return reply.code(429).send({ error: 'too many requests' })
    const job = store.getJob(jobId)
    if (job === undefined) return reply.code(404).send({ error: 'job not found' })
    const secret = bearerSecret(request)
    if (secret === '' || !safeEqual(sha256Hex(secret), job.callback_hash)) return reply.code(401).send({ error: 'bad context secret' })
    if (job.status !== 'queued' && job.status !== 'running') return reply.code(409).send({ error: 'job already finished' })
    const context = store.getJobContext(job.id)
    if (context === undefined) return reply.code(404).send({ error: 'no context for this job' })
    const path = queryText(request, 'path')
    if (path === undefined) {
      let files: unknown = []
      try {
        files = JSON.parse(context.manifest_json) as unknown
      } catch {}
      return reply.send({ commit: context.commit_sha, files })
    }
    if (path.length > 300 || path.includes('\0')) return reply.code(400).send({ error: 'invalid context path' })
    const file = store.getJobContextFile(job.id, path)
    if (file === undefined) return reply.code(404).send({ error: 'context file not found' })
    // docs/rules.md promises that every context read is audited. The path is
    // recorded whole and the content never enters the event.
    store.recordJobEvent({ jobId: job.id, repoId: job.repo_id, userId: job.user_id, kind: 'job.context_read', step: 'context', meta: path })
    return reply
      .header('cache-control', 'no-store')
      .header('x-content-sha256', file.sha256)
      .type('text/plain; charset=utf-8')
      .send(file.content)
  })

  app.get('/api/jobs/:id/credential', async (request, reply) => {
    if (!apiLimiter.take(`credential:${rateLimitKey(request)}`)) return reply.code(429).send({ error: 'too many requests' })
    const secret = bearerSecret(request)
    const result = await jobs.credential(String((request.params as Record<string, string>).id), secret)
    if (!result.ok) return reply.code(result.status ?? 400).send({ error: result.error ?? 'unauthorized' })
    return {
      token: result.token,
      owner: result.owner,
      name: result.name,
      defaultBranch: result.defaultBranch,
      upstream: result.upstream,
      fork: result.fork,
      isFork: result.isFork,
      permission: result.permission,
      repoRole: result.repoRole,
      autoMerge: result.autoMerge,
      canReview: result.canReview,
      canCreateIssue: result.canCreateIssue,
    }
  })

  // #638 slice 1: the agent's own writer. It is the callback credential — the
  // same secret the job uses for its context and its report — so only the running
  // job can propose, it can propose at most three notes per run, and it can never
  // replace an entry a person already wrote. A duplicate key is refused, not
  // overwritten: the console shows the proposal and a human decides.
  app.post('/api/jobs/:id/memory', async (request, reply) => {
    const jobId = String((request.params as Record<string, string>).id)
    if (!apiLimiter.take(`job-memory:${jobId}:${rateLimitKey(request)}`)) return reply.code(429).send({ error: { type: 'rate_limited', message: 'too many requests' } })
    const job = store.getJob(jobId)
    if (job === undefined) return reply.code(404).send({ error: { type: 'job_not_found', message: 'job not found' } })
    const secret = bearerSecret(request)
    if (secret === '' || !safeEqual(sha256Hex(secret), job.callback_hash)) return reply.code(401).send({ error: { type: 'bad_callback_secret', message: 'bad job secret' } })
    if (job.status !== 'queued' && job.status !== 'running') return reply.code(409).send({ error: { type: 'job_finished', message: 'job already finished' } })
    const parsed = parseAgentNoteInput((request.body ?? {}) as Record<string, unknown>)
    if (!parsed.ok) return reply.code(400).send({ error: { type: parsed.refused, message: `the note was refused: ${parsed.refused}` } })
    const note = parsed.value
    if (store.countAgentNotesForJob(job.id) >= AGENT_NOTE_LIMIT) {
      return reply.code(429).send({ error: { type: 'agent_note_limit', message: `a run may propose at most ${AGENT_NOTE_LIMIT} notes` } })
    }
    const existing = store.getMemory(job.repo_id, note.key)
    if (existing !== undefined) {
      return reply.code(409).send({ error: { type: 'memory_exists', message: `the key ${note.key} already exists at revision ${existing.revision}; a proposal never overwrites an entry` } })
    }
    const written = store.writeMemory({
      repoId: job.repo_id,
      key: note.key,
      kind: note.kind,
      status: 'needs_review',
      verification: 'unverified',
      audience: 'project',
      scope: '',
      body: note.body,
      digest: memoryDigest(note.body),
      sourcesJson: note.sourcesJson,
      actorType: 'agent',
      actorId: job.id,
      sourceJobId: job.id,
      reason: `proposed by job ${job.id}`,
      expectedRevision: 0,
    })
    if (!written.ok) return reply.code(409).send({ error: { type: 'memory_exists', message: written.code } })
    store.recordJobEvent({ jobId: job.id, repoId: job.repo_id, userId: job.user_id, kind: 'job.memory_proposed', step: 'memory', meta: note.key })
    store.audit(job.user_id, 'memory.proposed_by_agent', `${job.repo_id}: ${note.key} job=${job.id}`)
    return reply.send({ ok: true, key: note.key, revision: written.row.revision, id: written.row.id })
  })

  app.post('/api/jobs/:id/callback', async (request, reply) => {
    if (!apiLimiter.take(`callback:${rateLimitKey(request)}`)) return reply.code(429).send({ error: 'too many requests' })
    const secret = bearerSecret(request)
    const body = (request.body ?? {}) as Record<string, unknown>
    const result = await jobs.handleCallback(String((request.params as Record<string, string>).id), secret, body)
    if (!result.ok) return reply.code(result.status ?? 400).send({ error: result.error ?? 'callback rejected' })
    return result.duplicate === true ? { ok: true, duplicate: true } : { ok: true }
  })


  // #542 slice 1: a red default branch used to be invisible, because the
  // follow-up path needs a Fledge job on that exact PR. Intake records the
  // failure and the decision about it — `queued` for a failure on the default
  // branch, `ignored` with its reason for one this path will not triage — and
  // stops there: no log read, no model call, no rerun, no issue. A green or
  // cancelled run is not a failed run, so it stores nothing.
  const handleWorkflowRun = async (event: string, body: Record<string, unknown>): Promise<void> => {
    if (event !== 'workflow_run' || body.action !== 'completed') return
    const installation = typeof body.installation === 'object' && body.installation !== null ? (body.installation as Record<string, unknown>) : {}
    const installationId = Number(installation.id)
    const repository = typeof body.repository === 'object' && body.repository !== null ? (body.repository as Record<string, unknown>) : {}
    const fullName = typeof repository.full_name === 'string' ? repository.full_name : ''
    if (!Number.isFinite(installationId) || fullName === '') return
    const repo = store.findRepoByInstallationAndFullName(installationId, fullName)
    if (repo === undefined) return
    const run = typeof body.workflow_run === 'object' && body.workflow_run !== null ? (body.workflow_run as Record<string, unknown>) : {}
    if (String(run.conclusion ?? '') !== 'failure') return
    const runId = Number(run.id)
    const attempt = Number(run.run_attempt ?? 1)
    if (!Number.isInteger(runId) || runId <= 0 || !Number.isInteger(attempt) || attempt <= 0) return
    const runUrl = typeof run.html_url === 'string' ? run.html_url : ''
    const workflowName = typeof run.name === 'string' && run.name !== '' ? run.name : ''
    // GitHub always sends https here; refusing anything else keeps the console's
    // link from becoming a scheme the payload chose.
    if (!runUrl.startsWith('https://') || workflowName === '') return
    const headBranch = typeof run.head_branch === 'string' ? run.head_branch : ''
    const headSha = typeof run.head_sha === 'string' ? run.head_sha : ''
    const runEvent = typeof run.event === 'string' ? run.event : ''
    // A fork can carry a different default branch name on each side, so any of
    // the three names counts; a tag run reports the tag as `head_branch` and is
    // therefore not a default-branch run until a later slice proves ancestry.
    const defaultBranches = new Set(
      [repo.default_branch, repo.upstream_default_branch, repo.fork_default_branch]
        .filter((branch) => typeof branch === 'string' && branch !== '')
        .map((branch) => branch.toLowerCase()),
    )
    const pullRequestRun = (Array.isArray(run.pull_requests) && run.pull_requests.length > 0) || runEvent === 'pull_request' || runEvent === 'pull_request_target'
    const onDefaultBranch = headBranch !== '' && defaultBranches.has(headBranch.toLowerCase())
    const reason = pullRequestRun ? 'pull_request' : !onDefaultBranch ? 'not_default_branch' : null
    const status: WorkflowFailureStatus = reason === null ? 'queued' : 'ignored'
    const stored = store.recordWorkflowFailure({
      id: randomId('wf'),
      repoId: repo.id,
      runId,
      attempt,
      workflowName: workflowName.slice(0, 200),
      headSha: headSha.slice(0, 64),
      headBranch: headBranch.slice(0, 200),
      event: runEvent.slice(0, 40),
      status,
      reason,
      runUrl: runUrl.slice(0, 500),
    })
    if (!stored.created) return
    // Slice 2 reads the failed job log for a queued failure. The row already
    // exists, so a token or GitHub failure stores its reason and keeps the
    // intake. Ignored rows never spend a request on a log nobody will analyse.
    if (status === 'queued') {
      let excerpt: string | null = null
      let error: string | null = null
      const [logOwner, logName] = fullName.split('/')
      if (logOwner === undefined || logName === undefined || logOwner === '' || logName === '') {
        error = 'invalid_repository'
      } else {
        try {
          const token = await repoGithubToken(repo, config, githubApp, store)
          const result = await fetchFailureLog(new GithubClient(token, config.github.apiBase), logOwner, logName, runId)
          excerpt = result.excerpt
          error = result.error
        } catch (fetchError) {
          error = logFailureReason(fetchError)
        }
      }
      store.updateWorkflowFailureLog(stored.row.id, { excerpt, error })
    }
    // #371: a failing run on the default branch at a delivery's merge commit is a
    // post-merge failure of that delivery. It counts per run, so a second failing
    // run is a second fact rather than the same one seen twice.
    if (!pullRequestRun && headSha !== '' && store.getDeliveryOutcomeByMerge(repo.id, headSha) !== undefined) {
      store.recordPostMergeFailure(repo.id, headSha, nowIso())
      store.event('delivery_post_merge_failure', { userId: repo.user_id, repoId: repo.id, meta: `${headSha.slice(0, 12)}:${runId}`.slice(0, 300) })
    }
    store.event('workflow_failure', {
      userId: repo.user_id,
      repoId: repo.id,
      meta: `${status}:${reason ?? 'analysis_pending'}:${runId}:${attempt}:${headSha.slice(0, 12)}`.slice(0, 300),
    })
    log.info('workflow failure intake', { repo: `${repo.owner}/${repo.name}`, run: runId, attempt, status, reason })
  }

  const handleGithubFollowup = async (event: string, body: Record<string, unknown>): Promise<void> => {
    const installation = typeof body.installation === 'object' && body.installation !== null ? (body.installation as Record<string, unknown>) : {}
    const installationId = Number(installation.id)
    if (!Number.isFinite(installationId)) return
    const repository = typeof body.repository === 'object' && body.repository !== null ? (body.repository as Record<string, unknown>) : {}
    const fullName = typeof repository.full_name === 'string' ? repository.full_name : ''
    if (fullName === '') return
    const repo = store.findRepoByInstallationAndFullName(installationId, fullName)
    if (repo === undefined) return
    const pulls: Array<{ number?: number; html_url?: string; head?: { ref?: string; sha?: string }; base?: { ref?: string } }> = []
    let reason = ''
    // #251: a changes_requested review carries the maintainer's words in
    // `review.body`. The follow-up used to be built from a fixed template, so
    // the agent was told "review requested changes" and nothing else.
    let instruction = ''
    let reconcile = false
    // #637: who reviewed decides whether this fix is counted against a budget.
    let reviewAuthor: ReviewAuthor | undefined
    if (event === 'check_run') {
      const check = typeof body.check_run === 'object' && body.check_run !== null ? (body.check_run as Record<string, unknown>) : {}
      const conclusion = String(check.conclusion ?? '')
      if (!['failure', 'timed_out', 'cancelled', 'success', 'neutral', 'skipped'].includes(conclusion)) return
      reconcile = ['success', 'neutral', 'skipped'].includes(conclusion)
      reason = `check ${String(check.name ?? 'check')} ${conclusion}`
      if (Array.isArray(check.pull_requests)) pulls.push(...(check.pull_requests as typeof pulls))
    } else if (event === 'check_suite') {
      const suite = typeof body.check_suite === 'object' && body.check_suite !== null ? (body.check_suite as Record<string, unknown>) : {}
      const conclusion = String(suite.conclusion ?? '')
      if (!['failure', 'timed_out', 'cancelled', 'success', 'neutral', 'skipped'].includes(conclusion)) return
      reconcile = ['success', 'neutral', 'skipped'].includes(conclusion)
      reason = `check suite ${conclusion}`
      if (Array.isArray(suite.pull_requests)) pulls.push(...(suite.pull_requests as typeof pulls))
    } else if (event === 'pull_request_review') {
      const review = typeof body.review === 'object' && body.review !== null ? (body.review as Record<string, unknown>) : {}
      if (review.state !== 'changes_requested' && review.state !== 'approved') return
      reconcile = review.state === 'approved'
      reason = review.state === 'approved' ? 'review approved' : 'review requested changes'
      instruction = review.state === 'changes_requested' ? normalizeReviewInstruction(review.body) : ''
      const reviewer = typeof review.user === 'object' && review.user !== null ? (review.user as Record<string, unknown>) : {}
      reviewAuthor = classifyReviewAuthor(
        typeof reviewer.login === 'string' ? reviewer.login : '',
        typeof reviewer.type === 'string' ? reviewer.type : '',
        `${config.githubApp.slug}[bot]`,
      )
      const pull = typeof body.pull_request === 'object' && body.pull_request !== null ? (body.pull_request as typeof pulls[number]) : undefined
      if (pull !== undefined) pulls.push(pull)
    } else {
      return
    }
    for (const pull of pulls) {
      const number = Number(pull.number)
      if (!Number.isFinite(number)) continue
      const prUrl = typeof pull.html_url === 'string' ? pull.html_url : `https://github.com/${fullName}/pull/${number}`
      const branch = typeof pull.head?.ref === 'string' ? pull.head.ref : ''
      const baseBranch = typeof pull.base?.ref === 'string' ? pull.base.ref : undefined
      const headSha = typeof pull.head?.sha === 'string' ? pull.head.sha : ''
      if (branch === '') continue
      if (store.latestJobByPrUrl(repo.user_id, prUrl) === undefined) continue
      if (reconcile) {
        await jobs.reconcilePr(repo, prUrl)
        log.info('github merge reconcile', { repo: `${repo.owner}/${repo.name}`, pr: number, reason })
        continue
      }
      const result = await jobs.followUp(repo, { prUrl, branch, baseBranch, reason, headSha, ...(instruction === '' ? {} : { instruction }), ...(reviewAuthor === undefined ? {} : { reviewAuthor }) })
      log.info('github follow-up', { repo: `${repo.owner}/${repo.name}`, pr: number, ok: result.ok, code: result.code, author: reviewAuthor, trace: result.job?.id })
    }
  }

  const handleIssueCommand = async (event: string, body: Record<string, unknown>): Promise<void> => {
    if (event !== 'issue_comment' || body.action !== 'created') return
    const installation = typeof body.installation === 'object' && body.installation !== null ? (body.installation as Record<string, unknown>) : {}
    const installationId = Number(installation.id)
    if (!Number.isFinite(installationId)) return
    const repository = typeof body.repository === 'object' && body.repository !== null ? (body.repository as Record<string, unknown>) : {}
    const fullName = typeof repository.full_name === 'string' ? repository.full_name : ''
    if (fullName === '') return
    const repo = store.findRepoByInstallationAndFullName(installationId, fullName)
    if (repo === undefined) return
    const parsed = parseIssueCommand(body)
    // #637: a mention is the second matcher on the same comment surface. It is
    // read only when the comment is not a `/fledge` command, so one comment can
    // never be both, and it reuses the claim below: the comment id is the key.
    const mention = parsed === null
      ? parseMentionTrigger(body, { names: config.triggers.mentions, botLogin: `${config.githubApp.slug}[bot]` })
      : null
    if (parsed === null && mention === null) return
    const source = (parsed ?? mention) as IssueCommandInput | MentionTriggerInput
    const command = parsed?.command
    const { issueUrl, number, title, detail } = source
    const key = `issue_command:${source.commentId}`
    const marker = readIssueCommandMarker(store.getSetting(key))
    // Answered already: a redelivery says nothing twice.
    if (marker?.state === 'done') return
    // Still inside the claim's lease: another delivery of the same comment is
    // answering it right now. A lapsed claim is the shape a killed process leaves,
    // so this delivery takes it over rather than leaving the comment unanswered.
    if (marker !== undefined && Date.now() - marker.at < ISSUE_COMMAND_CLAIM_MS) return
    store.setSetting(key, `claimed:${nowIso()}`)
    const token = await repoGithubToken(repo, config, githubApp, store)
    const client = new GithubClient(token, config.github.apiBase)
    const owner = repo.upstream_owner || repo.owner
    const name = repo.upstream_name || repo.name
    const reply = async (message: string): Promise<void> => {
      await client.comment(owner, name, number, `${message}\n\n<sub>Fledge · issue command</sub>`)
      // The claim settles only once the answer is on the issue, so a reply that
      // never posted leaves a marker the next delivery can retake.
      store.setSetting(key, `done:${nowIso()}`)
    }

    if (mention !== null) {
      // #637: the kind of job follows the target's kind. A pull request is read,
      // not written: the review job reads the diff at its head and comments. An
      // issue is where a follow-up may open one branch and one pull request.
      if (!mention.onPullRequest) {
        const result = await jobs.mention(repo, {
          target: { kind: 'issue', number: mention.number, url: mention.issueUrl, headSha: '', state: 'open', draft: false },
          commentId: mention.commentId,
          actor: mention.actor,
        })
        if (result.ok && (result.action === 'start' || result.action === 'supersede')) await reply(`Mention accepted: starting a follow-up for this issue (${result.jobId}).`)
        else if (result.ok && result.action === 'record') await reply('Mention recorded on the job that already holds this issue; nothing new was started.')
        else if (result.ok) await reply('Mention recorded; the follow-up starts when the job that is running now finishes.')
        else await reply(`Mention received, but nothing started: ${result.error}`)
        return
      }
      try {
        const pr = await client.getPullRequest(owner, name, mention.number)
        const result = await jobs.mention(repo, {
          target: {
            kind: 'pull_request',
            number: mention.number,
            url: pr.url,
            headSha: pr.headSha,
            state: pr.state === 'open' && !pr.merged ? 'open' : 'closed',
            draft: pr.draft,
            branch: pr.head,
            baseBranch: pr.base,
          },
          commentId: mention.commentId,
          actor: mention.actor,
        })
        if (result.ok && (result.action === 'start' || result.action === 'supersede')) await reply(`Mention accepted: review started for ${pr.headSha.slice(0, 7)} on ${pr.url}.`)
        else if (result.ok && result.action === 'record') await reply('This head is already being reviewed; the mention is recorded on that job.')
        else if (result.ok) await reply('Mention recorded; the review starts when the job that is running now finishes.')
        else if (result.code === 'MENTION_DRAFT') await reply('This pull request is a draft; nothing was started.')
        else if (result.code === 'MENTION_CLOSED') await reply('This pull request is not open; nothing was started.')
        else await reply(`Mention received, but nothing started: ${result.error}`)
        return
      } catch (error) {
        // A target we cannot read starts nothing and says so in one audit line;
        // the claim settles, because a redelivery would fail the same read.
        if (error instanceof GithubError && (error.status === 404 || error.status === 403)) {
          store.audit(repo.user_id, 'trigger.mention_refused', `${mention.commentId} unreadable ${mention.number}`)
          store.setSetting(key, `done:${nowIso()}`)
          return
        }
        // Anything else is not the trigger's fault: the claim is released so the
        // redelivery can retry it.
        store.deleteSetting(key)
        throw error
      }
    }

  // #540 slice 6: the chat half. An issue comment is a third surface on the same
  // command contract as the console forms, so the reply is built from the receipt
  // and the audit row, the revision fence and the refusal codes are the same ones.
  // A chat message has no rendered page to go stale, so the revision is read as the
  // event is handled. The comment id is both the claim key and the idempotency key:
  // the claim absorbs a duplicate delivery, and if a delivery is retaken the
  // receipt answers the replay instead of queueing a second job.
  // #370 slice 2: the fence marks the text as data; this record says what the
  // text tried to do. Only rule ids and the body hash are written — the job page
  // and the audit log never receive the issue text itself.
  const recordUntrustedInput = (outcome: CommandOutcome, untrusted: UntrustedText, payload: string, itemId: string): void => {
    const firewall = scanUntrusted(payload)
    const queuedJobId = commandJobId(outcome)
    store.audit(repo.user_id, 'job.untrusted_input', untrustedAuditDetail(queuedJobId ?? itemId, untrusted, firewall.directives))
    // The event is the job page's source; without a job there is no page to put
    // it on, and an event keyed by a work item id would never be read back.
    if (queuedJobId === null) return
    store.recordJobEvent({ jobId: queuedJobId, repoId: repo.id, userId: repo.user_id, kind: UNTRUSTED_EVENT_KIND, meta: untrustedMeta(untrusted, firewall.directives) })
  }

  const runChatCreate = async (kind: JobKind, goal: string, itemId: string): Promise<CommandOutcome> => {
    const actor = managementActor({ store, userId: repo.user_id, repo, channel: 'chat', requestId: `issue_command:${source.commentId}` })
    return management.run(actor, {
      operation: 'task.create',
      target: { projectId: repo.id },
      arguments: { kind, goal, workItemId: itemId },
      expectedRevision: management.revisionOf('project', repo.id),
      idempotencyKey: `issue_command:${source.commentId}`,
    })
  }

    // The four job verbs act on the job attached to the issue's work item. They
    // never create that item: with no item — or no job on it — the answer is a
    // refusal, because a control command that starts work is a surprise, not a
    // retry. Each verb reuses the service action the console already calls, so the
    // audit rows and the timeline events are the same ones.
    if (command === 'retry' || command === 'pause' || command === 'resume' || command === 'cancel') {
      const linked = store.findWorkItemByIssueUrl(repo.id, issueUrl)
      if (linked === undefined) {
        await reply(`No work item is linked to this issue; nothing to ${command}.`)
        return
      }
      // #360 review: by the item, not through the repository's newest 20 — an older
      // work item's job must not be answered "no job is attached".
      const job = store.latestJobForWorkItem(linked.id)
      if (job === undefined) {
        await reply(`No job is attached to work item ${linked.id}; nothing to ${command}.`)
        return
      }
      const active = job.status === 'queued' || job.status === 'running'
      if (command === 'pause' || command === 'cancel') {
        if (!active) {
          await reply(`Job ${job.id} is ${job.status}; there is no queued or running job to ${command}.`)
          return
        }
        const result = command === 'pause' ? await jobs.pauseJob(job.id, 'issue command') : await jobs.cancelJob(job.id, 'issue command')
        if (!result.ok) {
          await reply(`Could not ${command} job ${job.id}: ${result.error ?? 'unknown error'}`)
          return
        }
        // The service returns what the stop path actually did, so the sentence
        // reports a hard stop, a request, no reachable session or a failed call —
        // never a send that did not happen, and never a claim a process was killed.
        const verb = command === 'pause' ? 'Paused' : 'Cancelled'
        const state = command === 'pause' ? 'paused' : 'cancelled'
        await reply(`${verb} job ${job.id}: ${describeJobStop(result)}; the row is ${state}.`)
        return
      }
      if (command === 'resume') {
        if (job.status !== 'paused') {
          await reply(`Job ${job.id} is ${job.status}; only a paused job can be resumed.`)
          return
        }
        const result = await jobs.resumeJob(job.id)
        await reply(result.ok && result.job !== undefined ? `Resumed job ${job.id} as job ${result.job.id}.` : `Could not resume job ${job.id}: ${result.error ?? 'unknown error'}`)
        return
      }
      if (active) {
        await reply(`Job ${job.id} is still ${job.status}; pause or cancel it before retrying.`)
        return
      }
      const result = await jobs.retryJob(job.id, repo.user_id, { workItemId: linked.id })
      await reply(result.ok && result.job !== undefined ? `Queued job ${result.job.id} to retry job ${job.id}.` : `Could not retry job ${job.id}: ${result.error ?? 'unknown error'}`)
      return
    }
    let item = store.findWorkItemByIssueUrl(repo.id, issueUrl)
    if (item === undefined) {
      item = store.createWorkItem({ id: randomId('work'), repoId: repo.id, userId: repo.user_id, title, detail, issueUrl, state: 'proposed' })
    }
    if (command === 'status') {
      const latest = store.listJobsForRepo(repo.id, 20).find((job) => job.work_item_id === item.id)
      await reply(`Work item ${item.id}: ${item.state}. ${latest === undefined ? 'No job yet.' : `Latest job ${latest.id}: ${latest.status}${latest.pr_url === null ? '' : ` · ${latest.pr_url}`}`}`)
      return
    }
    if (store.activeJobForRepo(repo.id) !== undefined) {
      await reply('A job is already running for this repository; wait for it to finish.')
      return
    }
    if (command === 'approve') {
      if (repo.repo_role !== 'maintainer') {
        await reply('Only a maintainer can approve a plan.')
        return
      }
      const plan = store.listJobsForRepo(repo.id, 20).find((job) => job.kind === 'plan' && job.status === 'succeeded' && job.work_item_id === item.id && job.plan_approved_at === null)
      if (plan === undefined) {
        await reply('No plan is waiting for approval.')
        return
      }
      // #634: the same function as the web form, so the columns and the audit name
      // are one record whichever door decided. The actor is the person who wrote
      // the command when Fledge knows them, not the repository owner.
      const decider = store.userByLogin(source.actor)?.id ?? repo.user_id
      const outcome = decidePlan(store, {
        job: planDecisionJob(plan),
        decision: 'approve',
        actor: decider,
        at: nowIso(),
        shownHash: null,
        latestBaseSha: store.latestFinishedBaseSha(repo.id),
        door: 'issue command',
        allowPaths: plan.plan_allow_paths ?? repo.allow_paths,
        denyPaths: plan.plan_deny_paths ?? repo.deny_paths,
        workItemId: plan.work_item_id,
      })
      await reply(outcome.ok
        ? `Plan ${plan.id} approved. Run /fledge fix to start implementation.`
        : `Could not approve plan ${plan.id}: ${outcome.reason.en}`)
      return
    }
    if (command === 'plan') {
      const { goal, untrusted, payload } = untrustedIssueGoal({
        issueUrl,
        title,
        detail,
        instruction: 'Produce one concrete plan only; do not write code, create a branch or open a PR.',
      })
      const outcome = await runChatCreate('plan', goal, item.id)
      if (outcome.ok) recordUntrustedInput(outcome, untrusted, payload, item.id)
      await reply(outcome.ok ? `Plan job ${commandJobId(outcome) ?? ''} queued.` : `Could not queue a plan: ${outcome.message}`)
      return
    }
    if (repo.plan_required === 1 && item.state !== 'approved' && item.state !== 'assigned' && item.state !== 'pr_ready') {
      await reply('This repository requires an approved plan first. Run /fledge plan, then /fledge approve.')
      return
    }
    const { goal, untrusted, payload } = untrustedIssueGoal({
      issueUrl,
      title,
      detail,
      instruction: 'Implement one focused fix for this issue.',
    })
    const outcome = await runChatCreate('iterate', goal, item.id)
    if (outcome.ok) recordUntrustedInput(outcome, untrusted, payload, item.id)
    await reply(outcome.ok ? `Implementation job ${commandJobId(outcome) ?? ''} queued.` : `Could not queue a fix: ${outcome.message}`)
  }

  // #371: a merge is a delivery. The row is written here; the revert scan runs
  // beside it and is best-effort, so a token or network failure leaves the row
  // un-reverted instead of failing the webhook delivery GitHub will not resend
  // for the same reason twice.
  const recordMergedDelivery = (repo: RepoRow, jobId: string | null, prUrl: string, title: string, mergeCommit: string | null): void => {
    if (mergeCommit === null || mergeCommit === '') return
    jobs.recordMergedDelivery({ repoId: repo.id, jobId, prUrl, mergeCommit, mergedAt: nowIso(), title })
    void scanDeliveryReverts(repo).catch((error: unknown) => log.warn('delivery revert scan failed', { repo: repo.id, error: String(error) }))
  }

  const scanDeliveryReverts = async (repo: RepoRow): Promise<void> => {
    const token = await repoGithubToken(repo, config, githubApp, store)
    const client = new GithubClient(token, config.github.apiBase)
    const commits = await client.listRecentCommits(repo.owner, repo.name, repo.default_branch, 50)
    for (const commit of commits) {
      const reverted = revertMatchOf(commit.message)
      if (reverted === null) continue
      if (store.markDeliveryReverted({ repoId: repo.id, mergeCommit: reverted, revertCommit: commit.sha, revertedAt: nowIso() })) {
        store.event('delivery_reverted', { userId: repo.user_id, repoId: repo.id, meta: `${reverted}:${commit.sha}`.slice(0, 300) })
      }
    }
  }

  const handleWorkItemEvent = async (event: string, body: Record<string, unknown>): Promise<void> => {
    if (event !== 'issues' && event !== 'pull_request' && event !== 'pull_request_review') return
    const installation = typeof body.installation === 'object' && body.installation !== null ? (body.installation as Record<string, unknown>) : {}
    const installationId = Number(installation.id)
    if (!Number.isFinite(installationId)) return
    const repository = typeof body.repository === 'object' && body.repository !== null ? (body.repository as Record<string, unknown>) : {}
    const fullName = typeof repository.full_name === 'string' ? repository.full_name : ''
    if (fullName === '') return
    const repo = store.findRepoByInstallationAndFullName(installationId, fullName)
    if (repo === undefined) return
    const action = typeof body.action === 'string' ? body.action : ''
    if (event === 'issues') {
      const issue = typeof body.issue === 'object' && body.issue !== null ? (body.issue as Record<string, unknown>) : {}
      const issueUrl = typeof issue.html_url === 'string' ? issue.html_url : ''
      const title = typeof issue.title === 'string' ? issue.title.slice(0, 200) : ''
      const detail = typeof issue.body === 'string' ? issue.body.slice(0, 4000) : ''
      const labels = Array.isArray(issue.labels)
        ? issue.labels.flatMap((label) => {
            if (typeof label === 'string') return [label]
            if (typeof label === 'object' && label !== null && typeof (label as Record<string, unknown>).name === 'string') return [(label as Record<string, unknown>).name as string]
            return []
          })
        : []
      if (issueUrl === '' || title === '') return
      const existing = store.findWorkItemByIssueUrl(repo.id, issueUrl)
      const closed = action === 'closed' || issue.state === 'closed'
      const priority = issuePriority(labels)
      const state = issueState(labels, closed)
      if (existing === undefined) {
        store.createWorkItem({ id: randomId('work'), repoId: repo.id, userId: repo.user_id, title, detail, issueUrl, state, priority })
      } else {
        // #371: an issue that names a delivered pull request is a follow-up to it.
        // The link counts once; a second comment on the same issue names the same
        // link and adds nothing.
        if (!closed) {
          const since = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString()
          for (const row of store.listDeliveryOutcomes(repo.id, since)) {
            if (detail.includes(row.pr_url) && store.linkDeliveryFollowUp(repo.id, row.merge_commit, issueUrl)) {
              store.event('delivery_follow_up', { userId: repo.user_id, repoId: repo.id, meta: `${row.merge_commit.slice(0, 12)}:${issueUrl}`.slice(0, 300) })
            }
          }
        }
        store.updateWorkItem(existing.id, {
          title,
          detail,
          issue_url: issueUrl,
          priority,
          ...(closed ? { state: 'closed' } : shouldTriage(labels) && existing.state === 'proposed' ? { state: 'triaged' } : {}),
        })
      }
      return
    }
    const pull = typeof body.pull_request === 'object' && body.pull_request !== null ? (body.pull_request as Record<string, unknown>) : {}
    const prUrl = typeof pull.html_url === 'string' ? pull.html_url : ''
    if (prUrl === '') return
    const existing = store.findWorkItemByPrUrl(repo.id, prUrl)
    if (event === 'pull_request') {
      const title = typeof pull.title === 'string' ? pull.title.slice(0, 200) : prUrl
      const merged = pull.merged === true
      const closed = action === 'closed' || pull.state === 'closed'
      store.updateJobsPrState(prUrl, merged ? 'merged' : closed ? 'closed' : 'open')
      if (existing === undefined && action !== 'opened') return
      if (existing === undefined) {
        const created = store.createWorkItem({ id: randomId('work'), repoId: repo.id, userId: repo.user_id, title, prUrl, state: merged ? 'merged' : closed ? 'closed' : 'pr_ready', prState: merged ? 'merged' : closed ? 'closed' : 'open', mergedAt: merged ? nowIso() : null, mergeCommit: typeof pull.merge_commit_sha === 'string' ? pull.merge_commit_sha : null })
        if (merged) recordMergedDelivery(repo, created.job_id, prUrl, title, typeof pull.merge_commit_sha === 'string' ? pull.merge_commit_sha : null)
        return
      }
      if (closed) {
        store.updateWorkItem(existing.id, {
          state: merged ? 'merged' : 'closed',
          pr_state: merged ? 'merged' : 'closed',
          ...(merged ? { merged_at: nowIso(), merge_commit: typeof pull.merge_commit_sha === 'string' ? pull.merge_commit_sha : null } : {}),
        })
        if (merged) recordMergedDelivery(repo, existing.job_id, prUrl, title, typeof pull.merge_commit_sha === 'string' ? pull.merge_commit_sha : null)
      } else {
        store.updateWorkItem(existing.id, { state: existing.state === 'in_review' ? 'in_review' : 'pr_ready', pr_state: 'open', pr_url: prUrl, title })
      }
      return
    }
    if (existing === undefined) return
    const review = typeof body.review === 'object' && body.review !== null ? (body.review as Record<string, unknown>) : {}
    const state = review.state === 'approved' ? 'approved' : review.state === 'changes_requested' ? 'changes_requested' : 'in_review'
    store.updateWorkItem(existing.id, { state })
  }

  const processGithubWebhook = async (event: string, body: Record<string, unknown>, delivery: string): Promise<void> => {
    const action = typeof body.action === 'string' ? body.action : ''
    const repository = typeof body.repository === 'object' && body.repository !== null ? (body.repository as Record<string, unknown>) : {}
    const fullName = typeof repository.full_name === 'string' ? repository.full_name : ''
    store.event('github_webhook', { meta: `${event}:${action}:${fullName}:${delivery}`.slice(0, 300) })
    if (event === 'installation') {
      const installation = typeof body.installation === 'object' && body.installation !== null ? (body.installation as Record<string, unknown>) : {}
      const installationId = Number(installation.id)
      if (action === 'created' && Number.isFinite(installationId)) {
        const sender = typeof body.sender === 'object' && body.sender !== null ? (body.sender as Record<string, unknown>) : {}
        const login = typeof sender.login === 'string' ? sender.login : ''
        if (login !== '') store.setSetting(`installation_sender:${installationId}`, `${login}:${Date.now()}`)
      }
      if (action === 'deleted' && Number.isFinite(installationId)) store.deleteInstallation(installationId)
    }
    try {
      await handleWorkItemEvent(event, body)
      await handleWorkflowRun(event, body)
      // A command that threw before it answered hands its comment claim back, so
      // the redelivery GitHub sends can retry it instead of reading a marker that
      // says "handled". The delivery row below is marked failed for the same
      // reason, and with the same five-minute lease.
      await handleIssueCommand(event, body).catch((error: unknown) => {
        releaseIssueCommandClaim(store, body)
        throw error
      })
      await handleGithubFollowup(event, body)
      if (delivery !== '') store.finishWebhookDelivery(delivery, 'processed')
    } catch (error) {
      if (delivery !== '') store.finishWebhookDelivery(delivery, 'failed', String(error))
      throw error
    }
  }

  app.post('/api/github/webhook', async (request, reply) => {
    if (!apiLimiter.take(`webhook:${rateLimitKey(request)}`)) return reply.code(429).send({ error: 'too many requests' })
    if (!githubApp.configured || config.githubApp.webhookSecret === '') return reply.code(503).send({ error: 'GitHub App webhook is not configured' })
    const signature = String(request.headers['x-hub-signature-256'] ?? '')
    const raw = (request as FastifyRequest & { rawBody?: Buffer }).rawBody
    const verdict = raw === undefined ? { ok: false, slot: null, superseded: false } : checkWebhookSignature(config.githubApp, raw, signature)
    if (!verdict.ok) {
      // #466: a signature that matches the value this instance retired is not
      // noise, it means a delivery is still being signed with the old secret.
      // One row per refusal, and the detail names only the closed window.
      if (verdict.superseded) store.audit(null, 'app.webhook_secret_superseded', `signed with GITHUB_APP_WEBHOOK_SECRET_PREVIOUS after its window closed at ${config.githubApp.webhookSecretPreviousUntil ?? ''}`)
      return reply.code(401).send({ error: 'bad webhook signature' })
    }
    const event = String(request.headers['x-github-event'] ?? '')
    const delivery = String(request.headers['x-github-delivery'] ?? '')
    const body = (request.body ?? {}) as Record<string, unknown>
    const action = typeof body.action === 'string' ? body.action : ''
    const repository = typeof body.repository === 'object' && body.repository !== null ? (body.repository as Record<string, unknown>) : {}
    const fullName = typeof repository.full_name === 'string' ? repository.full_name : ''
    const installation = typeof body.installation === 'object' && body.installation !== null ? (body.installation as Record<string, unknown>) : {}
    const installationId = Number(installation.id)
    if (delivery !== '' && !store.claimWebhookDelivery(delivery, event, action, {
      payloadJson: JSON.stringify(body).slice(0, 64 * 1024),
      repositoryFullName: fullName,
      installationId: Number.isFinite(installationId) ? installationId : null,
    })) return { ok: true, duplicate: true }
    await processGithubWebhook(event, body, delivery)
    return { ok: true }
  })


  app.post('/api/inbound/email', async (request, reply) => {
    if (!apiLimiter.take(`inbound:${rateLimitKey(request)}`)) return reply.code(429).send({ error: 'too many requests' })
    if (config.inboundEmailSecret === '') return reply.code(503).send({ error: 'inbound email is not configured' })
    const provided = String(request.headers['x-fledge-email-secret'] ?? '')
    if (!safeEqual(provided, config.inboundEmailSecret)) return reply.code(401).send({ error: 'bad inbound email secret' })
    const body = (request.body ?? {}) as Record<string, unknown>
    const to = typeof body.to === 'string' ? body.to : ''
    const from = typeof body.from === 'string' ? body.from : ''
    const text = typeof body.text === 'string' ? body.text : ''
    const token = /\+([A-Za-z0-9_-]+)@/.exec(to)?.[1]
    if (token === undefined) return { ok: true, ignored: 'no reply token' }
    const stored = store.getSetting(`email_reply:${token}`)
    if (stored === undefined) return { ok: true, ignored: 'unknown reply token' }
    const [userId = '', repoId = '', at = '0'] = stored.split(':')
    if (Date.now() - Number(at) > 7 * 24 * 60 * 60_000) return reply.code(410).send({ error: 'reply token expired' })
    const user = store.userById(userId)
    const repo = user === undefined ? undefined : store.getRepo(repoId)
    if (user === undefined || repo === undefined || repo.user_id !== user.id) return reply.code(404).send({ error: 'reply target not found' })
    const open = from.lastIndexOf('<')
    const close = from.lastIndexOf('>')
    const sender = (open >= 0 && close > open ? from.slice(open + 1, close) : from).trim().toLowerCase()
    if (sender !== notifyEmail(user).toLowerCase()) return reply.code(403).send({ error: 'sender does not match the notification email' })
    const cleaned = text
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('>'))
      .join('\n')
      .split(/^On .+ wrote:$/m)[0]!
      .trim()
      .slice(0, 4000)
    if (cleaned === '') return reply.code(400).send({ error: 'empty reply' })
    try {
      await instances.sendGuidance(repo.id, 'lead', cleaned)
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : String(error) })
    }
    store.audit(user.id, 'team.email_reply', `${repo.owner}/${repo.name} chars=${cleaned.length}`)
    store.event('team_intervention', { userId: user.id, repoId: repo.id, meta: 'email' })
    return { ok: true }
  })

  registerGateway(app, {
    config,
    store,
    onQuotaExhausted: (user) => jobs.notifier.notify(user),
    onQuotaBlocked: (user) => jobs.quotaBlocked(user),
  })

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/v1') || request.url.startsWith('/api/')) return reply.code(404).send({ error: { type: 'not_found', message: 'No such endpoint' } })
    return htmlPage(reply, 404, errorPage(config, request.viewer === undefined ? null : viewOf(request.viewer), 404, '页面不存在', '你访问的页面不存在。', request.locale))
  })

  app.setErrorHandler((error, request, reply) => {
    const failure = error as { statusCode?: number; code?: string; message?: string }
    const status = failure.statusCode ?? 500
    const code = failure.code ?? 'ERROR'
    const message = failure.message ?? 'Unknown error'
    if (status >= 500) log.error('request failed', { url: routePattern(request), error: redact(String(error)) })
    if (request.url.startsWith('/v1') || request.url.startsWith('/api/')) {
      return reply.code(status).send({ error: { type: code, message } })
    }
    // A page that only needs a session signs in and comes back, instead of
    // showing "出错了" over a 401 the visitor cannot act on. API paths keep the
    // status for machine clients, and a non-GET request keeps it too so a form
    // post does not lose its body through a redirect.
    if (status === 401 && code === 'AUTH_REQUIRED' && (request.method === 'GET' || request.method === 'HEAD')) {
      return reply.redirect(`/auth/github?next=${encodeURIComponent(safeLocalPath(request.url, '/dashboard'))}`)
    }
    let report: { ref: string } | undefined
    if (status >= 500) {
      try {
        const ref = randomToken(18)
        const viewer = request.viewer
        store.createErrorReport({
          ref,
          user_id: viewer?.user.id ?? null,
          user_login: viewer?.user.login ?? null,
          method: request.method,
          path: routePattern(request),
          status_code: status,
          error_name: (error instanceof Error && error.name !== '' ? error.name : 'Error').slice(0, 120),
          error_message: redact(message).slice(0, 1000),
          error_stack: error instanceof Error ? redact(error.stack ?? '').slice(0, 4000) : '',
          build_version: VERSION,
          build_commit: config.build.commit,
        })
        report = { ref }
      } catch (reportError) {
        log.warn('error report capture failed', { error: redact(String(reportError)) })
      }
    }
    return htmlPage(reply, status, errorPage(config, request.viewer === undefined ? null : viewOf(request.viewer), status, status === 404 ? '页面不存在' : '出错了', status >= 500 ? '服务器出了点问题，请稍后再试。' : message, request.locale, undefined, report))
  })

  // #635: the optional receiver is pushed at most once a UTC day, and its day
  // marker is written only after a 2xx, so a failed day retries. The memory
  // backoff keeps an endpoint that is refusing from being asked every minute of
  // that day; `productPushDue` still decides the day itself from the marker.
  let pushingProduct = false
  let productPushRetryAt = 0
  let retryingLead = false
  const sweeper = setInterval(() => {
    limits.sweep()
    apiLimiter.sweep()
    store.deleteExpiredSessions()
    if (options.startScheduler !== false && !pushingProduct && Date.now() >= productPushRetryAt && config.productWebhookUrl !== '') {
      pushingProduct = true
      void pushProductLoopWebhook({ store, config })
        .then((outcome) => {
          if (outcome.state === 'retry' || outcome.state === 'blocked' || outcome.state === 'unknown') {
            productPushRetryAt = Date.now() + 15 * 60_000
            log.warn('product loop push not delivered', { state: outcome.state })
          }
        })
        .catch((error) => {
          productPushRetryAt = Date.now() + 15 * 60_000
          log.warn('product loop push failed', { error: redact(String(error)) })
        })
        .finally(() => { pushingProduct = false })
    }
    if (options.startScheduler === false || retryingLead) return
    retryingLead = true
    void retryPendingLeadDeliveries({ store, config, instances })
      .catch((error) => log.warn('feedback lead retry failed', { error: redact(String(error)) }))
      .finally(() => { retryingLead = false })
  }, 60_000)
  sweeper.unref()

  if (options.startScheduler !== false) {
    jobs.start()
    void notifyReleasedFeedback({ store, mailer }).catch((error) => log.warn('released feedback notification failed', { error: redact(String(error)) }))
    void retryPendingLeadDeliveries({ store, config, instances }).catch((error) => log.warn('feedback lead retry failed', { error: redact(String(error)) }))
  }

  return {
    app,
    store,
    jobs,
    sessions,
    instances,
    githubApp,
    close: async () => {
      await jobs.drain(config.shutdown.graceSeconds * 1000)
      clearInterval(sweeper)
      await app.close()
      await shutdownOtel()
      store.close()
    },
  }
}
