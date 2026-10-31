#!/usr/bin/env node
// Fledge → FlyBot bridge.
//
// Runs on the FlyBot host, listens on loopback, and forwards a Fledge job to a
// configured FlyBot chat session through DSH's local /api/bot endpoint. The
// bridge never sees the user's GitHub token; Fledge gives the agent a scoped
// credential URL instead.
//
// Required env:
//   BRIDGE_TOKEN             shared secret with Fledge (>= 24 chars)
//   FLYBOT_CHAT_SESSION_ID   the Bot chat that should take jobs
// Optional:
//   BRIDGE_PORT              default 8787
//   BRIDGE_HOST              default 127.0.0.1
//   FLYBOT_WEB               default http://127.0.0.1:3080
//   FLYBOT_LOG               default /home/xuke/work/dsh-web.log
//   MAX_PROMPT_BYTES         default 32768

import http from 'node:http'
import { readFileSync, statSync } from 'node:fs'

const PORT = Number(process.env.BRIDGE_PORT ?? 8787)
const HOST = process.env.BRIDGE_HOST ?? '127.0.0.1'
const TOKEN = process.env.BRIDGE_TOKEN ?? ''
const SESSION_ID = process.env.FLYBOT_CHAT_SESSION_ID ?? ''
const REVIEW_SESSION_ID = process.env.FLYBOT_REVIEW_SESSION_ID ?? SESSION_ID
const WEB = (process.env.FLYBOT_WEB ?? 'http://127.0.0.1:3080').replace(/\/$/, '')
const LOG = process.env.FLYBOT_LOG ?? '/home/xuke/work/dsh-web.log'
const MAX_PROMPT = Number(process.env.MAX_PROMPT_BYTES ?? 32768)

if (TOKEN.length < 16) {
  console.error('BRIDGE_TOKEN must be set (>= 16 chars)')
  process.exit(1)
}
if (SESSION_ID === '') {
  console.error('FLYBOT_CHAT_SESSION_ID must be set')
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
  const kind = job.kind === 'review' ? 'review' : 'iterate'
  const upstream = job.upstream || job.repo || {}
  const fork = job.fork || job.repo || upstream
  const rules = kind === 'review'
    ? [
        '- Review every open pull request on the upstream, including PRs not created by Fledge.',
        '- Score each PR 0-100 with a short rationale and post a COMMENT review; never approve, merge, push or change settings.',
        '- Do not modify code in review mode.',
      ]
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

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/healthz') {
    return json(response, 200, { ok: true, service: 'fledge-flybot-bridge' })
  }
  if (request.method !== 'POST' || request.url !== '/run') {
    return json(response, 404, { error: 'not found' })
  }
  if (String(request.headers.authorization ?? '') !== `Bearer ${TOKEN}`) {
    return json(response, 401, { error: 'unauthorized' })
  }
  const chunks = []
  let size = 0
  request.on('data', (chunk) => {
    size += chunk.length
    if (size > MAX_PROMPT) {
      response.writeHead(413)
      response.end()
      request.destroy()
      return
    }
    chunks.push(chunk)
  })
  request.on('end', async () => {
    let job
    try {
      job = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return json(response, 400, { error: 'invalid JSON' })
    }
    if (typeof job.jobId !== 'string' || typeof job.credentialUrl !== 'string' || typeof job.callbackUrl !== 'string') {
      return json(response, 400, { error: 'jobId, credentialUrl and callbackUrl are required' })
    }
    try {
      const sessionId = job.kind === 'review' ? REVIEW_SESSION_ID : SESSION_ID
      await sendToBot(buildText(job), sessionId)
      logEvent('job-forwarded', { jobId: job.jobId, kind: job.kind === 'review' ? 'review' : 'iterate', repo: `${job.upstream?.owner || job.repo?.owner}/${job.upstream?.name || job.repo?.name}`, session: sessionId.slice(0, 12) })
      return json(response, 202, { ok: true, accepted: true })
    } catch (error) {
      logEvent('job-failed', { jobId: job.jobId, error: redact(String(error)) })
      return json(response, 502, { error: 'could not reach DSH' })
    }
  })
})

server.listen(PORT, HOST, () => {
  logEvent('bridge-start', { listen: `${HOST}:${PORT}`, web: WEB })
})
