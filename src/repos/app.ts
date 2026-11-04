import { createHmac, createSign, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Config } from '../config.js'
import { GithubError } from './github.js'

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

export class GithubApp {
  private key: string | null = null
  private skewMs = 0
  private skewAt = 0
  private readonly tokens = new Map<number, { token: string; expiresAt: number }>()

  constructor(private readonly config: Config) {}

  get configured(): boolean {
    return this.config.githubApp.id !== '' && this.config.githubApp.privateKeyPath !== ''
  }

  private privateKey(): string {
    if (this.key === null) this.key = readFileSync(this.config.githubApp.privateKeyPath, 'utf8')
    return this.key
  }

  private async appJwt(): Promise<string> {
    if (!this.configured) throw new Error('GitHub App 未配置')
    if (Date.now() - this.skewAt > 5 * 60_000) {
      try {
        const response = await fetch(`${this.config.github.apiBase}/rate_limit`, { headers: { 'user-agent': 'fledge/0.1' }, signal: AbortSignal.timeout(10_000) })
        const date = response.headers.get('date')
        if (date !== null) {
          this.skewMs = Date.now() - Date.parse(date)
          this.skewAt = Date.now()
        }
      } catch {
        this.skewAt = Date.now()
      }
    }
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

  async installationToken(id: number): Promise<string> {
    const cached = this.tokens.get(id)
    if (cached !== undefined && cached.expiresAt - Date.now() > 2 * 60_000) return cached.token
    const result = await this.appRequest<{ token: string; expires_at: string }>('POST', `/app/installations/${id}/access_tokens`, {})
    if (result === null) throw new Error('无法创建 GitHub App installation token')
    this.tokens.set(id, { token: result.token, expiresAt: Date.parse(result.expires_at) })
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

  verifyWebhook(payload: Buffer, signature: string): boolean {
    const secret = this.config.githubApp.webhookSecret
    if (secret === '' || !signature.startsWith('sha256=')) return false
    const expected = createHmac('sha256', secret).update(payload).digest('hex')
    const given = signature.slice('sha256='.length)
    if (given.length !== expected.length) return false
    return timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'))
  }
}
