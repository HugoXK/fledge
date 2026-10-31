#!/usr/bin/env node
// Fledge → FlyBot bridge.
//
// Runs on the FlyBot host, listens on loopback, and forwards a Fledge job to a
// configured FlyBot chat session through DSH's local /api/bot endpoint. The
// bridge never sees the user's GitHub token; Fledge gives the agent a scoped
// credential URL instead.
//
// It also exposes:
//   POST /dsh    authenticated DSH /api/bot proxy (state, create-bot, ...)
//   POST /run    forward a job to a session
//   /v1/*        a per-instance model proxy that injects a Fledge gateway token
//
// Required env:
//   BRIDGE_TOKEN             shared secret with Fledge (>= 16 chars)
//   FLYBOT_CHAT_SESSION_ID   the default Bot chat (iterate)
// Optional:
//   FLYBOT_REVIEW_SESSION_ID default reviewer chat (falls back to the iterate chat)
//   BRIDGE_PORT              default 8787
//   BRIDGE_HOST              default 127.0.0.1
//   FLYBOT_WEB               default http://127.0.0.1:3080
//   FLYBOT_LOG               default /home/xuke/work/dsh-web.log
//   MAX_PROMPT_BYTES         default 32768
//   FLEDGE_GATEWAY_ORIGIN    e.g. http://127.0.0.1:8095 (enables /v1 proxy)
//   FLEDGE_GATEWAY_TOKEN     a user-scoped flg_ token for the proxy
//   MODEL_PROXY_BIND         default 127.0.0.1
//   MODEL_PROXY_PORT         unset/0 disables the model proxy
//   MODEL_PROXY_KEY          shared key the instance model client sends

import http from 'node:http'
import https from 'node:https'
import { readFileSync, statSync } from 'node:fs'

const PORT = Number(process.env.BRIDGE_PORT ?? 8787)
const HOST = process.env.BRIDGE_HOST ?? '127.0.0.1'
const TOKEN = process.env.BRIDGE_TOKEN ?? ''
const SESSION_ID = process.env.FLYBOT_CHAT_SESSION_ID ?? ''
const REVIEW_SESSION_ID = process.env.FLYBOT_REVIEW_SESSION_ID ?? SESSION_ID
const WEB = (process.env.FLYBOT_WEB ?? 'http://127.0.0.1:3080').replace(/\/$/, '')
const LOG = process.env.FLYBOT_LOG ?? '/home/xuke/work/dsh-web.log'
const MAX_PROMPT = Number(process.env.MAX_PROMPT_BYTES ?? 32768)
const MAX_PROXY_BODY = Number(process.env.MAX_PROXY_BODY ?? 64 * 1024 * 1024)
const GATEWAY_ORIGIN = (process.env.FLEDGE_GATEWAY_ORIGIN ?? '').replace(/\/$/, '')
const GATEWAY_TOKEN = process.env.FLEDGE_GATEWAY_TOKEN ?? ''
const MODEL_PROXY_BIND = process.env.MODEL_PROXY_BIND ?? '127.0.0.1'
const MODEL_PROXY_PORT = Number(process.env.MODEL_PROXY_PORT ?? 0)
const MODEL_PROXY_KEY = process.env.MODEL_PROXY_KEY ?? ''

if (TOKEN.length < 16) {
  console.error('BRIDGE_TOKEN must be set (>= 16 chars)')
  process.exit(1)
}
if (SESSION_ID === '') {
  console.error('FLYBOT_CHAT_SESSION_ID must be set')
  process.exit(1)
}
if (MODEL_PROXY_PORT > 0 && (GATEWAY_ORIGIN === '' || GATEWAY_TOKEN === '' || MODEL_PROXY_KEY === '')) {
  console.error('MODEL_PROXY_PORT needs FLEDGE_GATEWAY_ORIGIN, FLEDGE_GATEWAY_TOKEN and MODEL_PROXY_KEY')
  process.exit(1)
}

function redact(text) {
  return String(text ?? '')
    .replace(/api_key:\s*[A-Fa-f0-9]{16,}/g, 'api_key: [redacted]')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-[redacted]')
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, '[redacted-github-token]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi, '$1[redacted]')
}

function logEvent(event, fields = {}) {
  const line = { ts: new Date().toISOString(), event, ...fields }
  console.log(JSON.stringify(line))
}

function lastDshToken() {
  const size = statSync(LOG).size
  const start = Math.max(0, size - 4 * 1024 * 1024)
  const fd = readFileSync(LOG, { encoding: 'utf8' })
  const slice = fd.slice(start)
  const matches = [...slice.matchAll(/token=([A-Za-z0-9_-]+)/g)]
  return matches.at(-1)?.[1] ?? ''
}

async function dshCookie() {
  const token = lastDshToken()
  if (token === '') throw new Error('no DSH token in the web log yet')
  const response = await fetch(`${WEB}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  const cookie = cookies.map((entry) => entry.split(';')[0]).join('; ')
  if (cookie === '') throw new Error('DSH did not set a session cookie')
  return cookie
}

async function dshApi(endpoint, payload) {
  const cookie = await dshCookie()
  const response = await fetch(`${WEB}/api/bot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ endpoint, payload }),
    signal: AbortSignal.timeout(120_000),
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`DSH /api/bot ${response.status}: ${body.slice(0, 300)}`)
  return body === '' ? {} : JSON.parse(body)
}

async function sendToBot(text, sessionId) {
  const cookie = await dshCookie()
  const response = await fetch(`${WEB}/api/bot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ endpoint: 'send', payload: { sessionId, text } }),
    signal: AbortSignal.timeout(30_000),
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`DSH /api/bot ${response.status}: ${body.slice(0, 300)}`)
  return body
}

function buildText(job) {
  const kind = job.kind === 'review' ? 'review' : job.kind === 'provision' ? 'provision' : 'iterate'
  const upstream = job.upstream || job.repo || {}
  const fork = job.fork || job.repo || upstream
  const rules = kind === 'review'
    ? [
        '- Review every open pull request on the upstream, including PRs not created by Fledge.',
        '- Score each PR 0-100 with a short rationale and post a COMMENT review; never approve, merge, push or change settings.',
        '- Do not modify code in review mode.',
      ]
    : kind === 'provision'
      ? ['- This is a provisioning request. Do not write code, push, or open PRs.']
      : [
          `- Push the branch to ${fork.owner}/${fork.name}; open one pull request against ${upstream.owner}/${upstream.name} (base ${upstream.defaultBranch}).`,
          job.canCreateIssue === false
            ? '- The token may not be able to create upstream issues; report a clear error instead of guessing.'
            : `- Create or reuse one issue on ${upstream.owner}/${upstream.name}; reference it from the PR.`,
          '- Never push to the upstream base branch. Do not force-push, merge or change repository settings.',
          '- Write a failing test first when a test is possible.',
        ]
  const lines = [
    'A Fledge job is ready. Work in your own workspace; do not touch the Fledge service.',
    '',
    `Job: ${job.jobId}`,
    `Mode: ${kind}`,
    `Upstream: ${upstream.owner}/${upstream.name} (base ${upstream.defaultBranch})`,
    `Fork: ${fork.owner}/${fork.name}${job.isFork ? ' (push here)' : ' (same as upstream)'}`,
    `Permission: ${job.permission || 'unknown'}${job.canReview ? ' · review enabled' : ''}`,
    `Goal: ${job.goal}`,
    '',
    'Credentials:',
    `- GitHub token: GET ${job.credentialUrl} with "Authorization: Bearer ${job.credentialSecret}"`,
    `- Model: POST ${job.platform?.baseUrl}/chat/completions with "Authorization: Bearer ${job.platform?.token}"`,
    `- Model id: ${job.platform?.model}`,
    '',
    'Rules:',
    ...rules,
    '- Do not print the GitHub token or the job token.',
    `- Finish by POSTing ${job.callbackUrl} with JSON {status, branch, prUrl, issueUrl, reviewScore, summary, error}`,
    `  and "Authorization: Bearer ${job.callbackSecret}".`,
    '',
    job.instructions ?? '',
  ]
  return lines.join('\n').slice(0, MAX_PROMPT)
}

function json(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) })
  response.end(text)
}

function authorized(request) {
  return String(request.headers.authorization ?? '') === `Bearer ${TOKEN}`
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/healthz') {
    return json(response, 200, { ok: true, service: 'fledge-flybot-bridge', modelProxy: MODEL_PROXY_PORT > 0 })
  }
  if (request.method === 'POST' && request.url === '/dsh') {
    if (!authorized(request)) return json(response, 401, { error: 'unauthorized' })
    let body
    try {
      body = JSON.parse((await readBody(request, MAX_PROMPT)).toString('utf8'))
    } catch {
      return json(response, 400, { error: 'invalid JSON' })
    }
    if (typeof body.endpoint !== 'string') return json(response, 400, { error: 'endpoint required' })
    try {
      return json(response, 200, await dshApi(body.endpoint, body.payload ?? {}))
    } catch (error) {
      logEvent('dsh-failed', { endpoint: body.endpoint, error: redact(String(error)) })
      return json(response, 502, { error: redact(String(error)) })
    }
  }
  if (request.method !== 'POST' || request.url !== '/run') {
    return json(response, 404, { error: 'not found' })
  }
  if (!authorized(request)) return json(response, 401, { error: 'unauthorized' })
  let job
  try {
    job = JSON.parse((await readBody(request, MAX_PROMPT)).toString('utf8'))
  } catch {
    return json(response, 400, { error: 'invalid JSON' })
  }
  if (typeof job.jobId !== 'string' || typeof job.credentialUrl !== 'string' || typeof job.callbackUrl !== 'string') {
    return json(response, 400, { error: 'jobId, credentialUrl and callbackUrl are required' })
  }
  try {
    const sessionId = typeof job.sessionId === 'string' && job.sessionId !== ''
      ? job.sessionId
      : job.kind === 'review' ? REVIEW_SESSION_ID : SESSION_ID
    await sendToBot(buildText(job), sessionId)
    logEvent('job-forwarded', { jobId: job.jobId, kind: job.kind ?? 'iterate', repo: `${job.upstream?.owner || job.repo?.owner}/${job.upstream?.name || job.repo?.name}`, session: sessionId.slice(0, 12) })
    return json(response, 202, { ok: true, accepted: true })
  } catch (error) {
    logEvent('job-failed', { jobId: job.jobId, error: redact(String(error)) })
    return json(response, 502, { error: 'could not reach DSH' })
  }
})

function createModelProxy() {
  if (MODEL_PROXY_PORT <= 0) return null
  const origin = new URL(GATEWAY_ORIGIN)
  const mod = origin.protocol === 'https:' ? https : http
  const proxy = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      return json(response, 200, { ok: true, service: 'fledge-model-proxy' })
    }
    if (!request.url?.startsWith('/v1/')) return json(response, 404, { error: 'not found' })
    const given = String(request.headers.authorization ?? '')
    if (given !== `Bearer ${MODEL_PROXY_KEY}`) return json(response, 401, { error: 'unauthorized' })
    let body
    try {
      body = await readBody(request, MAX_PROXY_BODY)
    } catch {
      return json(response, 413, { error: 'body too large' })
    }
    const headers = {
      'content-type': request.headers['content-type'] ?? 'application/json',
      accept: request.headers.accept ?? '*/*',
      authorization: `Bearer ${GATEWAY_TOKEN}`,
      'content-length': String(body.length),
      'user-agent': 'fledge-instance-proxy/0.1',
    }
    const upstream = mod.request(new URL(request.url, origin), { method: request.method, headers }, (upstreamResponse) => {
      const out = {}
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        const lower = name.toLowerCase()
        if (lower === 'connection' || lower === 'transfer-encoding' || lower === 'keep-alive' || lower === 'content-length') continue
        out[name] = value
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, out)
      upstreamResponse.pipe(response)
    })
    upstream.on('error', (error) => {
      logEvent('model-proxy-failed', { error: redact(String(error)) })
      if (!response.headersSent) json(response, 502, { error: 'gateway unavailable' })
      else response.destroy()
    })
    upstream.setTimeout(10 * 60 * 1000, () => upstream.destroy(new Error('gateway timeout')))
    if (body.length > 0) upstream.write(body)
    upstream.end()
    response.on('close', () => { if (!response.writableEnded) upstream.destroy() })
  })
  proxy.listen(MODEL_PROXY_PORT, MODEL_PROXY_BIND, () => {
    logEvent('model-proxy-start', { listen: `${MODEL_PROXY_BIND}:${MODEL_PROXY_PORT}` })
  })
  return proxy
}

server.listen(PORT, HOST, () => {
  logEvent('bridge-start', { listen: `${HOST}:${PORT}`, web: WEB, modelProxy: MODEL_PROXY_PORT > 0 })
})
const modelProxy = createModelProxy()

function shutdown(signal) {
  logEvent('stop', { signal })
  server.close()
  modelProxy?.close()
  setTimeout(() => process.exit(0), 1000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
