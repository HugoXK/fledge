import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import fastifyCookie from '@fastify/cookie'
import fastifyFormbody from '@fastify/formbody'
import fastifyStatic from '@fastify/static'
import { join } from 'node:path'
import type { Config } from './config.js'
import { assertProductionConfig } from './config.js'
import { openStore, type JobRow, type Store, type UserRow } from './db.js'
import { GithubOAuth } from './auth/github.js'
import { requireAdmin, requireApproved, requireViewer, Sessions } from './auth/session.js'
import { createMailer, type Mailer } from './email/mailer.js'
import { approvedEmail, rejectedEmail } from './email/templates.js'
import { registerGateway } from './gateway/gateway.js'
import { assertSafeModelUrl } from './gateway/modelUrl.js'
import { Jobs } from './jobs/service.js'
import { createRunner, type Runner } from './jobs/runner.js'
import { log } from './lib/log.js'
import { RateLimiter } from './lib/rateLimit.js'
import { decryptSecret, encryptSecret, randomId, randomToken, sha256Hex } from './lib/secrets.js'
import { AGREEMENT_VERSION, agreementHashFor } from './users/agreements.js'
import { addMinutes } from './lib/time.js'
import { isLocale, LOCALE_COOKIE, resolveLocale, translator, type Locale } from './i18n.js'
import { normalizeInterval } from './lib/intervals.js'
import { Approvals } from './users/approval.js'
import {
  adminPage,
  approvalPage,
  dashboardPage,
  landingPage,
  messagePage,
  applyPage,
  applicationStatusPage,
  repoPage,
  workspacePage,
  settingsPage,
  errorPage,
} from './views/pages.js'
import { parseRepoInput, prepareRepo } from './repos/github.js'
import { InstanceManager } from './flybot/instances.js'

export interface BuildOptions {
  config: Config
  store?: Store
  mailer?: Mailer
  runner?: Runner
  startScheduler?: boolean
}

export interface BuiltApp {
  app: FastifyInstance
  store: Store
  jobs: Jobs
  sessions: Sessions
  instances: InstanceManager
  close: () => Promise<void>
}

function httpError(statusCode: number, message: string, code = 'REQUEST_FAILED'): Error {
  return Object.assign(new Error(message), { statusCode, code })
}

function queryText(request: FastifyRequest, name: string): string | undefined {
  const value = (request.query as Record<string, unknown> | undefined)?.[name]
  return typeof value === 'string' && value !== '' ? value.slice(0, 500) : undefined
}

function form(request: FastifyRequest): Record<string, string> {
  const body = (request.body ?? {}) as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

function viewOf(viewer: { user: UserRow; csrfToken: string }): { user: UserRow; csrfToken: string } {
  return { user: viewer.user, csrfToken: viewer.csrfToken }
}

function htmlPage(reply: FastifyReply, status: number, page: string): FastifyReply {
  return reply.code(status).type('text/html; charset=utf-8').send(page)
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

export async function buildApp(options: BuildOptions): Promise<BuiltApp> {
  const { config } = options
  assertProductionConfig(config)
  const store = options.store ?? openStore(config.dbPath)
  const mailer = options.mailer ?? createMailer(config)
  const runner = options.runner ?? createRunner(config)
  const oauth = new GithubOAuth(config)
  const sessions = new Sessions(store, config)
  const approvals = new Approvals(store, config, mailer)
  const instances = new InstanceManager(store, config)
  const jobs = new Jobs(store, config, runner, mailer, instances)
  const loginLimiter = new RateLimiter(30, 60_000)
  const apiLimiter = new RateLimiter(120, 60_000)

  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 20 * 1024 * 1024,
    routerOptions: { ignoreTrailingSlash: true },
  })
  await app.register(fastifyCookie)
  await app.register(fastifyFormbody)
  await app.register(fastifyStatic, { root: join(process.cwd(), 'public'), prefix: '/assets/', decorateReply: false })

  app.addHook('onRequest', async (request) => {
    request.viewer = sessions.read(request) ?? undefined
    request.locale = resolveLocale(request)
  })

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff')
    reply.header('referrer-policy', 'strict-origin-when-cross-origin')
    reply.header('x-frame-options', 'DENY')
    if (request.url.startsWith('/auth/') || request.url.startsWith('/approve/')) reply.header('cache-control', 'no-store')
    if (!request.url.startsWith('/v1') && !request.url.startsWith('/api/')) {
      reply.header(
        'content-security-policy',
        "default-src 'self'; img-src 'self' https://avatars.githubusercontent.com data:; style-src 'self' 'unsafe-inline'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      )
    }
    if (config.baseUrl.startsWith('https://')) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains')
    return payload
  })

  const csrfGuard = (request: FastifyRequest) => {
    const viewer = requireViewer(request)
    if (!sessions.verifyCsrf(request, viewer)) throw httpError(403, '表单已过期，请刷新页面后重试。', 'CSRF_FAILED')
    return viewer
  }

  const ownedRepo = (request: FastifyRequest, id: string, mutating = false) => {
    const viewer = mutating ? csrfGuard(request) : requireApproved(request)
    const repo = store.getRepo(id)
    if (repo === undefined || repo.user_id !== viewer.user.id) throw httpError(404, '仓库不存在。', 'REPO_NOT_FOUND')
    return { viewer, repo }
  }

  const startSession = (user: UserRow, request: FastifyRequest, reply: FastifyReply): void => {
    const raw = sessions.start(user.id, request)
    const sessionHash = sha256Hex(raw)
    sessions.setCookies(reply, raw, { sessionHash, user, csrfToken: sessions.csrfFor(sessionHash) })
  }

  app.get('/healthz', async () => ({ ok: true, service: 'fledge', version: '0.1.0', time: new Date().toISOString() }))

  app.get('/lang/:locale', async (request, reply) => {
    const requested = String((request.params as Record<string, string>).locale)
    if (!isLocale(requested)) return htmlPage(reply, 404, errorPage(config, request.viewer === undefined ? null : viewOf(request.viewer), '页面不存在', '你访问的页面不存在。', request.locale))
    const next = queryText(request, 'next')
    const safeNext = next !== undefined && next.startsWith('/') && !next.startsWith('//') ? next : '/'
    reply.setCookie(LOCALE_COOKIE, requested, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.baseUrl.startsWith('https://'),
      maxAge: 365 * 86_400,
    })
    return reply.redirect(safeNext)
  })

  app.get('/', async (request, reply) => {
    const viewer = request.viewer
    const locale: Locale = request.locale ?? 'zh'
    if (viewer !== undefined) {
      if (viewer.user.status === 'approved') return reply.redirect('/dashboard')
      if (viewer.user.status === 'onboarding') return reply.redirect('/apply')
      return reply.redirect('/apply/status')
    }
    return reply.type('text/html').send(landingPage(config, null, config.env !== 'production' && config.devLogin.login !== '', config.github.clientId !== '' && config.github.clientSecret !== '', locale))
  })

  app.get('/auth/dev', async (request, reply) => {
    if (config.env === 'production' || config.devLogin.login === '') {
      return htmlPage(reply, 404, errorPage(config, request.viewer ?? null, '页面不存在', 'Dev 登录没有开启。', request.locale))
    }
    const user = store.upsertGithubUser({
      id: randomId('usr'),
      githubId: -1,
      login: config.devLogin.login,
      name: 'Dev Login',
      email: 'dev@example.com',
      avatarUrl: null,
      isAdmin: config.devLogin.admin,
      initialQuotaCny: config.quota.initialCny,
    })
    if (user.status !== 'approved') store.setUserStatus(user.id, 'approved', 'dev-login')
    startSession(store.userById(user.id)!, request, reply)
    store.audit(user.id, 'login.dev', 'DEV_LOGIN_LOGIN')
    return reply.redirect('/dashboard')
  })

  app.post('/auth/token', async (request, reply) => {
    if (!loginLimiter.take(`token:${request.ip}`)) return htmlPage(reply, 429, errorPage(config, request.viewer ?? null, '请求过多', '请稍后再试。', request.locale))
    const token = (form(request).token ?? '').trim()
    if (token === '') return htmlPage(reply, 400, messagePage(config, '缺少 token', '请填写一个 GitHub token。', request.viewer === undefined ? null : viewOf(request.viewer), request.locale))
    let profile
    try {
      profile = await oauth.profile(token)
    } catch (error) {
      log.warn('github token login failed', { error: String(error) })
      return htmlPage(reply, 401, messagePage(config, 'GitHub token 无效', '无法用这个 token 读取 GitHub 身份，请检查权限或重新生成。', request.viewer === undefined ? null : viewOf(request.viewer), request.locale))
    }
    const isAdmin = profile.login.toLowerCase() === config.github.adminLogin.toLowerCase()
    const user = store.upsertGithubUser({
      id: randomId('usr'),
      githubId: profile.id,
      login: profile.login,
      name: profile.name,
      email: profile.email,
      avatarUrl: profile.avatarUrl,
      isAdmin,
      initialQuotaCny: config.quota.initialCny,
    })
    store.audit(user.id, 'login.github-token', `@${profile.login}`)
    startSession(user, request, reply)
    if (user.status === 'approved') return reply.redirect('/dashboard')
    if (user.status === 'onboarding') return reply.redirect('/apply')
    return reply.redirect('/apply/status')
  })

  app.get('/auth/github', async (request, reply) => {
    if (!loginLimiter.take(`login:${request.ip}`)) return htmlPage(reply, 429, errorPage(config, request.viewer ?? null, '请求过多', '请稍后再试。', request.locale))
    if (config.github.clientId === '' || config.github.clientSecret === '') {
      return htmlPage(reply, 503, errorPage(config, request.viewer ?? null, 'GitHub OAuth 未配置', '请先在 .env 设置 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET。', request.locale))
    }
    const state = randomToken(32)
    store.createOAuthState(sha256Hex(state), addMinutes(20), null)
    return reply.redirect(oauth.authorizeUrl(state))
  })

  app.get('/auth/github/callback', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>
    const code = query.code ?? ''
    const state = query.state ?? ''
    if (code === '' || state === '' || store.consumeOAuthState(sha256Hex(state)) === undefined) {
      const t = translator(request.locale ?? 'zh')
      return htmlPage(reply, 400, errorPage(
        config,
        request.viewer ?? null,
        '登录链接已失效',
        '这个 GitHub 登录链接已失效或已经被使用。请重新登录；如果是在微信/QQ 内置浏览器打开，请改用 Safari 或 Chrome。',
        request.locale,
        { href: '/auth/github', label: t('重新登录', 'Sign in again') },
      ))
    }
    let profile
    let token
    try {
      token = await oauth.exchangeCode(code)
      profile = await oauth.profile(token)
    } catch (error) {
      log.warn('github login failed', { error: String(error) })
      const t = translator(request.locale ?? 'zh')
      return htmlPage(reply, 400, errorPage(config, request.viewer ?? null, 'GitHub 登录失败', '无法完成 GitHub 登录，请重试。', request.locale, { href: '/auth/github', label: t('重新登录', 'Sign in again') }))
    }
    const isAdmin = profile.login.toLowerCase() === config.github.adminLogin.toLowerCase()
    const user = store.upsertGithubUser({
      id: randomId('usr'),
      githubId: profile.id,
      login: profile.login,
      name: profile.name,
      email: profile.email,
      avatarUrl: profile.avatarUrl,
      isAdmin,
      initialQuotaCny: config.quota.initialCny,
    })
    store.setUserGithubToken(user.id, encryptSecret(token, config.tokenEncryptionKey))
    store.audit(user.id, 'login.github', `@${profile.login}`)
    startSession(user, request, reply)
    if (user.status === 'approved') return reply.redirect('/dashboard')
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
      applyPage({ config, locale: request.locale ?? 'zh', viewer: viewOf(viewer), notice: queryText(request, 'notice'), error: queryText(request, 'error') }),
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
    return reply.type('text/html').send(
      applicationStatusPage({
        config,
        locale: request.locale ?? 'zh',
        viewer: viewOf(viewer),
        position: store.queuePosition(viewer.user.id),
        total: store.pendingTotal(),
        notice: queryText(request, 'notice'),
        error: queryText(request, 'error'),
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

  app.get('/dashboard', async (request, reply) => {
    const viewer = requireApproved(request)
    const view = viewOf(viewer)
    return reply.type('text/html').send(
      dashboardPage({
        config,
        locale: request.locale ?? 'zh',
        viewer: view,
        repos: store.listRepos(viewer.user.id),
        jobs: store.listJobs(viewer.user.id),
        notifications: store.listNotifications(viewer.user.id),
        notice: queryText(request, 'notice'),
        error: queryText(request, 'error'),
      }),
    )
  })

  app.get('/console', async (request, reply) => {
    const viewer = requireApproved(request)
    return reply.type('text/html').send(
      workspacePage({
        config,
        locale: request.locale ?? 'zh',
        viewer: viewOf(viewer),
        repos: store.listRepos(viewer.user.id),
        jobs: store.listJobs(viewer.user.id),
        notice: queryText(request, 'notice'),
        error: queryText(request, 'error'),
      }),
    )
  })

  app.get('/repos', async (_request, reply) => {
    return reply.redirect('/dashboard#add-repo')
  })

  app.post('/repos', async (request, reply) => {
    const viewer = csrfGuard(request)
    const body = form(request)
    try {
      const { owner, name } = parseRepoInput(body.repo ?? '')
      const token = (body.token ?? '').trim()
      if (token === '') throw new Error('请填写 GitHub token')
      const prepared = await prepareRepo(token, owner, name, viewer.user.login, config.github.apiBase)
      const interval = normalizeInterval(body.interval, 1440)
      const reviewInterval = normalizeInterval(body.reviewInterval, 1440)
      const reviewerEnabled = prepared.canReview && body.review === '1'
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
      const t = translator(request.locale ?? 'zh')
      const bits = [t('仓库已添加。', 'Repository added.')]
      if (prepared.forkCreated) bits.push(t(`已创建 fork ${prepared.fork.fullName}。`, `Created fork ${prepared.fork.fullName}.`))
      else if (prepared.isFork) bits.push(t(`使用你的 fork ${prepared.fork.fullName}。`, `Using your fork ${prepared.fork.fullName}.`))
      else bits.push(t('这是你自己的仓库，无需 fork。', 'You own this repository; no fork is needed.'))
      if (!prepared.canReview) bits.push(t('你不是上游维护者/写权限成员，审核角色未启用。', 'You are not an upstream maintainer/write member; the reviewer role is not enabled.'))
      else bits.push(reviewerEnabled ? t('已启用 PR 审核角色。', 'PR reviewer role enabled.') : t('审核角色已关闭。', 'Reviewer role disabled.'))
      if (config.flybot.instanceImage !== '') {
        instances.ensureUserDir(viewer.user.id)
        void instances.provision(repo).catch((error) => log.error('flybot provisioning failed', { repo: repo.id, error: String(error) }))
        bits.push(t('FlyBot 实例初始化中。', 'FlyBot instance is initializing.'))
      }
      return reply.redirect(`/repos/${repo.id}?notice=${encodeURIComponent(bits.join(' '))}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return reply.redirect(`/dashboard?error=${encodeURIComponent(message)}`)
    }
  })

  app.get('/repos/:id', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id))
    return reply.type('text/html').send(
      repoPage({
        config,
        locale: request.locale ?? 'zh',
        viewer: viewOf(viewer),
        repo,
        instance: store.getRepoInstance(repo.id),
        jobs: store.listJobsForRepo(repo.id),
        notice: queryText(request, 'notice'),
        error: queryText(request, 'error'),
      }),
    )
  })

  app.get('/repos/:id/settings', async (request, reply) => {
    const { repo } = ownedRepo(request, String((request.params as Record<string, string>).id))
    return reply.redirect(`/repos/${repo.id}#repo-settings`)
  })

  app.get('/repos/:id/:action', async (request, reply) => {
    const { repo } = ownedRepo(request, String((request.params as Record<string, string>).id))
    return reply.redirect(`/repos/${repo.id}`)
  })

  app.post('/repos/:id/run', async (request, reply) => {
    const viewer = csrfGuard(request)
    const repo = store.getRepo(String((request.params as Record<string, string>).id))
    if (repo === undefined || repo.user_id !== viewer.user.id) throw httpError(404, '仓库不存在。', 'REPO_NOT_FOUND')
    const result = await jobs.enqueue(repo, 'manual')
    const key = result.ok ? 'notice' : 'error'
    const message = result.ok ? '任务已排队。' : result.error ?? '任务启动失败。'
    return reply.redirect(`/repos/${repo.id}?${key}=${encodeURIComponent(message)}`)
  })

  app.post('/repos/:id/refresh', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    try {
      const token = decryptSecret(repo.token_enc, config.tokenEncryptionKey)
      const prepared = await prepareRepo(token, repo.upstream_owner || repo.owner, repo.upstream_name || repo.name, viewer.user.login, config.github.apiBase)
      const enableReviewer = prepared.canReview && (repo.can_review !== 1 || repo.reviewer_enabled === 1)
      store.updateRepo(repo.id, {
        upstream_owner: prepared.upstream.owner,
        upstream_name: prepared.upstream.name,
        fork_owner: prepared.fork.owner,
        fork_name: prepared.fork.name,
        upstream_default_branch: prepared.upstream.defaultBranch,
        fork_default_branch: prepared.fork.defaultBranch,
        is_fork: prepared.isFork ? 1 : 0,
        fork_created: prepared.forkCreated ? 1 : 0,
        permission: prepared.permission,
        can_review: prepared.canReview ? 1 : 0,
        can_create_issue: prepared.canCreateIssue ? 1 : 0,
        reviewer_enabled: enableReviewer ? 1 : 0,
        upstream_html_url: prepared.upstream.htmlUrl,
        fork_html_url: prepared.fork.htmlUrl,
      })
      store.audit(viewer.user.id, 'repo.refreshed', `${repo.owner}/${repo.name} fork=${prepared.fork.owner}/${prepared.fork.name} permission=${prepared.permission}`)
      const t = translator(request.locale ?? 'zh')
      return reply.redirect(`/repos/${repo.id}?notice=${encodeURIComponent(prepared.forkCreated ? t(`已创建 fork ${prepared.fork.fullName}。`, `Created fork ${prepared.fork.fullName}.`) : t('上游 / fork / 权限已重新检测。', 'Upstream, fork and permissions refreshed.'))}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent(message)}`)
    }
  })

  app.post('/repos/:id/instance', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    if (config.flybot.instanceImage === '') throw httpError(400, 'FlyBot 实例未配置', 'INSTANCE_DISABLED')
    instances.ensureUserDir(viewer.user.id)
    void instances.provision(repo).catch((error) => log.error('flybot provisioning failed', { repo: repo.id, error: String(error) }))
    return reply.redirect(`/repos/${repo.id}?notice=${encodeURIComponent('FlyBot 实例初始化中。')}`)
  })

  app.post('/repos/:id/instance/stop', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    await instances.stop(repo.id)
    store.audit(viewer.user.id, 'flybot.instance.stopped', `${repo.owner}/${repo.name}`)
    return reply.redirect(`/repos/${repo.id}?notice=${encodeURIComponent('FlyBot 实例已停止。')}`)
  })

  app.post('/repos/:id/review', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const result = await jobs.enqueue(repo, 'manual', undefined, 'review')
    const key = result.ok ? 'notice' : 'error'
    const message = result.ok ? '审核任务已排队。' : result.error ?? '审核任务启动失败。'
    store.audit(viewer.user.id, 'review.enqueued', `${repo.owner}/${repo.name} ${result.ok ? 'ok' : message}`)
    return reply.redirect(`/repos/${repo.id}?${key}=${encodeURIComponent(message)}`)
  })

  app.post('/repos/:id/settings', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const body = form(request)
    const interval = normalizeInterval(body.interval, repo.interval_minutes)
    const reviewInterval = normalizeInterval(body.reviewInterval, repo.review_interval_minutes)
    store.updateRepo(repo.id, {
      goal: (body.goal ?? '').slice(0, 4000),
      auto_iterate: body.auto === '1' ? 1 : 0,
      enabled: body.enabled === '1' ? 1 : 0,
      interval_minutes: interval,
      reviewer_enabled: repo.can_review === 1 && body.review === '1' ? 1 : 0,
      review_interval_minutes: reviewInterval,
    })
    store.audit(viewer.user.id, 'repo.settings', `${repo.owner}/${repo.name} reviewer=${repo.can_review === 1 && body.review === '1' ? 'on' : 'off'}`)
    return reply.redirect(`/repos/${repo.id}?notice=${encodeURIComponent('设置已保存。')}`)
  })

  app.post('/repos/:id/delete', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    await instances.remove(repo.id)
    store.deleteRepo(repo.id)
    store.audit(viewer.user.id, 'repo.deleted', `${repo.owner}/${repo.name}`)
    return reply.redirect(`/dashboard?notice=${encodeURIComponent('仓库已删除。')}`)
  })

  app.get('/settings', async (request, reply) => {
    const viewer = requireApproved(request)
    return reply.type('text/html').send(
      settingsPage({
        config,
        locale: request.locale ?? 'zh',
        viewer: viewOf(viewer),
        tokens: store.listApiTokens(viewer.user.id),
        notice: queryText(request, 'notice'),
        error: queryText(request, 'error'),
      }),
    )
  })

  app.post('/settings/model', async (request, reply) => {
    const viewer = csrfGuard(request)
    const body = form(request)
    if (body.action === 'clear') {
      store.setUserOwnModel(viewer.user.id, null, null, null)
      store.audit(viewer.user.id, 'model.cleared')
      return reply.redirect(`/settings?notice=${encodeURIComponent('已改回平台额度。')}`)
    }
    const render = (error: string) =>
      reply.type('text/html').send(
        settingsPage({ config, locale: request.locale ?? 'zh', viewer: viewOf(viewer), tokens: store.listApiTokens(viewer.user.id), error }),
      )
    try {
      const baseUrl = (body.baseUrl ?? '').trim()
      if (baseUrl === '') throw new Error('请填写 Base URL')
      const safeUrl = await assertSafeModelUrl(baseUrl, config.allowPrivateModelUrls)
      const existingKey = viewer.user.own_llm_key_enc === null ? '' : decryptSecret(viewer.user.own_llm_key_enc, config.tokenEncryptionKey)
      const key = (body.apiKey ?? '').trim() !== '' ? (body.apiKey ?? '').trim() : existingKey
      if (key === '') throw new Error('请填写 API Key')
      const model = (body.model ?? '').trim() !== '' ? (body.model ?? '').trim() : config.llm.model
      await testOwnModel(safeUrl, key, model)
      store.setUserOwnModel(viewer.user.id, safeUrl, encryptSecret(key, config.tokenEncryptionKey), model)
      store.audit(viewer.user.id, 'model.saved', safeUrl)
      return reply.redirect(`/settings?notice=${encodeURIComponent('模型服务已保存并通过测试。')}`)
    } catch (error) {
      return render(error instanceof Error ? error.message : String(error))
    }
  })

  app.post('/settings/tokens', async (request, reply) => {
    const viewer = csrfGuard(request)
    const name = (form(request).name ?? '').trim().slice(0, 80) || 'default'
    const raw = `flg_${randomToken(32)}`
    store.createApiToken({
      id: randomId('tok'),
      userId: viewer.user.id,
      kind: 'pat',
      name,
      tokenHash: sha256Hex(raw),
      prefix: raw.slice(0, 8),
      expiresAt: null,
    })
    store.audit(viewer.user.id, 'token.created', name)
    return reply.type('text/html').send(
      settingsPage({
        config,
        locale: request.locale ?? 'zh',
        viewer: viewOf(viewer),
        tokens: store.listApiTokens(viewer.user.id),
        newToken: raw,
        notice: '新 token 只显示这一次，请现在复制保存。',
      }),
    )
  })

  app.post('/settings/tokens/:id/revoke', async (request, reply) => {
    const viewer = csrfGuard(request)
    store.revokeApiToken(String((request.params as Record<string, string>).id), viewer.user.id)
    store.audit(viewer.user.id, 'token.revoked')
    return reply.redirect(`/settings?notice=${encodeURIComponent('Token 已撤销。')}`)
  })

  app.post('/notifications/read', async (request, reply) => {
    const viewer = csrfGuard(request)
    store.markNotificationsRead(viewer.user.id)
    return reply.redirect('/dashboard')
  })

  app.get('/admin', async (request, reply) => {
    const viewer = requireAdmin(request)
    const users = store.listUsers()
    const activity = new Map(users.map((user) => [user.id, store.userActivity(user.id)]))
    const perPage = 10
    const pageNumber = (name: string): number => {
      const n = Number(queryText(request, name))
      return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
    }
    const jobsTotal = store.countJobs()
    const auditTotal = store.countAudit()
    const jobsPages = Math.max(1, Math.ceil(jobsTotal / perPage))
    const auditPages = Math.max(1, Math.ceil(auditTotal / perPage))
    const jobsPage = Math.min(pageNumber('jobsPage'), jobsPages)
    const auditPage = Math.min(pageNumber('auditPage'), auditPages)
    return reply.type('text/html').send(
      adminPage({
        config,
        locale: request.locale ?? 'zh',
        viewer: viewOf(viewer),
        users,
        activity,
        jobs: store.listJobsPage(perPage, (jobsPage - 1) * perPage),
        jobsPage,
        jobsTotal,
        audit: store.listAuditPage(perPage, (auditPage - 1) * perPage),
        auditPage,
        auditTotal,
        perPage,
        notice: queryText(request, 'notice'),
        error: queryText(request, 'error'),
      }),
    )
  })

  const adminStatus = async (request: FastifyRequest, status: 'approved' | 'rejected') => {
    const viewer = csrfGuard(request)
    if (viewer.user.role !== 'admin') throw httpError(403, 'Admin only', 'ADMIN_ONLY')
    const id = String((request.params as Record<string, string>).id)
    const user = store.userById(id)
    if (user === undefined) throw httpError(404, '用户不存在。', 'USER_NOT_FOUND')
    store.setUserStatus(user.id, status, `admin:${viewer.user.login}`)
    if (status === 'rejected') {
      for (const instance of store.listRepoInstances().filter((entry) => entry.user_id === user.id)) {
        await instances.stop(instance.repo_id)
      }
    }
    store.audit(user.id, `admin.${status}`, `by @${viewer.user.login}`)
    try {
      if (user.email !== null && user.email !== '') {
        await mailer.send({ to: user.email, ...(status === 'approved' ? approvedEmail(user, config.baseUrl) : rejectedEmail(user, '')) })
      }
    } catch (error) {
      log.warn('admin status mail failed', { user: user.login, error: String(error) })
    }
    return user
  }

  app.post('/admin/users/:id/approve', async (request, reply) => {
    await adminStatus(request, 'approved')
    return reply.redirect(`/admin?notice=${encodeURIComponent('已批准。')}`)
  })

  app.post('/admin/users/:id/reject', async (request, reply) => {
    await adminStatus(request, 'rejected')
    return reply.redirect(`/admin?notice=${encodeURIComponent('已拒绝。')}`)
  })

  app.post('/admin/users/:id/quota', async (request, reply) => {
    const viewer = csrfGuard(request)
    if (viewer.user.role !== 'admin') throw httpError(403, 'Admin only', 'ADMIN_ONLY')
    const id = String((request.params as Record<string, string>).id)
    const quota = Number(form(request).quota)
    if (!Number.isFinite(quota) || quota < 0 || quota > 10_000) throw httpError(400, '额度必须是 0–10000 之间的数字。', 'BAD_QUOTA')
    store.setUserQuota(id, quota)
    store.audit(id, 'admin.quota', `${quota} CNY by @${viewer.user.login}`)
    return reply.redirect(`/admin?notice=${encodeURIComponent('额度已更新。')}`)
  })

  app.get('/approve/:token', async (request, reply) => {
    const token = String((request.params as Record<string, string>).token)
    const resolved = approvals.resolve(token)
    if (resolved === undefined) return htmlPage(reply, 404, errorPage(config, request.viewer ?? null, '链接无效', '这个审批链接无效或已经过期。', request.locale))
    if (resolved.user.status !== 'pending') return reply.type('text/html').send(messagePage(config, '已经处理过', '这个申请已经处理过了。', request.viewer === undefined ? null : viewOf(request.viewer), request.locale))
    return reply.type('text/html').send(approvalPage({ config, locale: request.locale ?? 'zh', user: resolved.user, action: resolved.row.action, token }))
  })

  app.post('/approve/:token', async (request, reply) => {
    const token = String((request.params as Record<string, string>).token)
    const result = await approvals.apply(token, 'email-link')
    if (!result.ok) return htmlPage(reply, 400, messagePage(config, '无法处理', result.reason, request.viewer === undefined ? null : viewOf(request.viewer), request.locale))
    return reply.type('text/html').send(messagePage(config, result.user.status === 'approved' ? '已批准' : '已拒绝', `@${result.user.login} 的申请已${result.user.status === 'approved' ? '批准' : '拒绝'}。`, request.viewer === undefined ? null : viewOf(request.viewer), request.locale))
  })

  app.get('/api/jobs/:id/credential', async (request, reply) => {
    const header = String(request.headers.authorization ?? '')
    const secret = /^Bearer\s+(.+)$/i.exec(header)?.[1] ?? ''
    const result = jobs.credential(String((request.params as Record<string, string>).id), secret)
    if (!result.ok) return reply.code(result.status ?? 400).send({ error: result.error ?? 'unauthorized' })
    return { token: result.token, owner: result.owner, name: result.name, defaultBranch: result.defaultBranch }
  })

  app.post('/api/jobs/:id/callback', async (request, reply) => {
    if (!apiLimiter.take(`callback:${request.ip}`)) return reply.code(429).send({ error: 'too many requests' })
    const header = String(request.headers.authorization ?? '')
    const secret = /^Bearer\s+(.+)$/i.exec(header)?.[1] ?? ''
    const body = (request.body ?? {}) as Record<string, unknown>
    const result = await jobs.handleCallback(String((request.params as Record<string, string>).id), secret, body)
    if (!result.ok) return reply.code(result.status ?? 400).send({ error: result.error ?? 'callback rejected' })
    return { ok: true }
  })

  registerGateway(app, { config, store, onQuotaExhausted: (user) => jobs.notifier.notify(user) })

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/v1') || request.url.startsWith('/api/')) return reply.code(404).send({ error: { type: 'not_found', message: 'No such endpoint' } })
    return htmlPage(reply, 404, errorPage(config, request.viewer === undefined ? null : viewOf(request.viewer), '页面不存在', '你访问的页面不存在。', request.locale))
  })

  app.setErrorHandler((error, request, reply) => {
    const failure = error as { statusCode?: number; code?: string; message?: string }
    const status = failure.statusCode ?? 500
    const code = failure.code ?? 'ERROR'
    const message = failure.message ?? 'Unknown error'
    if (status >= 500) log.error('request failed', { url: request.url, error: String(error) })
    if (request.url.startsWith('/v1') || request.url.startsWith('/api/')) {
      return reply.code(status).send({ error: { type: code, message } })
    }
    return htmlPage(reply, status, errorPage(config, request.viewer === undefined ? null : viewOf(request.viewer), status === 404 ? '页面不存在' : '出错了', status >= 500 ? '服务器出了点问题，请稍后再试。' : message, request.locale))
  })

  const sweeper = setInterval(() => {
    loginLimiter.sweep()
    apiLimiter.sweep()
    store.deleteExpiredSessions()
  }, 60_000)
  sweeper.unref()

  if (options.startScheduler !== false) jobs.start()

  return {
    app,
    store,
    jobs,
    sessions,
    instances,
    close: async () => {
      jobs.stop()
      clearInterval(sweeper)
      await app.close()
      store.close()
    },
  }
}
