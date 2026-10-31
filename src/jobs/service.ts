import type { Config } from '../config.js'
import type { JobRow, RepoRow, Store } from '../db.js'
import type { Mailer } from '../email/mailer.js'
import { QuotaNotifier } from '../gateway/notifier.js'
import { quotaView } from '../gateway/quota.js'
import { log } from '../lib/log.js'
import { decryptSecret, randomToken, safeEqual, sha256Hex } from '../lib/secrets.js'
import { addMinutes, nowIso } from '../lib/time.js'
import type { JobKind, RepoRef, Runner } from './runner.js'
import type { InstanceManager } from '../flybot/instances.js'

export const DEFAULT_GOAL =
  'Review this repository for one high-value defect or improvement. Write a failing test first, implement the smallest correct fix, run the relevant tests, and open a pull request. Do not refactor unrelated code.'

export const DEFAULT_REVIEW_GOAL =
  'Review every open pull request on the upstream repository. For each PR, inspect the diff, tests and risk, give a score from 0 to 100 with a short rationale, and post a review comment. Do not approve, merge, push or change repository settings. Summarize the scores and the most important issues.'

export interface EnqueueResult {
  ok: boolean
  job?: JobRow
  error?: string
  code?: string
}

export interface CallbackPayload {
  status?: unknown
  branch?: unknown
  prUrl?: unknown
  issueUrl?: unknown
  reviewScore?: unknown
  summary?: unknown
  error?: unknown
}

export class Jobs {
  private timer: NodeJS.Timeout | null = null
  private readonly quotaNotifier: QuotaNotifier

  constructor(
    private readonly store: Store,
    private readonly config: Config,
    private readonly runner: Runner,
    private readonly mailer: Mailer,
    private readonly instances?: InstanceManager,
  ) {
    this.quotaNotifier = new QuotaNotifier(store, mailer, config)
  }

  get notifier(): QuotaNotifier {
    return this.quotaNotifier
  }

  async enqueue(repo: RepoRow, trigger: 'manual' | 'schedule', goalOverride?: string, kind: JobKind = 'iterate'): Promise<EnqueueResult> {
    if (repo.enabled !== 1) return { ok: false, error: '这个仓库已停用', code: 'REPO_DISABLED' }
    if (kind === 'review' && (repo.reviewer_enabled !== 1 || repo.can_review !== 1)) {
      return { ok: false, error: '这个仓库没有启用审核角色', code: 'REVIEW_DISABLED' }
    }
    const active = this.store.activeJobForRepo(repo.id)
    if (active !== undefined) return { ok: false, error: '这个仓库已有任务在运行', code: 'JOB_ACTIVE' }
    const user = this.store.userById(repo.user_id)
    if (user === undefined || user.status !== 'approved') return { ok: false, error: '用户不可用', code: 'USER_UNAVAILABLE' }

    const baseGoal = kind === 'review' ? DEFAULT_REVIEW_GOAL : (repo.goal !== '' ? repo.goal : DEFAULT_GOAL)
    const goal = (goalOverride ?? baseGoal).slice(0, 4000)
    const jobId = `job_${randomToken(10)}`
    const callbackSecret = randomToken(24)
    const callbackHash = sha256Hex(callbackSecret)
    const platformFunded = user.own_llm_base_url === null || user.own_llm_base_url === '' || user.own_llm_key_enc === null

    if (platformFunded && quotaView(user, this.config).exhausted) {
      const job = this.store.createJob({ id: jobId, repoId: repo.id, userId: user.id, trigger, goal, callbackHash, platformTokenHash: '', kind })
      this.store.updateJob(job.id, { status: 'quota_exhausted', error: '平台额度已用完，请在 Settings → Model 配置自己的模型 API。', finished_at: nowIso() })
      this.store.updateRepo(repo.id, { last_status: 'quota_exhausted', last_run_at: nowIso() })
      await this.quotaNotifier.notify(user)
      return { ok: false, error: '平台额度已用完，请先配置自己的模型 API', code: 'QUOTA_EXHAUSTED', job: this.store.getJob(job.id) }
    }

    let flybot: { url: string; token: string; sessionId: string } | undefined
    if (this.config.flybot.instanceImage !== '') {
      if (this.instances === undefined) return { ok: false, error: 'FlyBot 实例管理器未配置', code: 'INSTANCE_UNAVAILABLE' }
      try {
        const bridge = this.instances.bridgeFor(repo.id)
        const sessionId = kind === 'review' ? bridge.team.reviewer ?? bridge.team.lead : bridge.team.lead
        flybot = { url: bridge.url, token: bridge.token, sessionId }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error), code: 'INSTANCE_NOT_READY' }
      }
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
    const job = this.store.createJob({ id: jobId, repoId: repo.id, userId: user.id, trigger, goal, callbackHash, platformTokenHash: tokenRow.token_hash, kind })
    if (kind === 'review') this.store.updateRepo(repo.id, { last_review_status: 'queued' })
    else this.store.updateRepo(repo.id, { last_run_at: nowIso(), last_status: 'queued' })
    this.store.audit(user.id, 'job.enqueued', `${job.id} ${repo.owner}/${repo.name} (${kind}, ${trigger})`)

    const revoke = (): void => {
      const row = this.store.findApiToken(tokenRow.token_hash)
      if (row !== undefined) this.store.revokeApiToken(row.id, row.user_id)
    }

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

  private finish(jobId: string, result: { status: 'succeeded' | 'failed'; branch?: string; prUrl?: string; issueUrl?: string; reviewScore?: number; summary?: string; error?: string }, revoke: () => void): void {
    const job = this.store.getJob(jobId)
    if (job === undefined) return
    this.store.updateJob(jobId, {
      status: result.status,
      branch: result.branch ?? null,
      pr_url: result.prUrl ?? null,
      issue_url: result.issueUrl ?? null,
      review_score: result.reviewScore ?? null,
      summary: (result.summary ?? '').slice(0, 4000),
      error: (result.error ?? '').slice(0, 2000),
      finished_at: nowIso(),
    })
    if (job.kind === 'review') this.store.updateRepo(job.repo_id, { last_review_at: nowIso(), last_review_status: result.status })
    else this.store.updateRepo(job.repo_id, { last_status: result.status })
    revoke()
    this.store.audit(job.user_id, `job.${result.status}`, jobId)
    if (result.status === 'failed') this.store.notify(job.user_id, 'job', `${job.kind === 'review' ? '审核' : '任务'} ${jobId} 失败：${result.error ?? '未知原因'}`)
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
    const summary = typeof payload.summary === 'string' ? payload.summary.slice(0, 4000) : undefined
    const error = typeof payload.error === 'string' ? payload.error.slice(0, 2000) : undefined
    if (status === 'running') {
      this.store.updateJob(jobId, { status: 'running', ...(branch === undefined ? {} : { branch }), ...(summary === undefined ? {} : { summary }) })
      return { ok: true }
    }
    const revoke = (): void => {
      const row = this.store.findApiToken(job.platform_token_hash ?? '')
      if (row !== undefined) this.store.revokeApiToken(row.id, row.user_id)
    }
    this.finish(jobId, { status, branch, prUrl, issueUrl, reviewScore, summary, error }, revoke)
    return { ok: true }
  }

  credential(jobId: string, secret: string): {
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
  } {
    const job = this.store.getJob(jobId)
    if (job === undefined) return { ok: false, status: 404, error: 'job not found' }
    if (!safeEqual(sha256Hex(secret), job.callback_hash)) return { ok: false, status: 401, error: 'bad credential secret' }
    if (job.status !== 'queued' && job.status !== 'running') return { ok: false, status: 409, error: 'job already finished' }
    const repo = this.store.getRepo(job.repo_id)
    if (repo === undefined) return { ok: false, status: 404, error: 'repo not found' }
    try {
      const token = decryptSecret(repo.token_enc, this.config.tokenEncryptionKey)
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
    for (const job of this.store.staleRunningJobs(staleBefore)) {
      this.finish(job.id, { status: 'failed', error: '任务超时未回报' }, () => {})
    }
    this.store.deleteExpiredJobTokens()
    if (this.store.countActiveJobs() >= 2) return
    for (const repo of this.store.listReviewRepos()) {
      if (this.store.countActiveJobs() >= 2) break
      if (!this.instanceReady(repo.id)) continue
      if (this.store.activeJobForRepo(repo.id) !== undefined) continue
      if (!this.dueReview(repo)) continue
      const result = await this.enqueue(repo, 'schedule', undefined, 'review')
      if (!result.ok && result.code === 'QUOTA_EXHAUSTED') break
      log.info('scheduled review', { repo: `${repo.owner}/${repo.name}`, ok: result.ok, job: result.job?.id })
    }
    for (const repo of this.store.listAutoRepos()) {
      if (this.store.countActiveJobs() >= 2) break
      if (!this.instanceReady(repo.id)) continue
      if (this.store.activeJobForRepo(repo.id) !== undefined) continue
      if (!this.due(repo)) continue
      const result = await this.enqueue(repo, 'schedule')
      if (!result.ok && result.code === 'QUOTA_EXHAUSTED') break
      log.info('scheduled job', { repo: `${repo.owner}/${repo.name}`, ok: result.ok, job: result.job?.id })
    }
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

