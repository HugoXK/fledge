import http from 'node:http'
import https from 'node:https'
import { StringDecoder } from 'node:string_decoder'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Config } from '../config.js'
import type { ApiTokenRow, Store, UserRow } from '../db.js'
import { log } from '../lib/log.js'
import { decryptSecret, sha256Hex } from '../lib/secrets.js'
import { costUsdFromUsage, headerCost, quotaView } from './quota.js'

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
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match?.[1]?.trim() ?? ''
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

function targetFor(user: UserRow, config: Config, body: ChatBody): { baseUrl: string; key: string; model: string; platformFunded: boolean } | { error: string } {
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

  const authenticate = (request: FastifyRequest): { token: ApiTokenRow; user: UserRow } | null => {
    const raw = bearer(request)
    if (!raw.startsWith('flg_')) return null
    const token = store.findApiToken(sha256Hex(raw))
    if (token === undefined) return null
    const user = store.userById(token.user_id)
    if (user === undefined || user.status !== 'approved') return null
    store.touchApiToken(token.id)
    return { token, user }
  }

  app.get('/v1/models', async (request, reply) => {
    const auth = authenticate(request)
    if (auth === null) return reply.code(401).send({ error: { type: 'invalid_api_key', message: 'Missing or invalid Fledge API token' } })
    const model = auth.user.own_llm_model ?? config.llm.model
    return {
      object: 'list',
      data: [{ id: model, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'fledge' }],
    }
  })

  app.post('/v1/chat/completions', { bodyLimit: MAX_BODY }, async (request, reply) => {
    const auth = authenticate(request)
    if (auth === null) return reply.code(401).send({ error: { type: 'invalid_api_key', message: 'Missing or invalid Fledge API token' } })
    const body = (request.body ?? {}) as ChatBody
    const target = targetFor(auth.user, config, body)
    if ('error' in target) return reply.code(503).send({ error: { type: 'platform_model_unavailable', message: target.error } })

    const quota = quotaView(auth.user, config)
    if (target.platformFunded && quota.exhausted) {
      await deps.onQuotaBlocked?.(auth.user)
      return quotaError(reply, auth.user, config)
    }

    const stream = body.stream === true
    const payload: ChatBody = { ...body, model: target.model }
    if (stream) {
      const existing = body.stream_options
      payload.stream_options = {
        ...(existing !== null && typeof existing === 'object' ? (existing as Record<string, unknown>) : {}),
        include_usage: true,
      }
    }
    const url = new URL(`${target.baseUrl}/chat/completions`)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: stream ? 'text/event-stream' : 'application/json',
      'accept-encoding': 'identity',
      authorization: `Bearer ${target.key}`,
      'user-agent': 'fledge/0.1',
    }
    const bodyText = JSON.stringify(payload)
    const jobId = auth.token.name.startsWith('job:') ? auth.token.name.slice(4) : null
    const started = Date.now()

    let upstream
    try {
      upstream = await upstreamRequest(url, headers, bodyText, stream ? 30 * 60_000 : 3 * 60_000)
    } catch (error) {
      log.error('gateway upstream failed', { error: String(error), platformFunded: target.platformFunded })
      return reply.code(502).send({ error: { type: 'provider_error', message: 'The model provider could not be reached.' } })
    }

    const funded = target.platformFunded
    const targetModel = target.model
    const costFromHeader = headerCost(upstream.headers)
    const writeHeaders = forwardHeaders(upstream.headers)
    writeHeaders['x-fledge-quota-remaining-cny'] = quota.unlimited ? 'unlimited' : quota.remainingCny.toFixed(4)
    writeHeaders['x-fledge-top-up-url'] = `${config.baseUrl}/settings`

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
      store.recordUsage(auth!.user.id, jobId, costUsd, JSON.stringify({ model: targetModel, usage: usageValue, ms: Date.now() - started }))
      log.info('gateway usage', { user: auth!.user.login, costUsd, jobId, model: targetModel })
      const updated = store.userById(auth!.user.id)
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
