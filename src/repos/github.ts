import { log } from '../lib/log.js'

const DEFAULT_API = 'https://api.github.com'
const SEGMENT = /^[A-Za-z0-9_.-]+$/

export interface RepoInfo {
  owner: string
  name: string
  fullName: string
  defaultBranch: string
  private: boolean
  canPush: boolean
  htmlUrl: string
}

export interface PullRequestInfo {
  number: number
  url: string
  title: string
  state: string
  head: string
  base: string
}

export class GithubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'GithubError'
  }
}

export function parseRepoInput(input: string): { owner: string; name: string } {
  const cleaned = input.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '')
  const parts = cleaned.split('/').filter((part) => part !== '')
  if (parts.length !== 2) throw new Error('仓库格式应为 owner/name')
  const [owner, name] = parts as [string, string]
  if (!SEGMENT.test(owner) || !SEGMENT.test(name)) throw new Error('仓库名只能包含字母、数字、. _ -')
  return { owner, name }
}

export class GithubClient {
  constructor(
    private readonly token: string,
    private readonly apiBase = DEFAULT_API,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.apiBase.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'fledge/0.1',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    })
    const text = await response.text()
    if (!response.ok) {
      let message = text.slice(0, 300)
      try {
        const parsed = JSON.parse(text) as { message?: string }
        if (parsed.message !== undefined) message = parsed.message
      } catch {}
      throw new GithubError(response.status, message)
    }
    return (text === '' ? {} : JSON.parse(text)) as T
  }

  async getRepo(owner: string, name: string): Promise<RepoInfo> {
    const repo = await this.request<{
      name: string
      full_name: string
      default_branch: string
      private: boolean
      html_url: string
      owner: { login: string }
      permissions?: { push?: boolean; admin?: boolean; maintain?: boolean }
    }>('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`)
    return {
      owner: repo.owner.login,
      name: repo.name,
      fullName: repo.full_name,
      defaultBranch: repo.default_branch,
      private: repo.private,
      canPush: repo.permissions?.push === true || repo.permissions?.admin === true || repo.permissions?.maintain === true,
      htmlUrl: repo.html_url,
    }
  }

  async createPullRequest(
    owner: string,
    name: string,
    input: { title: string; head: string; base: string; body: string },
  ): Promise<PullRequestInfo> {
    const pr = await this.request<{ number: number; html_url: string; title: string; state: string; head: { ref: string }; base: { ref: string } }>(
      'POST',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls`,
      input,
    )
    return { number: pr.number, url: pr.html_url, title: pr.title, state: pr.state, head: pr.head.ref, base: pr.base.ref }
  }

  async getPullRequest(owner: string, name: string, number: number): Promise<PullRequestInfo> {
    const pr = await this.request<{ number: number; html_url: string; title: string; state: string; head: { ref: string }; base: { ref: string } }>(
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}`,
    )
    return { number: pr.number, url: pr.html_url, title: pr.title, state: pr.state, head: pr.head.ref, base: pr.base.ref }
  }

  async comment(owner: string, name: string, number: number, body: string): Promise<void> {
    await this.request('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/comments`, { body })
  }
}

export async function validateRepoToken(token: string, owner: string, name: string, apiBase?: string): Promise<RepoInfo> {
  try {
    const info = await new GithubClient(token, apiBase).getRepo(owner, name)
    if (!info.canPush) throw new Error('这个 token 没有该仓库的写入权限（需要 Contents: write + Pull requests: write）')
    return info
  } catch (error) {
    if (error instanceof GithubError) {
      if (error.status === 401) throw new Error('GitHub token 无效或已过期')
      if (error.status === 404) throw new Error('仓库不存在，或 token 没有该仓库的访问权限')
      if (error.status === 403) throw new Error('GitHub 拒绝了访问，请检查 token 权限或组织 SSO 授权')
    }
    log.warn('repo token validation failed', { error: String(error) })
    throw error
  }
}
