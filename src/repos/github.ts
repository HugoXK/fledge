import { log } from '../lib/log.js'

const DEFAULT_API = 'https://api.github.com'
const SEGMENT = /^[A-Za-z0-9_.-]+$/
const REVIEW_PERMISSIONS = new Set(['admin', 'maintain', 'write'])

export type RepoPermission = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none'

export interface RepoPermissions {
  admin: boolean
  maintain: boolean
  push: boolean
  triage: boolean
  pull: boolean
}

export interface RepoInfo {
  owner: string
  name: string
  fullName: string
  defaultBranch: string
  private: boolean
  canPush: boolean
  htmlUrl: string
  isFork: boolean
  parent: string | null
  permissions: RepoPermissions
}

export interface ViewerInfo {
  login: string
  id: number
}

export interface PreparedRepo {
  viewer: ViewerInfo
  upstream: RepoInfo
  fork: RepoInfo
  isFork: boolean
  forkCreated: boolean
  permission: RepoPermission
  canReview: boolean
  canCreateIssue: boolean
}

export interface PullRequestInfo {
  number: number
  url: string
  title: string
  state: string
  head: string
  base: string
}

interface GithubRepoPayload {
  name: string
  full_name: string
  default_branch: string
  private: boolean
  html_url: string
  fork?: boolean
  parent?: { full_name?: string } | null
  owner: { login: string }
  permissions?: { push?: boolean; admin?: boolean; maintain?: boolean; triage?: boolean; pull?: boolean }
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

function permissionOf(info: RepoInfo): RepoPermission {
  if (info.permissions.admin) return 'admin'
  if (info.permissions.maintain) return 'maintain'
  if (info.permissions.push) return 'write'
  if (info.permissions.triage) return 'triage'
  if (info.permissions.pull) return 'read'
  return 'none'
}

function canReview(permission: RepoPermission): boolean {
  return REVIEW_PERMISSIONS.has(permission)
}

function canCreateIssue(info: RepoInfo, permission: RepoPermission): boolean {
  return !info.private || permission === 'admin' || permission === 'maintain' || permission === 'write' || permission === 'triage'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
      signal: AbortSignal.timeout(30_000),
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

  private mapRepo(repo: GithubRepoPayload): RepoInfo {
    return {
      owner: repo.owner.login,
      name: repo.name,
      fullName: repo.full_name,
      defaultBranch: repo.default_branch,
      private: repo.private,
      canPush: repo.permissions?.push === true || repo.permissions?.admin === true || repo.permissions?.maintain === true,
      htmlUrl: repo.html_url,
      isFork: repo.fork === true,
      parent: repo.parent?.full_name ?? null,
      permissions: {
        admin: repo.permissions?.admin === true,
        maintain: repo.permissions?.maintain === true,
        push: repo.permissions?.push === true,
        triage: repo.permissions?.triage === true,
        pull: repo.permissions?.pull === true,
      },
    }
  }

  async getViewer(): Promise<ViewerInfo> {
    const user = await this.request<{ login: string; id: number }>('GET', '/user')
    return { login: user.login, id: user.id }
  }

  async getRepo(owner: string, name: string): Promise<RepoInfo> {
    const repo = await this.request<GithubRepoPayload>('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`)
    return this.mapRepo(repo)
  }

  async getRepoOrNull(owner: string, name: string): Promise<RepoInfo | null> {
    try {
      return await this.getRepo(owner, name)
    } catch (error) {
      if (error instanceof GithubError && error.status === 404) return null
      throw error
    }
  }

  async createFork(owner: string, name: string): Promise<RepoInfo> {
    const repo = await this.request<GithubRepoPayload>('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/forks`, {})
    return this.mapRepo(repo)
  }

  async waitForRepo(owner: string, name: string, timeoutMs = 30_000, intervalMs = 2_000): Promise<RepoInfo> {
    const deadline = Date.now() + timeoutMs
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        return await this.getRepo(owner, name)
      } catch (error) {
        lastError = error
        if (!(error instanceof GithubError) || error.status !== 404) throw error
        await sleep(intervalMs)
      }
    }
    throw new Error(`等待 fork ${owner}/${name} 创建超时${lastError instanceof Error ? `：${lastError.message}` : ''}`)
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

export async function prepareRepo(
  token: string,
  owner: string,
  name: string,
  expectedLogin?: string,
  apiBase?: string,
): Promise<PreparedRepo> {
  const client = new GithubClient(token, apiBase)
  let viewer: ViewerInfo
  let upstream: RepoInfo
  try {
    viewer = await client.getViewer()
    if (expectedLogin !== undefined && viewer.login.toLowerCase() !== expectedLogin.toLowerCase()) {
      throw new Error(`这个 GitHub token 属于 @${viewer.login}，请使用当前登录用户 @${expectedLogin} 的 token`)
    }
    upstream = await client.getRepo(owner, name)
  } catch (error) {
    if (error instanceof GithubError) {
      if (error.status === 401) throw new Error('GitHub token 无效或已过期')
      if (error.status === 404) throw new Error('上游仓库不存在，或 token 没有该仓库的访问权限')
      if (error.status === 403) throw new Error('GitHub 拒绝了访问，请检查 token 权限或组织 SSO 授权')
    }
    log.warn('repo preparation failed', { error: String(error) })
    throw error
  }

  const permission = permissionOf(upstream)
  if (viewer.login.toLowerCase() === upstream.owner.toLowerCase()) {
    if (!canReview(permission)) throw new Error(`token 对自己的仓库 ${upstream.fullName} 没有写权限（需要 Contents: write + Pull requests: write）`)
    return {
      viewer,
      upstream,
      fork: upstream,
      isFork: false,
      forkCreated: false,
      permission,
      canReview: true,
      canCreateIssue: canCreateIssue(upstream, permission),
    }
  }

  let fork = await client.getRepoOrNull(viewer.login, upstream.name)
  let forkCreated = false
  if (fork === null) {
    try {
      await client.createFork(upstream.owner, upstream.name)
      fork = await client.waitForRepo(viewer.login, upstream.name)
      forkCreated = true
    } catch (error) {
      if (error instanceof GithubError) {
        if (error.status === 403) throw new Error('无法创建 fork：token 权限不足，或上游组织禁止 fork')
        if (error.status === 422) throw new Error('无法创建 fork：你的账号下已有同名仓库或组织策略冲突')
      }
      throw error
    }
  } else if (!fork.isFork || (fork.parent ?? '').toLowerCase() !== upstream.fullName.toLowerCase()) {
    throw new Error(`你的账号下已有 ${fork.fullName}，但它不是 ${upstream.fullName} 的 fork；请先处理同名仓库，或直接填写你自己的仓库`)
  }

  const forkPermission = permissionOf(fork)
  if (!canReview(forkPermission)) {
    throw new Error(`token 对 fork ${fork.fullName} 没有写权限（需要 Contents: write + Pull requests: write）`)
  }

  return {
    viewer,
    upstream,
    fork,
    isFork: true,
    forkCreated,
    permission,
    canReview: canReview(permission),
    canCreateIssue: canCreateIssue(upstream, permission),
  }
}

export async function validateRepoToken(token: string, owner: string, name: string, apiBase?: string): Promise<RepoInfo> {
  const prepared = await prepareRepo(token, owner, name, undefined, apiBase)
  return prepared.upstream
}
