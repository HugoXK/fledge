import type { Config } from '../config.js'
import type { JobRow, RepoRow, Store, UserRow } from '../db.js'
import type { Mailer } from '../email/mailer.js'
import { QuotaNotifier } from '../gateway/notifier.js'
import { quotaView } from '../gateway/quota.js'
import { dailyDigestEmail, jobAttentionEmail, jobFailedEmail, jobSucceededEmail, type DigestInput } from '../email/templates.js'
import { notifyEmail, replyAddressFor } from '../email/recipient.js'
import { sendNotificationWebhook } from '../lib/webhook.js'
import { log } from '../lib/log.js'
import { isValidBranchName } from '../lib/branches.js'
import { attributionSentence, parseAttribution, type Attribution } from '../lib/attribution.js'
import { parseEvidence, type Evidence } from '../lib/evidence.js'
import { checkStage, parseStageMode } from '../lib/stages.js'
import { observedAttribution } from '../lib/teamStats.js'
import { decryptSecret, randomId, randomToken, safeEqual, sha256Hex } from '../lib/secrets.js'
import { addMinutes, nowIso } from '../lib/time.js'
import { GithubClient, GithubError, prepareRepo, prepareRepoWithInstallation, repoPermissionWithToken } from '../repos/github.js'
import { GithubApp } from '../repos/app.js'
import { repoGithubToken } from '../repos/token.js'
import { parseTeam } from '../flybot/instances.js'
import type { JobKind, RepoRef, Runner } from './runner.js'
import type { InstanceManager } from '../flybot/instances.js'

export const DEFAULT_GOAL =
  'Review this repository for one high-value defect or improvement. Write a failing test first, implement the smallest correct fix, run the relevant tests, and open a pull request. Do not refactor unrelated code.'

export const DEFAULT_SCOPE_GOAL =
  'Produce a Product scope for the requested issue: goal, non-goals, acceptance criteria and a test plan. Do not write code, create a branch, open a PR or change settings.'

export const DEFAULT_VERIFY_GOAL =
  'Verify the existing pull request and branch with the Test role: run the relevant tests, report the failing evidence and the passing evidence after the fix, plus CI/check status. Do not write code, push, open a PR or merge.'

export const DEFAULT_REVIEW_GOAL =
  'Review every open pull request on the upstream repository. For each PR, inspect the diff, tests and risk, give a score from 0 to 100 with a short rationale, and post a COMMENT review. Do not request changes, approve, merge, push or change repository settings. Return followUps for every Fledge PR that needs a same-branch fix. Summarize the scores and the most important issues.'

export interface EnqueueResult {
  ok: boolean
  job?: JobRow
  error?: string
  code?: string
}

function progressSummary(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as { summary?: unknown }
      if (typeof parsed.summary === 'string' && parsed.summary.trim() !== '') return parsed.summary.slice(0, 4000)
    } catch {}
  }
  return value.slice(0, 4000)
}

export interface ReviewFollowUp {
  prUrl: string
  branch: string
  baseBranch?: string
  headSha?: string
  reason?: string
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
}

export class Jobs {
  private timer: NodeJS.Timeout | null = null
  private questionBusy = false
  private readonly followUpLocks = new Set<string>()
  private ticking = false
  private lastPruneAt = 0
  private readonly credentialCache = new Map<string, { at: number }>()
  private readonly quotaNotifier: QuotaNotifier

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
      this.finish(job.id, { status: 'quota_exhausted', error: '平台额度已用完，请在 Settings → Model 配置自己的模型 API 后重试。' }, revoke)
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

  async cancelJob(jobId: string, reason: string): Promise<{ ok: boolean; error?: string }> {
    const job = this.store.getJob(jobId)
    if (job === undefined) return { ok: false, error: '任务不存在。' }
    if (job.status !== 'queued' && job.status !== 'running') return { ok: false, error: '这个任务已经结束。' }
    if (job.status === 'running' && this.instances !== undefined) {
      try {
        const state = await this.instances.teamState(job.repo_id, 5_000)
        const sessions = state.bots.filter((bot) => bot.activity === 'thinking' || bot.activity === 'working').map((bot) => bot.sessionId)
        if (sessions.length > 0) await this.instances.stopSessions(job.repo_id, sessions)
      } catch (error) {
        log.warn('cancel job stop failed', { job: jobId, error: String(error) })
      }
    }
    const row = job.platform_token_hash === null ? undefined : this.store.findApiToken(job.platform_token_hash)
    if (row !== undefined) this.store.revokeApiToken(row.id, row.user_id)
    await this.instances?.clearJobToken(job.repo_id, jobId).catch((error) => log.warn('clear job token failed', { job: jobId, error: String(error) }))
    this.store.updateJob(jobId, { status: 'cancelled', error: reason.slice(0, 1000), finished_at: nowIso() })
    if (job.kind === 'review') this.store.updateRepo(job.repo_id, { last_review_status: 'cancelled' })
    else this.store.updateRepo(job.repo_id, { last_status: 'cancelled' })
    if (job.work_item_id !== null) {
      const item = this.store.getWorkItem(job.work_item_id)
      if (item !== undefined) this.store.updateWorkItem(item.id, { state: 'closed' })
    }
    this.store.audit(job.user_id, 'job.cancelled', `${jobId}: ${reason.slice(0, 300)}`)
    this.store.event('job_cancelled', { userId: job.user_id, repoId: job.repo_id, jobId })
    return { ok: true }
  }

  async pauseJob(jobId: string, reason = '任务已暂停'): Promise<{ ok: boolean; error?: string }> {
    const job = this.store.getJob(jobId)
    if (job === undefined) return { ok: false, error: '任务不存在。' }
    if (job.status !== 'queued' && job.status !== 'running') return { ok: false, error: '这个任务已经结束。' }
    if (job.status === 'running' && this.instances !== undefined) {
      try {
        const state = await this.instances.teamState(job.repo_id, 5_000)
        const sessions = state.bots.filter((bot) => bot.activity === 'thinking' || bot.activity === 'working').map((bot) => bot.sessionId)
        if (sessions.length > 0) await this.instances.stopSessions(job.repo_id, sessions)
      } catch (error) {
        log.warn('pause job stop failed', { job: jobId, error: String(error) })
      }
    }
    const row = job.platform_token_hash === null ? undefined : this.store.findApiToken(job.platform_token_hash)
    if (row !== undefined) this.store.revokeApiToken(row.id, row.user_id)
    await this.instances?.clearJobToken(job.repo_id, jobId).catch((error) => log.warn('clear job token failed', { job: jobId, error: String(error) }))
    this.store.updateJob(jobId, { status: 'paused', error: reason.slice(0, 1000) })
    this.store.updateRepo(job.repo_id, { last_status: 'paused', ...(job.kind === 'review' ? { last_review_status: 'paused' } : {}) })
    this.store.audit(job.user_id, 'job.paused', jobId)
    this.store.event('job_paused', { userId: job.user_id, repoId: job.repo_id, jobId })
    return { ok: true }
  }

  async resumeJob(jobId: string): Promise<{ ok: boolean; job?: JobRow; error?: string }> {
    const job = this.store.getJob(jobId)
    if (job === undefined) return { ok: false, error: '任务不存在。' }
    if (job.status !== 'paused') return { ok: false, error: '只有已暂停的任务可以恢复。' }
    const repo = this.store.getRepo(job.repo_id)
    if (repo === undefined) return { ok: false, error: '仓库不存在。' }
    const goal = job.checkpoint === null || job.checkpoint === '' ? job.goal : `${job.goal}\n\nResume from checkpoint:\n${job.checkpoint}`
    const result = await this.enqueue(repo, 'manual', goal, job.kind === 'review' ? 'review' : job.kind === 'plan' ? 'plan' : 'iterate', {
      ...(job.branch === null ? {} : { branch: job.branch }),
      ...(job.pr_url === null ? {} : { prUrl: job.pr_url }),
      ...(job.base_branch === null ? {} : { baseBranch: job.base_branch }),
      ...(job.work_item_id === null ? {} : { workItemId: job.work_item_id }),
      priority: job.priority,
    })
    if (!result.ok || result.job === undefined) return { ok: false, error: result.error ?? '恢复失败。' }
    this.store.updateJob(jobId, { status: 'cancelled', error: `resumed as ${result.job.id}`, finished_at: nowIso() })
    this.store.audit(job.user_id, 'job.resumed', `${jobId} -> ${result.job.id}`)
    return { ok: true, job: result.job }
  }

  async cancelRepoJobs(repoId: string, reason: string): Promise<void> {
    for (const job of this.store.listActiveJobs().filter((entry) => entry.repo_id === repoId)) {
      const revoke = (): void => {
        const row = job.platform_token_hash === null ? undefined : this.store.findApiToken(job.platform_token_hash)
        if (row !== undefined) this.store.revokeApiToken(row.id, row.user_id)
      }
      this.finish(job.id, { status: 'failed', error: reason }, revoke)
    }
  }

  private async preflight(repo: RepoRow, baseBranch: string, trigger: string): Promise<{ ok: boolean; baseSha?: string; warning?: string; error?: string; code?: string }> {
    if (this.runner.name !== 'flybot') return { ok: true }
    if (trigger === 'schedule' && this.store.hasActiveWorkItem(repo.id)) {
      return { ok: false, error: '已有进行中的工作项，跳过定时任务。', code: 'WORK_ITEM_OPEN' }
    }
    try {
      const token = await repoGithubToken(repo, this.config, this.githubApp, this.store)
      const client = new GithubClient(token, this.config.github.apiBase)
      const upstreamOwner = repo.upstream_owner || repo.owner
      const upstreamName = repo.upstream_name || repo.name
      const branch = await client.getBranch(upstreamOwner, upstreamName, baseBranch)
      this.store.markRepoCredential(repo.id, 'ok')
      this.credentialCache.set(repo.id, { at: Date.now() })
      if (branch === null) return { ok: false, error: `目标分支 ${baseBranch} 不存在或不可访问。`, code: 'BRANCH_MISSING' }
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
    this.store.audit(repo.user_id, 'repo.credential_invalid', `${repo.owner}/${repo.name}: ${message.slice(0, 200)}`)
    this.store.notify(repo.user_id, 'job', `${repo.owner}/${repo.name} 的 GitHub token 权限不足，自动迭代已暂停；请重新授权后手动开启。`)
    void sendNotificationWebhook(this.config, 'repo.credential_invalid', { text: `${repo.owner}/${repo.name}: GitHub token is invalid`, repoId: repo.id, error: message.slice(0, 300) })
  }

  async enqueue(repo: RepoRow, trigger: 'manual' | 'schedule' | 'followup', goalOverride?: string, kind: JobKind = 'iterate', options: { branch?: string; prUrl?: string; baseBranch?: string; workItemId?: string; priority?: number } = {}): Promise<EnqueueResult> {
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
    let preflightSha: string | null = null
    let preflightWarning = ''
    if (kind === 'iterate') {
      const preflight = await this.preflight(repo, baseBranch, trigger)
      if (!preflight.ok) return { ok: false, error: preflight.error, code: preflight.code }
      preflightSha = preflight.baseSha ?? null
      preflightWarning = preflight.warning ?? ''
    }
    const baseGoal = kind === 'review' ? DEFAULT_REVIEW_GOAL : kind === 'scope' ? DEFAULT_SCOPE_GOAL : kind === 'verify' ? DEFAULT_VERIFY_GOAL : (repo.goal !== '' ? repo.goal : DEFAULT_GOAL)
    const rawGoal = goalOverride ?? baseGoal
    const goal = (preflightWarning === '' ? rawGoal : `${rawGoal}\n\nPreflight: ${preflightWarning}. Sync the fork before creating the working branch.`).slice(0, 4000)
    const jobId = `job_${randomToken(10)}`
    const callbackSecret = randomToken(24)
    const callbackHash = sha256Hex(callbackSecret)
    const platformFunded = user.own_llm_base_url === null || user.own_llm_base_url === '' || user.own_llm_key_enc === null

    if (platformFunded && quotaView(user, this.config).exhausted) {
      const job = this.store.createJob({ id: jobId, repoId: repo.id, userId: user.id, trigger, goal, callbackHash, platformTokenHash: '', kind })
      this.store.updateJob(job.id, { status: 'quota_exhausted', error: '平台额度已用完，请在 Settings → Model 配置自己的模型 API。', finished_at: nowIso() })
      if (kind === 'review') this.store.updateRepo(repo.id, { last_review_status: 'quota_exhausted' })
      else if (kind === 'iterate') this.store.updateRepo(repo.id, { last_status: 'quota_exhausted', last_run_at: nowIso() })
      else this.store.updateRepo(repo.id, { last_status: 'quota_exhausted' })
      await this.quotaNotifier.notify(user)
      return { ok: false, error: '平台额度已用完，请先配置自己的模型 API', code: 'QUOTA_EXHAUSTED', job: this.store.getJob(job.id) }
    }

    let flybot: { url: string; token: string; sessionId: string; role: 'chief' | 'lead' | 'reviewer' | 'product' | 'test'; leadName: string } | undefined
    if (this.config.flybot.instanceImage !== '') {
      if (this.instances === undefined) return { ok: false, error: 'FlyBot 实例管理器未配置', code: 'INSTANCE_UNAVAILABLE' }
      try {
        await this.instances.ensurePlaybook(repo.id).catch((error) => {
          log.warn('team playbook not refreshed', { repo: repo.id, error: String(error) })
        })
        const bridge = this.instances.bridgeFor(repo.id)
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
    if (this.store.countActiveJobs() >= 2) {
      return { ok: false, error: '平台当前已有 2 个任务在运行，请稍后再试。', code: 'JOB_LIMIT' }
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
    const job = this.store.createJob({ id: jobId, repoId: repo.id, userId: user.id, trigger, goal, callbackHash, platformTokenHash: tokenRow.token_hash, kind, baseBranch, workItemId: options.workItemId ?? null, priority, baseSha: preflightSha })
    if (options.workItemId !== undefined) {
      this.store.updateWorkItem(options.workItemId, { state: 'in_progress', job_id: job.id, assignee_user_id: user.id })
    }
    if (options.branch !== undefined || options.prUrl !== undefined) {
      this.store.updateJob(job.id, { branch: options.branch ?? null, pr_url: options.prUrl ?? null })
      job.branch = options.branch ?? null
      job.pr_url = options.prUrl ?? null
    }
    this.store.event('job_enqueued', { userId: user.id, repoId: repo.id, jobId: job.id, meta: `${kind}:${trigger}` })
    if (priorJobs === 0) this.store.event('first_job_start', { userId: user.id, repoId: repo.id, jobId: job.id })
    if (kind === 'review') this.store.updateRepo(repo.id, { last_review_status: 'queued' })
    else if (kind === 'iterate') this.store.updateRepo(repo.id, { last_run_at: nowIso(), last_status: 'queued' })
    else this.store.updateRepo(repo.id, { last_status: 'queued' })
    this.store.audit(user.id, 'job.enqueued', `${job.id} ${repo.owner}/${repo.name} (${kind}, ${trigger})`)

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
    try {
      const result = await this.runner.run({
        job,
        repo,
        user,
        kind,
        goal,
        upstream,
        fork,
        isFork: repo.is_fork === 1,
        permission: repo.permission,
        repoRole: repo.repo_role === 'maintainer' || repo.repo_role === 'developer' ? repo.repo_role : null,
        autoMerge: kind === 'iterate' && repo.repo_role === 'maintainer' && repo.auto_merge === 1,
        canReview: repo.can_review === 1,
        canCreateIssue: repo.can_create_issue === 1,
        callback: { url: `${this.config.baseUrl}/api/jobs/${job.id}/callback`, secret: callbackSecret },
        credential: { url: `${this.config.baseUrl}/api/jobs/${job.id}/credential`, secret: callbackSecret },
        platform: { baseUrl: `${this.config.baseUrl}/v1`, model: this.config.llm.model, token: platformToken },
        ...(flybot === undefined ? {} : { flybot }),
        timeoutMinutes: this.config.runner.timeoutMinutes,
      })
      if (result.status === 'running') {
        const current = this.store.getJob(job.id)
        if (current !== undefined && current.status !== 'queued') {
          if (current.status === 'succeeded' || current.status === 'running') return { ok: true, job: current }
          return { ok: false, job: current, error: current.error ?? '任务失败' }
        }
        this.store.updateJob(job.id, { status: 'running', started_at: nowIso() })
        if (kind === 'review') this.store.updateRepo(repo.id, { last_review_status: 'running' })
        else this.store.updateRepo(repo.id, { last_status: 'running' })
        return { ok: true, job: this.store.getJob(job.id) }
      }
      this.finish(job.id, { status: result.status === 'succeeded' ? 'succeeded' : 'failed', branch: result.branch, prUrl: result.prUrl, issueUrl: result.issueUrl, reviewScore: result.reviewScore, summary: result.summary, error: result.error }, revoke)
      return { ok: result.status === 'succeeded', job: this.store.getJob(job.id), ...(result.status === 'failed' ? { error: result.error ?? '任务失败' } : {}) }
    } catch (error) {
      revoke()
      const message = String(error instanceof Error ? error.message : error)
      this.store.updateJob(job.id, { status: 'failed', error: message.slice(0, 1000), finished_at: nowIso() })
      if (kind === 'review') this.store.updateRepo(repo.id, { last_review_at: nowIso(), last_review_status: 'failed' })
      else this.store.updateRepo(repo.id, { last_status: 'failed' })
      this.store.notify(user.id, 'job', `${kind === 'review' ? '审核' : '任务'} ${job.id} 启动失败：${message}`)
      this.store.audit(user.id, 'job.failed', `${job.id}: ${message.slice(0, 300)}`)
      log.error('job start failed', { job: job.id, error: message })
      return { ok: false, job: this.store.getJob(job.id), error: message, code: 'RUNNER_ERROR' }
    }
  }

  private syncWorkItemForJob(job: JobRow, result: { status: 'succeeded' | 'failed' | 'quota_exhausted'; prUrl: string | null; issueUrl: string | null }): void {
    const existing = job.work_item_id === null ? undefined : this.store.getWorkItem(job.work_item_id)
    if (existing !== undefined) {
      const prState = result.prUrl === null ? existing.pr_state : 'open'
      const state = result.status === 'succeeded' && result.prUrl !== null ? 'pr_ready' : result.status === 'failed' ? 'in_progress' : existing.state
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

  private finish(jobId: string, result: { status: 'succeeded' | 'failed' | 'quota_exhausted'; branch?: string; prUrl?: string; issueUrl?: string; reviewScore?: number; summary?: string; error?: string }, revoke: () => void, attribution: Attribution | null = null, evidence: Evidence | null = null): void {
    const job = this.store.getJob(jobId)
    if (job === undefined) return
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'quota_exhausted') return
    const branch = result.branch ?? job.branch
    const prUrl = result.prUrl ?? job.pr_url
    const issueUrl = result.issueUrl ?? job.issue_url
    const reviewScore = result.reviewScore ?? job.review_score
    this.store.updateJob(jobId, {
      status: result.status,
      branch,
      pr_url: prUrl,
      issue_url: issueUrl,
      review_score: reviewScore,
      attribution_json: attribution === null ? job.attribution_json : JSON.stringify(attribution),
      evidence_json: evidence === null ? job.evidence_json : JSON.stringify(evidence),
      summary: (result.summary ?? job.summary ?? '').slice(0, 4000),
      error: (result.error ?? job.error ?? '').slice(0, 2000),
      finished_at: nowIso(),
    })
    this.syncWorkItemForJob(job, { status: result.status, prUrl, issueUrl })
    if (job.kind === 'review') this.store.updateRepo(job.repo_id, { last_review_at: nowIso(), last_review_status: result.status })
    else this.store.updateRepo(job.repo_id, { last_status: result.status })
    void this.instances?.clearJobToken(job.repo_id, jobId).catch((error) => {
      log.warn('clear job model token failed', { job: jobId, error: String(error) })
    })
    revoke()
    this.store.audit(job.user_id, `job.${result.status}`, jobId)
    this.store.event(`job_${result.status}`, { userId: job.user_id, repoId: job.repo_id, jobId })
    if (result.status === 'succeeded' && prUrl !== null) this.store.event('pr_open', { userId: job.user_id, repoId: job.repo_id, jobId })
    if (result.status === 'failed') this.store.notify(job.user_id, 'job', `${job.kind === 'review' ? '审核' : '任务'} ${jobId} 失败：${result.error ?? job.error ?? '未知原因'}`)
    if (result.status === 'succeeded' || result.status === 'failed') {
      void this.sendJobEmail(job, result)
      void sendNotificationWebhook(this.config, `job.${result.status}`, {
        text: `${job.kind} job ${job.id} ${result.status}`,
        jobId: job.id,
        repoId: job.repo_id,
        kind: job.kind,
        trigger: job.trigger,
        status: result.status,
        prUrl: prUrl,
        issueUrl: issueUrl,
        summary: result.summary ?? job.summary ?? '',
        error: result.error ?? job.error ?? '',
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
    }
    if (result.status === 'succeeded') {
      void this.afterSucceeded(job, prUrl ?? undefined, issueUrl ?? undefined, attribution).catch((error) => log.warn('post-job side effects failed', { job: jobId, error: String(error) }))
      void this.autoQueueNextStage(jobId).catch((error) => log.warn('auto next stage failed', { job: jobId, error: String(error) }))
    } else {
      void this.captureTeamStats(jobId, attribution).catch((error) => log.warn('team stats capture failed', { job: jobId, error: String(error) }))
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

  private async tryMerge(job: JobRow, prUrl: string, manual: boolean): Promise<{ ok: boolean; message?: string }> {
    if (job.kind !== 'iterate') return { ok: false, message: '只有 iterate 任务可以合并。' }
    let repo = this.store.getRepo(job.repo_id)
    if (repo === undefined) return { ok: false, message: '仓库不存在。' }
    if (repo.repo_role !== 'maintainer') return { ok: false, message: '只有 maintainer 可以合并。' }
    if (!manual && repo.auto_merge !== 1) return { ok: false, message: '自动合并未开启。' }
    if (!this.roleFresh(repo)) {
      const refreshed = await this.refreshRepoAccess(repo)
      if (refreshed === undefined || refreshed.repo_role !== 'maintainer') {
        this.store.audit(job.user_id, 'job.merge_skipped', `${job.id}: stale role check`)
        return { ok: false, message: 'GitHub 权限已过期，请刷新仓库。' }
      }
      repo = refreshed
      if (!manual && repo.auto_merge !== 1) return { ok: false, message: '自动合并未开启。' }
    }
    const match = /\/pull\/(\d+)(?:[/?#]|$)/.exec(prUrl)
    if (match === null) return { ok: false, message: 'PR 链接格式不正确。' }
    const number = Number(match[1])
    const owner = repo.upstream_owner || repo.owner
    const name = repo.upstream_name || repo.name
    try {
      const token = await repoGithubToken(repo, this.config, this.githubApp, this.store)
      const client = new GithubClient(token, this.config.github.apiBase)
      const pr = await client.getPullRequest(owner, name, number)
      if (pr.merged) {
        this.store.updateJobsPrState(prUrl, 'merged')
        return { ok: false, message: 'PR 已合并。' }
      }
      if (pr.state !== 'open' || pr.draft) return { ok: false, message: 'PR 不是 open 状态。' }
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
      const requestedMethod = repo.merge_method === 'merge' || repo.merge_method === 'rebase' ? repo.merge_method : 'squash'
      const merged = await client.mergePullRequest(owner, name, number, { sha: pr.headSha, mergeMethod: requestedMethod })
      if (merged.merged) {
        const workItem = job.work_item_id === null ? undefined : this.store.getWorkItem(job.work_item_id)
        if (workItem !== undefined) {
          this.store.updateWorkItem(workItem.id, { state: 'merged', pr_state: 'merged', merged_at: nowIso(), merge_commit: merged.sha ?? null })
        }
        this.store.updateJobsPrState(prUrl, 'merged')
        this.store.audit(job.user_id, manual ? 'job.manually_merged' : 'job.auto_merged', `${job.id}: PR ${number} ${merged.sha ?? ''}`)
        this.store.event('job_auto_merged', { userId: job.user_id, repoId: job.repo_id, jobId: job.id, meta: `pr=${number}` })
        return { ok: true, message: '已合并。' }
      }
      this.store.audit(job.user_id, 'job.merge_skipped', `${job.id}: ${merged.message ?? 'merge rejected'}`)
      return { ok: false, message: merged.message ?? 'GitHub 拒绝了合并。' }
    } catch (error) {
      this.store.audit(job.user_id, 'job.merge_failed', `${job.id}: ${String(error).slice(0, 300)}`)
      log.warn('merge failed', { job: job.id, pr: number, error: String(error) })
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  private async maybeAutoMerge(job: JobRow, prUrl: string): Promise<void> {
    await this.tryMerge(job, prUrl, false)
  }

  async mergeCleanPrs(repoId: string): Promise<{ merged: string[]; skipped: Array<{ jobId: string; message: string }> }> {
    const repo = this.store.getRepo(repoId)
    if (repo === undefined) return { merged: [], skipped: [] }
    const merged: string[] = []
    const skipped: Array<{ jobId: string; message: string }> = []
    const seen = new Set<string>()
    for (const job of this.store.listPrJobsForRepo(repoId, 10)) {
      if (job.pr_url === null || seen.has(job.pr_url)) continue
      seen.add(job.pr_url)
      const result = await this.manualMerge(repo, job)
      if (result.ok) merged.push(job.id)
      else skipped.push({ jobId: job.id, message: result.message ?? 'skipped' })
    }
    return { merged, skipped }
  }

  async manualMerge(repo: RepoRow, job: JobRow): Promise<{ ok: boolean; message?: string }> {
    if (job.repo_id !== repo.id) return { ok: false, message: '任务不属于这个仓库。' }
    if (job.pr_url === null) return { ok: false, message: '这个任务没有 PR。' }
    return this.tryMerge(job, job.pr_url, true)
  }

  private async resolveHeadSha(repo: RepoRow, prUrl: string): Promise<string | undefined> {
    const match = /\/pull\/(\d+)(?:[/?#]|$)/.exec(prUrl)
    if (match === null) return undefined
    try {
      const token = await repoGithubToken(repo, this.config, this.githubApp, this.store)
      const client = new GithubClient(token, this.config.github.apiBase)
      const pr = await client.getPullRequest(repo.upstream_owner || repo.owner, repo.upstream_name || repo.name, Number(match[1]))
      return pr.headSha
    } catch (error) {
      log.warn('could not resolve PR head', { repo: repo.id, prUrl, error: String(error) })
      return undefined
    }
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
      let input: { prUrl: string; branch: string; baseBranch?: string; reason: string; headSha: string }
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
      else log.info('pending follow-up queued', { repo: repoId, job: result.job?.id })
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
          log.warn('team participation low', { job: jobId, repo: job.repo_id, roles: active })
        }
      }
      return observed
    } catch (error) {
      log.warn('team stats capture failed', { job: jobId, error: String(error) })
      return null
    }
  }

  private async sendJobEmail(job: JobRow, result: { status: 'succeeded' | 'failed' | 'quota_exhausted'; prUrl?: string; issueUrl?: string; reviewScore?: number; summary?: string; error?: string }): Promise<void> {
    if (result.status === 'quota_exhausted') return
    const user = this.store.userById(job.user_id)
    if (user === undefined || user.email_job_updates !== 1) return
    const email = notifyEmail(user)
    if (email === '') return
    const repo = this.store.getRepo(job.repo_id)
    if (repo === undefined) return
    const context = {
      repo: `${repo.upstream_owner || repo.owner}/${repo.upstream_name || repo.name}`,
      jobId: job.id,
      kind: job.kind,
      teamUrl: `${this.config.baseUrl}/repos/${repo.id}/jobs/${job.id}`,
      issueUrl: result.issueUrl ?? job.issue_url,
      prUrl: result.prUrl ?? job.pr_url,
      summary: result.summary ?? job.summary ?? '',
      error: result.error ?? job.error ?? '',
      reviewScore: result.reviewScore ?? job.review_score,
    }
    try {
      const template = result.status === 'succeeded' ? jobSucceededEmail(user, context) : jobFailedEmail(user, context)
      await this.mailer.send({ to: email, ...template })
    } catch (error) {
      log.warn('job email failed', { job: job.id, error: String(error) })
    }
  }

  async followUp(repo: RepoRow, input: { prUrl: string; branch: string; baseBranch?: string; reason: string; headSha: string }): Promise<EnqueueResult> {
    const baseBranch = input.baseBranch ?? (repo.target_branch !== '' ? repo.target_branch : (repo.upstream_default_branch || repo.default_branch))
    if (!isValidBranchName(input.branch) || input.branch === baseBranch || input.branch === repo.upstream_default_branch || input.branch === repo.default_branch) {
      return { ok: false, error: 'follow-up 分支不能是目标分支。', code: 'BRANCH_INVALID' }
    }
    const key = `followup:${repo.id}:${input.prUrl}:${input.headSha}:${input.reason}`.slice(0, 300)
    if (this.store.getSetting(key) !== undefined) return { ok: false, error: '这个失败已经跟进过', code: 'DUPLICATE_FOLLOWUP' }
    const activeJob = this.store.activeJobForRepo(repo.id)
    if (activeJob !== undefined) {
      if (activeJob.kind === 'review') {
        const pendingKey = `pending_followup:${repo.id}:${input.prUrl}:${input.headSha}:${input.reason}`.slice(0, 300)
        this.store.setSetting(pendingKey, JSON.stringify(input))
        return { ok: false, error: '审核结束后会自动跟进', code: 'JOB_ACTIVE' }
      }
      return { ok: false, error: '这个仓库已有任务在运行', code: 'JOB_ACTIVE' }
    }
    this.store.setSetting(key, nowIso())
    const goal = [
      `Follow-up on the existing pull request ${input.prUrl} (branch ${input.branch}).`,
      `Reason: ${input.reason}.`,
      'Continue on the same branch and update the existing PR. Do not open a second PR or create a new issue.',
      'Make the smallest correct fix, add or adjust tests, run the relevant checks, and callback with the branch and PR URL.',
    ].join('\n')
    const result = await this.enqueue(repo, 'followup', goal, 'iterate', { branch: input.branch, prUrl: input.prUrl, baseBranch: input.baseBranch })
    if (!result.ok) this.store.deleteSetting(key)
    return result
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
            log.warn('question email failed', { job: job.id, error: String(error) })
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
        const next = Number.isFinite(last) ? new Date(last + repo.interval_minutes * 60_000) : new Date()
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
    const autoMergeEnabled = repo.repo_role === 'maintainer' && repo.auto_merge === 1 && job.kind === 'iterate'
    const body = [
      '<details>',
      `<summary>Fledge automation · ${teamLabel} · job <code>${job.id}</code> (${job.trigger}, ${job.kind})</summary>`,
      '',
      journey === '' ? `Produced by the ${teamLabel} team.` : `Automated run: ${journey}.`,
      '',
      autoMergeEnabled ? 'The maintainer enabled auto-merge for this repository; Fledge may merge only after checks pass and no changes are requested.' : 'Fledge does not merge by default; a human must review and merge.',
      '',
      `- Issue: ${result.issueUrl ?? 'none'}`,
      `- Fledge job: ${this.config.baseUrl}/repos/${job.repo_id}/jobs/${job.id}`,
      '</details>',
    ]
    try {
      const token = await repoGithubToken(repo, this.config, this.githubApp, this.store)
      const client = new GithubClient(token, this.config.github.apiBase)
      await client.comment(owner, name, number, body.join('\n'))
      log.info('automation comment posted', { job: job.id, pr: number })
    } catch (error) {
      log.warn('automation comment failed', { job: job.id, pr: number, error: String(error) })
    }
  }

  async handleCallback(jobId: string, secret: string, payload: CallbackPayload): Promise<{ ok: boolean; status?: number; error?: string }> {
    const job = this.store.getJob(jobId)
    if (job === undefined) return { ok: false, status: 404, error: 'job not found' }
    if (!safeEqual(sha256Hex(secret), job.callback_hash)) return { ok: false, status: 401, error: 'bad callback secret' }
    if (job.status !== 'queued' && job.status !== 'running') return { ok: false, status: 409, error: 'job already finished' }
    const status = payload.status
    if (status !== 'succeeded' && status !== 'failed' && status !== 'running') return { ok: false, status: 400, error: 'invalid status' }
    this.store.touchJobCallback(jobId)
    const branch = typeof payload.branch === 'string' ? payload.branch.slice(0, 300) : undefined
    const prUrl = typeof payload.prUrl === 'string' && payload.prUrl.startsWith('https://') ? payload.prUrl.slice(0, 500) : undefined
    const issueUrl = typeof payload.issueUrl === 'string' && payload.issueUrl.startsWith('https://') ? payload.issueUrl.slice(0, 500) : undefined
    const reviewScore = typeof payload.reviewScore === 'number' && Number.isFinite(payload.reviewScore) ? Math.max(0, Math.min(100, Math.round(payload.reviewScore))) : undefined
    const summary = progressSummary(payload.summary)
    const error = typeof payload.error === 'string' ? payload.error.slice(0, 2000) : undefined
    const attribution = parseAttribution(payload.attribution)
    const evidence = parseEvidence(payload.evidence)
    const checkpoint = typeof payload.checkpoint === 'string' ? payload.checkpoint.trim().slice(0, 4000) : undefined
    if (branch !== undefined && (!isValidBranchName(branch) || branch === job.base_branch)) {
      return { ok: false, status: 400, error: 'invalid branch' }
    }
    const followUps: ReviewFollowUp[] = job.kind === 'review' && Array.isArray(payload.followUps)
      ? payload.followUps.flatMap((entry) => {
          if (entry === null || typeof entry !== 'object') return []
          const value = entry as Record<string, unknown>
          const prUrl = typeof value.prUrl === 'string' && value.prUrl.startsWith('https://') ? value.prUrl.slice(0, 500) : ''
          const branch = typeof value.branch === 'string' ? value.branch.trim().slice(0, 300) : ''
          if (prUrl === '' || branch === '') return []
          return [{
            prUrl,
            branch,
            ...(typeof value.baseBranch === 'string' ? { baseBranch: value.baseBranch.slice(0, 300) } : {}),
            ...(typeof value.headSha === 'string' ? { headSha: value.headSha.slice(0, 100) } : {}),
            ...(typeof value.reason === 'string' ? { reason: value.reason.slice(0, 300) } : {}),
          }]
        }).slice(0, 10)
      : []
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
      if (job.status === 'queued') {
        if (job.kind === 'review') this.store.updateRepo(job.repo_id, { last_review_status: 'running' })
        else this.store.updateRepo(job.repo_id, { last_status: 'running' })
      }
      return { ok: true }
    }
    const revoke = (): void => {
      const row = this.store.findApiToken(job.platform_token_hash ?? '')
      if (row !== undefined) this.store.revokeApiToken(row.id, row.user_id)
    }
    if (status === 'succeeded') {
      const repo = this.store.getRepo(job.repo_id)
      const stageMode = parseStageMode(repo?.stage_mode) ?? 'off'
      const stage = checkStage(stageMode, job.kind, evidence, attribution, reviewScore)
      if (!stage.ok) {
        const detail = stage.errors.join('；')
        const meta = `stage:${stageMode}:${stage.errors.join('|')}`.slice(0, 500)
        this.store.event('stage_evidence_missing', { userId: job.user_id, repoId: job.repo_id, jobId, meta })
        this.store.audit(job.user_id, stageMode === 'enforced' ? 'job.stage_missing' : 'job.stage_missing_shadow', `${jobId}: ${detail}`.slice(0, 600))
        if (stageMode === 'enforced') {
          const message = `STAGE_EVIDENCE_MISSING: ${detail}`
          this.store.notify(job.user_id, 'job', `${job.kind} 任务 ${jobId} 缺少阶段证据：${detail}`)
          this.finish(jobId, { status: 'failed', branch, prUrl, issueUrl, summary, error: message }, revoke, attribution, evidence)
          return { ok: false, status: 422, error: message }
        }
      }
    }
    if (checkpoint !== undefined) this.store.updateJob(jobId, { checkpoint })
    this.finish(jobId, { status, branch, prUrl, issueUrl, reviewScore, summary, error }, revoke, attribution, evidence)
    if (status === 'succeeded' && followUps.length > 0) {
      await this.queueReviewFollowUps(job, followUps)
      await this.releasePendingFollowups(job.repo_id)
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
    if (status === 'succeeded' && prUrl !== undefined) await this.maybeAutoMerge(job, prUrl)
    return { ok: true }
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
      const token = await repoGithubToken(repo, this.config, this.githubApp, this.store)
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
        autoMerge: job.kind === 'iterate' && repo.repo_role === 'maintainer' && repo.auto_merge === 1,
        canReview: repo.can_review === 1,
        canCreateIssue: repo.can_create_issue === 1,
      }
    } catch {
      return { ok: false, status: 500, error: 'credential unavailable' }
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.tickOnce()
    } finally {
      this.ticking = false
    }
  }

  private async tickOnce(): Promise<void> {
    const handled = new Set<string>()
    const stalledBefore = addMinutes(-this.config.runner.stallMinutes)
    for (const job of this.store.stalledRunningJobs(stalledBefore)) {
      handled.add(job.id)
      const revoke = (): void => {
        const row = job.platform_token_hash === null ? undefined : this.store.findApiToken(job.platform_token_hash)
        if (row !== undefined) this.store.revokeApiToken(row.id, row.user_id)
      }
      this.finish(job.id, { status: 'failed', error: `任务停滞：超过 ${this.config.runner.stallMinutes} 分钟没有心跳。` }, revoke)
    }
    const staleBefore = addMinutes(-this.config.runner.timeoutMinutes)
    const staleJobs = [...this.store.staleQueuedJobs(addMinutes(-10)), ...this.store.staleRunningJobs(staleBefore)].filter((job) => !handled.has(job.id))
    for (const job of staleJobs) {
      const revoke = (): void => {
        const row = job.platform_token_hash === null ? undefined : this.store.findApiToken(job.platform_token_hash)
        if (row !== undefined) this.store.revokeApiToken(row.id, row.user_id)
      }
      this.finish(job.id, { status: 'failed', error: job.status === 'queued' ? '任务排队超时未启动' : '任务超时未回报' }, revoke)
    }
    this.store.deleteExpiredJobTokens()
    if (Date.now() - this.lastPruneAt > 60 * 60 * 1_000) {
      this.lastPruneAt = Date.now()
      this.store.pruneOldData()
    }
    if (this.config.env !== 'test' && this.instances !== undefined) {
      await this.instances.healthSweep().catch((error) => log.warn('instance health sweep failed', { error: String(error) }))
    }
    await this.releaseAllPendingFollowups().catch((error) => log.warn('pending follow-up recovery failed', { error: String(error) }))
    await this.notifyQuestions().catch((error) => log.warn('question notification pass failed', { error: String(error) }))
    await this.maybeSendDigests().catch((error) => log.warn('daily digest pass failed', { error: String(error) }))
    if (this.store.countActiveJobs() >= 2) return
    for (const listed of this.store.listReviewRepos()) {
      if (this.store.countActiveJobs() >= 2) break
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
      log.info('scheduled review', { repo: `${repo.owner}/${repo.name}`, ok: result.ok, job: result.job?.id })
    }
    for (const listed of this.store.listAutoRepos()) {
      if (this.store.countActiveJobs() >= 2) break
      let repo = listed
      if (repo.auto_merge === 1 && repo.repo_role === 'maintainer' && !this.roleFresh(repo)) {
        const refreshed = await this.refreshRepoAccess(repo)
        if (refreshed !== undefined) repo = refreshed
      }
      if (repo.repo_role !== 'maintainer' && repo.repo_role !== 'developer') continue
      if (!this.userReadyForScheduling(repo.user_id)) continue
      if (!this.instanceReady(repo.id)) continue
      if (this.store.activeJobForRepo(repo.id) !== undefined) continue
      if (!this.due(repo)) continue
      const result = await this.enqueue(repo, 'schedule', undefined, 'iterate')
      if (!result.ok && result.code === 'QUOTA_EXHAUSTED') break
      log.info('scheduled job', { repo: `${repo.owner}/${repo.name}`, ok: result.ok, job: result.job?.id })
    }
  }

  private userReadyForScheduling(userId: string): boolean {
    return this.store.userById(userId)?.status === 'approved'
  }

  private instanceReady(repoId: string): boolean {
    if (this.config.flybot.instanceImage === '') return true
    return this.store.getRepoInstance(repoId)?.status === 'ready'
  }

  private due(repo: RepoRow): boolean {
    if (repo.last_run_at === null) return true
    const last = Date.parse(repo.last_run_at)
    if (!Number.isFinite(last)) return true
    return Date.now() - last >= Math.max(15, repo.interval_minutes) * 60_000
  }

  private dueReview(repo: RepoRow): boolean {
    if (repo.last_review_at === null) return true
    const last = Date.parse(repo.last_review_at)
    if (!Number.isFinite(last)) return true
    return Date.now() - last >= Math.max(15, repo.review_interval_minutes) * 60_000
  }

  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => {
      this.tick().catch((error) => log.error('scheduler tick failed', { error: String(error) }))
    }, 60_000)
    this.timer.unref()
    void this.tick().catch((error) => log.error('scheduler first tick failed', { error: String(error) }))
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }
}

