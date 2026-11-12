import http from 'node:http'
import https from 'node:https'
import { StringDecoder } from 'node:string_decoder'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Config } from '../config.js'
import type { ApiTokenRow, RepoProviderModelRow, Store, UserRow } from '../db.js'
import { log } from '../lib/log.js'
import { decryptSecret, sha256Hex } from '../lib/secrets.js'
import { costUsdFromUsage, headerCost, quotaView } from './quota.js'
import { modelOrder, retryableModelFailure } from './modelFallback.js'
import { parseModelRun } from '../lib/modelRun.js'
import type { ModelAttempt, ModelFallback } from '../lib/modelRun.js'
import { rateLimitKey, RateLimiter } from '../lib/rateLimit.js'
import { GATEWAY_SCOPE } from '../lib/tokens.js'

interface GatewayDeps {
  config: Config
  store: Store
  onQuotaExhausted?: (user: UserRow) => Promise<void> | void
  onQuotaBlocked?: (user: UserRow) => Promise<void> | void
}

interface ChatBody {
  model?: unknown
  stream?: unknown
  stream_options?: unknown
  messages?: unknown
  [key: string]: unknown
}

const MAX_BODY = 20 * 1024 * 1024

function bearer(request: FastifyRequest): string {
  const header = String(request.headers.authorization ?? '')
  if (header.slice(0, 7).toLowerCase() !== 'bearer ') return ''
  return header.slice(7).trim().slice(0, 512)
}

function quotaError(reply: FastifyReply, user: UserRow, config: Config): void {
  const quota = quotaView(user, config)
  reply.code(402).send({
    error: {
      type: 'quota_exhausted',
      code: 'FLEDGE_QUOTA_EXHAUSTED',
      message: '平台额度已用完，请到 Settings → Model 配置你自己的模型 API 后继续。',
      quota: {
        initialCny: Number(quota.initialCny.toFixed(4)),
        usedCny: Number(quota.usedCny.toFixed(4)),
        remainingCny: 0,
      },
      settingsUrl: `${config.baseUrl}/settings`,
    },
  })
}

function targetFor(user: UserRow, config: Config, body: ChatBody, repoModel?: RepoProviderModelRow): { baseUrl: string; key: string; model: string; platformFunded: boolean } | { error: string } {
  if (repoModel !== undefined) {
    return {
      baseUrl: repoModel.base_url.replace(/\/$/, ''),
      key: decryptSecret(repoModel.key_enc, config.tokenEncryptionKey),
      model: repoModel.model,
      platformFunded: false,
    }
  }
  if (user.own_llm_base_url !== null && user.own_llm_base_url !== '' && user.own_llm_key_enc !== null) {
    return {
      baseUrl: user.own_llm_base_url.replace(/\/$/, ''),
      key: decryptSecret(user.own_llm_key_enc, config.tokenEncryptionKey),
      model: user.own_llm_model ?? (typeof body.model === 'string' ? body.model : config.llm.model),
      platformFunded: false,
    }
  }
  if (config.llm.key === '') return { error: 'Platform model is not configured. Set your own model API in Settings → Model.' }
  return { baseUrl: config.llm.baseUrl, key: config.llm.key, model: config.llm.model, platformFunded: true }
}

function upstreamRequest(url: URL, headers: Record<string, string>, body: string, timeoutMs: number): Promise<{ res: http.IncomingMessage; status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http
    const request = mod.request(url, { method: 'POST', headers }, (res) => {
      resolve({ res, status: res.statusCode ?? 502, headers: res.headers })
    })
    request.on('error', reject)
    request.setTimeout(timeoutMs, () => request.destroy(new Error('upstream timeout')))
    request.write(body)
    request.end()
  })
}

// A refusal's body can be large; it is read only to decide retryability and to
// answer the client, never kept.
async function readAnswer(res: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of res) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > 1_048_576) {
      res.destroy()
      break
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function forwardHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (['connection', 'transfer-encoding', 'keep-alive', 'content-length', 'content-encoding'].includes(lower)) continue
    out[lower] = Array.isArray(value) ? value.join(', ') : value
  }
  return out
}

function sseUsage(line: string): unknown {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return null
  const data = trimmed.slice(5).trim()
  if (data === '' || data === '[DONE]') return null
  try {
    const parsed = JSON.parse(data) as { usage?: unknown }
    return parsed.usage ?? null
  } catch {
    return null
  }
}

export function registerGateway(app: FastifyInstance, deps: GatewayDeps): void {
  const { config, store } = deps
  const limiter = new RateLimiter(240, 60_000)

  // #355: three answers, not two. A wrong scope is a 403 with a stable type and
  // is decided before `last_used_at` is written, so a refused token leaves no
  // trace that it was tried; an expired or revoked token is simply unknown here
  // (findApiToken filters both), which keeps that answer a plain 401.
  const authenticate = (request: FastifyRequest): { kind: 'ok'; token: ApiTokenRow; user: UserRow } | { kind: 'unauthorized' } | { kind: 'forbidden' } => {
    const raw = bearer(request)
    if (!raw.startsWith('flg_')) return { kind: 'unauthorized' }
    const token = store.findApiToken(sha256Hex(raw))
    if (token === undefined) return { kind: 'unauthorized' }
    const user = store.userById(token.user_id)
    if (user === undefined || user.status !== 'approved') return { kind: 'unauthorized' }
    if (token.scope !== GATEWAY_SCOPE) return { kind: 'forbidden' }
    store.touchApiToken(token.id)
    return { kind: 'ok', token, user }
  }

  const refuse = (reply: FastifyReply, auth: { kind: 'unauthorized' } | { kind: 'forbidden' }): FastifyReply => auth.kind === 'forbidden'
    ? reply.code(403).send({ error: { type: 'insufficient_scope', message: 'This Fledge API token is not allowed to use the model gateway' } })
    : reply.code(401).send({ error: { type: 'invalid_api_key', message: 'Missing or invalid Fledge API token' } })

  app.get('/v1/models', async (request, reply) => {
    if (!limiter.take(`gateway-ip:${rateLimitKey(request)}`)) return reply.code(429).send({ error: { type: 'rate_limited', message: 'Too many gateway requests' } })
    const auth = authenticate(request)
    if (auth.kind !== 'ok') return refuse(reply, auth)
    const repoModels = auth.token.repo_id === null ? [] : store.listRepoModelSelection(auth.token.repo_id)
    if (repoModels.length > 0) {
      return {
        object: 'list',
        data: repoModels.map((entry) => ({ id: entry.id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'fledge', name: entry.label })),
      }
    }
    const userModels = auth.token.repo_id === null ? store.listUserProviderModels(auth.user.id) : []
    if (userModels.length > 0) {
      return {
        object: 'list',
        data: userModels.map((entry) => ({ id: entry.id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'fledge', name: entry.label })),
      }
    }
    const model = auth.user.own_llm_model ?? config.llm.model
    return {
      object: 'list',
      data: [{ id: model, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'fledge' }],
    }
  })

  app.post('/v1/chat/completions', { bodyLimit: MAX_BODY }, async (request, reply) => {
    if (!limiter.take(`gateway-chat:${rateLimitKey(request)}`)) return reply.code(429).send({ error: { type: 'rate_limited', message: 'Too many gateway requests' } })
    const auth = authenticate(request)
    if (auth.kind !== 'ok') return refuse(reply, auth)
    // Captured once: a closure below must not lose the narrowing of the union.
    const authed = auth
    const body = (request.body ?? {}) as ChatBody
    const repoModel = auth.token.repo_id === null || typeof body.model !== 'string' ? undefined : store.providerModelForRun(auth.token.repo_id, body.model)
    const stream = body.stream === true
    const jobId = auth.token.name.startsWith('job:') ? auth.token.name.slice(4) : null
    const started = Date.now()
    const quota = quotaView(auth.user, config)

    // #358: a repository's order decides the attempts, and only a retryable
    // refusal moves to the next model. `is_default` is the head and the rest keep
    // the query's order, so the picker in `src/flybot/instances.ts` and this loop
    // cannot disagree about the primary. The platform model and a user's own single
    // model have nothing behind them: they stay one attempt.
    const selection = auth.token.repo_id === null ? [] : store.listRepoModelSelection(auth.token.repo_id)
    const candidates: Array<RepoProviderModelRow | undefined> =
      repoModel === undefined ? [undefined] : modelOrder(selection, repoModel.id)
    const attempts: ModelAttempt[] = []
    const quotaHeaders = (): Record<string, string> => ({
      'x-fledge-quota-remaining-cny': quota.unlimited ? 'unlimited' : quota.remainingCny.toFixed(4),
      'x-fledge-top-up-url': `${config.baseUrl}/settings`,
    })

    // The job names the model that actually ran and the models it fell through.
    // The row is the record; a call whose job was deleted under it must not fail.
    // #407: `attempts` is this call's list, so the fallback is kept beside it —
    // the first one the job ever made survives a later call that answered on the
    // primary, which is exactly the case this record exists to show.
    const recordModel = (winner: { id: string; label: string } | null, fallback: ModelFallback | null): void => {
      if (jobId === null) return
      try {
        const stored = parseModelRun(store.getJob(jobId)?.model_json ?? null)?.fallback ?? null
        store.updateJob(jobId, { model_json: JSON.stringify({ model: winner, attempts, fallback: fallback ?? stored }) })
      } catch (error) {
        log.warn('gateway model record failed', { trace: jobId, error: String(error) })
      }
    }

    let target: { baseUrl: string; key: string; model: string; platformFunded: boolean } | null = null
    let targetName: { modelId: string; label: string } | null = null
    let upstream: Awaited<ReturnType<typeof upstreamRequest>> | null = null
    let lastFailure: { status: number; text: string; headers: Record<string, string> } | null = null

    for (const candidate of candidates) {
      const attemptTarget = targetFor(auth.user, config, body, candidate)
      if ('error' in attemptTarget) return reply.code(503).send({ error: { type: 'platform_model_unavailable', message: attemptTarget.error } })
      if (attemptTarget.platformFunded && quota.exhausted) {
        await deps.onQuotaBlocked?.(auth.user)
        return quotaError(reply, auth.user, config)
      }
      const payload: ChatBody = { ...body, model: attemptTarget.model }
      if (stream) {
        const existing = body.stream_options
        payload.stream_options = {
          ...(existing !== null && typeof existing === 'object' ? (existing as Record<string, unknown>) : {}),
          include_usage: true,
        }
      }
      const attemptUrl = new URL(`${attemptTarget.baseUrl}/chat/completions`)
      const attemptHeaders: Record<string, string> = {
        'content-type': 'application/json',
        accept: stream ? 'text/event-stream' : 'application/json',
        'accept-encoding': 'identity',
        authorization: `Bearer ${attemptTarget.key}`,
        'user-agent': 'fledge/0.1',
      }
      const attemptName = { modelId: candidate?.id ?? attemptTarget.model, label: candidate?.label ?? attemptTarget.model }
      let answer: Awaited<ReturnType<typeof upstreamRequest>>
      try {
        answer = await upstreamRequest(attemptUrl, attemptHeaders, JSON.stringify(payload), stream ? 30 * 60_000 : 3 * 60_000)
      } catch (error) {
        // Unreachable is the one retryable failure with no answer to forward.
        log.error('gateway upstream failed', { error: String(error), platformFunded: attemptTarget.platformFunded })
        attempts.push({ ...attemptName, status: 502, retryable: true })
        continue
      }
      if (answer.status >= 200 && answer.status < 300) {
        target = attemptTarget
        targetName = attemptName
        upstream = answer
        break
      }
      const text = await readAnswer(answer.res)
      const retryable = retryableModelFailure(answer.status, text)
      attempts.push({ ...attemptName, status: answer.status, retryable })
      lastFailure = { status: answer.status, text, headers: { ...forwardHeaders(answer.headers), ...quotaHeaders() } }
      // Auth, an exhausted quota, a payment problem and a policy refusal are the
      // repository's own answer: a second model must not mask them.
      if (!retryable) break
    }

    if (upstream === null || target === null || targetName === null) {
      // No winner means no fallback pair to record; a fallback from an earlier
      // call is left as it is rather than cleared by a failed call.
      recordModel(null, null)
      if (lastFailure !== null) return reply.code(lastFailure.status).headers(lastFailure.headers).send(lastFailure.text)
      return reply.code(502).send({ error: { type: 'provider_error', message: 'The model provider could not be reached.' } })
    }

    const firstAttempt = attempts[0]
    const fellBack: ModelFallback | null = firstAttempt === undefined
      ? null
      : {
          from: { modelId: firstAttempt.modelId, label: firstAttempt.label },
          to: { modelId: targetName.modelId, label: targetName.label },
          status: firstAttempt.status,
        }
    recordModel({ id: target.model, label: targetName.label }, fellBack)
    const funded = target.platformFunded
    const targetModel = target.model
    const costFromHeader = headerCost(upstream.headers)
    const writeHeaders = forwardHeaders(upstream.headers)
    Object.assign(writeHeaders, quotaHeaders())

    if (stream && upstream.status >= 200 && upstream.status < 300) {
      reply.hijack()
      reply.raw.writeHead(upstream.status, writeHeaders)
      const decoder = new StringDecoder('utf8')
      let pending = ''
      let usage: unknown = null
      upstream.res.on('data', (chunk: Buffer) => {
        reply.raw.write(chunk)
        pending += decoder.write(chunk)
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) {
          const found = sseUsage(line)
          if (found !== null) usage = found
        }
      })
      upstream.res.on('end', () => {
        pending += decoder.end()
        const found = sseUsage(pending)
        if (found !== null) usage = found
        reply.raw.end()
        const cost = costFromHeader ?? costUsdFromUsage(usage, config.llm.pricePerTokenUsd)
        finishCost(cost, usage)
      })
      upstream.res.on('error', (error) => {
        log.warn('gateway stream error', { error: String(error) })
        try {
          reply.raw.end()
        } catch {}
      })
      return
    }

    const chunks: Buffer[] = []
    for await (const chunk of upstream.res) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    const text = Buffer.concat(chunks).toString('utf8')
    let usage: unknown = null
    try {
      const parsed = JSON.parse(text) as { usage?: unknown }
      usage = parsed.usage ?? null
    } catch {}
    const cost = costFromHeader ?? costUsdFromUsage(usage, config.llm.pricePerTokenUsd)
    if (upstream.status >= 200 && upstream.status < 300) finishCost(cost, usage)
    reply
      .code(upstream.status)
      .headers(writeHeaders)
      .send(text)

    function finishCost(costUsd: number, usageValue: unknown): void {
      if (!funded || costUsd <= 0) return
      store.recordUsage(authed.user.id, jobId, costUsd, JSON.stringify({ model: targetModel, usage: usageValue, ms: Date.now() - started }), authed.token.repo_id ?? null)
      if (jobId !== null) store.addJobCost(jobId, costUsd)
      // #100: a call made with a job token is that job's spend; name the job
      // under the same key every other job line uses. A call without a job in
      // scope (a user's own PAT) carries no trace at all rather than a null one.
      log.info('gateway usage', { user: authed.user.login, costUsd, model: targetModel, ...(jobId === null ? {} : { trace: jobId }) })
      const updated = store.userById(authed.user.id)
      if (updated !== undefined && quotaView(updated, config).exhausted) {
        store.notify(updated.id, 'quota', '平台额度已用完，请到 Settings → Model 配置你自己的模型 API。')
        void deps.onQuotaExhausted?.(updated)
      }
    }
  })
}

export function modelGatewayInfo(config: Config): { baseUrl: string; model: string } {
  return { baseUrl: `${config.baseUrl}/v1`, model: config.llm.model }
}
