import type { Config } from '../config.js'
import { log } from '../lib/log.js'

export interface GithubProfile {
  id: number
  login: string
  name: string | null
  email: string | null
  avatarUrl: string | null
}

interface OAuthTokenResponse {
  access_token?: string
  token_type?: string
  scope?: string
  error?: string
  error_description?: string
}

interface GithubUser {
  id: number
  login: string
  name: string | null
  email: string | null
  avatar_url: string | null
}

interface GithubEmail {
  email: string
  primary: boolean
  verified: boolean
  visibility: string | null
}

async function httpJson<T>(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`GitHub ${response.status}: ${body.slice(0, 300)}`)
  }
  return (await response.json()) as T
}

export class GithubOAuth {
  constructor(private readonly config: Config) {}

  authorizeUrl(state: string): string {
    const url = new URL('https://github.com/login/oauth/authorize')
    url.searchParams.set('client_id', this.config.github.clientId)
    url.searchParams.set('redirect_uri', `${this.config.baseUrl}/auth/github/callback`)
    url.searchParams.set('scope', this.config.github.scopes)
    url.searchParams.set('state', state)
    url.searchParams.set('allow_signup', 'true')
    return url.toString()
  }

  async exchangeCode(code: string): Promise<string> {
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: this.config.github.clientId,
        client_secret: this.config.github.clientSecret,
        code,
        redirect_uri: `${this.config.baseUrl}/auth/github/callback`,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`GitHub OAuth exchange failed: ${response.status}`)
    const body = (await response.json()) as OAuthTokenResponse
    if (body.error !== undefined || body.access_token === undefined) {
      throw new Error(`GitHub OAuth: ${body.error ?? 'no access token'} ${body.error_description ?? ''}`.trim())
    }
    return body.access_token
  }

  async profile(token: string): Promise<GithubProfile> {
    const user = await httpJson<GithubUser>('https://api.github.com/user', {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'fledge' },
    })
    let email = user.email
    if (email === null || email === '') {
      try {
        const emails = await httpJson<GithubEmail[]>('https://api.github.com/user/emails', {
          headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'fledge' },
        })
        const primary = emails.find((entry) => entry.primary && entry.verified) ?? emails.find((entry) => entry.verified)
        email = primary?.email ?? null
      } catch (error) {
        log.warn('github email lookup failed', { error: String(error) })
      }
    }
    return { id: user.id, login: user.login, name: user.name, email, avatarUrl: user.avatar_url }
  }
}
