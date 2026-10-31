import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { log } from './lib/log.js'
import { nowIso } from './lib/time.js'

const require = createRequire(import.meta.url)

interface Statement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

interface Database {
  exec(sql: string): void
  prepare(sql: string): Statement
  close(): void
}

const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => Database }

export type UserStatus = 'onboarding' | 'pending' | 'approved' | 'rejected'
export type UserRole = 'user' | 'admin'
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'quota_exhausted'

export interface UserRow {
  id: string
  github_id: number
  login: string
  name: string | null
  email: string | null
  avatar_url: string | null
  status: UserStatus
  role: UserRole
  quota_cny: number
  quota_unlimited: number
  quota_used_usd: number
  github_token_enc: string | null
  own_llm_base_url: string | null
  own_llm_key_enc: string | null
  own_llm_model: string | null
  created_at: string
  approved_at: string | null
  approved_by: string | null
  approval_sent_at: string | null
  disclaimer_version: string | null
  disclaimer_name: string | null
  disclaimer_accepted_at: string | null
  security_version: string | null
  security_accepted_at: string | null
  agreement_hash: string | null
  application_submitted_at: string | null
  application_ip: string | null
  application_ua: string | null
  reviewed_at: string | null
  last_login_at: string | null
}

export interface RepoRow {
  id: string
  user_id: string
  owner: string
  name: string
  default_branch: string
  token_enc: string
  goal: string
  enabled: number
  auto_iterate: number
  interval_minutes: number
  last_run_at: string | null
  last_status: string | null
  created_at: string
  upstream_owner: string
  upstream_name: string
  fork_owner: string
  fork_name: string
  upstream_default_branch: string
  fork_default_branch: string
  is_fork: number
  fork_created: number
  permission: string
  can_review: number
  can_create_issue: number
  reviewer_enabled: number
  review_interval_minutes: number
  last_review_at: string | null
  last_review_status: string | null
  upstream_html_url: string | null
  fork_html_url: string | null
}

export interface RepoInstanceRow {
  repo_id: string
  user_id: string
  container: string
  network: string
  data_dir: string
  bridge_script: string
  dsh_port: number
  bridge_port: number
  model_port: number
  model_bind: string
  image: string
  status: string
  chief_session: string | null
  team_json: string | null
  bridge_token_enc: string | null
  bridge_pid: number | null
  log_pid: number | null
  last_error: string | null
  created_at: string
  updated_at: string
  last_health_at: string | null
}

export interface JobRow {
  id: string
  repo_id: string
  user_id: string
  status: JobStatus
  trigger: string
  goal: string
  branch: string | null
  pr_url: string | null
  summary: string | null
  error: string | null
  cost_usd: number
  platform_token_hash: string | null
  callback_hash: string
  kind: string
  issue_url: string | null
  review_score: number | null
  attribution_json: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

export interface ApiTokenRow {
  id: string
  user_id: string
  kind: string
  name: string
  token_hash: string
  prefix: string
  expires_at: string | null
  revoked_at: string | null
  last_used_at: string | null
  created_at: string
}

export interface SessionRow {
  id_hash: string
  user_id: string
  created_at: string
  expires_at: string
  ip: string | null
  user_agent: string | null
}

export interface ApprovalRow {
  token_hash: string
  user_id: string
  action: 'approve' | 'reject'
  created_at: string
  expires_at: string
  used_at: string | null
}

export interface OAuthStateRow {
  state_hash: string
  created_at: string
  expires_at: string
  redirect_to: string | null
}

export interface NotificationRow {
  id: string
  user_id: string
  kind: string
  message: string
  created_at: string
  read_at: string | null
}

export interface AuditRow {
  id: number
  at: string
  user_id: string | null
  action: string
  detail: string | null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL UNIQUE,
  login TEXT NOT NULL,
  name TEXT,
  email TEXT,
  avatar_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  role TEXT NOT NULL DEFAULT 'user',
  quota_cny REAL NOT NULL DEFAULT 1,
  quota_unlimited INTEGER NOT NULL DEFAULT 0,
  quota_used_usd REAL NOT NULL DEFAULT 0,
  github_token_enc TEXT,
  own_llm_base_url TEXT,
  own_llm_key_enc TEXT,
  own_llm_model TEXT,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  approved_by TEXT,
  approval_sent_at TEXT,
  disclaimer_version TEXT,
  disclaimer_name TEXT,
  disclaimer_accepted_at TEXT,
  security_version TEXT,
  security_accepted_at TEXT,
  agreement_hash TEXT,
  application_submitted_at TEXT,
  application_ip TEXT,
  application_ua TEXT,
  reviewed_at TEXT,
  last_login_at TEXT
);
CREATE INDEX IF NOT EXISTS users_status_idx ON users(status);
CREATE INDEX IF NOT EXISTS users_login_idx ON users(login);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  redirect_to TEXT
);

CREATE TABLE IF NOT EXISTS approval_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS approval_user_idx ON approval_tokens(user_id);

CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  token_enc TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  auto_iterate INTEGER NOT NULL DEFAULT 0,
  interval_minutes INTEGER NOT NULL DEFAULT 1440,
  last_run_at TEXT,
  last_status TEXT,
  created_at TEXT NOT NULL,
  upstream_owner TEXT NOT NULL DEFAULT '',
  upstream_name TEXT NOT NULL DEFAULT '',
  fork_owner TEXT NOT NULL DEFAULT '',
  fork_name TEXT NOT NULL DEFAULT '',
  upstream_default_branch TEXT NOT NULL DEFAULT 'main',
  fork_default_branch TEXT NOT NULL DEFAULT 'main',
  is_fork INTEGER NOT NULL DEFAULT 0,
  fork_created INTEGER NOT NULL DEFAULT 0,
  permission TEXT NOT NULL DEFAULT 'write',
  can_review INTEGER NOT NULL DEFAULT 0,
  can_create_issue INTEGER NOT NULL DEFAULT 1,
  reviewer_enabled INTEGER NOT NULL DEFAULT 0,
  review_interval_minutes INTEGER NOT NULL DEFAULT 1440,
  last_review_at TEXT,
  last_review_status TEXT,
  upstream_html_url TEXT,
  fork_html_url TEXT,
  UNIQUE(user_id, owner, name)
);
CREATE INDEX IF NOT EXISTS repos_user_idx ON repos(user_id);

CREATE TABLE IF NOT EXISTS repo_instances (
  repo_id TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  container TEXT NOT NULL,
  network TEXT NOT NULL,
  data_dir TEXT NOT NULL,
  bridge_script TEXT NOT NULL,
  dsh_port INTEGER NOT NULL,
  bridge_port INTEGER NOT NULL,
  model_port INTEGER NOT NULL,
  model_bind TEXT NOT NULL,
  image TEXT NOT NULL,
  status TEXT NOT NULL,
  chief_session TEXT,
  team_json TEXT,
  bridge_token_enc TEXT,
  bridge_pid INTEGER,
  log_pid INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_health_at TEXT
);
CREATE INDEX IF NOT EXISTS repo_instances_user_idx ON repo_instances(user_id);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  trigger TEXT NOT NULL,
  goal TEXT NOT NULL,
  branch TEXT,
  pr_url TEXT,
  summary TEXT,
  error TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  platform_token_hash TEXT,
  callback_hash TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'iterate',
  issue_url TEXT,
  review_score INTEGER,
  attribution_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS jobs_repo_idx ON jobs(repo_id, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_user_idx ON jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status);

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS api_tokens_user_idx ON api_tokens(user_id);

CREATE TABLE IF NOT EXISTS quota_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id TEXT,
  cost_usd REAL NOT NULL,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS quota_ledger_user_idx ON quota_ledger(user_id, at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  user_id TEXT,
  action TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

function clean(params: unknown[]): unknown[] {
  return params.map((value) => (value === undefined ? null : value))
}

export class Store {
  readonly db: Database

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA foreign_keys = ON;')
    this.db.exec(SCHEMA)
    this.migrateColumns()
    this.migrateRepoColumns()
    this.db.exec('PRAGMA user_version = 5;')
  }

  private migrateColumns(): void {
    const columns = new Set(this.all<{ name: string }>('PRAGMA table_info(users)').map((row) => row.name))
    const additions: Array<[string, string]> = [
      ['disclaimer_version', 'TEXT'],
      ['disclaimer_name', 'TEXT'],
      ['disclaimer_accepted_at', 'TEXT'],
      ['security_version', 'TEXT'],
      ['security_accepted_at', 'TEXT'],
      ['agreement_hash', 'TEXT'],
      ['application_submitted_at', 'TEXT'],
      ['application_ip', 'TEXT'],
      ['application_ua', 'TEXT'],
      ['reviewed_at', 'TEXT'],
      ['quota_unlimited', 'INTEGER NOT NULL DEFAULT 0'],
    ]
    for (const [name, type] of additions) {
      if (!columns.has(name)) this.run(`ALTER TABLE users ADD COLUMN ${name} ${type}`)
    }
  }

  private migrateRepoColumns(): void {
    const repoColumns = new Set(this.all<{ name: string }>('PRAGMA table_info(repos)').map((row) => row.name))
    const repoAdditions: Array<[string, string]> = [
      ['upstream_owner', "TEXT NOT NULL DEFAULT ''"],
      ['upstream_name', "TEXT NOT NULL DEFAULT ''"],
      ['fork_owner', "TEXT NOT NULL DEFAULT ''"],
      ['fork_name', "TEXT NOT NULL DEFAULT ''"],
      ['upstream_default_branch', "TEXT NOT NULL DEFAULT 'main'"],
      ['fork_default_branch', "TEXT NOT NULL DEFAULT 'main'"],
      ['is_fork', 'INTEGER NOT NULL DEFAULT 0'],
      ['fork_created', 'INTEGER NOT NULL DEFAULT 0'],
      ['permission', "TEXT NOT NULL DEFAULT 'write'"],
      ['can_review', 'INTEGER NOT NULL DEFAULT 0'],
      ['can_create_issue', 'INTEGER NOT NULL DEFAULT 1'],
      ['reviewer_enabled', 'INTEGER NOT NULL DEFAULT 0'],
      ['review_interval_minutes', 'INTEGER NOT NULL DEFAULT 1440'],
      ['last_review_at', 'TEXT'],
      ['last_review_status', 'TEXT'],
      ['upstream_html_url', 'TEXT'],
      ['fork_html_url', 'TEXT'],
    ]
    for (const [name, type] of repoAdditions) {
      if (!repoColumns.has(name)) this.run(`ALTER TABLE repos ADD COLUMN ${name} ${type}`)
    }
    this.run("UPDATE repos SET upstream_owner = owner WHERE upstream_owner = ''")
    this.run("UPDATE repos SET upstream_name = name WHERE upstream_name = ''")
    this.run("UPDATE repos SET fork_owner = owner WHERE fork_owner = ''")
    this.run("UPDATE repos SET fork_name = name WHERE fork_name = ''")
    this.run("UPDATE repos SET upstream_default_branch = default_branch WHERE upstream_default_branch = 'main'")
    this.run("UPDATE repos SET fork_default_branch = default_branch WHERE fork_default_branch = 'main'")
    const jobColumns = new Set(this.all<{ name: string }>('PRAGMA table_info(jobs)').map((row) => row.name))
    if (!jobColumns.has('kind')) this.run("ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'iterate'")
    if (!jobColumns.has('issue_url')) this.run('ALTER TABLE jobs ADD COLUMN issue_url TEXT')
    if (!jobColumns.has('review_score')) this.run('ALTER TABLE jobs ADD COLUMN review_score INTEGER')
    if (!jobColumns.has('attribution_json')) this.run('ALTER TABLE jobs ADD COLUMN attribution_json TEXT')
  }

  close(): void {
    this.db.close()
  }

  get<T>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...clean(params)) as T | undefined
  }

  all<T>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...clean(params)) as T[]
  }

  run(sql: string, ...params: unknown[]): void {
    this.db.prepare(sql).run(...clean(params))
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  upsertGithubUser(input: {
    id: string
    githubId: number
    login: string
    name: string | null
    email: string | null
    avatarUrl: string | null
    isAdmin: boolean
    initialQuotaCny: number
  }): UserRow {
    const existing = this.userByGithubId(input.githubId)
    const at = nowIso()
    if (existing !== undefined) {
      this.run(
        'UPDATE users SET login=?, name=?, email=?, avatar_url=?, last_login_at=?, role=? WHERE id=?',
        input.login,
        input.name,
        input.email,
        input.avatarUrl,
        at,
        input.isAdmin ? 'admin' : existing.role,
        existing.id,
      )
      return this.userById(existing.id)!
    }
    this.run(
      `INSERT INTO users (id, github_id, login, name, email, avatar_url, status, role, quota_cny, quota_used_usd, created_at, approved_at, approved_by, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      input.id,
      input.githubId,
      input.login,
      input.name,
      input.email,
      input.avatarUrl,
      input.isAdmin ? 'approved' : 'onboarding',
      input.isAdmin ? 'admin' : 'user',
      input.initialQuotaCny,
      at,
      input.isAdmin ? at : null,
      input.isAdmin ? 'system' : null,
      at,
    )
    return this.userById(input.id)!
  }

  userById(id: string): UserRow | undefined {
    return this.get<UserRow>('SELECT * FROM users WHERE id = ?', id)
  }

  userByGithubId(githubId: number): UserRow | undefined {
    return this.get<UserRow>('SELECT * FROM users WHERE github_id = ?', githubId)
  }

  userByLogin(login: string): UserRow | undefined {
    return this.get<UserRow>('SELECT * FROM users WHERE lower(login) = lower(?)', login)
  }

  listUsers(status?: UserStatus): UserRow[] {
    if (status === undefined) return this.all<UserRow>('SELECT * FROM users ORDER BY created_at DESC')
    return this.all<UserRow>('SELECT * FROM users WHERE status = ? ORDER BY created_at DESC', status)
  }

  setUserStatus(id: string, status: UserStatus, by: string): void {
    const at = status === 'approved' ? nowIso() : null
    this.run(
      'UPDATE users SET status = ?, approved_at = COALESCE(?, approved_at), approved_by = ?, reviewed_at = ? WHERE id = ?',
      status,
      at,
      by,
      nowIso(),
      id,
    )
  }

  submitApplication(
    id: string,
    input: {
      name: string
      disclaimerVersion: string
      securityVersion: string
      agreementHash: string
      ip: string | null
      userAgent: string | null
    },
  ): boolean {
    const at = nowIso()
    const result = this.db
      .prepare(
        `UPDATE users SET status = 'pending', disclaimer_name = ?, disclaimer_version = ?, disclaimer_accepted_at = ?,
         security_version = ?, security_accepted_at = ?, agreement_hash = ?, application_submitted_at = ?,
         application_ip = ?, application_ua = ? WHERE id = ? AND status = 'onboarding'`,
      )
      .run(
        input.name,
        input.disclaimerVersion,
        at,
        input.securityVersion,
        at,
        input.agreementHash,
        at,
        input.ip,
        input.userAgent,
        id,
      )
    return Number(result.changes) > 0
  }

  queuePosition(id: string): number | null {
    const user = this.userById(id)
    if (user === undefined || user.status !== 'pending') return null
    const row = this.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM users WHERE status = 'pending' AND COALESCE(application_submitted_at, created_at) < COALESCE(?, created_at)",
      user.application_submitted_at,
    )
    return Number(row?.n ?? 0) + 1
  }

  userActivity(id: string): { repos: number; jobs: number; lastJobAt: string | null } {
    const row = this.get<{ repos: number; jobs: number; last_job_at: string | null }>(
      `SELECT (SELECT COUNT(*) FROM repos WHERE user_id = ?) AS repos,
              (SELECT COUNT(*) FROM jobs WHERE user_id = ?) AS jobs,
              (SELECT MAX(created_at) FROM jobs WHERE user_id = ?) AS last_job_at`,
      id,
      id,
      id,
    )
    return { repos: Number(row?.repos ?? 0), jobs: Number(row?.jobs ?? 0), lastJobAt: row?.last_job_at ?? null }
  }

  pendingTotal(): number {
    const row = this.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE status = 'pending'")
    return Number(row?.n ?? 0)
  }

  markApprovalSent(id: string): void {
    this.run('UPDATE users SET approval_sent_at = ? WHERE id = ?', nowIso(), id)
  }

  setUserRole(id: string, role: UserRole): void {
    this.run('UPDATE users SET role = ? WHERE id = ?', role, id)
  }

  setUserQuota(id: string, quotaCny: number): void {
    this.run('UPDATE users SET quota_cny = ? WHERE id = ?', quotaCny, id)
  }

  setUserQuotaUnlimited(id: string, unlimited: boolean): void {
    this.run('UPDATE users SET quota_unlimited = ? WHERE id = ?', unlimited ? 1 : 0, id)
  }

  addUserUsage(id: string, usd: number): void {
    this.run('UPDATE users SET quota_used_usd = quota_used_usd + ? WHERE id = ?', usd, id)
  }

  setUserGithubToken(id: string, encrypted: string | null): void {
    this.run('UPDATE users SET github_token_enc = ? WHERE id = ?', encrypted, id)
  }

  setUserOwnModel(id: string, baseUrl: string | null, keyEnc: string | null, model: string | null): void {
    this.run('UPDATE users SET own_llm_base_url = ?, own_llm_key_enc = ?, own_llm_model = ? WHERE id = ?', baseUrl, keyEnc, model, id)
  }

  createSession(input: { idHash: string; userId: string; expiresAt: string; ip: string | null; userAgent: string | null }): void {
    this.run(
      'INSERT INTO sessions (id_hash, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
      input.idHash,
      input.userId,
      nowIso(),
      input.expiresAt,
      input.ip,
      input.userAgent,
    )
  }

  getSession(idHash: string): SessionRow | undefined {
    return this.get<SessionRow>('SELECT * FROM sessions WHERE id_hash = ? AND expires_at > ?', idHash, nowIso())
  }

  deleteSession(idHash: string): void {
    this.run('DELETE FROM sessions WHERE id_hash = ?', idHash)
  }

  deleteExpiredSessions(): void {
    this.run('DELETE FROM sessions WHERE expires_at <= ?', nowIso())
  }

  createOAuthState(stateHash: string, expiresAt: string, redirectTo: string | null): void {
    this.run('INSERT INTO oauth_states (state_hash, created_at, expires_at, redirect_to) VALUES (?, ?, ?, ?)', stateHash, nowIso(), expiresAt, redirectTo)
  }

  consumeOAuthState(stateHash: string): OAuthStateRow | undefined {
    const row = this.get<OAuthStateRow>('SELECT * FROM oauth_states WHERE state_hash = ? AND expires_at > ?', stateHash, nowIso())
    if (row !== undefined) this.run('DELETE FROM oauth_states WHERE state_hash = ?', stateHash)
    return row
  }

  createApprovalToken(tokenHash: string, userId: string, action: 'approve' | 'reject', expiresAt: string): void {
    this.run('INSERT INTO approval_tokens (token_hash, user_id, action, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', tokenHash, userId, action, nowIso(), expiresAt)
  }

  findApprovalToken(tokenHash: string): ApprovalRow | undefined {
    return this.get<ApprovalRow>('SELECT * FROM approval_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?', tokenHash, nowIso())
  }

  useApprovalToken(tokenHash: string): void {
    this.run('UPDATE approval_tokens SET used_at = ? WHERE token_hash = ?', nowIso(), tokenHash)
  }

  createRepo(input: {
    id: string
    userId: string
    owner: string
    name: string
    defaultBranch: string
    tokenEnc: string
    goal: string
    autoIterate: boolean
    intervalMinutes: number
    upstreamOwner?: string
    upstreamName?: string
    forkOwner?: string
    forkName?: string
    upstreamDefaultBranch?: string
    forkDefaultBranch?: string
    isFork?: boolean
    forkCreated?: boolean
    permission?: string
    canReview?: boolean
    canCreateIssue?: boolean
    reviewerEnabled?: boolean
    reviewIntervalMinutes?: number
    upstreamHtmlUrl?: string | null
    forkHtmlUrl?: string | null
  }): RepoRow {
    this.run(
      `INSERT INTO repos (id, user_id, owner, name, default_branch, token_enc, goal, enabled, auto_iterate, interval_minutes, created_at,
         upstream_owner, upstream_name, fork_owner, fork_name, upstream_default_branch, fork_default_branch,
         is_fork, fork_created, permission, can_review, can_create_issue, reviewer_enabled, review_interval_minutes, upstream_html_url, fork_html_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.userId,
      input.owner,
      input.name,
      input.defaultBranch,
      input.tokenEnc,
      input.goal,
      input.autoIterate ? 1 : 0,
      input.intervalMinutes,
      nowIso(),
      input.upstreamOwner ?? input.owner,
      input.upstreamName ?? input.name,
      input.forkOwner ?? input.owner,
      input.forkName ?? input.name,
      input.upstreamDefaultBranch ?? input.defaultBranch,
      input.forkDefaultBranch ?? input.defaultBranch,
      input.isFork === true ? 1 : 0,
      input.forkCreated === true ? 1 : 0,
      input.permission ?? 'write',
      input.canReview === true ? 1 : 0,
      input.canCreateIssue === true ? 1 : 0,
      input.reviewerEnabled === true ? 1 : 0,
      input.reviewIntervalMinutes ?? 1440,
      input.upstreamHtmlUrl ?? null,
      input.forkHtmlUrl ?? null,
    )
    return this.getRepo(input.id)!
  }

  listRepos(userId: string): RepoRow[] {
    return this.all<RepoRow>('SELECT * FROM repos WHERE user_id = ? ORDER BY created_at DESC', userId)
  }

  getRepo(id: string): RepoRow | undefined {
    return this.get<RepoRow>('SELECT * FROM repos WHERE id = ?', id)
  }

  getRepoByOwnerName(userId: string, owner: string, name: string): RepoRow | undefined {
    return this.get<RepoRow>('SELECT * FROM repos WHERE user_id = ? AND lower(owner) = lower(?) AND lower(name) = lower(?)', userId, owner, name)
  }

  updateRepo(id: string, patch: Partial<Pick<RepoRow, 'goal' | 'enabled' | 'auto_iterate' | 'interval_minutes' | 'last_run_at' | 'last_status' | 'default_branch' | 'permission' | 'can_review' | 'can_create_issue' | 'reviewer_enabled' | 'review_interval_minutes' | 'last_review_at' | 'last_review_status' | 'is_fork' | 'fork_created' | 'upstream_owner' | 'upstream_name' | 'fork_owner' | 'fork_name' | 'upstream_default_branch' | 'fork_default_branch' | 'upstream_html_url' | 'fork_html_url'>>): void {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined)
    if (entries.length === 0) return
    const sets = entries.map(([key]) => `${key} = ?`).join(', ')
    this.run(`UPDATE repos SET ${sets} WHERE id = ?`, ...entries.map(([, value]) => value), id)
  }

  deleteRepo(id: string): void {
    this.run('DELETE FROM repos WHERE id = ?', id)
  }

  listAutoRepos(): RepoRow[] {
    return this.all<RepoRow>('SELECT * FROM repos WHERE enabled = 1 AND auto_iterate = 1')
  }

  listReviewRepos(): RepoRow[] {
    return this.all<RepoRow>('SELECT * FROM repos WHERE enabled = 1 AND reviewer_enabled = 1 AND can_review = 1')
  }

  getRepoInstance(repoId: string): RepoInstanceRow | undefined {
    return this.get<RepoInstanceRow>('SELECT * FROM repo_instances WHERE repo_id = ?', repoId)
  }

  listRepoInstances(): RepoInstanceRow[] {
    return this.all<RepoInstanceRow>('SELECT * FROM repo_instances ORDER BY created_at DESC')
  }

  saveRepoInstance(input: RepoInstanceRow): RepoInstanceRow {
    this.run(
      `INSERT OR REPLACE INTO repo_instances
       (repo_id, user_id, container, network, data_dir, bridge_script, dsh_port, bridge_port, model_port, model_bind, image, status, chief_session, team_json, bridge_token_enc, bridge_pid, log_pid, last_error, created_at, updated_at, last_health_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.repo_id,
      input.user_id,
      input.container,
      input.network,
      input.data_dir,
      input.bridge_script,
      input.dsh_port,
      input.bridge_port,
      input.model_port,
      input.model_bind,
      input.image,
      input.status,
      input.chief_session,
      input.team_json,
      input.bridge_token_enc,
      input.bridge_pid,
      input.log_pid,
      input.last_error,
      input.created_at,
      input.updated_at,
      input.last_health_at,
    )
    return this.getRepoInstance(input.repo_id)!
  }

  updateRepoInstance(repoId: string, patch: Partial<Omit<RepoInstanceRow, 'repo_id' | 'user_id' | 'created_at'>>): void {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined)
    if (entries.length === 0) return
    const sets = entries.map(([key]) => `${key} = ?`).join(', ')
    this.run(`UPDATE repo_instances SET ${sets} WHERE repo_id = ?`, ...entries.map(([, value]) => value), repoId)
  }

  deleteRepoInstance(repoId: string): void {
    this.run('DELETE FROM repo_instances WHERE repo_id = ?', repoId)
  }

  createJob(input: { id: string; repoId: string; userId: string; trigger: string; goal: string; callbackHash: string; platformTokenHash: string; kind?: string }): JobRow {
    this.run(
      `INSERT INTO jobs (id, repo_id, user_id, status, trigger, goal, callback_hash, platform_token_hash, kind, created_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.repoId,
      input.userId,
      input.trigger,
      input.goal,
      input.callbackHash,
      input.platformTokenHash,
      input.kind ?? 'iterate',
      nowIso(),
    )
    return this.getJob(input.id)!
  }

  getJob(id: string): JobRow | undefined {
    return this.get<JobRow>('SELECT * FROM jobs WHERE id = ?', id)
  }

  listJobs(userId: string, limit = 20): JobRow[] {
    return this.all<JobRow>('SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', userId, limit)
  }

  listJobsForRepo(repoId: string, limit = 20): JobRow[] {
    return this.all<JobRow>('SELECT * FROM jobs WHERE repo_id = ? ORDER BY created_at DESC LIMIT ?', repoId, limit)
  }

  activeJobForRepo(repoId: string): JobRow | undefined {
    return this.get<JobRow>("SELECT * FROM jobs WHERE repo_id = ? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1", repoId)
  }

  listActiveJobsForUser(userId: string): JobRow[] {
    return this.all<JobRow>("SELECT * FROM jobs WHERE user_id = ? AND status IN ('queued','running') ORDER BY created_at DESC", userId)
  }

  updateJob(id: string, patch: Partial<Pick<JobRow, 'status' | 'branch' | 'pr_url' | 'issue_url' | 'review_score' | 'attribution_json' | 'summary' | 'error' | 'cost_usd' | 'started_at' | 'finished_at'>>): void {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined)
    if (entries.length === 0) return
    const sets = entries.map(([key]) => `${key} = ?`).join(', ')
    this.run(`UPDATE jobs SET ${sets} WHERE id = ?`, ...entries.map(([, value]) => value), id)
  }

  countActiveJobs(): number {
    const row = this.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')")
    return Number(row?.n ?? 0)
  }

  staleRunningJobs(beforeIso: string): JobRow[] {
    return this.all<JobRow>("SELECT * FROM jobs WHERE status = 'running' AND started_at < ?", beforeIso)
  }

  createApiToken(input: { id: string; userId: string; kind: string; name: string; tokenHash: string; prefix: string; expiresAt: string | null }): ApiTokenRow {
    this.run(
      'INSERT INTO api_tokens (id, user_id, kind, name, token_hash, prefix, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      input.id,
      input.userId,
      input.kind,
      input.name,
      input.tokenHash,
      input.prefix,
      input.expiresAt,
      nowIso(),
    )
    return this.get<ApiTokenRow>('SELECT * FROM api_tokens WHERE id = ?', input.id)!
  }

  findApiToken(tokenHash: string): ApiTokenRow | undefined {
    return this.get<ApiTokenRow>('SELECT * FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)', tokenHash, nowIso())
  }

  touchApiToken(id: string): void {
    this.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', nowIso(), id)
  }

  revokeApiToken(id: string, userId: string): void {
    this.run('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ?', nowIso(), id, userId)
  }

  listApiTokens(userId: string): ApiTokenRow[] {
    return this.all<ApiTokenRow>('SELECT * FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC', userId)
  }

  deleteExpiredJobTokens(): void {
    this.run("UPDATE api_tokens SET revoked_at = ? WHERE kind = 'job' AND (expires_at IS NOT NULL AND expires_at <= ?) AND revoked_at IS NULL", nowIso(), nowIso())
  }

  recordUsage(userId: string, jobId: string | null, costUsd: number, meta: string | null = null): void {
    this.transaction(() => {
      this.run('INSERT INTO quota_ledger (at, user_id, job_id, cost_usd, meta) VALUES (?, ?, ?, ?, ?)', nowIso(), userId, jobId, costUsd, meta)
      this.run('UPDATE users SET quota_used_usd = quota_used_usd + ? WHERE id = ?', costUsd, userId)
    })
  }

  usageTotal(userId: string): number {
    const row = this.get<{ total: number | null }>('SELECT SUM(cost_usd) AS total FROM quota_ledger WHERE user_id = ?', userId)
    return Number(row?.total ?? 0)
  }

  notify(userId: string, kind: string, message: string): void {
    this.run('INSERT INTO notifications (id, user_id, kind, message, created_at) VALUES (?, ?, ?, ?, ?)', `ntf_${Math.random().toString(36).slice(2, 12)}`, userId, kind, message, nowIso())
  }

  listNotifications(userId: string, limit = 20): NotificationRow[] {
    return this.all<NotificationRow>('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', userId, limit)
  }

  markNotificationsRead(userId: string): void {
    this.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', nowIso(), userId)
  }

  audit(userId: string | null, action: string, detail: string | null = null): void {
    this.run('INSERT INTO audit_log (at, user_id, action, detail) VALUES (?, ?, ?, ?)', nowIso(), userId, action, detail)
  }

  listAudit(limit = 100): AuditRow[] {
    return this.all<AuditRow>('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', limit)
  }

  listAuditPage(limit: number, offset: number): AuditRow[] {
    return this.all<AuditRow>('SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?', limit, offset)
  }

  countAudit(): number {
    const row = this.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log')
    return Number(row?.n ?? 0)
  }

  listJobsPage(limit: number, offset: number): JobRow[] {
    return this.all<JobRow>('SELECT * FROM jobs ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?', limit, offset)
  }

  countJobs(): number {
    const row = this.get<{ n: number }>('SELECT COUNT(*) AS n FROM jobs')
    return Number(row?.n ?? 0)
  }

  getSetting(key: string): string | undefined {
    return this.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value
  }

  setSetting(key: string, value: string): void {
    this.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value)
  }
}

export function openStore(path: string): Store {
  const store = new Store(path)
  log.info('database ready', { path })
  return store
}
