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

// #758 slice 2: the number that turns a measurement into a decision. It is the
// same 120 the alert rule fires on (`deploy/prometheus/fledge-alerts.yml`) and
// `docs/deploy.md` names both, so a failing readiness probe and a firing alert
// cannot disagree about what "too far" means.
export const CLOCK_SKEW_FAIL_SECONDS = 120

// How long one successful measurement stays usable. Inside the window a GitHub
// outage is tolerated; past it the clock is unverified, which is not the same as
// good, and nothing may sign from a number nobody has re-measured.
export const CLOCK_SKEW_REUSE_MS = 15 * 60_000

export type ClockStateName = 'not-configured' | 'ok' | 'fail' | 'unknown'

export interface ClockState {
  /** The last successful measurement: seconds the process is ahead of GitHub. */
  skewSeconds: number | null
  /** When that measurement was taken, ISO-8601, or null when none succeeded. */
  measuredAt: string | null
  thresholdSeconds: number
  state: ClockStateName
}

export class GithubApp {
  private key: string | null = null
  private skewAt = 0
  // The last successful measurement. It is kept when a refresh fails — the
  // reading is still what was measured, it just stops being trusted once
  // `CLOCK_SKEW_REUSE_MS` passes — and it is the only number the JWT may sign
  // with. `skewMs` used to be a private fail-open copy of it and is gone: that
  // copy is how a host 28 minutes fast kept signing.
  private measuredSkewSeconds: number | null = null
  private measuredAt: number | null = null
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>()

  // `bootedAt` is the process age the never-measured rule is measured from;
  // it is a constructor argument so a test can age the App instead of waiting.
  constructor(private readonly config: Config, private readonly bootedAt: number = Date.now()) {}

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
      this.measuredAt = null
      return null
    }
    try {
      const response = await fetch(`${this.config.github.apiBase}/rate_limit`, { headers: { 'user-agent': 'fledge/0.1' }, signal: AbortSignal.timeout(10_000) })
      const date = response.headers.get('date')
      const at = Date.now()
      this.skewAt = at
      if (date === null) return null
      const remote = Date.parse(date)
      if (!Number.isFinite(remote)) {
        // #758 finding: a `Date` header that is present but unparseable (a
        // rewriting proxy is the realistic case) is a failed measurement, not a
        // reading — `NaN` here used to travel to /readyz, to the metric, and into
        // the JWT's `iat` without failing anything. The previous reading stays;
        // it ages out of `ok` on its own rather than being replaced by a guess.
        return null
      }
      const seconds = Math.round((at - remote) / 1000)
      this.measuredSkewSeconds = seconds
      this.measuredAt = at
      if (Math.abs(seconds) > CLOCK_SKEW_LOG_SECONDS) log.warn('clock.skew', { skewSeconds: seconds, source: 'github' })
      return seconds
    } catch {
      // A failed refresh is not a reading: the last successful one stays as the
      // report's answer and ages out of `ok` after `CLOCK_SKEW_REUSE_MS`. The JWT
      // has no correction of its own to fall back on any more.
      this.skewAt = Date.now()
      return null
    }
  }

  // #915: a `fail` verdict has no expiry of its own, and every path that can take
  // a new reading (`appJwt`) runs after admission. The scheduler tick calls this
  // while the clock is not `ok`, so an operator who corrects the host clock is
  // rewarded within one refresh interval without a restart or an unrelated GitHub
  // call. #1028: `unknown` is included — an App that has never measured (or whose
  // reading aged out) has no verdict either, and waiting for an App JWT that may
  // never be minted is how the instance stayed unmeasured and ready forever.
  // It costs nothing while the clock is healthy (the JWT path already refreshes
  // there) and reuses `skewAt`, so a failed attempt is throttled like a reading
  // instead of turning the tick into a retry per minute.
  async refreshSkewWhileNotOk(): Promise<void> {
    if (!this.configured) return
    if (this.clockState().state === 'ok') return
    if (Date.now() - this.skewAt <= SKEW_REFRESH_MS) return
    await this.measureSkew()
  }

  /** The last measured skew in seconds, or null when no measurement succeeded. */
  clockSkewSeconds(): number | null {
    return this.measuredSkewSeconds
  }

  // #758 slice 2: one answer to "may anything act on this clock", read by
  // /readyz, by `appJwt` and by `Jobs.enqueue`. `not-configured` is a deployment
  // with no App, which is not a clock verdict; `unknown` is "nobody measured, or
  // the last reading is stale"; `fail` is a measurement above the threshold, and
  // it stays `fail` once it ages out — an outage does not repair a clock that was
  // measured 28 minutes wrong.
  clockState(): ClockState {
    const thresholdSeconds = CLOCK_SKEW_FAIL_SECONDS
    if (!this.configured) return { skewSeconds: null, measuredAt: null, thresholdSeconds, state: 'not-configured' }
    const seconds = this.measuredSkewSeconds
    const at = this.measuredAt
    if (seconds === null || at === null) return { skewSeconds: null, measuredAt: null, thresholdSeconds, state: 'unknown' }
    const measuredAt = new Date(at).toISOString()
    if (Math.abs(seconds) > thresholdSeconds) return { skewSeconds: seconds, measuredAt, thresholdSeconds, state: 'fail' }
    if (Date.now() - at > CLOCK_SKEW_REUSE_MS) return { skewSeconds: seconds, measuredAt, thresholdSeconds, state: 'unknown' }
    return { skewSeconds: seconds, measuredAt, thresholdSeconds, state: 'ok' }
  }

  // #1028: `unknown` covers two situations that are not the same. A process that
  // has been up for a few minutes has not needed GitHub yet, which is not a clock
  // verdict. A configured App that has been up for a whole reuse window without a
  // single successful measurement never gets the guard's protection, and that is
  // the hole this answers: past the window, "no number" is reported as unready
  // instead of being read as "nothing wrong".
  clockUnverified(): boolean {
    if (!this.configured) return false
    if (this.measuredAt !== null) return false
    return Date.now() - this.bootedAt > CLOCK_SKEW_REUSE_MS
  }

  private async appJwt(): Promise<string> {
    if (!this.configured) throw new Error('GitHub App 未配置')
    if (Date.now() - this.skewAt > SKEW_REFRESH_MS) await this.measureSkew()
    // #758 slice 2: sign only with a measurement that is inside both the reuse
    // window and the threshold. Everything else refuses with a named error
    // instead of signing from a stale or zero correction — that fail-open is what
    // let a host 28 minutes fast keep talking to GitHub as if its clock were
    // right, and a 401 from GitHub was the only symptom.
    const clock = this.clockState()
    if (clock.state === 'fail') {
      throw new Error(`CLOCK_SKEW_EXCEEDED: the process clock is ${String(clock.skewSeconds)}s from GitHub time, above the ${String(clock.thresholdSeconds)}s threshold`)
    }
    if (clock.state !== 'ok') throw new Error('CLOCK_SKEW_UNVERIFIED: no clock measurement inside the reuse window')
    const now = Math.floor(Date.now() / 1000) - (clock.skewSeconds ?? 0)
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

  // #546 slice 4: a short-lived read credential whose whole life is one read.
  // It is minted outside the cache on purpose — revoking a cached token would
  // hand the next caller a token that no longer works — and the caller revokes
  // it itself through `revokeToken` when the read ends. `repositories` narrows
  // the token to the named repositories of the installation; a token without it
  // reaches every repository the installation can see.
  async ephemeralToken(id: number, permissions: Record<string, 'read'>, repositories?: string[]): Promise<string> {
    const body = repositories === undefined ? { permissions } : { permissions, repositories }
    const result = await this.appRequest<{ token: string }>('POST', `/app/installations/${id}/access_tokens`, body)
    if (result === null) throw new Error('无法创建 GitHub App installation token')
    return result.token
  }

  // An installation token revokes itself: `DELETE /installation/token` is
  // authenticated with that token, never with the App JWT. A failed revocation
  // returns false so the caller can record that the token outlived its read
  // rather than losing the answer.
  async revokeToken(token: string): Promise<boolean> {
    try {
      await this.request<Record<string, unknown>>('DELETE', '/installation/token', token)
      return true
    } catch {
      return false
    }
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
