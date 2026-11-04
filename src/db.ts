import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
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
export type UserRole = 'user' | 'admin' | 'superadmin'
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
  email_job_updates: number
  email_daily_digest: number
  notify_email: string | null
  github_token_enc: string | null
  github_token_scopes: string | null
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
  installation_id: number | null
  goal: string
  enabled: number
  job_mode: string
  repo_role: string | null
  auto_merge: number
  role_checked_at: string | null
  plan_required: number
  allow_paths: string
  deny_paths: string
  merge_method: string
  require_protection: number
  protection_state: string | null
  protection_checked_at: string | null
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
  target_branch: string
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
  base_branch: string | null
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
  evidence_json: string | null
  checkpoint: string | null
  team_stats_json: string | null
  work_item_id: string | null
  priority: number
  plan_approved_at: string | null
  plan_approved_by: string | null
  plan_rejected_at: string | null
  plan_allow_paths: string | null
  plan_deny_paths: string | null
  base_sha: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

export interface WorkItemRow {
  id: string
  repo_id: string
  user_id: string
  title: string
  detail: string
  issue_url: string | null
  pr_url: string | null
  state: string
  priority: number
  assignee_user_id: string | null
  job_id: string | null
  pr_state: string | null
  merged_at: string | null
  merge_commit: string | null
  created_at: string
  updated_at: string
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
  email_job_updates INTEGER NOT NULL DEFAULT 1,
  email_daily_digest INTEGER NOT NULL DEFAULT 1,
  notify_email TEXT,
  github_token_enc TEXT,
  github_token_scopes TEXT,
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
  installation_id INTEGER,
  goal TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  job_mode TEXT NOT NULL DEFAULT 'iterate',
  repo_role TEXT,
  auto_merge INTEGER NOT NULL DEFAULT 0,
  role_checked_at TEXT,
  plan_required INTEGER NOT NULL DEFAULT 0,
  allow_paths TEXT NOT NULL DEFAULT '',
  deny_paths TEXT NOT NULL DEFAULT '',
  merge_method TEXT NOT NULL DEFAULT 'squash',
  require_protection INTEGER NOT NULL DEFAULT 1,
  protection_state TEXT,
  protection_checked_at TEXT,
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
  target_branch TEXT NOT NULL DEFAULT '',
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
  base_branch TEXT,
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
  evidence_json TEXT,
  checkpoint TEXT,
  team_stats_json TEXT,
  work_item_id TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  plan_approved_at TEXT,
  plan_approved_by TEXT,
  plan_rejected_at TEXT,
  plan_allow_paths TEXT,
  plan_deny_paths TEXT,
  base_sha TEXT,
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

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  user_id TEXT,
  name TEXT NOT NULL,
  repo_id TEXT,
  job_id TEXT,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS events_name_at_idx ON events(name, at DESC);
CREATE INDEX IF NOT EXISTS events_user_at_idx ON events(user_id, at DESC);

CREATE TABLE IF NOT EXISTS github_installations (
  installation_id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS github_installations_user_idx ON github_installations(user_id);

CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  issue_url TEXT,
  pr_url TEXT,
  state TEXT NOT NULL DEFAULT 'proposed',
  priority INTEGER NOT NULL DEFAULT 0,
  assignee_user_id TEXT,
  job_id TEXT,
  pr_state TEXT,
  merged_at TEXT,
  merge_commit TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS work_items_repo_idx ON work_items(repo_id, state, created_at DESC);
CREATE INDEX IF NOT EXISTS work_items_pr_idx ON work_items(pr_url);
CREATE INDEX IF NOT EXISTS work_items_issue_idx ON work_items(issue_url);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS audit_log_user_idx ON audit_log(user_id, id DESC);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log(at);
CREATE INDEX IF NOT EXISTS repos_installation_idx ON repos(installation_id);
CREATE INDEX IF NOT EXISTS repos_auto_idx ON repos(enabled, auto_iterate);
CREATE INDEX IF NOT EXISTS repos_review_idx ON repos(enabled, reviewer_enabled, can_review, repo_role);
CREATE INDEX IF NOT EXISTS jobs_user_pr_idx ON jobs(user_id, pr_url);
CREATE INDEX IF NOT EXISTS jobs_created_idx ON jobs(created_at);
CREATE INDEX IF NOT EXISTS events_at_idx ON events(at);
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
    this.db.exec('PRAGMA busy_timeout = 5000;')
    const previousVersion = Number(this.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0)
    if (previousVersion > 18) {
      this.db.close()
      throw new Error(`database schema version ${previousVersion} is newer than this build supports (18)`)
    }
    this.db.exec(SCHEMA)
    this.migrateColumns()
    this.migrateRepoColumns()
    this.run("UPDATE repos SET job_mode = 'iterate' WHERE job_mode != 'iterate'")
    if (previousVersion < 15) {
      this.run("UPDATE repos SET repo_role = CASE WHEN permission IN ('admin', 'maintain') THEN 'maintainer' ELSE 'developer' END WHERE repo_role IS NULL")
    }
    if (previousVersion < 16) {
      this.run('UPDATE repos SET role_checked_at = ? WHERE repo_role IS NOT NULL AND role_checked_at IS NULL', nowIso())
    }
    this.db.exec(`PRAGMA user_version = ${Math.max(previousVersion, 18)};`)
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
      ['email_job_updates', 'INTEGER NOT NULL DEFAULT 1'],
      ['email_daily_digest', 'INTEGER NOT NULL DEFAULT 1'],
      ['notify_email', 'TEXT'],
      ['github_token_scopes', 'TEXT'],
    ]
    for (const [name, type] of additions) {
      if (!columns.has(name)) this.run(`ALTER TABLE users ADD COLUMN ${name} ${type}`)
    }
  }

  private migrateRepoColumns(): void {
    const repoColumns = new Set(this.all<{ name: string }>('PRAGMA table_info(repos)').map((row) => row.name))
    const repoAdditions: Array<[string, string]> = [
      ['installation_id', 'INTEGER'],
      ['job_mode', "TEXT NOT NULL DEFAULT 'iterate'"],
      ['repo_role', 'TEXT'],
      ['auto_merge', 'INTEGER NOT NULL DEFAULT 0'],
      ['role_checked_at', 'TEXT'],
      ['plan_required', 'INTEGER NOT NULL DEFAULT 0'],
      ['allow_paths', "TEXT NOT NULL DEFAULT ''"],
      ['deny_paths', "TEXT NOT NULL DEFAULT ''"],
      ['merge_method', "TEXT NOT NULL DEFAULT 'squash'"],
      ['require_protection', 'INTEGER NOT NULL DEFAULT 1'],
      ['protection_state', 'TEXT'],
      ['protection_checked_at', 'TEXT'],
      ['upstream_owner', "TEXT NOT NULL DEFAULT ''"],
      ['upstream_name', "TEXT NOT NULL DEFAULT ''"],
      ['fork_owner', "TEXT NOT NULL DEFAULT ''"],
      ['fork_name', "TEXT NOT NULL DEFAULT ''"],
      ['upstream_default_branch', "TEXT NOT NULL DEFAULT 'main'"],
      ['fork_default_branch', "TEXT NOT NULL DEFAULT 'main'"],
      ['target_branch', "TEXT NOT NULL DEFAULT ''"],
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
    this.run("UPDATE repos SET target_branch = upstream_default_branch WHERE target_branch = ''")
    const jobColumns = new Set(this.all<{ name: string }>('PRAGMA table_info(jobs)').map((row) => row.name))
    if (!jobColumns.has('kind')) this.run("ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'iterate'")
    if (!jobColumns.has('issue_url')) this.run('ALTER TABLE jobs ADD COLUMN issue_url TEXT')
    if (!jobColumns.has('review_score')) this.run('ALTER TABLE jobs ADD COLUMN review_score INTEGER')
    if (!jobColumns.has('attribution_json')) this.run('ALTER TABLE jobs ADD COLUMN attribution_json TEXT')
    if (!jobColumns.has('evidence_json')) this.run('ALTER TABLE jobs ADD COLUMN evidence_json TEXT')
    if (!jobColumns.has('checkpoint')) this.run('ALTER TABLE jobs ADD COLUMN checkpoint TEXT')
    if (!jobColumns.has('team_stats_json')) this.run('ALTER TABLE jobs ADD COLUMN team_stats_json TEXT')
    if (!jobColumns.has('work_item_id')) this.run('ALTER TABLE jobs ADD COLUMN work_item_id TEXT')
    if (!jobColumns.has('priority')) this.run('ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0')
    if (!jobColumns.has('plan_approved_at')) this.run('ALTER TABLE jobs ADD COLUMN plan_approved_at TEXT')
    if (!jobColumns.has('plan_approved_by')) this.run('ALTER TABLE jobs ADD COLUMN plan_approved_by TEXT')
    if (!jobColumns.has('plan_rejected_at')) this.run('ALTER TABLE jobs ADD COLUMN plan_rejected_at TEXT')
    if (!jobColumns.has('plan_allow_paths')) this.run('ALTER TABLE jobs ADD COLUMN plan_allow_paths TEXT')
    if (!jobColumns.has('plan_deny_paths')) this.run('ALTER TABLE jobs ADD COLUMN plan_deny_paths TEXT')
    if (!jobColumns.has('base_sha')) this.run('ALTER TABLE jobs ADD COLUMN base_sha TEXT')
    if (!jobColumns.has('base_branch')) this.run('ALTER TABLE jobs ADD COLUMN base_branch TEXT')
    this.run("UPDATE jobs SET base_branch = (SELECT upstream_default_branch FROM repos WHERE repos.id = jobs.repo_id) WHERE base_branch IS NULL")
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
    isSuperAdmin?: boolean
    initialQuotaCny: number
  }): UserRow {
    const existing = this.userByGithubId(input.githubId)
    const at = nowIso()
    const role = input.isSuperAdmin === true ? 'superadmin' : input.isAdmin ? 'admin' : undefined
    if (existing !== undefined) {
      this.run(
        'UPDATE users SET login=?, name=?, email=?, avatar_url=?, last_login_at=?, role=? WHERE id=?',
        input.login,
        input.name,
        input.email,
        input.avatarUrl,
        at,
        role ?? existing.role,
        existing.id,
      )
      return this.userById(existing.id)!
    }
    const privileged = role !== undefined
    this.run(
      `INSERT INTO users (id, github_id, login, name, email, avatar_url, status, role, quota_cny, quota_used_usd, created_at, approved_at, approved_by, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      input.id,
      input.githubId,
      input.login,
      input.name,
      input.email,
      input.avatarUrl,
      privileged ? 'approved' : 'onboarding',
      role ?? 'user',
      input.initialQuotaCny,
      at,
      privileged ? at : null,
      privileged ? 'system' : null,
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

  ensureSuperadmin(login: string): void {
    if (login === '') return
    this.run("UPDATE users SET role = 'superadmin' WHERE lower(login) = lower(?) AND role != 'superadmin'", login)
  }

  setUserQuota(id: string, quotaCny: number): void {
    this.run('UPDATE users SET quota_cny = ? WHERE id = ?', quotaCny, id)
  }

  setUserQuotaUnlimited(id: string, unlimited: boolean): void {
    this.run('UPDATE users SET quota_unlimited = ? WHERE id = ?', unlimited ? 1 : 0, id)
  }

  setEmailJobUpdates(id: string, enabled: boolean): void {
    this.run('UPDATE users SET email_job_updates = ? WHERE id = ?', enabled ? 1 : 0, id)
  }

  setEmailDailyDigest(id: string, enabled: boolean): void {
    this.run('UPDATE users SET email_daily_digest = ? WHERE id = ?', enabled ? 1 : 0, id)
  }

  setNotifyEmail(id: string, email: string | null): void {
    this.run('UPDATE users SET notify_email = ? WHERE id = ?', email, id)
  }

  saveInstallation(input: { installationId: number; userId: string; accountLogin: string; accountType: string }): void {
    this.run(
      `INSERT INTO github_installations (installation_id, user_id, account_login, account_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(installation_id) DO UPDATE SET account_login = excluded.account_login, account_type = excluded.account_type, updated_at = excluded.updated_at`,
      input.installationId, input.userId, input.accountLogin, input.accountType, nowIso(), nowIso(),
    )
  }

  listInstallations(userId: string): Array<{ installation_id: number; user_id: string; account_login: string; account_type: string }> {
    return this.all('SELECT installation_id, user_id, account_login, account_type FROM github_installations WHERE user_id = ? ORDER BY created_at DESC', userId)
  }

  getInstallation(installationId: number): { installation_id: number; user_id: string; account_login: string; account_type: string } | undefined {
    return this.get('SELECT installation_id, user_id, account_login, account_type FROM github_installations WHERE installation_id = ?', installationId)
  }

  deleteInstallation(installationId: number): void {
    this.run('DELETE FROM github_installations WHERE installation_id = ?', installationId)
  }

  addUserUsage(id: string, usd: number): void {
    this.run('UPDATE users SET quota_used_usd = quota_used_usd + ? WHERE id = ?', usd, id)
  }

  addJobCost(id: string, usd: number): void {
    this.run('UPDATE jobs SET cost_usd = cost_usd + ? WHERE id = ?', usd, id)
  }

  event(name: string, input: { userId?: string | null; repoId?: string | null; jobId?: string | null; meta?: string | null } = {}): void {
    this.run(
      'INSERT INTO events (at, user_id, name, repo_id, job_id, meta) VALUES (?, ?, ?, ?, ?, ?)',
      nowIso(),
      input.userId ?? null,
      name,
      input.repoId ?? null,
      input.jobId ?? null,
      input.meta ?? null,
    )
  }

  countEvents(name: string, sinceIso?: string): number {
    const row = sinceIso === undefined
      ? this.get<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE name = ?', name)
      : this.get<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE name = ? AND at >= ?', name, sinceIso)
    return Number(row?.n ?? 0)
  }

  teamMetrics(sinceIso: string): {
    jobs: number
    avgRoles: number
    leadOnly: number
    roles: Array<{ role: string; calls: number; jobs: number }>
  } {
    const rows = this.all<{ team_stats_json: string }>('SELECT team_stats_json FROM jobs WHERE created_at >= ? AND team_stats_json IS NOT NULL', sinceIso)
    const perRole = new Map<string, { calls: number; jobs: number }>()
    let jobs = 0
    let rolesTotal = 0
    let leadOnly = 0
    for (const row of rows) {
      let stats: Array<{ role?: unknown; calls?: unknown }>
      try { stats = JSON.parse(row.team_stats_json) as Array<{ role?: unknown; calls?: unknown }> } catch { continue }
      if (!Array.isArray(stats)) continue
      const active = stats.filter((entry) => typeof entry.calls === 'number' && entry.calls > 0 && typeof entry.role === 'string')
      if (active.length === 0) continue
      jobs += 1
      rolesTotal += active.length
      if (active.length === 1 && active[0]?.role === 'lead') leadOnly += 1
      for (const entry of active) {
        const role = String(entry.role)
        const current = perRole.get(role) ?? { calls: 0, jobs: 0 }
        current.calls += Number(entry.calls ?? 0)
        current.jobs += 1
        perRole.set(role, current)
      }
    }
    return {
      jobs,
      avgRoles: jobs === 0 ? 0 : Math.round((rolesTotal / jobs) * 10) / 10,
      leadOnly,
      roles: [...perRole.entries()].map(([role, value]) => ({ role, ...value })).sort((a, b) => b.calls - a.calls),
    }
  }

  productMetrics(sinceIso: string): {
    users: number
    approved: number
    repos: number
    jobs: number
    succeeded: number
    failed: number
    usersWithJobs: number
    usersWithPr: number
    costUsd: number
    events: Array<{ name: string; n: number }>
  } {
    const count = (sql: string, ...params: Array<string | number>): number => Number(this.get<{ n: number }>(sql, ...params)?.n ?? 0)
    return {
      users: count('SELECT COUNT(*) AS n FROM users'),
      approved: count("SELECT COUNT(*) AS n FROM users WHERE status = 'approved'"),
      repos: count('SELECT COUNT(*) AS n FROM repos'),
      jobs: count('SELECT COUNT(*) AS n FROM jobs'),
      succeeded: count("SELECT COUNT(*) AS n FROM jobs WHERE status = 'succeeded'"),
      failed: count("SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed'"),
      usersWithJobs: count('SELECT COUNT(DISTINCT user_id) AS n FROM jobs'),
      usersWithPr: count("SELECT COUNT(DISTINCT user_id) AS n FROM jobs WHERE pr_url IS NOT NULL"),
      costUsd: Number(this.get<{ n: number | null }>("SELECT SUM(cost_usd) AS n FROM jobs WHERE created_at >= ?", sinceIso)?.n ?? 0),
      events: this.all<{ name: string; n: number }>('SELECT name, COUNT(*) AS n FROM events WHERE at >= ? GROUP BY name ORDER BY n DESC', sinceIso),
    }
  }

  setUserGithubToken(id: string, encrypted: string | null, scopes = ''): void {
    this.run('UPDATE users SET github_token_enc = ?, github_token_scopes = ? WHERE id = ?', encrypted, scopes, id)
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
    installationId?: number | null
    goal: string
    autoIterate: boolean
    intervalMinutes: number
    repoRole?: string | null
    autoMerge?: boolean
    roleCheckedAt?: string | null
    planRequired?: boolean
    allowPaths?: string
    denyPaths?: string
    mergeMethod?: string
    requireProtection?: boolean
    protectionState?: string | null
    protectionCheckedAt?: string | null
    upstreamOwner?: string
    upstreamName?: string
    forkOwner?: string
    forkName?: string
    upstreamDefaultBranch?: string
    forkDefaultBranch?: string
    targetBranch?: string
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
      `INSERT INTO repos (id, user_id, owner, name, default_branch, token_enc, installation_id, goal, enabled, auto_iterate, interval_minutes, created_at,
         upstream_owner, upstream_name, fork_owner, fork_name, upstream_default_branch, fork_default_branch, target_branch, job_mode,
         repo_role, auto_merge, role_checked_at, plan_required, allow_paths, deny_paths, merge_method, require_protection, protection_state, protection_checked_at,
         is_fork, fork_created, permission, can_review, can_create_issue, reviewer_enabled, review_interval_minutes, upstream_html_url, fork_html_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.userId,
      input.owner,
      input.name,
      input.defaultBranch,
      input.tokenEnc,
      input.installationId ?? null,
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
      input.targetBranch ?? input.upstreamDefaultBranch ?? input.defaultBranch,
      'iterate',
      input.repoRole ?? null,
      input.autoMerge === true ? 1 : 0,
      input.roleCheckedAt ?? (input.repoRole === 'maintainer' || input.repoRole === 'developer' ? nowIso() : null),
      input.planRequired === true ? 1 : 0,
      input.allowPaths ?? '',
      input.denyPaths ?? '',
      input.mergeMethod ?? 'squash',
      input.requireProtection === false ? 0 : 1,
      input.protectionState ?? null,
      input.protectionCheckedAt ?? null,
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

  listReposPage(userId: string, limit: number, offset: number): RepoRow[] {
    return this.all<RepoRow>('SELECT * FROM repos WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?', userId, limit, offset)
  }

  countReposForUser(userId: string): number {
    return Number(this.get<{ n: number }>('SELECT COUNT(*) AS n FROM repos WHERE user_id = ?', userId)?.n ?? 0)
  }

  getRepo(id: string): RepoRow | undefined {
    return this.get<RepoRow>('SELECT * FROM repos WHERE id = ?', id)
  }

  findRepoByInstallationAndFullName(installationId: number, fullName: string): RepoRow | undefined {
    return this.get<RepoRow>(
      "SELECT * FROM repos WHERE installation_id = ? AND (lower(upstream_owner || '/' || upstream_name) = lower(?) OR lower(fork_owner || '/' || fork_name) = lower(?)) LIMIT 1",
      installationId, fullName, fullName,
    )
  }

  getRepoByOwnerName(userId: string, owner: string, name: string): RepoRow | undefined {
    return this.get<RepoRow>('SELECT * FROM repos WHERE user_id = ? AND lower(owner) = lower(?) AND lower(name) = lower(?)', userId, owner, name)
  }

  updateRepo(id: string, patch: Partial<Pick<RepoRow, 'goal' | 'enabled' | 'auto_iterate' | 'interval_minutes' | 'last_run_at' | 'last_status' | 'default_branch' | 'repo_role' | 'auto_merge' | 'role_checked_at' | 'plan_required' | 'allow_paths' | 'deny_paths' | 'merge_method' | 'require_protection' | 'protection_state' | 'protection_checked_at' | 'permission' | 'can_review' | 'can_create_issue' | 'reviewer_enabled' | 'review_interval_minutes' | 'last_review_at' | 'last_review_status' | 'target_branch' | 'is_fork' | 'fork_created' | 'upstream_owner' | 'upstream_name' | 'fork_owner' | 'fork_name' | 'upstream_default_branch' | 'fork_default_branch' | 'upstream_html_url' | 'fork_html_url'>>): void {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined)
    if (entries.length === 0) return
    const sets = entries.map(([key]) => `${key} = ?`).join(', ')
    this.run(`UPDATE repos SET ${sets} WHERE id = ?`, ...entries.map(([, value]) => value), id)
  }

  deleteRepo(id: string): void {
    this.run('DELETE FROM repos WHERE id = ?', id)
  }

  listAutoRepos(): RepoRow[] {
    return this.all<RepoRow>("SELECT * FROM repos WHERE enabled = 1 AND auto_iterate = 1 ORDER BY CASE WHEN last_run_at IS NULL THEN 0 ELSE 1 END, last_run_at ASC, created_at ASC")
  }

  listReviewRepos(): RepoRow[] {
    return this.all<RepoRow>("SELECT * FROM repos WHERE enabled = 1 AND reviewer_enabled = 1 AND can_review = 1 AND repo_role = 'maintainer' ORDER BY CASE WHEN last_review_at IS NULL THEN 0 ELSE 1 END, last_review_at ASC, created_at ASC")
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

  createJob(input: { id: string; repoId: string; userId: string; trigger: string; goal: string; callbackHash: string; platformTokenHash: string; kind?: string; baseBranch?: string | null; workItemId?: string | null; priority?: number; baseSha?: string | null }): JobRow {
    this.run(
      `INSERT INTO jobs (id, repo_id, user_id, status, trigger, goal, callback_hash, platform_token_hash, kind, base_branch, work_item_id, priority, base_sha, created_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.repoId,
      input.userId,
      input.trigger,
      input.goal,
      input.callbackHash,
      input.platformTokenHash,
      input.kind ?? 'iterate',
      input.baseBranch ?? null,
      input.workItemId ?? null,
      input.priority ?? 0,
      input.baseSha ?? null,
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

  listJobsPageForUser(userId: string, limit: number, offset: number): JobRow[] {
    return this.all<JobRow>('SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?', userId, limit, offset)
  }

  countJobsForUser(userId: string): number {
    return Number(this.get<{ n: number }>('SELECT COUNT(*) AS n FROM jobs WHERE user_id = ?', userId)?.n ?? 0)
  }

  listJobsSince(userId: string, sinceIso: string): JobRow[] {
    return this.all<JobRow>('SELECT * FROM jobs WHERE user_id = ? AND (created_at >= ? OR finished_at >= ?) ORDER BY created_at DESC', userId, sinceIso, sinceIso)
  }

  listJobsForRepo(repoId: string, limit = 20): JobRow[] {
    return this.all<JobRow>('SELECT * FROM jobs WHERE repo_id = ? ORDER BY created_at DESC LIMIT ?', repoId, limit)
  }

  listJobsPageForRepo(repoId: string, limit: number, offset: number): JobRow[] {
    return this.all<JobRow>('SELECT * FROM jobs WHERE repo_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?', repoId, limit, offset)
  }

  countJobsForRepo(repoId: string): number {
    return Number(this.get<{ n: number }>('SELECT COUNT(*) AS n FROM jobs WHERE repo_id = ?', repoId)?.n ?? 0)
  }

  latestJobByPrUrl(userId: string, prUrl: string): JobRow | undefined {
    return this.get<JobRow>('SELECT * FROM jobs WHERE user_id = ? AND pr_url = ? ORDER BY created_at DESC LIMIT 1', userId, prUrl)
  }

  createWorkItem(input: { id: string; repoId: string; userId: string; title: string; detail?: string; issueUrl?: string | null; prUrl?: string | null; state?: string; priority?: number; assigneeUserId?: string | null; jobId?: string | null; prState?: string | null; mergedAt?: string | null; mergeCommit?: string | null }): WorkItemRow {
    const at = nowIso()
    this.run(
      `INSERT INTO work_items (id, repo_id, user_id, title, detail, issue_url, pr_url, state, priority, assignee_user_id, job_id, pr_state, merged_at, merge_commit, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id, input.repoId, input.userId, input.title, input.detail ?? '', input.issueUrl ?? null, input.prUrl ?? null,
      input.state ?? 'proposed', input.priority ?? 0, input.assigneeUserId ?? null, input.jobId ?? null,
      input.prState ?? null, input.mergedAt ?? null, input.mergeCommit ?? null, at, at,
    )
    return this.getWorkItem(input.id)!
  }

  getWorkItem(id: string): WorkItemRow | undefined {
    return this.get<WorkItemRow>('SELECT * FROM work_items WHERE id = ?', id)
  }

  findWorkItemByPrUrl(repoId: string, prUrl: string): WorkItemRow | undefined {
    return this.get<WorkItemRow>('SELECT * FROM work_items WHERE repo_id = ? AND pr_url = ? ORDER BY updated_at DESC LIMIT 1', repoId, prUrl)
  }

  findWorkItemByIssueUrl(repoId: string, issueUrl: string): WorkItemRow | undefined {
    return this.get<WorkItemRow>('SELECT * FROM work_items WHERE repo_id = ? AND issue_url = ? ORDER BY updated_at DESC LIMIT 1', repoId, issueUrl)
  }

  listWorkItems(repoId: string): WorkItemRow[] {
    return this.all<WorkItemRow>('SELECT * FROM work_items WHERE repo_id = ? ORDER BY priority DESC, updated_at DESC', repoId)
  }

  hasActiveWorkItem(repoId: string): boolean {
    const row = this.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM work_items WHERE repo_id = ? AND state IN ('assigned', 'in_progress', 'pr_ready', 'in_review', 'changes_requested', 'approved')",
      repoId,
    )
    return Number(row?.n ?? 0) > 0
  }

  listOpenWorkItems(repoId: string): WorkItemRow[] {
    return this.all<WorkItemRow>("SELECT * FROM work_items WHERE repo_id = ? AND state NOT IN ('merged', 'closed') ORDER BY priority DESC, updated_at DESC", repoId)
  }

  updateWorkItem(id: string, patch: Partial<Pick<WorkItemRow, 'title' | 'detail' | 'issue_url' | 'pr_url' | 'state' | 'priority' | 'assignee_user_id' | 'job_id' | 'pr_state' | 'merged_at' | 'merge_commit'>>): void {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined)
    if (entries.length === 0) return
    entries.push(['updated_at', nowIso()])
    const sets = entries.map(([key]) => `${key} = ?`).join(', ')
    this.run(`UPDATE work_items SET ${sets} WHERE id = ?`, ...entries.map(([, value]) => value), id)
  }

  workItemMetrics(sinceIso: string): { total: number; open: number; merged: number; closed: number } {
    const count = (sql: string): number => Number(this.get<{ n: number }>(sql, sinceIso)?.n ?? 0)
    return {
      total: count('SELECT COUNT(*) AS n FROM work_items WHERE created_at >= ?'),
      open: count("SELECT COUNT(*) AS n FROM work_items WHERE created_at >= ? AND state NOT IN ('merged', 'closed')"),
      merged: count("SELECT COUNT(*) AS n FROM work_items WHERE created_at >= ? AND state = 'merged'"),
      closed: count("SELECT COUNT(*) AS n FROM work_items WHERE created_at >= ? AND state = 'closed'"),
    }
  }

  activeJobForRepo(repoId: string): JobRow | undefined {
    return this.get<JobRow>("SELECT * FROM jobs WHERE repo_id = ? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1", repoId)
  }

  listActiveJobsForUser(userId: string): JobRow[] {
    return this.all<JobRow>("SELECT * FROM jobs WHERE user_id = ? AND status IN ('queued','running') ORDER BY created_at DESC", userId)
  }

  listActiveJobs(): JobRow[] {
    return this.all<JobRow>("SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY created_at ASC")
  }

  updateJob(id: string, patch: Partial<Pick<JobRow, 'status' | 'branch' | 'pr_url' | 'issue_url' | 'review_score' | 'attribution_json' | 'evidence_json' | 'checkpoint' | 'team_stats_json' | 'summary' | 'error' | 'cost_usd' | 'started_at' | 'finished_at' | 'base_branch' | 'work_item_id' | 'priority' | 'plan_approved_at' | 'plan_approved_by' | 'plan_rejected_at' | 'plan_allow_paths' | 'plan_deny_paths' | 'base_sha'>>): void {
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
    return this.all<JobRow>("SELECT * FROM jobs WHERE status = 'running' AND COALESCE(started_at, created_at) < ?", beforeIso)
  }

  staleQueuedJobs(beforeIso: string): JobRow[] {
    return this.all<JobRow>("SELECT * FROM jobs WHERE status = 'queued' AND created_at < ?", beforeIso)
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

  pruneOldData(): void {
    const now = Date.now()
    const cutoff = (days: number): string => new Date(now - days * 86_400_000).toISOString()
    this.deleteExpiredSessions()
    this.run('DELETE FROM oauth_states WHERE created_at < ?', cutoff(7))
    this.run('DELETE FROM approval_tokens WHERE (expires_at < ? OR used_at IS NOT NULL) AND created_at < ?', nowIso(), cutoff(30))
    this.run('DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < ?', cutoff(30))
    this.run('DELETE FROM notifications WHERE read_at IS NULL AND created_at < ?', cutoff(90))
    this.run('DELETE FROM events WHERE at < ?', cutoff(90))
    this.run("DELETE FROM jobs WHERE status IN ('succeeded', 'failed', 'quota_exhausted') AND finished_at IS NOT NULL AND finished_at < ?", cutoff(365))
    this.run('DELETE FROM audit_log WHERE at < ?', cutoff(365))
    this.run('DELETE FROM quota_ledger WHERE at < ?', cutoff(730))
    const settings = this.all<{ key: string; value: string }>(
      "SELECT key, value FROM settings WHERE key LIKE 'followup:%' OR key LIKE 'question_notified:%' OR key LIKE 'digest_sent:%' OR key LIKE 'email_test:%' OR key LIKE 'webhook_delivery:%' OR key LIKE 'email_reply:%' OR key LIKE 'github_app_state:%' OR key LIKE 'installation_sender:%'",
    )
    const limits: Array<[string, string]> = [
      ['followup:', cutoff(30)],
      ['question_notified:', cutoff(30)],
      ['digest_sent:', cutoff(14)],
      ['email_test:', cutoff(1)],
      ['webhook_delivery:', cutoff(30)],
      ['email_reply:', cutoff(7)],
      ['github_app_state:', cutoff(1)],
      ['installation_sender:', cutoff(30)],
    ]
    for (const row of settings) {
      const limit = limits.find(([prefix]) => row.key.startsWith(prefix))?.[1]
      if (limit === undefined) continue
      const raw = row.value.slice(row.value.lastIndexOf(':') + 1)
      const at = /^\d{4}-\d{2}-\d{2}T/.test(row.value) ? Date.parse(row.value) : Number(raw)
      if (!Number.isFinite(at) || at === 0) continue
      const iso = at > 10_000_000_000 ? new Date(at).toISOString() : row.value
      if (iso < limit) this.run('DELETE FROM settings WHERE key = ?', row.key)
    }
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

  usageSince(userId: string, sinceIso: string): number {
    const row = this.get<{ total: number | null }>('SELECT SUM(cost_usd) AS total FROM quota_ledger WHERE user_id = ? AND at >= ?', userId, sinceIso)
    return Number(row?.total ?? 0)
  }

  usageForJob(jobId: string): number {
    const row = this.get<{ total: number | null }>('SELECT SUM(cost_usd) AS total FROM quota_ledger WHERE job_id = ?', jobId)
    return Number(row?.total ?? 0)
  }

  notify(userId: string, kind: string, message: string): void {
    this.run('INSERT INTO notifications (id, user_id, kind, message, created_at) VALUES (?, ?, ?, ?, ?)', `ntf_${randomBytes(6).toString('hex')}`, userId, kind, message, nowIso())
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

  listAuditPageForUsers(userIds: string[] | null, limit: number, offset: number): AuditRow[] {
    if (userIds === null) return this.listAuditPage(limit, offset)
    if (userIds.length === 0) return []
    const marks = userIds.map(() => '?').join(', ')
    return this.all<AuditRow>(`SELECT * FROM audit_log WHERE user_id IN (${marks}) ORDER BY id DESC LIMIT ? OFFSET ?`, ...userIds, limit, offset)
  }

  countAuditForUsers(userIds: string[] | null): number {
    if (userIds === null) return this.countAudit()
    if (userIds.length === 0) return 0
    const marks = userIds.map(() => '?').join(', ')
    return Number(this.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE user_id IN (${marks})`, ...userIds)?.n ?? 0)
  }

  listJobsPage(limit: number, offset: number): JobRow[] {
    return this.all<JobRow>('SELECT * FROM jobs ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?', limit, offset)
  }

  countJobs(): number {
    const row = this.get<{ n: number }>('SELECT COUNT(*) AS n FROM jobs')
    return Number(row?.n ?? 0)
  }

  listJobsPageForUsers(userIds: string[] | null, limit: number, offset: number): JobRow[] {
    if (userIds === null) return this.listJobsPage(limit, offset)
    if (userIds.length === 0) return []
    const marks = userIds.map(() => '?').join(', ')
    return this.all<JobRow>(`SELECT * FROM jobs WHERE user_id IN (${marks}) ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, ...userIds, limit, offset)
  }

  countJobsForUsers(userIds: string[] | null): number {
    if (userIds === null) return this.countJobs()
    if (userIds.length === 0) return 0
    const marks = userIds.map(() => '?').join(', ')
    return Number(this.get<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs WHERE user_id IN (${marks})`, ...userIds)?.n ?? 0)
  }

  getSetting(key: string): string | undefined {
    return this.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value
  }

  setSetting(key: string, value: string): void {
    this.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value)
  }

  deleteSetting(key: string): void {
    this.run('DELETE FROM settings WHERE key = ?', key)
  }

  listSettings(prefix: string): Array<{ key: string; value: string }> {
    return this.all<{ key: string; value: string }>('SELECT key, value FROM settings WHERE key LIKE ? ORDER BY key', `${prefix}%`)
  }
}

export function openStore(path: string): Store {
  const store = new Store(path)
  log.info('database ready', { path })
  return store
}
