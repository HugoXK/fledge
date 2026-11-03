import type { Config } from '../config.js'
import type { JobRow, RepoRow, Store, UserRow } from '../db.js'
import type { Mailer } from '../email/mailer.js'
import { QuotaNotifier } from '../gateway/notifier.js'
import { quotaView } from '../gateway/quota.js'
import { dailyDigestEmail, jobAttentionEmail, jobFailedEmail, jobSucceededEmail, type DigestInput } from '../email/templates.js'
import { notifyEmail, replyAddressFor } from '../email/recipient.js'
import { log } from '../lib/log.js'
import { isValidBranchName } from '../lib/branches.js'
import { attributionSentence, parseAttribution, type Attribution } from '../lib/attribution.js'
import { parseEvidence, type Evidence } from '../lib/evidence.js'
import { randomToken, safeEqual, sha256Hex } from '../lib/secrets.js'
import { addMinutes, nowIso } from '../lib/time.js'
import { GithubClient } from '../repos/github.js'
import { GithubApp } from '../repos/app.js'
import { repoGithubToken } from '../repos/token.js'
import { parseTeam } from '../flybot/instances.js'
import type { JobKind, RepoRef, Runner } from './runner.js'
import type { InstanceManager } from '../flybot/instances.js'

export const DEFAULT_GOAL =
  'Review this repository for one high-value defect or improvement. Write a failing test first, implement the smallest correct fix, run the relevant tests, and open a pull request. Do not refactor unrelated code.'

export const DEFAULT_RESEARCH_GOAL =
  'Analyze this repository and return one evidence-backed report for the human: product value, current state, risks, options, a recommendation and the next work direction. Do not write code, create branches, open issues or PRs, comment on GitHub or change settings.'

export const DEFAULT_REVIEW_GOAL =
  'Review every open pull request on the upstream repository. For each PR, inspect the diff, tests and risk, give a score from 0 to 100 with a short rationale, and post a review comment. Do not approve, merge, push or change repository settings. Summarize the scores and the most important issues.'

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

  async enqueue(repo: RepoRow, trigger: 'manual' | 'schedule' | 'followup', goalOverride?: string, kind: JobKind = 'iterate', options: { branch?: string; prUrl?: string; baseBranch?: string } = {}): Promise<EnqueueResult> {
    if (repo.enabled !== 1) return { ok: false, error: '这个仓库已停用', code: 'REPO_DISABLED' }
    if (kind === 'review' && (repo.reviewer_enabled !== 1 || repo.can_review !== 1)) {
      return { ok: false, error: '这个仓库没有启用审核角色', code: 'REVIEW_DISABLED' }
    }
    const active = this.store.activeJobForRepo(repo.id)
    if (active !== undefined) return { ok: false, error: '这个仓库已有任务在运行', code: 'JOB_ACTIVE' }
    const user = this.store.userById(repo.user_id)
    if (user === undefined || user.status !== 'approved') return { ok: false, error: '用户不可用', code: 'USER_UNAVAILABLE' }

    const repoBaseBranch = repo.target_branch !== '' ? repo.target_branch : (repo.upstream_default_branch || repo.default_branch)
    const baseBranch = (options.baseBranch ?? repoBaseBranch).trim()
    if (!isValidBranchName(baseBranch)) return { ok: false, error: '目标分支格式不正确。', code: 'BRANCH_INVALID' }
    const baseGoal = kind === 'review'
      ? DEFAULT_REVIEW_GOAL
      : kind === 'research'
        ? (repo.goal !== '' ? repo.goal : DEFAULT_RESEARCH_GOAL)
        : (repo.goal !== '' ? repo.goal : DEFAULT_GOAL)
    const goal = (goalOverride ?? baseGoal).slice(0, 4000)
    const jobId = `job_${randomToken(10)}`
    const callbackSecret = randomToken(24)
    const callbackHash = sha256Hex(callbackSecret)
    const platformFunded = user.own_llm_base_url === null || user.own_llm_base_url === '' || user.own_llm_key_enc === null

    if (platformFunded && quotaView(user, this.config).exhausted) {
      const job = this.store.createJob({ id: jobId, repoId: repo.id, userId: user.id, trigger, goal, callbackHash, platformTokenHash: '', kind })
      this.store.updateJob(job.id, { status: 'quota_exhausted', error: '平台额度已用完，请在 Settings → Model 配置自己的模型 API。', finished_at: nowIso() })
      if (kind === 'review') this.store.updateRepo(repo.id, { last_review_status: 'quota_exhausted' })
      else if (kind === 'iterate' || kind === 'research') this.store.updateRepo(repo.id, { last_status: 'quota_exhausted', last_run_at: nowIso() })
      else this.store.updateRepo(repo.id, { last_status: 'quota_exhausted' })
      await this.quotaNotifier.notify(user)
      return { ok: false, error: '平台额度已用完，请先配置自己的模型 API', code: 'QUOTA_EXHAUSTED', job: this.store.getJob(job.id) }
    }

    let flybot: { url: string; token: string; sessionId: string; role: 'chief' | 'lead' | 'reviewer'; leadName: string } | undefined
    if (this.config.flybot.instanceImage !== '') {
      if (this.instances === undefined) return { ok: false, error: 'FlyBot 实例管理器未配置', code: 'INSTANCE_UNAVAILABLE' }
      try {
        await this.instances.ensurePlaybook(repo.id).catch((error) => {
          log.warn('team playbook not refreshed', { repo: repo.id, error: String(error) })
        })
        const bridge = this.instances.bridgeFor(repo.id)
        const reviewer = kind === 'review' ? bridge.team.reviewer : null
        const role = reviewer !== null && reviewer !== '' ? 'reviewer' : bridge.team.chief !== '' ? 'chief' : 'lead'
        const sessionId = reviewer !== null && reviewer !== '' ? reviewer : bridge.team.chief !== '' ? bridge.team.chief : bridge.team.lead
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
      expiresAt: addMinutes(this.config.runner.timeoutMinutes + 60),
    })
    const priorJobs = this.store.listJobs(user.id, 1).length
    const job = this.store.createJob({ id: jobId, repoId: repo.id, userId: user.id, trigger, goal, callbackHash, platformTokenHash: tokenRow.token_hash, kind, baseBranch })
    if (options.branch !== undefined || options.prUrl !== undefined) {
      this.store.updateJob(job.id, { branch: options.branch ?? null, pr_url: options.prUrl ?? null })
      job.branch = options.branch ?? null
      job.pr_url = options.prUrl ?? null
    }
    this.store.event('job_enqueued', { userId: user.id, repoId: repo.id, jobId: job.id, meta: `${kind}:${trigger}` })
    if (priorJobs === 0) this.store.event('first_job_start', { userId: user.id, repoId: repo.id, jobId: job.id })
    if (kind === 'review') this.store.updateRepo(repo.id, { last_review_status: 'queued' })
    else if (kind === 'iterate' || kind === 'research') this.store.updateRepo(repo.id, { last_run_at: nowIso(), last_status: 'queued' })
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
        canReview: repo.can_review === 1,
        canCreateIssue: repo.can_create_issue === 1,
        callback: { url: `${this.config.baseUrl}/api/jobs/${job.id}/callback`, secret: callbackSecret },
        credential: { url: `${this.config.baseUrl}/api/jobs/${job.id}/credential`, secret: callbackSecret },
        platform: { baseUrl: `${this.config.baseUrl}/v1`, model: this.config.llm.model, token: platformToken },
        ...(flybot === undefined ? {} : { flybot }),
        timeoutMinutes: this.config.runner.timeoutMinutes,
      })
      if (result.status === 'running') {
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

  private finish(jobId: string, result: { status: 'succeeded' | 'failed' | 'quota_exhausted'; branch?: string; prUrl?: string; issueUrl?: string; reviewScore?: number; summary?: string; error?: string }, revoke: () => void, attribution: Attribution | null = null, evidence: Evidence | null = null): void {
    const job = this.store.getJob(jobId)
    if (job === undefined) return
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
    if (job.kind === 'review') this.store.updateRepo(job.repo_id, { last_review_at: nowIso(), last_review_status: result.status })
    else this.store.updateRepo(job.repo_id, { last_status: result.status })
    void this.instances?.clearJobToken(job.repo_id, jobId).catch((error) => {
      log.warn('clear job model token failed', { job: jobId, error: String(error) })
    })
    revoke()
    void this.releasePendingFollowups(job.repo_id)
    this.store.audit(job.user_id, `job.${result.status}`, jobId)
    this.store.event(`job_${result.status}`, { userId: job.user_id, repoId: job.repo_id, jobId })
    if (result.status === 'succeeded' && prUrl !== null) this.store.event('pr_open', { userId: job.user_id, repoId: job.repo_id, jobId })
    if (result.status === 'failed') this.store.notify(job.user_id, 'job', `${job.kind === 'review' ? '审核' : '任务'} ${jobId} 失败：${result.error ?? job.error ?? '未知原因'}`)
    if (result.status === 'succeeded') void this.postAutomationComment(job, { prUrl: prUrl ?? undefined, issueUrl: issueUrl ?? undefined }, attribution)
    if (result.status === 'succeeded' || result.status === 'failed') void this.sendJobEmail(job, result)
    void this.captureTeamStats(jobId)
  }

  private async releasePendingFollowups(repoId: string): Promise<void> {
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

  private async captureTeamStats(jobId: string): Promise<void> {
    if (this.instances === undefined || this.config.flybot.instanceImage === '') return
    const job = this.store.getJob(jobId)
    if (job === undefined) return
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
      this.store.updateJob(jobId, { team_stats_json: JSON.stringify(stats) })
      this.store.event('team_stats', { userId: job.user_id, repoId: job.repo_id, jobId })
      if (job.kind === 'iterate' || job.kind === 'research') {
        const active = stats.filter((entry) => entry.calls > 0).map((entry) => entry.role)
        if (active.length === 1 && active[0] === 'lead') {
          const repo = this.store.getRepo(job.repo_id)
          const label = repo === undefined ? job.repo_id : `${repo.upstream_owner || repo.owner}/${repo.upstream_name || repo.name}`
          this.store.notify(job.user_id, 'team', `${label} 的本次任务只有 Lead 参与，其他团队角色没有实际介入。`)
          this.store.event('team_participation_low', { userId: job.user_id, repoId: job.repo_id, jobId, meta: 'lead-only' })
          log.warn('team participation low', { job: jobId, repo: job.repo_id, roles: active })
        }
      }
    } catch (error) {
      log.warn('team stats capture failed', { job: jobId, error: String(error) })
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
    const body = [
      '<details>',
      `<summary>Fledge automation · ${teamLabel} · job <code>${job.id}</code> (${job.trigger}, ${job.kind})</summary>`,
      '',
      journey === '' ? `Produced by the ${teamLabel} team.` : `Automated run: ${journey}.`,
      '',
      'Fledge never merges; a human must review and merge.',
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
    const branch = typeof payload.branch === 'string' ? payload.branch.slice(0, 300) : undefined
    const prUrl = typeof payload.prUrl === 'string' && payload.prUrl.startsWith('https://') ? payload.prUrl.slice(0, 500) : undefined
    const issueUrl = typeof payload.issueUrl === 'string' && payload.issueUrl.startsWith('https://') ? payload.issueUrl.slice(0, 500) : undefined
    const reviewScore = typeof payload.reviewScore === 'number' && Number.isFinite(payload.reviewScore) ? Math.max(0, Math.min(100, Math.round(payload.reviewScore))) : undefined
    const summary = progressSummary(payload.summary)
    const error = typeof payload.error === 'string' ? payload.error.slice(0, 2000) : undefined
    const attribution = parseAttribution(payload.attribution)
    const evidence = parseEvidence(payload.evidence)
    const checkpoint = typeof payload.checkpoint === 'string' ? payload.checkpoint.trim().slice(0, 4000) : undefined
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
    if (checkpoint !== undefined) this.store.updateJob(jobId, { checkpoint })
    this.finish(jobId, { status, branch, prUrl, issueUrl, reviewScore, summary, error }, revoke, attribution, evidence)
    if (status === 'succeeded' && followUps.length > 0) await this.queueReviewFollowUps(job, followUps)
    return { ok: true }
  }

  private async queueReviewFollowUps(job: JobRow, followUps: ReviewFollowUp[]): Promise<void> {
    const repo = this.store.getRepo(job.repo_id)
    if (repo === undefined) return
    for (const follow of followUps) {
      const input = {
        prUrl: follow.prUrl,
        branch: follow.branch,
        ...(follow.baseBranch === undefined ? {} : { baseBranch: follow.baseBranch }),
        reason: follow.reason ?? 'review requested changes',
        headSha: follow.headSha ?? '',
      }
      const result = await this.followUp(repo, input)
      if (!result.ok && result.code !== 'DUPLICATE_FOLLOWUP') {
        log.warn('review follow-up not queued', { repo: repo.id, prUrl: follow.prUrl, code: result.code, error: result.error })
      }
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
      const upstream: RepoRef = {
        owner: repo.upstream_owner || repo.owner,
        name: repo.upstream_name || repo.name,
        defaultBranch: repo.upstream_default_branch || repo.default_branch,
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
        defaultBranch: upstream.defaultBranch,
        upstream,
        fork,
        isFork: repo.is_fork === 1,
        permission: repo.permission,
        canReview: repo.can_review === 1,
        canCreateIssue: repo.can_create_issue === 1,
      }
    } catch {
      return { ok: false, status: 500, error: 'credential unavailable' }
    }
  }

  async tick(): Promise<void> {
    const staleBefore = addMinutes(-this.config.runner.timeoutMinutes)
    const staleJobs = [...this.store.staleQueuedJobs(addMinutes(-10)), ...this.store.staleRunningJobs(staleBefore)]
    for (const job of staleJobs) {
      const revoke = (): void => {
        const row = job.platform_token_hash === null ? undefined : this.store.findApiToken(job.platform_token_hash)
        if (row !== undefined) this.store.revokeApiToken(row.id, row.user_id)
      }
      this.finish(job.id, { status: 'failed', error: job.status === 'queued' ? '任务排队超时未启动' : '任务超时未回报' }, revoke)
    }
    this.store.deleteExpiredJobTokens()
    await this.notifyQuestions().catch((error) => log.warn('question notification pass failed', { error: String(error) }))
    await this.maybeSendDigests().catch((error) => log.warn('daily digest pass failed', { error: String(error) }))
    if (this.store.countActiveJobs() >= 2) return
    for (const repo of this.store.listReviewRepos()) {
      if (this.store.countActiveJobs() >= 2) break
      if (!this.userReadyForScheduling(repo.user_id)) continue
      if (!this.instanceReady(repo.id)) continue
      if (this.store.activeJobForRepo(repo.id) !== undefined) continue
      if (!this.dueReview(repo)) continue
      const result = await this.enqueue(repo, 'schedule', undefined, 'review')
      if (!result.ok && result.code === 'QUOTA_EXHAUSTED') break
      log.info('scheduled review', { repo: `${repo.owner}/${repo.name}`, ok: result.ok, job: result.job?.id })
    }
    for (const repo of this.store.listAutoRepos()) {
      if (this.store.countActiveJobs() >= 2) break
      if (!this.userReadyForScheduling(repo.user_id)) continue
      if (!this.instanceReady(repo.id)) continue
      if (this.store.activeJobForRepo(repo.id) !== undefined) continue
      if (!this.due(repo)) continue
      const kind = repo.job_mode === 'research' ? 'research' : 'iterate'
      const result = await this.enqueue(repo, 'schedule', undefined, kind)
      if (!result.ok && result.code === 'QUOTA_EXHAUSTED') break
      log.info('scheduled job', { repo: `${repo.owner}/${repo.name}`, kind, ok: result.ok, job: result.job?.id })
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

