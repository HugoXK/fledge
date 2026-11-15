import { createHmac, createSign, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Config } from '../config.js'
import { GithubError } from './github.js'
import { log } from '../lib/log.js'

export interface AppInstallation {
  id: number
  account: { login: string; type: string }
  repositorySelection: string
}

export interface InstallationRepo {
  fullName: string
  owner: string
  name: string
  private: boolean
  defaultBranch: string
}

interface InstallationPayload {
  id: number
  account: { login: string; type: string }
  repository_selection: string
}

interface RepoPayload {
  full_name: string
  name: string
  private: boolean
  default_branch: string
  owner: { login: string }
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url')
}

// #758: one clock.skew line per measurement once the drift is worth reading, and
// a five-minute refresh so the number on /readyz is never older than the JWT's.
const CLOCK_SKEW_LOG_SECONDS = 60
const SKEW_REFRESH_MS = 5 * 60_000

export class GithubApp {
  private key: string | null = null
  private skewMs = 0
  private skewAt = 0
  // The last successful measurement, kept apart from `skewMs`: the JWT needs a
  // number, while a report has to be able to say "unknown". A 0 here would read
  // as a clock that is exactly right, which is the one lie this slice exists to
  // prevent.
  private measuredSkewSeconds: number | null = null
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>()

  constructor(private readonly config: Config) {}

  get configured(): boolean {
    return this.config.githubApp.id !== '' && this.config.githubApp.privateKeyPath !== ''
  }

  private privateKey(): string {
    if (this.key === null) this.key = readFileSync(this.config.githubApp.privateKeyPath, 'utf8')
    return this.key
  }

  // One measurement of the process clock against GitHub's `Date` header. The JWT
  // path calls it at most every five minutes; it is public so the report can read
  // the value the JWT already uses instead of measuring again (a second reading
  // per /readyz would cost a network call on a health endpoint), and so a test can
  // force one.
  async measureSkew(): Promise<number | null> {
    if (!this.configured) {
      this.measuredSkewSeconds = null
      return null
    }
    try {
      const response = await fetch(`${this.config.github.apiBase}/rate_limit`, { headers: { 'user-agent': 'fledge/0.1' }, signal: AbortSignal.timeout(10_000) })
      const date = response.headers.get('date')
      this.skewAt = Date.now()
      if (date === null) {
        this.measuredSkewSeconds = null
        return null
      }
      this.skewMs = Date.now() - Date.parse(date)
      const seconds = Math.round(this.skewMs / 1000)
      this.measuredSkewSeconds = seconds
      if (Math.abs(seconds) > CLOCK_SKEW_LOG_SECONDS) log.warn('clock.skew', { skewSeconds: seconds, source: 'github' })
      return seconds
    } catch {
      // The JWT keeps its last correction here; slice 2 of #758 owns that hole.
      // The report does not keep it, because a measurement that failed is not a
      // reading, and a stale number would hide the next drift.
      this.skewAt = Date.now()
      this.measuredSkewSeconds = null
      return null
    }
  }

  /** The last measured skew in seconds, or null when no measurement succeeded. */
  clockSkewSeconds(): number | null {
    return this.measuredSkewSeconds
  }

  private async appJwt(): Promise<string> {
    if (!this.configured) throw new Error('GitHub App 未配置')
    if (Date.now() - this.skewAt > SKEW_REFRESH_MS) await this.measureSkew()
    const now = Math.floor((Date.now() - this.skewMs) / 1000)
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.config.githubApp.id }))
    const signer = createSign('RSA-SHA256')
    signer.update(`${header}.${payload}`)
    return `${header}.${payload}.${base64url(signer.sign(this.privateKey()))}`
  }

  private async request<T>(method: string, path: string, token: string, body?: unknown, allow404 = false): Promise<T | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(`${this.config.github.apiBase}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'fledge/0.1',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      })
      const text = await response.text()
      if (response.status === 404 && allow404) return null
      if (response.ok) return (text === '' ? {} : JSON.parse(text)) as T
      let message = text.slice(0, 300)
      try {
        const parsed = JSON.parse(text) as { message?: string }
        if (parsed.message !== undefined) message = parsed.message
      } catch {}
      const retryable = response.status === 429 || (method === 'GET' && response.status >= 500) || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.get('retry-after') !== null || /rate limit/i.test(message)))
      if (!retryable || attempt === 2) throw new GithubError(response.status, message)
      const retryAfter = Number(response.headers.get('retry-after'))
      await new Promise((resolve) => setTimeout(resolve, Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : Math.min(500 * 2 ** attempt, 5_000)))
    }
    throw new GithubError(500, 'GitHub App request failed')
  }

  private async appRequest<T>(method: string, path: string, body?: unknown, allow404 = false): Promise<T | null> {
    return this.request<T>(method, path, await this.appJwt(), body, allow404)
  }

  async getApp(): Promise<{ id: number; slug: string; name: string }> {
    const app = await this.appRequest<{ id: number; slug: string; name: string }>('GET', '/app')
    if (app === null) throw new Error('GitHub App 不可用')
    return app
  }

  async listInstallations(): Promise<AppInstallation[]> {
    const list = await this.appRequest<InstallationPayload[]>('GET', '/app/installations?per_page=100')
    return (list ?? []).map((item) => ({
      id: item.id,
      account: { login: item.account.login, type: item.account.type },
      repositorySelection: item.repository_selection,
    }))
  }

  async getInstallation(id: number): Promise<AppInstallation | null> {
    const item = await this.appRequest<InstallationPayload>('GET', `/app/installations/${id}`, undefined, true)
    if (item === null) return null
    return {
      id: item.id,
      account: { login: item.account.login, type: item.account.type },
      repositorySelection: item.repository_selection,
    }
  }

  // #390 review: a downscoped token is not the installation's full token, so the
  // cache is keyed by the permissions too. One key per installation would hand a
  // read-only token to a write path, or a write token to a read-only run, and a
  // cache key is exactly the kind of detail that makes a downscope untrue later.
  async installationToken(id: number, permissions?: Record<string, 'read'>): Promise<string> {
    const key = permissions === undefined ? String(id) : `${id}:${JSON.stringify(permissions)}`
    const cached = this.tokens.get(key)
    if (cached !== undefined && cached.expiresAt - Date.now() > 2 * 60_000) return cached.token
    const result = await this.appRequest<{ token: string; expires_at: string }>('POST', `/app/installations/${id}/access_tokens`, permissions === undefined ? {} : { permissions })
    if (result === null) throw new Error('无法创建 GitHub App installation token')
    this.tokens.set(key, { token: result.token, expiresAt: Date.parse(result.expires_at) })
    return result.token
  }

  async installationRepos(id: number): Promise<InstallationRepo[]> {
    const token = await this.installationToken(id)
    const repos: InstallationRepo[] = []
    for (let page = 1; page <= 10; page += 1) {
      const result = await this.request<{ total_count: number; repositories: RepoPayload[] }>('GET', `/installation/repositories?per_page=100&page=${page}`, token)
      if (result === null) break
      repos.push(...result.repositories.map((repo) => ({
        fullName: repo.full_name,
        owner: repo.owner.login,
        name: repo.name,
        private: repo.private,
        defaultBranch: repo.default_branch,
      })))
      if (result.repositories.length < 100) break
    }
    return repos
  }

  verifyWebhook(payload: Buffer, signature: string, now: number = Date.now()): boolean {
    return checkWebhookSignature(this.config.githubApp, payload, signature, now).ok
  }
}

// #466: the webhook secret is a pair, not one value. `current` is what the App
// signs with now; `previous` stays acceptable only until its own ISO instant, so
// a rotation has an overlap window instead of a flag day. The two readers below
// are the only place that decision is made: the route, the audit row for a
// retired signature and the `/healthz` report all ask them, which is why the
// operator's status cannot drift from the verifier.

export type WebhookSecretSlot = 'none' | 'current' | 'previous'

export type WebhookSecretConfig = Pick<Config['githubApp'], 'webhookSecret' | 'webhookSecretPrevious' | 'webhookSecretPreviousUntil'>

export interface WebhookSignatureVerdict {
  ok: boolean
  /** Which slot matched a good signature; null when nothing did. */
  slot: 'current' | 'previous' | null
  /** The signature matched the retired value after its window closed. */
  superseded: boolean
}

// A missing or unparseable instant is closed, never open: loadConfig refuses to
// boot on that pair, and a config assembled without it must fail the same way.
function previousSlotOpen(app: WebhookSecretConfig, now: number): boolean {
  if ((app.webhookSecretPrevious ?? '') === '') return false
  const until = Date.parse(app.webhookSecretPreviousUntil ?? '')
  return Number.isFinite(until) && now <= until
}

export function webhookSecretSlot(app: WebhookSecretConfig, now: number = Date.now()): WebhookSecretSlot {
  if (app.webhookSecret === '') return 'none'
  return previousSlotOpen(app, now) ? 'previous' : 'current'
}

function signatureMatches(secret: string, payload: Buffer, given: string): boolean {
  const expected = createHmac('sha256', secret).update(payload).digest('hex')
  // A 64-character value that is not hex decodes to a shorter buffer, and
  // timingSafeEqual throws on a length mismatch: the guard keeps a malformed
  // header a 401 instead of a 500.
  if (given.length !== expected.length || !/^[0-9a-f]+$/i.test(given)) return false
  return timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'))
}

export function checkWebhookSignature(app: WebhookSecretConfig, payload: Buffer, signature: string, now: number = Date.now()): WebhookSignatureVerdict {
  if (!signature.startsWith('sha256=')) return { ok: false, slot: null, superseded: false }
  const given = signature.slice('sha256='.length)
  if (app.webhookSecret !== '' && signatureMatches(app.webhookSecret, payload, given)) return { ok: true, slot: 'current', superseded: false }
  const previous = app.webhookSecretPrevious ?? ''
  if (previous === '' || !signatureMatches(previous, payload, given)) return { ok: false, slot: null, superseded: false }
  return previousSlotOpen(app, now)
    ? { ok: true, slot: 'previous', superseded: false }
    : { ok: false, slot: null, superseded: true }
}
