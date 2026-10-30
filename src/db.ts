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
  UNIQUE(user_id, owner, name)
);
CREATE INDEX IF NOT EXISTS repos_user_idx ON repos(user_id);

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
    this.db.exec('PRAGMA user_version = 2;')
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
    ]
    for (const [name, type] of additions) {
      if (!columns.has(name)) this.run(`ALTER TABLE users ADD COLUMN ${name} ${type}`)
    }
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
  }): RepoRow {
    this.run(
      `INSERT INTO repos (id, user_id, owner, name, default_branch, token_enc, goal, enabled, auto_iterate, interval_minutes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
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

  updateRepo(id: string, patch: Partial<Pick<RepoRow, 'goal' | 'enabled' | 'auto_iterate' | 'interval_minutes' | 'last_run_at' | 'last_status' | 'default_branch'>>): void {
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

  createJob(input: { id: string; repoId: string; userId: string; trigger: string; goal: string; callbackHash: string; platformTokenHash: string }): JobRow {
    this.run(
      `INSERT INTO jobs (id, repo_id, user_id, status, trigger, goal, callback_hash, platform_token_hash, created_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
      input.id,
      input.repoId,
      input.userId,
      input.trigger,
      input.goal,
      input.callbackHash,
      input.platformTokenHash,
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

  updateJob(id: string, patch: Partial<Pick<JobRow, 'status' | 'branch' | 'pr_url' | 'summary' | 'error' | 'cost_usd' | 'started_at' | 'finished_at'>>): void {
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
