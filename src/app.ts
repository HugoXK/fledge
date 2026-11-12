import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import fastifyCookie from '@fastify/cookie'
import fastifyFormbody from '@fastify/formbody'
import fastifyStatic from '@fastify/static'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { Config } from './config.js'
import { assertProductionConfig } from './config.js'
import { openStore, type JobRow, type RepoRow, type Store, type UserRow } from './db.js'
import { GithubOAuth } from './auth/github.js'
import { oauthConfigured, tokenLoginEnabled } from './auth/login.js'
import { isAdminRole, requireAdmin, requireApproved, requireSuperAdmin, requireViewer, Sessions } from './auth/session.js'
import { isTrialFilter } from './lib/trials.js'
import { createMailer, type Mailer } from './email/mailer.js'
import { approvedEmail, rejectedEmail, testEmail } from './email/templates.js'
import { notifyEmail } from './email/recipient.js'
import { registerGateway } from './gateway/gateway.js'
import { assertSafeModelUrl } from './gateway/modelUrl.js'
import { quotaView } from './gateway/quota.js'
import { parseAttributionJson } from './lib/attribution.js'
import { failureBreakdown } from './lib/failure.js'
import { Jobs } from './jobs/service.js'
import { createRunner, type Runner } from './jobs/runner.js'
import { log } from './lib/log.js'
import { rateLimitKey, RateLimiter } from './lib/rateLimit.js'
import { decryptSecret, encryptSecret, randomId, randomToken, safeEqual, sha256Hex } from './lib/secrets.js'
import { AGREEMENT_VERSION, agreementHashFor } from './users/agreements.js'
import { addMinutes, nowIso } from './lib/time.js'
import { isLocale, LOCALE_COOKIE, localizeMessage, resolveLocale, translator, type Locale } from './i18n.js'
import { normalizeInterval } from './lib/intervals.js'
import { parseJobFilters } from './lib/jobFilters.js'
import { isValidBranchName } from './lib/branches.js'
import { allowedRepoRoles, parseRepoRole, roleAllowed } from './lib/repoRole.js'
import { isWorkItemState, MAINTAINER_ONLY_STATES, WORK_ITEM_TRANSITIONS, type WorkItemState } from './lib/workItems.js'
import { parseStageMode } from './lib/stages.js'
import { issuePriority, issueState, shouldTriage } from './lib/issueIntake.js'
import { parseIssueCommand } from './lib/issueCommands.js'
import { VERSION } from './version.js'
import { incCounter, observeHistogram, renderMetrics } from './lib/metrics.js'
import { readReleaseStatus } from './lib/releaseStatus.js'
import { configureOtel, endSpan, shutdownOtel, startSpan, type SpanHandle } from './lib/otel.js'
import { configureGithubBudget } from './lib/githubBudget.js'
import { normalizeReviewInstruction } from './lib/followUpInstruction.js'
import { Approvals } from './users/approval.js'
import {
  adminPage,
  adminSupportPage,
  adminTrialsPage,
  adminSearchPage,
  adminWebhooksPage,
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
  agentWorkspacePage,
  settingsPage,
  inboxSection,
  errorPage,
  type InboxQuestion,
} from './views/pages.js'
import { GithubClient, parseRepoInput, prepareRepo, prepareRepoWithInstallation, repoPermissionWithToken } from './repos/github.js'
import { GithubApp } from './repos/app.js'
import { repoGithubToken } from './repos/token.js'
import { InstanceManager } from './flybot/instances.js'
import { dshCookie, proxyWorkspaceHttp, proxyWorkspaceUpgrade } from './flybot/workspace.js'

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

function queryText(request: FastifyRequest, name: string): string | undefined {
  const value = (request.query as Record<string, unknown> | undefined)?.[name]
  return typeof value === 'string' && value !== '' ? value.slice(0, 500) : undefined
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

export async function buildApp(options: BuildOptions): Promise<BuiltApp> {
  const { config } = options
  assertProductionConfig(config)
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
  const instances = new InstanceManager(store, config)
  if (options.startScheduler !== false && config.env !== 'test' && config.flybot.instanceImage !== '') {
    void instances.healthSweep().catch((error) => log.warn('startup instance health sweep failed', { error: String(error) }))
  }
  const githubApp = new GithubApp(config)
  const jobs = new Jobs(store, config, runner, mailer, instances, githubApp)
  const loginLimiter = new RateLimiter(30, 60_000)
  const apiLimiter = new RateLimiter(120, 60_000)

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

  app.addHook('onRequest', async (request) => {
    request.viewer = sessions.read(request) ?? undefined
    request.locale = resolveLocale(request)
    otelSpans.set(request, startSpan('http.request', { method: request.method, path: request.url.split('?')[0] ?? request.url }))
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

  const approvedCsrfGuard = (request: FastifyRequest) => {
    const viewer = csrfGuard(request)
    if (viewer.user.status !== 'approved') throw httpError(403, '账号正在等待审批。', 'NOT_APPROVED')
    return viewer
  }

  const ownedRepo = (request: FastifyRequest, id: string, mutating = false) => {
    const viewer = mutating ? approvedCsrfGuard(request) : requireApproved(request)
    const repo = store.getRepo(id)
    if (repo === undefined || repo.user_id !== viewer.user.id) throw httpError(404, '仓库不存在。', 'REPO_NOT_FOUND')
    return { viewer, repo }
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
    const questions = settled
      .flatMap((result) => result.status === 'fulfilled' ? result.value : [])
      .slice(0, 20)
    inboxCache.set(userId, { at: Date.now(), questions })
    return questions
  }

  const localizedJobs = (jobs: JobRow[], locale: Locale): JobRow[] => jobs.map((job) => ({
    ...job,
    summary: job.summary === null ? null : localizeMessage(locale, job.summary) ?? job.summary,
    error: job.error === null ? null : localizeMessage(locale, job.error) ?? job.error,
  }))

  const requireAdvanced = (viewer: { user: UserRow; preview?: boolean }): void => {
    if (viewer.user.role !== 'superadmin' || viewer.preview === true) throw httpError(403, '仅超级管理员可访问实时团队页面。', 'SUPERADMIN_ONLY')
  }

  const startSession = (user: UserRow, request: FastifyRequest, reply: FastifyReply): void => {
    if (user.status === 'approved') instances.ensureUserDir(user.id)
    const raw = sessions.start(user.id, request)
    const sessionHash = sha256Hex(raw)
    sessions.setCookies(reply, raw, { sessionHash, user, csrfToken: sessions.csrfFor(sessionHash) })
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
    return { ...publicAnswer, commit: config.build.commit, builtAt: config.build.builtAt }
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
    return { ok: true, db: true, instances: { ready, failed, total: instances.length } }
  })

  app.get('/lang/:locale', async (request, reply) => {
    const requested = String((request.params as Record<string, string>).locale)
    if (!isLocale(requested)) return htmlPage(reply, 404, errorPage(config, request.viewer === undefined ? null : viewOf(request.viewer), '页面不存在', '你访问的页面不存在。', request.locale))
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
      return htmlPage(reply, 404, errorPage(config, request.viewer ?? null, '页面不存在', 'Dev 登录没有开启。', request.locale))
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
      return htmlPage(reply, 403, errorPage(config, request.viewer ?? null, 'OAuth 已启用', '这个部署已经启用 GitHub OAuth，请使用 GitHub 登录。', request.locale, { href: '/auth/github', label: t('使用 GitHub 登录', 'Sign in with GitHub') }))
    }
    if (!loginLimiter.take(`token:${rateLimitKey(request)}`)) return htmlPage(reply, 429, errorPage(config, request.viewer ?? null, '请求过多', '请稍后再试。', request.locale))
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
    if (!loginLimiter.take(`login:${rateLimitKey(request)}`)) return htmlPage(reply, 429, errorPage(config, request.viewer ?? null, '请求过多', '请稍后再试。', request.locale))
    if (!oauthConfigured(config)) {
      return htmlPage(reply, 503, errorPage(config, request.viewer ?? null, 'GitHub OAuth 未配置', '请先在 .env 设置 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET。', request.locale))
    }
    const state = randomToken(32)
    store.createOAuthState(sha256Hex(state), addMinutes(20), safeLocalPath(queryText(request, 'next'), '/dashboard'))
    return reply.redirect(oauth.authorizeUrl(state))
  })

  app.get('/auth/github/reauthorize', async (request, reply) => {
    const viewer = requireApproved(request)
    if (!loginLimiter.take(`reauth:${viewer.user.id}`)) return htmlPage(reply, 429, errorPage(config, request.viewer ?? null, '请求过多', '请稍后再试。', request.locale))
    if (!oauthConfigured(config)) return reply.redirect('/settings?error=' + encodeURIComponent('GitHub OAuth 未配置。'))
    const state = randomToken(32)
    store.createOAuthState(sha256Hex(state), addMinutes(20), safeLocalPath(queryText(request, 'next'), '/dashboard'))
    const scopes = [...new Set(`${config.github.scopes} repo`.split(/\s+/).filter(Boolean))].join(' ')
    return reply.redirect(oauth.authorizeUrl(state, scopes))
  })

  app.get('/auth/github/callback', async (request, reply) => {
    if (!loginLimiter.take(`callback:${rateLimitKey(request)}`)) return htmlPage(reply, 429, errorPage(config, request.viewer ?? null, '请求过多', '请稍后再试。', request.locale))
    const query = request.query as Record<string, string | undefined>
    const code = query.code ?? ''
    const state = query.state ?? ''
    const invalidLink = () => {
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
      return htmlPage(reply, 400, errorPage(config, request.viewer ?? null, 'GitHub 登录失败', '无法完成 GitHub 登录，请重试。', request.locale, { href: '/auth/github', label: t('重新登录', 'Sign in again') }))
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
    startSession(user, request, reply)
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
        notice: queryText(request, 'notice'),
        error: queryText(request, 'error'),
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

  app.get('/dashboard', async (request, reply) => {
    const viewer = requireApproved(request)
    const view = viewOf(viewer)
    const windowDays = queryText(request, 'window') === '30' ? 30 : 7
    const since = new Date(Date.now() - windowDays * 86_400_000).toISOString()
    const personal = store.personalMetrics(viewer.user.id, since)
    const alerts = store.alerts({ userId: viewer.user.id, usdCny: config.quota.usdCny })
    const perPage = 10
    const allRepos = store.listRepos(viewer.user.id)
    // #232: the job filters are read from the query on every request and applied
    // in SQL, so the URL, the count and the page always describe the same list.
    const jobFilter = parseJobFilters(
      { repo: queryText(request, 'repo'), status: queryText(request, 'status'), kind: queryText(request, 'kind') },
      allRepos.map((repo) => repo.id),
    )
    const reposTotal = store.countReposForUser(viewer.user.id)
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
    const setup = {
      repos: reposTotal,
      roleChosen: allRepos.some((repo) => repo.repo_role !== null),
      modelConfigured: store
        .listModelProviders(viewer.user.id)
        .some((provider) => store.listProviderModels(provider.id).length > 0),
      instanceReady: allRepos.some((repo) => store.getRepoInstance(repo.id)?.status === 'ready'),
      jobs: jobsTotal,
      firstJobStatus: firstJob?.status ?? null,
      firstPrUrl: firstJob?.pr_url ?? null,
      repoHref: allRepos[0] === undefined ? null : `/repos/${allRepos[0].id}`,
    }
    return reply.type('text/html').send(
      dashboardPage({
        config,
        locale: request.locale ?? 'zh',
        viewer: view,
        repos,
        jobs,
        latestJob,
        setup,
        reposPage,
        reposTotal,
        jobsPage,
        jobsTotal,
        jobFilter,
        repoOptions: allRepos.map((repo) => ({ id: repo.id, label: `${repo.upstream_owner || repo.owner}/${repo.upstream_name || repo.name}` })),
        allRepos,
        questions,
        personal,
        windowDays,
        alerts,
        notifications: store.listNotifications(viewer.user.id),
        notice: queryText(request, 'notice'),
        error: queryText(request, 'error'),
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
        alerts: store.alerts({ usdCny: config.quota.usdCny }),
      }
    }
    return { windowDays, since, personal: store.personalMetrics(viewer.user.id, since), alerts: store.alerts({ userId: viewer.user.id, usdCny: config.quota.usdCny }) }
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
        notice: queryText(request, 'notice'),
        error: queryText(request, 'error'),
      }),
    )
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
    if (!githubApp.configured) return reply.redirect(`/dashboard?error=${encodeURIComponent('GitHub App 未配置；仍可使用 PAT 接入。')}`)
    const installations = store.listInstallations(viewer.user.id)
    const raw = Number(queryText(request, 'installation'))
    const installationId = Number.isFinite(raw) && raw > 0 ? raw : undefined
    let repos
    let error = queryText(request, 'error')
    if (installationId !== undefined) {
      const owned = store.getInstallation(installationId)
      if (owned === undefined || owned.user_id !== viewer.user.id) throw httpError(404, '安装不存在。', 'INSTALLATION_NOT_FOUND')
      try {
        repos = await githubApp.installationRepos(installationId)
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause)
      }
    }
    return reply.type('text/html').send(appReposPage({
      config,
      locale: request.locale ?? 'zh',
      viewer: viewOf(viewer),
      installations,
      installationId,
      repos,
      notice: queryText(request, 'notice'),
      error,
    }))
  })

  app.post('/repos/app', async (request, reply) => {
    const viewer = approvedCsrfGuard(request)
    if (!githubApp.configured) return reply.redirect(`/dashboard?error=${encodeURIComponent('GitHub App 未配置。')}`)
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
    const added: string[] = []
    for (const fullName of selected) {
      const repoInfo = byName.get(fullName.toLowerCase())
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
        if (config.flybot.instanceImage !== '') {
          instances.ensureUserDir(viewer.user.id)
          void instances.provision(repo).catch((error) => log.error('flybot provisioning failed', { repo: repo.id, error: String(error) }))
        }
        added.push(`${repo.owner}/${repo.name}`)
      } catch (error) {
        log.warn('github app repo add failed', { repo: repoInfo.fullName, error: String(error) })
      }
    }
    if (added.length === 0) return reply.redirect(`/repos/new?installation=${installationId}&error=${encodeURIComponent('没有新增仓库；可能已经添加过，或 App 权限不足。')}`)
    return reply.redirect(`/dashboard?notice=${encodeURIComponent(`已接入 ${added.length} 个仓库。`)}`)
  })

  app.post('/repos', async (request, reply) => {
    const viewer = approvedCsrfGuard(request)
    const body = form(request)
    try {
      const { owner, name } = parseRepoInput(body.repo ?? '')
      const existing = store.getRepoByOwnerName(viewer.user.id, owner, name)
      if (existing !== undefined) {
        return reply.redirect(`/repos/${existing.id}?notice=${encodeURIComponent('这个仓库已经添加过了。')}`)
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
    const jobsTotal = store.countJobsForRepo(repo.id)
    const jobsPage = Math.min(Math.max(1, Math.floor(Number(queryText(request, 'jobsPage')) || 1)), Math.max(1, Math.ceil(jobsTotal / 10)))
    const questions = (await inboxForUser(viewer.user.id, store.listRepos(viewer.user.id))).filter((question) => question.repoId === repo.id)
    const workState = queryText(request, 'workState')
    const instance = store.getRepoInstance(repo.id)
    const repoModels = store.listRepoModelSelection(repo.id)
    let chiefMessages
    if ((viewer.user.role !== 'superadmin' || viewer.preview === true) && instance?.status === 'ready') {
      chiefMessages = await instances.chiefTranscript(repo.id).catch((error) => {
        log.warn('chief transcript failed', { repo: repo.id, error: String(error) })
        return []
      })
    }
    const planDeadlineCutoff = new Date(Date.now() - config.plan.expiryDays * 86_400_000).toISOString()
    const pendingPlan = store.pendingPlanJob(repo.id, planDeadlineCutoff)
    return reply.type('text/html').send(
      repoPage({
        config,
        locale: request.locale ?? 'zh',
        viewer: viewOf(viewer),
        repo,
        instance,
        jobs: store.listJobsPageForRepo(repo.id, 10, (jobsPage - 1) * 10),
        prJobs: store.listPrJobsForRepo(repo.id, 10),
        workItems: store.listWorkItems(repo.id),
        // #359: the page names the deadline and the way out, so an ignored plan
        // is a visible decision with a date rather than a silent wait.
        ...(pendingPlan === undefined || pendingPlan.finished_at === null ? {} : {
          pendingPlan: {
            jobId: pendingPlan.id,
            deadline: new Date(Date.parse(pendingPlan.finished_at) + config.plan.expiryDays * 86_400_000).toISOString().slice(0, 10),
          },
        }),
        ...(workState !== undefined && isWorkItemState(workState) ? { workState } : {}),
        models: store.listUserProviderModels(repo.user_id),
        repoModelIds: repoModels.map((model) => model.id),
        repoBotModels: store.listRepoBotModels(repo.id),
        repoDefaultModelId: repoModels.find((model) => model.is_default === 1)?.id ?? '',
        repoSpendCny: store.repoUsageSince(repo.id, new Date(Date.now() - 30 * 86_400_000).toISOString()) * config.quota.usdCny,
        questions,
        chiefMessages,
        activeJob: store.activeJobForRepo(repo.id) !== undefined,
        jobsPage,
        jobsTotal,
        notice: queryText(request, 'notice'),
        error: queryText(request, 'error'),
      }),
    )
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
      jobsPage,
      jobsTotal,
      notice: queryText(request, 'notice'),
      error: queryText(request, 'error'),
    }))
  })

  app.get('/api/repos/:id/team', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id))
    requireAdvanced(viewer)
    try {
      const state = await instances.teamState(repo.id, 15_000)
      return { ...state, jobs: localizedJobs(store.listJobsForRepo(repo.id).slice(0, 5), request.locale ?? 'zh') }
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
    try {
      await instances.answerQuestion(repo.id, text('sessionId'), text('questionId'), selected, text('custom'))
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
          jobs: localizedJobs(store.listJobsForRepo(repo.id, 5), request.locale ?? 'zh').map((job) => ({
            id: job.id,
            kind: job.kind,
            status: job.status,
            summary: job.summary,
            error: job.error,
            issueUrl: job.issue_url,
            prUrl: job.pr_url,
            reviewScore: job.review_score,
            attribution: parseAttributionJson(job.attribution_json),
            createdAt: job.created_at,
            finishedAt: job.finished_at,
          })),
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
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id))
    const job = store.getJob(String((request.params as Record<string, string>).jobId))
    if (job === undefined || job.repo_id !== repo.id) throw httpError(404, '任务不存在。', 'JOB_NOT_FOUND')
    const queued = store.listQueuedJobs()
    const queueIndex = queued.findIndex((entry) => entry.id === job.id)
    return reply.type('text/html').send(jobPage({
      config,
      locale: request.locale ?? 'zh',
      viewer: viewOf(viewer),
      repo,
      job,
      queuePosition: queueIndex === -1 ? undefined : queueIndex + 1,
      events: store.listJobEvents(job.id, 200),
      notice: queryText(request, 'notice'),
      error: queryText(request, 'error'),
    }))
  })

  app.post('/repos/:id/jobs/:jobId/cancel', async (request, reply) => {
    const { repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const job = store.getJob(String((request.params as Record<string, string>).jobId))
    if (job === undefined || job.repo_id !== repo.id) throw httpError(404, '任务不存在。', 'JOB_NOT_FOUND')
    const result = await jobs.cancelJob(job.id, '用户取消任务')
    return reply.redirect(`/repos/${repo.id}/jobs/${job.id}?${result.ok ? 'notice' : 'error'}=${encodeURIComponent(result.ok ? '任务已取消。' : result.error ?? '取消失败。')}`)
  })

  app.post('/repos/:id/jobs/:jobId/pause', async (request, reply) => {
    const { repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const job = store.getJob(String((request.params as Record<string, string>).jobId))
    if (job === undefined || job.repo_id !== repo.id) throw httpError(404, '任务不存在。', 'JOB_NOT_FOUND')
    const result = await jobs.pauseJob(job.id)
    return reply.redirect(`/repos/${repo.id}/jobs/${job.id}?${result.ok ? 'notice' : 'error'}=${encodeURIComponent(result.ok ? '任务已暂停。' : result.error ?? '暂停失败。')}`)
  })

  app.post('/repos/:id/jobs/:jobId/resume', async (request, reply) => {
    const { repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const job = store.getJob(String((request.params as Record<string, string>).jobId))
    if (job === undefined || job.repo_id !== repo.id) throw httpError(404, '任务不存在。', 'JOB_NOT_FOUND')
    const result = await jobs.resumeJob(job.id)
    if (!result.ok || result.job === undefined) return reply.redirect(`/repos/${repo.id}/jobs/${job.id}?error=${encodeURIComponent(refusalValue(result, '恢复失败。'))}`)
    return reply.redirect(`/repos/${repo.id}/jobs/${result.job.id}?notice=${encodeURIComponent('已恢复任务。')}`)
  })

  app.post('/repos/:id/jobs/:jobId/retry', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const job = store.getJob(String((request.params as Record<string, string>).jobId))
    if (job === undefined || job.repo_id !== repo.id) throw httpError(404, '任务不存在。', 'JOB_NOT_FOUND')
    const active = store.activeJobForRepo(repo.id)
    if (active !== undefined) return reply.redirect(`/repos/${repo.id}/jobs/${job.id}?error=${encodeURIComponent('这个仓库已有任务在运行。')}`)
    const kind = job.kind === 'review' ? 'review' : job.kind === 'plan' ? 'plan' : 'iterate'
    const goal = job.checkpoint === null || job.checkpoint === '' ? job.goal : `${job.goal}\n\nResume from checkpoint:\n${job.checkpoint}`
    const resumePr = kind === 'iterate' && job.pr_url !== null
    // #353: this route is a person pressing a button, so the run is theirs. The
    // trigger alone cannot say that — `followup` is also what `tick()` enqueues.
    const result = await jobs.enqueue(repo, resumePr ? 'followup' : 'manual', goal, kind, { ownerStarted: true, ...(resumePr ? { branch: job.branch ?? undefined, prUrl: job.pr_url ?? undefined, baseBranch: job.base_branch ?? undefined } : {}) })
    store.audit(viewer.user.id, 'job.retried', `${job.id} -> ${result.job?.id ?? result.error ?? 'failed'}`)
    if (!result.ok || result.job === undefined) {
      return reply.redirect(`/repos/${repo.id}/jobs/${job.id}?error=${encodeURIComponent(refusalValue(result, '重试失败。'))}`)
    }
    return reply.redirect(`/repos/${repo.id}/jobs/${result.job.id}?notice=${encodeURIComponent('已重新排队。')}`)
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

  app.post('/repos/:id/jobs/:jobId/merge', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const job = store.getJob(String((request.params as Record<string, string>).jobId))
    if (job === undefined || job.repo_id !== repo.id) throw httpError(404, '任务不存在。', 'JOB_NOT_FOUND')
    if (repo.repo_role !== 'maintainer') return reply.redirect(`/repos/${repo.id}/jobs/${job.id}?error=${encodeURIComponent('只有 maintainer 可以合并 PR。')}`)
    const result = await jobs.manualMerge(repo, job)
    store.audit(viewer.user.id, 'job.merge_requested', `${job.id}: ${result.ok ? 'merged' : (result.message ?? 'failed')}`)
    const key = result.ok ? 'notice' : 'error'
    const message = result.ok ? 'PR 已合并。' : (result.message ?? '合并失败。')
    return reply.redirect(`/repos/${repo.id}/jobs/${job.id}?${key}=${encodeURIComponent(message)}`)
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
    store.updateJob(job.id, { plan_approved_at: nowIso(), plan_approved_by: viewer.user.id, plan_rejected_at: null, plan_allow_paths: allow, plan_deny_paths: deny })
    if (job.work_item_id !== null) store.updateWorkItem(job.work_item_id, { state: 'assigned' })
    store.audit(viewer.user.id, 'job.plan_approved', `${job.id} allow=${allow.slice(0, 200)} deny=${deny.slice(0, 200)}`)
    return reply.redirect(`/repos/${repo.id}/jobs/${job.id}?notice=${encodeURIComponent('计划已批准，可以执行。')}`)
  })

  app.post('/repos/:id/jobs/:jobId/reject-plan', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const job = store.getJob(String((request.params as Record<string, string>).jobId))
    if (job === undefined || job.repo_id !== repo.id || job.kind !== 'plan' || job.status !== 'succeeded') throw httpError(404, '计划任务不存在或尚未完成。', 'PLAN_NOT_READY')
    if (repo.repo_role !== 'maintainer') return reply.redirect(`/repos/${repo.id}/jobs/${job.id}?error=${encodeURIComponent('只有 maintainer 可以拒绝计划。')}`)
    store.updateJob(job.id, { plan_rejected_at: nowIso(), plan_approved_at: null, plan_approved_by: null })
    store.audit(viewer.user.id, 'job.plan_rejected', job.id)
    return reply.redirect(`/repos/${repo.id}/jobs/${job.id}?notice=${encodeURIComponent('计划已拒绝。')}`)
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
    const result = await jobs.enqueue(repo, 'manual', goal, 'iterate', { workItemId: job.work_item_id ?? undefined, priority: job.priority })
    store.audit(viewer.user.id, 'job.executed', `${job.id} -> ${result.job?.id ?? result.error ?? 'failed'}`)
    if (!result.ok || result.job === undefined) {
      return reply.redirect(`/repos/${repo.id}/jobs/${job.id}?error=${encodeURIComponent(refusalValue(result, '执行计划失败。'))}`)
    }
    return reply.redirect(`/repos/${repo.id}/jobs/${result.job.id}?notice=${encodeURIComponent('已按计划开始执行。')}`)
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
    const kind = repo.plan_required === 1 ? 'plan' : 'iterate'
    const result = await jobs.enqueue(repo, 'manual', goal, kind, { workItemId: item.id, priority: item.priority })
    store.audit(viewer.user.id, 'work_item.run', `${item.id} -> ${result.job?.id ?? result.error ?? 'failed'}`)
    if (!result.ok || result.job === undefined) {
      return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent(refusalValue(result, '工作项启动失败。'))}#work`)
    }
    return reply.redirect(`/repos/${repo.id}/jobs/${result.job.id}?notice=${encodeURIComponent(kind === 'plan' ? '计划任务已排队。' : '工作项任务已排队。')}`)
  })

  app.post('/repos/:id/delivery/merge-clean', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    if (repo.repo_role !== 'maintainer') return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent('只有 maintainer 可以批量合并 PR。')}#delivery`)
    const result = await jobs.mergeCleanPrs(repo.id)
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

  app.post('/repos/:id/work/:workItemId/scope', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const item = store.getWorkItem(String((request.params as Record<string, string>).workItemId))
    if (item === undefined || item.repo_id !== repo.id) throw httpError(404, '工作项不存在。', 'WORK_ITEM_NOT_FOUND')
    if (repo.repo_role !== 'maintainer' && repo.repo_role !== 'developer') return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent('请先选择你的角色。')}#work`)
    if (item.state === 'merged' || item.state === 'closed') return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent('这个工作项已经结束。')}#work`)
    const active = store.activeJobForRepo(repo.id)
    if (active !== undefined) return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent('这个仓库已有任务在运行。')}#work`)
    const goal = [`Scope work item: ${item.title}`, item.detail === '' ? '' : item.detail, item.issue_url === null ? '' : `Issue: ${item.issue_url}`, 'Product scoping only: goal, non-goals, acceptance criteria and test plan. Do not code.'].filter((line) => line !== '').join('\n\n')
    const result = await jobs.enqueue(repo, 'manual', goal, 'scope', { workItemId: item.id, priority: item.priority })
    store.audit(viewer.user.id, 'work_item.scope', `${item.id} -> ${result.job?.id ?? result.error ?? 'failed'}`)
    if (!result.ok || result.job === undefined) return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent(refusalValue(result, '范围任务启动失败。'))}#work`)
    return reply.redirect(`/repos/${repo.id}/jobs/${result.job.id}?notice=${encodeURIComponent('Product 范围任务已排队。')}`)
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
    const result = await jobs.enqueue(repo, 'manual', goal, 'verify', { prUrl: item.pr_url, workItemId: item.id, priority: item.priority })
    store.audit(viewer.user.id, 'work_item.verify', `${item.id} -> ${result.job?.id ?? result.error ?? 'failed'}`)
    if (!result.ok || result.job === undefined) return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent(refusalValue(result, '验证任务启动失败。'))}#work`)
    return reply.redirect(`/repos/${repo.id}/jobs/${result.job.id}?notice=${encodeURIComponent('Test 验证任务已排队。')}`)
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
      notice: queryText(request, 'notice'),
      error: queryText(request, 'error'),
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
    const viewer = approvedCsrfGuard(request)
    const repo = store.getRepo(String((request.params as Record<string, string>).id))
    if (repo === undefined || repo.user_id !== viewer.user.id) throw httpError(404, '仓库不存在。', 'REPO_NOT_FOUND')
    const result = await jobs.enqueue(repo, 'manual', undefined, repo.plan_required === 1 ? 'plan' : 'iterate')
    const key = result.ok ? 'notice' : 'error'
    const message = result.ok ? (repo.plan_required === 1 ? '计划任务已排队；批准后才会写代码。' : '任务已排队。') : refusalValue(result, '任务启动失败。')
    return reply.redirect(`/repos/${repo.id}?${key}=${encodeURIComponent(message)}`)
  })

  app.post('/repos/:id/plan', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const result = await jobs.enqueue(repo, 'manual', undefined, 'plan')
    store.audit(viewer.user.id, 'plan.enqueued', `${repo.owner}/${repo.name} ${result.ok ? 'ok' : result.error ?? 'failed'}`)
    const key = result.ok ? 'notice' : 'error'
    const message = result.ok ? '计划任务已排队，不会写代码或开 PR。' : refusalValue(result, '计划任务启动失败。')
    return reply.redirect(`/repos/${repo.id}?${key}=${encodeURIComponent(message)}`)
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
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    if (config.flybot.instanceImage === '') throw httpError(400, 'FlyBot 实例未配置', 'INSTANCE_DISABLED')
    instances.ensureUserDir(viewer.user.id)
    const existing = store.getRepoInstance(repo.id)
    if (existing !== undefined && existing.status !== 'ready' && !instances.isProvisioning(repo.id)) await instances.stop(repo.id)
    void instances.provision(repo).catch((error) => log.error('flybot provisioning failed', { repo: repo.id, error: String(error) }))
    return reply.redirect(`/repos/${repo.id}?notice=${encodeURIComponent('FlyBot 实例初始化中。')}`)
  })

  app.post('/repos/:id/instance/stop', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    await instances.stop(repo.id)
    await jobs.cancelRepoJobs(repo.id, 'FlyBot 实例已停止', 'BRIDGE_ERROR')
    store.audit(viewer.user.id, 'flybot.instance.stopped', `${repo.owner}/${repo.name}`)
    return reply.redirect(`/repos/${repo.id}?notice=${encodeURIComponent('FlyBot 实例已停止。')}`)
  })

  app.post('/repos/:id/review', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const result = await jobs.enqueue(repo, 'manual', undefined, 'review')
    const key = result.ok ? 'notice' : 'error'
    const message = result.ok ? '审核任务已排队。' : refusalValue(result, '审核任务启动失败。')
    store.audit(viewer.user.id, 'review.enqueued', `${repo.owner}/${repo.name} ${result.ok ? 'ok' : result.error ?? message}`)
    return reply.redirect(`/repos/${repo.id}?${key}=${encodeURIComponent(message)}`)
  })

  app.post('/repos/:id/role', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const body = form(request)
    const t = translator(request.locale ?? 'zh')
    const role = parseRepoRole(body.role)
    if (role === null) {
      return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent(t('请选择 maintainer 或 developer。', 'Choose maintainer or developer.'))}#role`)
    }
    if (!roleAllowed(repo.permission, role)) {
      return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent(t('你的 GitHub 权限不允许选择这个角色。', 'Your GitHub permission does not allow this role.'))}#role`)
    }
    store.updateRepo(repo.id, { repo_role: role, auto_merge: 0, reviewer_enabled: role === 'maintainer' ? repo.reviewer_enabled : 0, role_checked_at: nowIso() })
    store.audit(viewer.user.id, 'repo.role', `${repo.owner}/${repo.name} role=${role} previous=${repo.repo_role ?? 'none'}`)
    return reply.redirect(`/repos/${repo.id}?notice=${encodeURIComponent(role === 'maintainer' ? t('已选择角色：Maintainer。', 'Role selected: Maintainer.') : t('已选择角色：Developer。', 'Role selected: Developer.'))}`)
  })

  app.post('/repos/:id/settings', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    const body = form(request)
    const interval = normalizeInterval(body.interval, repo.interval_minutes)
    const reviewInterval = normalizeInterval(body.reviewInterval, repo.review_interval_minutes)
    const t = translator(request.locale ?? 'zh')
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
    const roleChanged = repoRole !== currentRole
    const goal = (body.goal ?? '').slice(0, 4000)
    const goalChanged = goal !== repo.goal
    const requestedBranch = (body.targetBranch ?? '').trim()
    const targetBranch = requestedBranch === '' ? (repo.upstream_default_branch || repo.default_branch) : requestedBranch
    if (!isValidBranchName(targetBranch)) {
      return reply.redirect(`/repos/${repo.id}?error=${encodeURIComponent('目标分支格式不正确。')}#repo-settings`)
    }
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
    store.updateRepo(repo.id, {
      goal,
      target_branch: targetBranch,
      repo_role: repoRole,
      ...(roleChanged ? { role_checked_at: nowIso() } : {}),
      auto_merge: canMaintain && body.autoMerge === '1' ? 1 : 0,
      plan_required: body.planRequired === '1' ? 1 : 0,
      allow_paths: (body.allowPaths ?? '').trim().slice(0, 2000),
      deny_paths: (body.denyPaths ?? '').trim().slice(0, 2000),
      merge_method: body.mergeMethod === 'merge' || body.mergeMethod === 'rebase' ? body.mergeMethod : 'squash',
      require_protection: body.requireProtection === '1' ? 1 : 0,
      stage_mode: parseStageMode(body.stageMode) ?? 'off',
      monthly_budget_cny: Math.max(0, Math.min(10000, Number(body.monthlyBudget) || 0)),
      job_budget_cny: Math.max(0, Math.min(10000, Number(body.jobBudget) || 0)),
      job_budget_action: body.jobBudgetAction === 'pause' || body.jobBudgetAction === 'cancel' ? body.jobBudgetAction : 'alert',
      auto_iterate: body.auto === '1' ? 1 : 0,
      enabled: body.enabled === '1' ? 1 : 0,
      interval_minutes: interval,
      reviewer_enabled: canMaintain && repo.can_review === 1 && body.review === '1' ? 1 : 0,
      review_interval_minutes: reviewInterval,
    })
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
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
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
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    store.updateRepo(repo.id, { enabled: 1 })
    store.audit(viewer.user.id, 'repo.enabled', `${repo.owner}/${repo.name}`)
    return reply.redirect(`/repos/${repo.id}?notice=${encodeURIComponent('仓库已启用；自动迭代不会自动打开，需要时在设置里开启。')}`)
  })

  app.post('/repos/:id/disable', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
    store.updateRepo(repo.id, { enabled: 0, auto_iterate: 0 })
    await jobs.cancelRepoJobs(repo.id, '仓库已停用', 'REPO_DISABLED')
    store.audit(viewer.user.id, 'repo.disabled', `${repo.owner}/${repo.name}`)
    return reply.redirect(`/repos/${repo.id}?notice=${encodeURIComponent('仓库已停用，任务不会再运行。')}`)
  })

  app.post('/repos/:id/delete', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id), true)
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
        providers: store.listModelProviders(viewer.user.id).map((provider) => ({ ...provider, models: store.listProviderModels(provider.id) })),
        discoveredProvider: queryText(request, 'discoveredProvider'),
        discovered: (queryText(request, 'discovered') ?? '').split(',').filter((value) => value !== ''),
        notice: queryText(request, 'notice'),
        error: queryText(request, 'error'),
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
      const provider = store.createModelProvider({
        id: randomId('prv'),
        userId: viewer.user.id,
        label,
        baseUrl: safeUrl,
        keyEnc: encryptSecret(key, config.tokenEncryptionKey),
        allowPrivate,
      })
      store.audit(viewer.user.id, 'model.provider.added', `${provider.id} ${label} private=${allowPrivate ? 'on' : 'off'}`)
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
      })
      store.audit(viewer.user.id, 'model.provider.updated', `${provider.id} ${label} private=${allowPrivate ? 'on' : 'off'}`)
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

  app.post('/settings/providers/:id/delete', async (request, reply) => {
    const viewer = approvedCsrfGuard(request)
    const id = String((request.params as Record<string, string>).id)
    const provider = store.modelProviderById(id, viewer.user.id)
    if (provider === undefined) return reply.code(404).send({ error: '模型提供方不存在。' })
    store.deleteModelProvider(id, viewer.user.id)
    store.audit(viewer.user.id, 'model.provider.removed', `${id} ${provider.label}`)
    return reply.redirect(`/settings?notice=${encodeURIComponent('模型提供方已删除。')}#model-providers`)
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
    const removed = store.deleteProviderModel(modelId, viewer.user.id)
    if (!removed) return reply.code(404).send({ error: '模型不存在。' })
    store.audit(viewer.user.id, 'model.removed', modelId)
    return reply.redirect(`/settings?notice=${encodeURIComponent('模型已删除。')}#model-providers`)
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
    if (clear) store.setNotifyEmail(viewer.user.id, null)
    else if (rawEmail !== '') store.setNotifyEmail(viewer.user.id, rawEmail)
    store.setEmailJobUpdates(viewer.user.id, jobUpdates)
    store.setEmailDailyDigest(viewer.user.id, dailyDigest)
    store.setEmailJobSuccess(viewer.user.id, jobSuccess)
    const saved = store.userById(viewer.user.id)
    store.audit(viewer.user.id, 'settings.email', `email=${saved?.notify_email === null || saved?.notify_email === undefined ? 'github' : 'custom'} jobs=${jobUpdates ? 'on' : 'off'} digest=${dailyDigest ? 'on' : 'off'} success=${jobSuccess ? 'on' : 'off'}`)
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

  app.post('/settings/tokens', async (request, reply) => {
    const viewer = approvedCsrfGuard(request)
    const name = (form(request).name ?? '').trim().slice(0, 80) || 'default'
    const raw = `flg_${randomToken(32)}`
    store.createApiToken({
      id: randomId('tok'),
      userId: viewer.user.id,
      kind: 'pat',
      name,
      tokenHash: sha256Hex(raw),
      prefix: raw.slice(0, 8),
      repoId: null,
      expiresAt: null,
    })
    store.audit(viewer.user.id, 'token.created', name)
    return reply.type('text/html').send(
      settingsPage({
        config,
        locale: request.locale ?? 'zh',
        viewer: viewOf(viewer),
        tokens: store.listApiTokens(viewer.user.id).filter((token) => token.kind === 'pat'),
        providers: store.listModelProviders(viewer.user.id).map((provider) => ({ ...provider, models: store.listProviderModels(provider.id) })),
        newToken: raw,
        notice: '新 token 只显示这一次，请现在复制保存。',
      }),
    )
  })

  app.post('/settings/tokens/:id/revoke', async (request, reply) => {
    const viewer = approvedCsrfGuard(request)
    store.revokeApiToken(String((request.params as Record<string, string>).id), viewer.user.id)
    store.audit(viewer.user.id, 'token.revoked')
    return reply.redirect(`/settings?notice=${encodeURIComponent('Token 已撤销。')}`)
  })

  app.post('/notifications/read', async (request, reply) => {
    const viewer = approvedCsrfGuard(request)
    store.markNotificationsRead(viewer.user.id)
    return reply.redirect('/dashboard')
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
      alerts: store.alerts({ usdCny: config.quota.usdCny }),
      windowDays,
      failures: failureBreakdown(store.failedJobsSince(since)),
      since,
      notice: queryText(request, 'notice'),
      error: queryText(request, 'error'),
    }))
  })

  const adminVisibleUserIds = (viewer: { user: UserRow }): string[] | null => {
    if (viewer.user.role === 'superadmin') return null
    return store.listUsers().filter((user) => user.id === viewer.user.id || user.role === 'user').map((user) => user.id)
  }

  const adminCanViewUser = (viewer: { user: UserRow; preview?: boolean }, user: UserRow): boolean => {
    if (viewer.preview === true) return false
    if (viewer.user.role === 'superadmin') return true
    return user.id === viewer.user.id || user.role === 'user'
  }

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
      notice: queryText(request, 'notice'),
      error: queryText(request, 'error'),
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
      filter: isTrialFilter(requested) ? requested : 'all',
      notice: queryText(request, 'notice'),
      error: queryText(request, 'error'),
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
      events: store.listJobEvents(job.id, 200),
      supportMode: true,
      notice: queryText(request, 'notice'),
      error: queryText(request, 'error'),
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
    const perPage = 20
    const page = (name: string, total: number): number => {
      const n = Number(queryText(request, name))
      return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), Math.max(1, Math.ceil(total / perPage))) : 1
    }
    const auditFilters = { q, action, from, to: to === '' ? '' : (to.length === 10 ? `${to}T23:59:59.999Z` : to) }
    const jobFilters = { q, status, kind }
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
      filters: { q, status, kind, action, from, to },
      jobsPage,
      jobsTotal,
      auditPage,
      auditTotal,
      notice: queryText(request, 'notice'),
      error: queryText(request, 'error'),
    }))
  })

  const csvCell = (value: unknown): string => {
    const text = String(value ?? '')
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }

  app.get('/admin/export/audit.csv', async (request, reply) => {
    const viewer = requireAdmin(request)
    if (viewer.preview === true) return reply.code(403).send({ error: 'preview' })
    const userIds = adminVisibleUserIds(viewer)
    const to = (queryText(request, 'to') ?? '').slice(0, 20)
    const filters = { q: (queryText(request, 'q') ?? '').slice(0, 200), action: (queryText(request, 'action') ?? '').slice(0, 80), from: (queryText(request, 'from') ?? '').slice(0, 20), to: to === '' ? '' : (to.length === 10 ? `${to}T23:59:59.999Z` : to) }
    const rows = store.searchAudit(userIds, filters, 5000, 0)
    const csv = ['at,user_id,action,detail', ...rows.map((row) => [row.at, row.user_id ?? '', row.action, row.detail ?? ''].map(csvCell).join(','))].join('\n')
    store.audit(viewer.user.id, 'admin.audit_export', `rows=${rows.length}`)
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="fledge-audit.csv"').send(csv)
  })

  app.get('/admin/export/jobs.csv', async (request, reply) => {
    const viewer = requireAdmin(request)
    if (viewer.preview === true) return reply.code(403).send({ error: 'preview' })
    const userIds = adminVisibleUserIds(viewer)
    const filters = { q: (queryText(request, 'q') ?? '').slice(0, 200), status: (queryText(request, 'status') ?? '').slice(0, 30), kind: (queryText(request, 'kind') ?? '').slice(0, 30) }
    const rows = store.searchJobs(userIds, filters, 5000, 0)
    const csv = ['id,repo_id,user_id,status,kind,trigger,created_at,finished_at,pr_url,issue_url,cost_usd', ...rows.map((row) => [row.id, row.repo_id, row.user_id, row.status, row.kind, row.trigger, row.created_at, row.finished_at ?? '', row.pr_url ?? '', row.issue_url ?? '', row.cost_usd].map(csvCell).join(','))].join('\n')
    store.audit(viewer.user.id, 'admin.jobs_export', `rows=${rows.length}`)
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="fledge-jobs.csv"').send(csv)
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
      notice: queryText(request, 'notice'),
      error: queryText(request, 'error'),
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
        platformStop: jobs.platformStop(),
        superadmin,
        preview: false,
        showAudit: true,
        hideActor: !superadmin,
        notice: queryText(request, 'notice'),
        error: queryText(request, 'error'),
        // Read from the data directory; a missing or unreadable snapshot renders
        // as "not recorded" rather than failing the page.
        releaseStatus: readReleaseStatus(config.dataDir),
      }),
    )
  })

  // #283: the platform emergency stop. `isAdminRole` on purpose, not
  // `requireAdmin`, and no `preview` rejection: the preview cookie is how the
  // admin panel degrades to read-only, and the one action that must still work in
  // that state is stopping everything. The stop is a persisted `settings` row, so
  // it survives a restart, and this route reports what the drain did rather than
  // a bare "stopped".
  app.post('/admin/platform/stop', async (request, reply) => {
    // Same limiter and window as the other mutating form (`/approve/:token`), and
    // an HTML page rather than the JSON 429 the API routes send: this is a form
    // post from a browser, and a raw JSON body would replace the page.
    if (!loginLimiter.take(`platform-stop:${rateLimitKey(request)}`)) return htmlPage(reply, 429, errorPage(config, request.viewer ?? null, '请求过多', '请稍后再试。', request.locale))
    const viewer = approvedCsrfGuard(request)
    if (!isAdminRole(viewer.user.role)) throw httpError(403, '仅管理员可以停止平台。', 'ADMIN_ONLY')
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
    if (!loginLimiter.take(`platform-resume:${rateLimitKey(request)}`)) return htmlPage(reply, 429, errorPage(config, request.viewer ?? null, '请求过多', '请稍后再试。', request.locale))
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

  const adminStatus = async (request: FastifyRequest, status: 'approved' | 'rejected') => {
    const viewer = approvedCsrfGuard(request)
    if (!isAdminRole(viewer.user.role)) throw httpError(403, '仅管理员可访问。', 'ADMIN_ONLY')
    const id = String((request.params as Record<string, string>).id)
    const user = store.userById(id)
    if (user === undefined) throw httpError(404, '用户不存在。', 'USER_NOT_FOUND')
    if (user.id === viewer.user.id || user.role === 'superadmin') throw httpError(403, '不能修改这个账号。', 'ROLE_PROTECTED')
    if (viewer.user.role !== 'superadmin' && user.role !== 'user') throw httpError(404, '用户不存在。', 'USER_NOT_FOUND')
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

  app.post('/admin/users/:id/approve', async (request, reply) => {
    await adminStatus(request, 'approved')
    return reply.redirect(`/admin?notice=${encodeURIComponent('已批准。')}`)
  })

  app.post('/admin/users/:id/reject', async (request, reply) => {
    await adminStatus(request, 'rejected')
    return reply.redirect(`/admin?notice=${encodeURIComponent('已拒绝。')}`)
  })

  app.post('/admin/users/:id/quota', async (request, reply) => {
    const viewer = approvedCsrfGuard(request)
    if (!isAdminRole(viewer.user.role)) throw httpError(403, '仅管理员可访问。', 'ADMIN_ONLY')
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
    const viewer = approvedCsrfGuard(request)
    if (viewer.user.role !== 'superadmin') throw httpError(403, '仅超级管理员可访问。', 'SUPERADMIN_ONLY')
    const id = String((request.params as Record<string, string>).id)
    const user = store.userById(id)
    if (user === undefined || user.id === viewer.user.id || user.role === 'superadmin') throw httpError(403, '不能修改这个账号。', 'ROLE_PROTECTED')
    const role = form(request).role
    if (role !== 'admin' && role !== 'user') throw httpError(400, '角色无效。', 'BAD_ROLE')
    store.setUserRole(id, role)
    store.audit(id, 'admin.role', `role=${role} by @${viewer.user.login}`)
    return reply.redirect(`/admin?notice=${encodeURIComponent(role === 'admin' ? '已设为管理员。' : '已设为用户。')}`)
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
    if (resolved === undefined) return htmlPage(reply, 404, errorPage(config, request.viewer ?? null, '链接无效', '这个审批链接无效或已经过期。', request.locale))
    if (resolved.user.status !== 'pending') return reply.type('text/html').send(messagePage(config, '已经处理过', '这个申请已经处理过了。', request.viewer === undefined ? null : viewOf(request.viewer), request.locale))
    return reply.type('text/html').send(approvalPage({ config, locale: request.locale ?? 'zh', user: resolved.user, action: resolved.row.action, token }))
  })

  app.post('/approve/:token', async (request, reply) => {
    if (!loginLimiter.take(`approve:${rateLimitKey(request)}`)) return htmlPage(reply, 429, errorPage(config, request.viewer ?? null, '请求过多', '请稍后再试。', request.locale))
    const token = String((request.params as Record<string, string>).token)
    const result = await approvals.apply(token, 'email-link')
    if (!result.ok) return htmlPage(reply, 400, messagePage(config, '无法处理', result.reason, request.viewer === undefined ? null : viewOf(request.viewer), request.locale))
    return reply.type('text/html').send(messagePage(config, result.user.status === 'approved' ? '已批准' : '已拒绝', `@${result.user.login} 的申请已${result.user.status === 'approved' ? '批准' : '拒绝'}。`, request.viewer === undefined ? null : viewOf(request.viewer), request.locale))
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

  app.post('/api/jobs/:id/callback', async (request, reply) => {
    if (!apiLimiter.take(`callback:${rateLimitKey(request)}`)) return reply.code(429).send({ error: 'too many requests' })
    const secret = bearerSecret(request)
    const body = (request.body ?? {}) as Record<string, unknown>
    const result = await jobs.handleCallback(String((request.params as Record<string, string>).id), secret, body)
    if (!result.ok) return reply.code(result.status ?? 400).send({ error: result.error ?? 'callback rejected' })
    return result.duplicate === true ? { ok: true, duplicate: true } : { ok: true }
  })


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
      const result = await jobs.followUp(repo, { prUrl, branch, baseBranch, reason, headSha, ...(instruction === '' ? {} : { instruction }) })
      log.info('github follow-up', { repo: `${repo.owner}/${repo.name}`, pr: number, ok: result.ok, code: result.code, trace: result.job?.id })
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
    if (parsed === null) return
    const { command, issueUrl, number, title, detail } = parsed
    const key = `issue_command:${parsed.commentId}`
    if (store.getSetting(key) !== undefined) return
    store.setSetting(key, nowIso())
    let item = store.findWorkItemByIssueUrl(repo.id, issueUrl)
    if (item === undefined) {
      item = store.createWorkItem({ id: randomId('work'), repoId: repo.id, userId: repo.user_id, title, detail, issueUrl, state: 'proposed' })
    }
    const token = await repoGithubToken(repo, config, githubApp, store)
    const client = new GithubClient(token, config.github.apiBase)
    const owner = repo.upstream_owner || repo.owner
    const name = repo.upstream_name || repo.name
    const reply = async (message: string): Promise<void> => {
      await client.comment(owner, name, number, `${message}\n\n<sub>Fledge · issue command</sub>`)
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
      store.updateJob(plan.id, { plan_approved_at: nowIso(), plan_approved_by: repo.user_id, plan_rejected_at: null })
      store.updateWorkItem(item.id, { state: 'assigned' })
      store.audit(repo.user_id, 'plan.approved', `${plan.id} via issue command`)
      await reply(`Plan ${plan.id} approved. Run /fledge fix to start implementation.`)
      return
    }
    if (command === 'plan') {
      const goal = `Issue ${issueUrl}\nTitle: ${title}\n${detail}\n\nProduce one concrete plan only; do not write code, create a branch or open a PR.`
      const result = await jobs.enqueue(repo, 'manual', goal, 'plan', { workItemId: item.id })
      await reply(result.ok ? `Plan job ${result.job?.id ?? ''} queued.` : `Could not queue a plan: ${result.error ?? 'unknown error'}`)
      return
    }
    if (repo.plan_required === 1 && item.state !== 'approved' && item.state !== 'assigned' && item.state !== 'pr_ready') {
      await reply('This repository requires an approved plan first. Run /fledge plan, then /fledge approve.')
      return
    }
    const goal = `Issue ${issueUrl}\nTitle: ${title}\n${detail}\n\nImplement one focused fix for this issue.`
    const result = await jobs.enqueue(repo, 'manual', goal, 'iterate', { workItemId: item.id })
    await reply(result.ok ? `Implementation job ${result.job?.id ?? ''} queued.` : `Could not queue a fix: ${result.error ?? 'unknown error'}`)
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
        store.createWorkItem({ id: randomId('work'), repoId: repo.id, userId: repo.user_id, title, prUrl, state: merged ? 'merged' : closed ? 'closed' : 'pr_ready', prState: merged ? 'merged' : closed ? 'closed' : 'open', mergedAt: merged ? nowIso() : null, mergeCommit: typeof pull.merge_commit_sha === 'string' ? pull.merge_commit_sha : null })
        return
      }
      if (closed) {
        store.updateWorkItem(existing.id, {
          state: merged ? 'merged' : 'closed',
          pr_state: merged ? 'merged' : 'closed',
          ...(merged ? { merged_at: nowIso(), merge_commit: typeof pull.merge_commit_sha === 'string' ? pull.merge_commit_sha : null } : {}),
        })
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
      await handleIssueCommand(event, body)
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
    if (raw === undefined || !githubApp.verifyWebhook(raw, signature)) return reply.code(401).send({ error: 'bad webhook signature' })
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
    // A page that only needs a session signs in and comes back, instead of
    // showing "出错了" over a 401 the visitor cannot act on. API paths keep the
    // status for machine clients, and a non-GET request keeps it too so a form
    // post does not lose its body through a redirect.
    if (status === 401 && code === 'AUTH_REQUIRED' && (request.method === 'GET' || request.method === 'HEAD')) {
      return reply.redirect(`/auth/github?next=${encodeURIComponent(safeLocalPath(request.url, '/dashboard'))}`)
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
      await jobs.drain(config.shutdown.graceSeconds * 1000)
      clearInterval(sweeper)
      await app.close()
      await shutdownOtel()
      store.close()
    },
  }
}
