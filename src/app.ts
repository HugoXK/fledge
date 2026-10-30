import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
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
import { addMinutes } from './lib/time.js'
import { Approvals } from './users/approval.js'
import {
  adminPage,
  approvalPage,
  dashboardPage,
  landingPage,
  messagePage,
  pendingPage,
  rejectedPage,
  repoPage,
  settingsPage,
  errorPage,
} from './views/pages.js'
import { parseRepoInput, validateRepoToken } from './repos/github.js'

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
  const jobs = new Jobs(store, config, runner, mailer)
  const loginLimiter = new RateLimiter(30, 60_000)
  const apiLimiter = new RateLimiter(120, 60_000)

  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 20 * 1024 * 1024,
  })
  await app.register(fastifyCookie)
  await app.register(fastifyFormbody)
  await app.register(fastifyStatic, { root: join(process.cwd(), 'public'), prefix: '/assets/', decorateReply: false })

  app.addHook('onRequest', async (request) => {
    request.viewer = sessions.read(request) ?? undefined
  })

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff')
    reply.header('referrer-policy', 'strict-origin-when-cross-origin')
    reply.header('x-frame-options', 'DENY')
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

  const ownedRepo = (request: FastifyRequest, id: string) => {
    const viewer = requireApproved(request)
    const repo = store.getRepo(id)
    if (repo === undefined || repo.user_id !== viewer.user.id) throw httpError(404, '仓库不存在。', 'REPO_NOT_FOUND')
    return { viewer, repo }
  }

  app.get('/healthz', async () => ({ ok: true, service: 'fledge', version: '0.1.0', time: new Date().toISOString() }))

  app.get('/', async (request, reply) => {
    const viewer = request.viewer
    if (viewer !== undefined) {
      if (viewer.user.status === 'approved') return reply.redirect('/dashboard')
      return reply.redirect('/pending')
    }
    return reply.type('text/html').send(landingPage(config, null, config.env !== 'production' && config.devLogin.login !== ''))
  })

  app.get('/auth/dev', async (request, reply) => {
    if (config.env === 'production' || config.devLogin.login === '') {
      return reply.code(404).send(errorPage(config, request.viewer ?? null, '页面不存在', 'Dev 登录没有开启。'))
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
    const raw = sessions.start(user.id, request)
    const sessionHash = sha256Hex(raw)
    sessions.setCookies(reply, raw, { sessionHash, user: store.userById(user.id)!, csrfToken: sessions.csrfFor(sessionHash) })
    store.audit(user.id, 'login.dev', 'DEV_LOGIN_LOGIN')
    return reply.redirect('/dashboard')
  })

  app.get('/auth/github', async (request, reply) => {
    if (!loginLimiter.take(`login:${request.ip}`)) return reply.code(429).send(errorPage(config, request.viewer ?? null, '请求过多', '请稍后再试。'))
    if (config.github.clientId === '' || config.github.clientSecret === '') {
      return reply.code(503).send(errorPage(config, request.viewer ?? null, 'GitHub OAuth 未配置', '请先在 .env 设置 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET。'))
    }
    const state = randomToken(32)
    store.createOAuthState(sha256Hex(state), addMinutes(10), null)
    return reply.redirect(oauth.authorizeUrl(state))
  })

  app.get('/auth/github/callback', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>
    const code = query.code ?? ''
    const state = query.state ?? ''
    if (code === '' || state === '' || store.consumeOAuthState(sha256Hex(state)) === undefined) {
      return reply.code(400).send(errorPage(config, request.viewer ?? null, '登录失败', 'OAuth state 无效或已过期，请重新登录。'))
    }
    let profile
    let token
    try {
      token = await oauth.exchangeCode(code)
      profile = await oauth.profile(token)
    } catch (error) {
      log.warn('github login failed', { error: String(error) })
      return reply.code(400).send(errorPage(config, request.viewer ?? null, 'GitHub 登录失败', '无法完成 GitHub 登录，请重试。'))
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
    if (user.status === 'approved') {
      const raw = sessions.start(user.id, request)
      const sessionHash = sha256Hex(raw)
      sessions.setCookies(reply, raw, { sessionHash, user, csrfToken: sessions.csrfFor(sessionHash) })
      return reply.redirect('/dashboard')
    }
    if (user.status === 'pending') {
      try {
        await approvals.request(user)
      } catch (error) {
        log.error('approval request mail failed', { user: user.login, error: String(error) })
      }
    }
    return reply.redirect('/pending')
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
    const view = viewOf(viewer)
    if (viewer.user.status === 'rejected') return reply.type('text/html').send(rejectedPage(config, view))
    return reply.type('text/html').send(pendingPage(config, view))
  })

  app.get('/dashboard', async (request, reply) => {
    const viewer = requireApproved(request)
    const view = viewOf(viewer)
    return reply.type('text/html').send(
      dashboardPage({
        config,
        viewer: view,
        repos: store.listRepos(viewer.user.id),
        jobs: store.listJobs(viewer.user.id),
        notifications: store.listNotifications(viewer.user.id),
        notice: queryText(request, 'notice'),
        error: queryText(request, 'error'),
      }),
    )
  })

  app.post('/repos', async (request, reply) => {
    const viewer = csrfGuard(request)
    const body = form(request)
    try {
      const { owner, name } = parseRepoInput(body.repo ?? '')
      const token = (body.token ?? '').trim()
      if (token === '') throw new Error('请填写 GitHub token')
      const info = await validateRepoToken(token, owner, name, config.github.apiBase)
      const interval = [60, 360, 1440, 10080].includes(Number(body.interval)) ? Number(body.interval) : 1440
      const repo = store.createRepo({
        id: randomId('repo'),
        userId: viewer.user.id,
        owner: info.owner,
        name: info.name,
        defaultBranch: info.defaultBranch,
        tokenEnc: encryptSecret(token, config.tokenEncryptionKey),
        goal: (body.goal ?? '').slice(0, 4000),
        autoIterate: body.auto === '1',
        intervalMinutes: interval,
      })
      store.audit(viewer.user.id, 'repo.added', `${repo.owner}/${repo.name}`)
      return reply.redirect(`/repos/${repo.id}?notice=${encodeURIComponent('仓库已添加。')}`)
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
        viewer: viewOf(viewer),
        repo,
        jobs: store.listJobsForRepo(repo.id),
        notice: queryText(request, 'notice'),
        error: queryText(request, 'error'),
      }),
    )
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

  app.post('/repos/:id/settings', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id))
    const body = form(request)
    const interval = [60, 360, 1440, 10080].includes(Number(body.interval)) ? Number(body.interval) : repo.interval_minutes
    store.updateRepo(repo.id, {
      goal: (body.goal ?? '').slice(0, 4000),
      auto_iterate: body.auto === '1' ? 1 : 0,
      enabled: body.enabled === '1' ? 1 : 0,
      interval_minutes: interval,
    })
    store.audit(viewer.user.id, 'repo.settings', `${repo.owner}/${repo.name}`)
    return reply.redirect(`/repos/${repo.id}?notice=${encodeURIComponent('设置已保存。')}`)
  })

  app.post('/repos/:id/delete', async (request, reply) => {
    const { viewer, repo } = ownedRepo(request, String((request.params as Record<string, string>).id))
    store.deleteRepo(repo.id)
    store.audit(viewer.user.id, 'repo.deleted', `${repo.owner}/${repo.name}`)
    return reply.redirect(`/dashboard?notice=${encodeURIComponent('仓库已删除。')}`)
  })

  app.get('/settings', async (request, reply) => {
    const viewer = requireApproved(request)
    return reply.type('text/html').send(
      settingsPage({
        config,
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
        settingsPage({ config, viewer: viewOf(viewer), tokens: store.listApiTokens(viewer.user.id), error }),
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
    return reply.type('text/html').send(
      adminPage({
        config,
        viewer: viewOf(viewer),
        users: store.listUsers(),
        jobs: store.all<JobRow>('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 30'),
        audit: store.listAudit(50),
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
    store.audit(user.id, `admin.${status}`, `by @${viewer.user.login}`)
    try {
      await mailer.send({ to: user.email ?? config.mail.adminEmail, ...(status === 'approved' ? approvedEmail(user) : rejectedEmail(user, '')) })
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
    if (resolved === undefined) return reply.code(404).send(errorPage(config, request.viewer ?? null, '链接无效', '这个审批链接无效或已经过期。'))
    if (resolved.user.status !== 'pending') return reply.type('text/html').send(messagePage(config, '已经处理过', '这个申请已经处理过了。', request.viewer === undefined ? null : viewOf(request.viewer)))
    return reply.type('text/html').send(approvalPage({ config, user: resolved.user, action: resolved.row.action, token }))
  })

  app.post('/approve/:token', async (request, reply) => {
    const token = String((request.params as Record<string, string>).token)
    const result = await approvals.apply(token, 'email-link')
    if (!result.ok) return reply.code(400).send(messagePage(config, '无法处理', result.reason, request.viewer === undefined ? null : viewOf(request.viewer)))
    return reply.type('text/html').send(messagePage(config, result.user.status === 'approved' ? '已批准' : '已拒绝', `@${result.user.login} 的申请已${result.user.status === 'approved' ? '批准' : '拒绝'}。`, request.viewer === undefined ? null : viewOf(request.viewer)))
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
    return reply.code(404).send(errorPage(config, request.viewer === undefined ? null : viewOf(request.viewer), '页面不存在', '你访问的页面不存在。'))
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
    return reply.code(status).send(errorPage(config, request.viewer === undefined ? null : viewOf(request.viewer), status === 404 ? '页面不存在' : '出错了', status >= 500 ? '服务器出了点问题，请稍后再试。' : message))
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
    close: async () => {
      jobs.stop()
      clearInterval(sweeper)
      await app.close()
      store.close()
    },
  }
}
