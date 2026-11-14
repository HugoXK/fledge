import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { log } from './lib/log.js'
import { nowIso } from './lib/time.js'
import { WORK_ITEM_TRANSITIONS, type WorkItemState } from './lib/workItems.js'
import { parseModelRun } from './lib/modelRun.js'
import { normalizeProviderRegion, parseProviderAllowlist } from './gateway/modelUrl.js'
import { redact } from './lib/secrets.js'
import { DEFAULT_PAT_EXPIRY_DAYS } from './lib/tokens.js'
import { buildPostmortem, isPreventiveActionKind, type PreventiveActionKind } from './lib/postmortem.js'
import { artifactKey, candidateRefusal, type CandidateRefusal } from './lib/evolution/artifacts.js'

// #355: one settings row marks the PAT expiry backfill as done, so a later
// operator token (explicitly minted without an expiry) is never given one by a
// restart.
const PAT_EXPIRY_BACKFILL_KEY = 'pat_expiry_backfilled'

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
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'paused' | 'quota_exhausted'

// #361: a repository's review history, read from rows that already exist.
// A window is one `since`; the page asks for two. The outcome of a review is
// not the work item's current state (a later fix moves it on), so the count
// comes from the audit row the job service writes when the review finishes.
export interface ReviewTrendWindow {
  reviews: number
  averageScore: number | null
  outcomes: number
  changesRequested: number
  changesRequestedRate: number | null
  medianPrOpenToReviewMs: number | null
  medianPrOpenToMergeMs: number | null
  models: Array<{ label: string; reviews: number }>
  smallSample: boolean
}

// Below this many completed reviews the page says "small sample" instead of
// letting one score read as a trend.
export const REVIEW_TREND_SMALL_SAMPLE = 5

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
  /** #353: also mail a success the schedule produced. Off by default. */
  email_job_success: number
  notify_email: string | null
  github_token_enc: string | null
  github_token_scopes: string | null
  own_llm_base_url: string | null
  own_llm_key_enc: string | null
  own_llm_model: string | null
  allow_private_models: number
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
  stage_mode: string
  models_dirty: number
  credential_state: string
  consecutive_failures: number
  monthly_budget_cny: number
  job_budget_cny: number
  /** #357: `alert` (default), `pause` or `cancel` when a job crosses its budget. */
  job_budget_action: string
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
  provider_allowlist: string
  required_region: string
}

export interface UserModelRow {
  id: string
  user_id: string
  label: string
  base_url: string
  key_enc: string
  model: string
  allow_private: number
  created_at: string
  updated_at: string
}

export interface RepoModelRow {
  repo_id: string
  model_id: string
  is_default: number
  created_at: string
}

export interface ModelProviderRow {
  id: string
  user_id: string
  label: string
  base_url: string
  key_enc: string
  allow_private: number
  region: string
  data_policy_url: string
  allowed: number
  created_at: string
  updated_at: string
}

export interface ProviderModelRow {
  id: string
  provider_id: string
  model: string
  label: string
  created_at: string
}

export interface RepoProviderModelRow extends ProviderModelRow {
  provider_label: string
  provider_region: string
  provider_data_policy_url: string
  provider_allowed: number
  base_url: string
  key_enc: string
  allow_private: number
  is_default: number
}

export interface RepoBotModelRow {
  repo_id: string
  role: string
  provider_model_id: string
  created_at: string
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
  error_code: string | null
  cost_usd: number
  platform_token_hash: string | null
  callback_hash: string
  kind: string
  work_type: string
  triage_json: string | null
  issue_url: string | null
  pr_state: string | null
  review_score: number | null
  attribution_json: string | null
  evidence_json: string | null
  checkpoint: string | null
  team_stats_json: string | null
  work_item_id: string | null
  priority: number
  queue_seq: number
  plan_approved_at: string | null
  plan_approved_by: string | null
  plan_rejected_at: string | null
  plan_allow_paths: string | null
  plan_deny_paths: string | null
  base_sha: string | null
  callback_fingerprint: string | null
  path_guard_json: string | null
  verification_json: string | null
  continuity_json: string | null
  model_json: string | null
  provider_id: string | null
  provider_label: string | null
  provider_region: string | null
  provider_model: string | null
  output_kind: string | null
  continuity_used: number
  owner_started: number
  retry_attempt: number
  retry_of: string | null
  lease_owner: string | null
  lease_until: string | null
  callback_secret_enc: string | null
  platform_token_enc: string | null
  last_callback_at: string | null
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
  // Why a terminal `closed` item was closed (#359). NULL for every older row and
  // for a close done by hand; `plan_expired` is the only value today.
  closed_reason: string | null
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
  repo_id: string | null
  // #355: what the token may do. `gateway` is the only scope enforced today and
  // is the default for every existing row.
  scope: string
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
  recent_auth_at: string | null
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
  code: string | null
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

// #540: one row per command a caller asked for. `accepted` is the reservation
// (the receipt exists before any business write), `succeeded`/`failed` is the
// outcome, and `unknown` is reserved for a write whose external response was
// lost — no operation in this build can reach it yet.
export type ManagementCommandStatus = 'accepted' | 'running' | 'succeeded' | 'failed' | 'unknown'

export interface ManagementCommandRow {
  id: string
  principal_id: string
  channel: string
  idempotency_scope: string
  idempotency_key: string
  request_hash: string
  operation: string
  target_json: string
  arguments_json: string
  expected_revision: number
  before_revision: number | null
  after_revision: number | null
  status: ManagementCommandStatus
  result_json: string | null
  error_code: string | null
  error_message: string | null
  source_conversation: string | null
  source_message: string | null
  created_at: string
  updated_at: string
}

// #362: only the columns the owner search renders, so a row it returns can carry
// no `token_enc`, `platform_token_hash` or email.
export type SearchRepoRow = Pick<RepoRow, 'id' | 'owner' | 'name' | 'enabled'>
export type SearchJobRow = Pick<JobRow, 'id' | 'repo_id' | 'status' | 'kind' | 'goal' | 'summary' | 'error' | 'pr_url' | 'issue_url' | 'created_at'>
export type SearchWorkItemRow = Pick<WorkItemRow, 'id' | 'repo_id' | 'title' | 'state' | 'issue_url' | 'pr_url' | 'updated_at'>
export type SearchAuditRow = Pick<AuditRow, 'id' | 'at' | 'action' | 'detail'>

export interface OwnedSearchFilters {
  q: string
  repo: string
  kind: string
  status: string
  from: string
  to: string
}

export interface OwnedSearchSection<T> {
  rows: T[]
  capped: boolean
}

export interface OwnedSearch {
  repos: OwnedSearchSection<SearchRepoRow>
  jobs: OwnedSearchSection<SearchJobRow>
  workItems: OwnedSearchSection<SearchWorkItemRow>
  audit: OwnedSearchSection<SearchAuditRow>
}

// A LIKE pattern built from a person's text has to match that text: `%`, `_` and
// the escape character itself are escaped, and every clause that uses this also
// carries `ESCAPE '\'`.
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
}

function postmortemRepositories(value: string | null | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

export interface JobEventRow {
  id: number
  at: string
  job_id: string
  repo_id: string | null
  user_id: string | null
  kind: string
  role: string | null
  step: string | null
  meta: string | null
}

export interface JobContextRow {
  job_id: string
  repo_id: string
  commit_sha: string
  rules_json: string
  manifest_json: string
  created_at: string
}

export interface JobContextFileRow {
  job_id: string
  path: string
  sha256: string
  bytes: number
  content: string
}

export interface RepoRuleOverrideRow {
  repo_id: string
  path: string
  content: string
  revision: number
  updated_by: string
  updated_at: string
}

export interface PostmortemRow {
  id: string
  job_id: string
  repo_id: string
  user_id: string
  status: string
  category: string
  outcome: string
  recurrence_key: string
  evidence_state: string
  evidence_json: string | null
  timeline_json: string | null
  suspected_cause: string | null
  owner: string
  preventive_action: string | null
  preventive_kind: string | null
  preventive_verified: number
  preventive_verified_at: string | null
  first_seen_at: string
  last_seen_at: string
  closed_at: string | null
  created_at: string
  updated_at: string
}

export interface PostmortemRecurrenceRow {
  recurrence_key: string
  category: string
  count: number
  first_seen_at: string
  last_seen_at: string
  repositories_json: string
  escalated_at: string | null
  representative_id: string | null
  updated_at: string
}

export interface PostmortemRecord {
  postmortem: PostmortemRow
  recurrence: PostmortemRecurrenceRow
  created: boolean
  escalated: boolean
}

// #542: one row per failed Actions run on a repository's default branch, and
// the decision Fledge made about it. The first slice records the decision only —
// `queued` for a failure it will analyse later, `ignored` (with its reason) for
// a failure it deliberately will not triage — so "nothing happened" is a stored
// decision instead of silence. No log, model call or rerun is involved yet.
export type WorkflowFailureStatus = 'queued' | 'ignored'

export interface WorkflowFailureRow {
  id: string
  repo_id: string
  run_id: number
  attempt: number
  workflow_name: string
  head_sha: string
  head_branch: string
  event: string
  status: WorkflowFailureStatus
  reason: string | null
  run_url: string
  created_at: string
  updated_at: string
}

export interface ArtifactVersionRow {
  id: string
  artifact: string
  version: number
  hash: string
  content: string
  status: string
  evidence_json: string | null
  created_at: string
  promoted_at: string | null
  /** `unspecified` on rows written before ADR 0003's ledger columns existed. */
  kind: string
  scope: string
  repo_id: string | null
  /** The version this candidate was built on; null for a lineage root. */
  parent_id: string | null
  base_version: number | null
  frozen: number
  paths_json: string | null
}

export interface ArtifactPointerRow {
  artifact: string
  channel: string
  version_id: string
  updated_at: string
}

// A candidate write either lands or carries the reason it did not. Refusals are
// values, not exceptions: the caller writes the audit reason and answers the
// user, and a test can assert the pair without catching.
export type ArtifactWriteResult = { ok: true; row: ArtifactVersionRow } | { ok: false; refusal: CandidateRefusal }

export interface EvaluationRow {
  id: string
  artifact_id: string
  dataset: string
  metric: string
  value: number
  ci_low: number | null
  ci_high: number | null
  samples: number
  created_at: string
}

export interface PromotionRow {
  id: string
  artifact_id: string
  decision: string
  reason: string | null
  evidence_hash: string | null
  approved_by: string | null
  created_at: string
}

// #395: what an operator recorded about one environment. Fledge never runs the
// host deploy, so every field is a fact supplied by a person and kept as it was
// supplied; `gate_json` is the canary checklist that had to pass first.
export interface DeploymentRow {
  id: string
  environment: string
  version: string
  commit_sha: string
  image_digest: string
  deployed_at: string
  operator: string
  healthz_ok: number
  healthz_status: number | null
  healthz_version: string | null
  healthz_commit: string | null
  readyz_ok: number
  readyz_status: number | null
  release_url: string | null
  gate_json: string
  created_at: string
}

export interface DeploymentRollbackRow {
  id: string
  environment: string
  from_deployment_id: string | null
  previous_deployment_id: string
  previous_digest: string
  previous_commit: string
  owner: string
  command: string
  decision: string
  healthz_ok: number
  healthz_status: number | null
  healthz_commit: string | null
  verified: number
  created_at: string
}

export interface DeploymentInput {
  environment: string
  version: string
  commit: string
  imageDigest: string
  deployedAt: string
  operator: string
  healthz: { ok: boolean; status: number | null; version?: string | null; commit?: string | null }
  readyz: { ok: boolean; status: number | null }
  releaseUrl: string | null
  gate: unknown
}

export interface DeploymentRollbackInput {
  environment: string
  fromDeploymentId: string | null
  previousDeploymentId: string
  previousDigest: string
  previousCommit: string
  owner: string
  command: string
  decision: string
  healthz: { ok: boolean; status: number | null; commit?: string | null }
  verified: boolean
}

// #265: what the sweep may end. No address and no display name — the operator
// output is built from this, and it stays safe to paste into a terminal.
export interface TrialExpiryCandidate {
  id: string
  login: string
  created_at: string
}

// #279: one row per user for the read-only preview-trial view. `repo_added_at`
// and `expired_at` are audit lookups, not columns: the sweep owns the audit row,
// this view only reads it.
export interface TrialCandidate {
  id: string
  login: string
  created_at: string
  last_login_at: string | null
  status: string
  role: string
  repos: number
  repo_added_at: string | null
  expired_at: string | null
}

export interface AlertView {
  kind: string
  level: 'info' | 'warning' | 'critical'
  repoId?: string
  repoLabel?: string
  jobId?: string
  prUrl?: string
  minutes?: number
  hours?: number
  spentCny?: number
  budgetCny?: number
  state?: string
  message: string
}

// #539: a versioned project-memory entry. The row in `project_memories` is the
// current revision; every revision including the first lives in
// `project_memory_versions`, and no version row is ever updated in place.
// `audience` is `project` or `role:<id>` and is decided by the reader's
// repository role, never by an administrator's permission.
export interface ProjectMemoryRow {
  id: string
  repo_id: string
  key: string
  kind: string
  status: string
  verification: string
  audience: string
  scope: string
  body: string
  digest: string
  sources_json: string
  owner_type: string
  owner_id: string | null
  source_job_id: string | null
  revision: number
  created_at: string
  updated_at: string
}

export interface ProjectMemoryVersionRow {
  memory_id: string
  revision: number
  kind: string
  status: string
  verification: string
  audience: string
  scope: string
  body: string
  digest: string
  sources_json: string
  actor_type: string
  actor_id: string | null
  reason: string
  created_at: string
}

export interface MemoryWriteInput {
  repoId: string
  key: string
  kind: string
  status: string
  verification: string
  audience: string
  scope: string
  body: string
  digest: string
  sourcesJson: string
  actorType: string
  actorId: string | null
  sourceJobId: string | null
  reason: string
  // The revision the writer believed it was replacing. `0` means "create only":
  // an existing entry at the same key refuses the write instead of adopting it.
  expectedRevision: number
}

export type MemoryWriteResult =
  | { ok: true; created: boolean; noop: boolean; row: ProjectMemoryRow }
  | { ok: false; code: 'memory_revision_conflict' | 'memory_not_found'; current: ProjectMemoryRow | null; revision: number }

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
  email_job_success INTEGER NOT NULL DEFAULT 0,
  notify_email TEXT,
  github_token_enc TEXT,
  github_token_scopes TEXT,
  own_llm_base_url TEXT,
  own_llm_key_enc TEXT,
  own_llm_model TEXT,
  allow_private_models INTEGER NOT NULL DEFAULT 0,
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
  recent_auth_at TEXT,
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
  stage_mode TEXT NOT NULL DEFAULT 'off',
  models_dirty INTEGER NOT NULL DEFAULT 0,
  credential_state TEXT NOT NULL DEFAULT 'ok',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  monthly_budget_cny REAL NOT NULL DEFAULT 0,
  job_budget_cny REAL NOT NULL DEFAULT 0,
  job_budget_action TEXT NOT NULL DEFAULT 'alert',
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
  provider_allowlist TEXT NOT NULL DEFAULT '',
  required_region TEXT NOT NULL DEFAULT '',
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
  error_code TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  platform_token_hash TEXT,
  callback_hash TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'iterate',
  work_type TEXT NOT NULL DEFAULT 'iterate',
  triage_json TEXT,
  issue_url TEXT,
  pr_state TEXT,
  review_score INTEGER,
  attribution_json TEXT,
  evidence_json TEXT,
  checkpoint TEXT,
  team_stats_json TEXT,
  work_item_id TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  -- The position this job holds in its priority level (#545). Allocated once,
  -- monotonically, and never reused; 0 means a row that predates the column and
  -- has not been backfilled yet.
  queue_seq INTEGER NOT NULL DEFAULT 0,
  plan_approved_at TEXT,
  plan_approved_by TEXT,
  plan_rejected_at TEXT,
  plan_allow_paths TEXT,
  plan_deny_paths TEXT,
  base_sha TEXT,
  callback_fingerprint TEXT,
  path_guard_json TEXT,
  verification_json TEXT,
  continuity_json TEXT,
  model_json TEXT,
  provider_id TEXT,
  provider_label TEXT,
  provider_region TEXT,
  provider_model TEXT,
  output_kind TEXT,
  continuity_used INTEGER NOT NULL DEFAULT 0,
  owner_started INTEGER NOT NULL DEFAULT 0,
  retry_attempt INTEGER NOT NULL DEFAULT 0,
  retry_of TEXT,
  lease_owner TEXT,
  lease_until TEXT,
  callback_secret_enc TEXT,
  platform_token_enc TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  last_callback_at TEXT,
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
  repo_id TEXT,
  scope TEXT NOT NULL DEFAULT 'gateway',
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
  repo_id TEXT,
  cost_usd REAL NOT NULL,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS quota_ledger_user_idx ON quota_ledger(user_id, at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  code TEXT,
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
  closed_reason TEXT,
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

CREATE TABLE IF NOT EXISTS user_models (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  base_url TEXT NOT NULL,
  key_enc TEXT NOT NULL,
  model TEXT NOT NULL,
  allow_private INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS user_models_user_idx ON user_models(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS repo_models (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL REFERENCES user_models(id) ON DELETE CASCADE,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, model_id)
);

CREATE TABLE IF NOT EXISTS model_providers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  base_url TEXT NOT NULL,
  key_enc TEXT NOT NULL,
  allow_private INTEGER NOT NULL DEFAULT 0,
  region TEXT NOT NULL DEFAULT '',
  data_policy_url TEXT NOT NULL DEFAULT '',
  allowed INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS model_providers_user_idx ON model_providers(user_id, created_at ASC);

CREATE TABLE IF NOT EXISTS provider_models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES model_providers(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS provider_models_provider_idx ON provider_models(provider_id, created_at ASC);

CREATE TABLE IF NOT EXISTS repo_model_selection (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  provider_model_id TEXT NOT NULL REFERENCES provider_models(id) ON DELETE CASCADE,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, provider_model_id)
);

CREATE TABLE IF NOT EXISTS repo_bot_models (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  provider_model_id TEXT NOT NULL REFERENCES provider_models(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, role)
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  action TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  status TEXT NOT NULL DEFAULT 'processing',
  error TEXT,
  payload_json TEXT,
  repository_full_name TEXT,
  installation_id INTEGER
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_at_idx ON webhook_deliveries(received_at);
CREATE INDEX IF NOT EXISTS webhook_deliveries_status_idx ON webhook_deliveries(status, received_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  repo_id TEXT,
  user_id TEXT,
  kind TEXT NOT NULL,
  role TEXT,
  step TEXT,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS job_events_job_idx ON job_events(job_id, id DESC);
CREATE INDEX IF NOT EXISTS job_events_at_idx ON job_events(at);

CREATE TABLE IF NOT EXISTS job_contexts (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  rules_json TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_context_files (
  job_id TEXT NOT NULL REFERENCES job_contexts(job_id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY (job_id, path)
);

-- #538: a maintainer can override one of the three rule files from the console.
-- A repository file still wins; this row is the middle layer, and revision is
-- the fence a console write compares against.
CREATE TABLE IF NOT EXISTS repo_rule_overrides (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, path)
);

-- #384: one postmortem per failed/stalled/cancelled job, plus a ledger row per
-- recurrence key. The job_id unique constraint is the idempotency guard: a
-- replayed terminal transition cannot create a second write-up for the same job.
CREATE TABLE IF NOT EXISTS postmortems (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open',
  category TEXT NOT NULL,
  outcome TEXT NOT NULL,
  recurrence_key TEXT NOT NULL,
  evidence_state TEXT NOT NULL DEFAULT 'unverified',
  evidence_json TEXT,
  timeline_json TEXT,
  suspected_cause TEXT,
  owner TEXT NOT NULL,
  preventive_action TEXT,
  preventive_kind TEXT,
  preventive_verified INTEGER NOT NULL DEFAULT 0,
  preventive_verified_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS postmortems_repo_idx ON postmortems(repo_id, status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS postmortems_recurrence_idx ON postmortems(recurrence_key);

CREATE TABLE IF NOT EXISTS postmortem_recurrences (
  recurrence_key TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  repositories_json TEXT NOT NULL DEFAULT '[]',
  escalated_at TEXT,
  representative_id TEXT,
  updated_at TEXT NOT NULL
);

-- #542: intake keeps one row per failed run attempt, so a redelivered webhook or
-- a retried run cannot double-count. The reason column carries the intake
-- decision when Fledge chose not to triage the failure.
CREATE TABLE IF NOT EXISTS workflow_failures (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  run_id INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  workflow_name TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  head_branch TEXT NOT NULL,
  event TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  run_url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(repo_id, run_id, attempt)
);
CREATE INDEX IF NOT EXISTS workflow_failures_repo_idx ON workflow_failures(repo_id, created_at DESC);

CREATE TABLE IF NOT EXISTS artifact_versions (
  id TEXT PRIMARY KEY,
  artifact TEXT NOT NULL,
  version INTEGER NOT NULL,
  hash TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate',
  evidence_json TEXT,
  created_at TEXT NOT NULL,
  promoted_at TEXT,
  kind TEXT NOT NULL DEFAULT 'unspecified',
  scope TEXT NOT NULL DEFAULT 'global',
  repo_id TEXT,
  parent_id TEXT,
  base_version INTEGER,
  frozen INTEGER NOT NULL DEFAULT 0,
  paths_json TEXT,
  UNIQUE(artifact, version)
);
CREATE INDEX IF NOT EXISTS artifact_versions_artifact_idx ON artifact_versions(artifact, version DESC);

-- ADR 0003's ledger pointers: one row per artifact and channel, so "what is dev
-- right now" is a row rather than a scan, and a compare-and-swap has something
-- concrete to compare against. A version row is immutable; a pointer moves.
CREATE TABLE IF NOT EXISTS artifact_pointers (
  artifact TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('dev', 'stable')),
  version_id TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (artifact, channel)
);

CREATE TABLE IF NOT EXISTS evaluations (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE CASCADE,
  dataset TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  ci_low REAL,
  ci_high REAL,
  samples INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS evaluations_artifact_idx ON evaluations(artifact_id, created_at DESC);

CREATE TABLE IF NOT EXISTS promotions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE CASCADE,
  decision TEXT NOT NULL,
  reason TEXT,
  evidence_hash TEXT,
  approved_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS promotions_artifact_idx ON promotions(artifact_id, created_at DESC);

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  version TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  image_digest TEXT NOT NULL,
  deployed_at TEXT NOT NULL,
  operator TEXT NOT NULL,
  healthz_ok INTEGER NOT NULL,
  healthz_status INTEGER,
  healthz_version TEXT,
  healthz_commit TEXT,
  readyz_ok INTEGER NOT NULL,
  readyz_status INTEGER,
  release_url TEXT,
  gate_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deployments_env_idx ON deployments(environment, created_at DESC);

CREATE TABLE IF NOT EXISTS deployment_rollbacks (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  from_deployment_id TEXT REFERENCES deployments(id) ON DELETE SET NULL,
  previous_deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  previous_digest TEXT NOT NULL,
  previous_commit TEXT NOT NULL,
  owner TEXT NOT NULL,
  command TEXT NOT NULL,
  decision TEXT NOT NULL,
  healthz_ok INTEGER NOT NULL,
  healthz_status INTEGER,
  healthz_commit TEXT,
  verified INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deployment_rollbacks_env_idx ON deployment_rollbacks(environment, created_at DESC);

CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS audit_log_user_idx ON audit_log(user_id, id DESC);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log(at);
CREATE INDEX IF NOT EXISTS repos_installation_idx ON repos(installation_id);
CREATE INDEX IF NOT EXISTS repos_auto_idx ON repos(enabled, auto_iterate);
CREATE INDEX IF NOT EXISTS repos_review_idx ON repos(enabled, reviewer_enabled, can_review, repo_role);
CREATE INDEX IF NOT EXISTS jobs_user_pr_idx ON jobs(user_id, pr_url);
CREATE INDEX IF NOT EXISTS jobs_created_idx ON jobs(created_at);
CREATE INDEX IF NOT EXISTS events_at_idx ON events(at);
CREATE INDEX IF NOT EXISTS quota_ledger_at_idx ON quota_ledger(at);
CREATE INDEX IF NOT EXISTS work_items_merged_idx ON work_items(merged_at);

-- #540: the management contract's two durable pieces. A receipt records one
-- command (what was asked, by whom, under which key, against which revision, and
-- what happened); a revision row is the fence a command compares against, so a
-- page rendered before someone else's write is refused instead of applied. Both
-- are additive, so the version bump is a refusal boundary, not a backfill.
CREATE TABLE IF NOT EXISTS resource_revisions (
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (resource_type, resource_id)
);

CREATE TABLE IF NOT EXISTS management_commands (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  idempotency_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  operation TEXT NOT NULL,
  target_json TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  expected_revision INTEGER NOT NULL,
  before_revision INTEGER,
  after_revision INTEGER,
  status TEXT NOT NULL,
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  source_conversation TEXT,
  source_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(idempotency_scope, idempotency_key)
);
CREATE INDEX IF NOT EXISTS management_commands_principal_idx ON management_commands(principal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS management_commands_status_idx ON management_commands(status, created_at DESC);

CREATE TABLE IF NOT EXISTS project_memories (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  verification TEXT NOT NULL,
  audience TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  digest TEXT NOT NULL,
  sources_json TEXT NOT NULL DEFAULT '[]',
  owner_type TEXT NOT NULL,
  owner_id TEXT,
  source_job_id TEXT,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(repo_id, key)
);
CREATE INDEX IF NOT EXISTS project_memories_repo_idx ON project_memories(repo_id, audience, updated_at DESC);

CREATE TABLE IF NOT EXISTS project_memory_versions (
  memory_id TEXT NOT NULL REFERENCES project_memories(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  verification TEXT NOT NULL,
  audience TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  digest TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, revision)
);
`

function clean(params: unknown[]): unknown[] {
  return params.map((value) => (value === undefined ? null : value))
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

function durationMs(start: string | null, end: string | null): number | null {
  if (start === null || end === null) return null
  const a = Date.parse(start)
  const b = Date.parse(end)
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null
}

// One definition of "newest job" for a pull request. created_at is a
// millisecond string, so two rows for the same PR can tie; rowid is the only
// stable tie-break, and both callers must order the same way.
function newestJobOrder(alias: string): string {
  return `${alias}.created_at DESC, ${alias}.rowid DESC`
}

// #458: `summary` and `error` are the two free-text columns a runner can echo a
// secret into. Both writers pass through this one helper, so a caller that skips
// the job service (a retry, a test, a future runner) cannot store a raw value.
function redactJobText(patch: Record<string, unknown>): Record<string, unknown> {
  if (typeof patch.summary !== 'string' && typeof patch.error !== 'string') return patch
  return {
    ...patch,
    ...(typeof patch.summary === 'string' ? { summary: redact(patch.summary) } : {}),
    ...(typeof patch.error === 'string' ? { error: redact(patch.error) } : {}),
  }
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
    if (previousVersion > 35) {
      this.db.close()
      throw new Error(`database schema version ${previousVersion} is newer than this build supports (35)`)
    }
    this.db.exec(SCHEMA)
    this.migrateColumns()
    this.migrateRepoColumns()
    this.migrateProviderColumns()
    this.migrateWebhookColumns()
    this.migrateArtifactColumns()
    this.migrateIndexes()
    this.backfillTokenRepoIds()
    this.migrateModelsV2()
    this.run("UPDATE repos SET job_mode = 'iterate' WHERE job_mode != 'iterate'")
    if (previousVersion < 15) {
      this.run("UPDATE repos SET repo_role = CASE WHEN permission IN ('admin', 'maintain') THEN 'maintainer' ELSE 'developer' END WHERE repo_role IS NULL")
    }
    if (previousVersion < 16) {
      this.run('UPDATE repos SET role_checked_at = ? WHERE repo_role IS NOT NULL AND role_checked_at IS NULL', nowIso())
    }
    this.db.exec(`PRAGMA user_version = ${Math.max(previousVersion, 35)};`)
  }

  migrateIndexes(): void {
    this.run('CREATE INDEX IF NOT EXISTS quota_ledger_repo_idx ON quota_ledger(repo_id, at DESC)')
    this.run('CREATE INDEX IF NOT EXISTS jobs_pr_state_idx ON jobs(pr_state, created_at DESC)')
    this.ensureOneActiveJobIndex()
  }

  // The unique index below is created in the constructor, so a database written
  // before it existed cannot be left holding two queued/running rows for one
  // repository: the DDL would throw and the process would never boot. Resolve
  // those rows deterministically instead. Rule: keep a running job (never fail a
  // job that is executing; the newest one if several are), otherwise keep the
  // oldest queued job, and fail every other active row with a stated reason and
  // one audit line.
  private ensureOneActiveJobIndex(): void {
    const ddl = "CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active_per_repo ON jobs(repo_id) WHERE status IN ('queued','running')"
    try {
      this.run(ddl)
      return
    } catch (error) {
      if (!/UNIQUE constraint failed/i.test(String(error))) throw error
    }
    try {
      this.transaction(() => {
        this.resolveDuplicateActiveJobs()
        this.run(ddl)
      })
    } catch (error) {
      const offenders = this.all<{ repo_id: string }>("SELECT repo_id FROM jobs WHERE status IN ('queued','running') GROUP BY repo_id HAVING COUNT(*) > 1").map((row) => row.repo_id)
      throw new Error(`cannot enforce one active job per repository; still duplicated: ${offenders.join(', ') || 'unknown'} (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  private resolveDuplicateActiveJobs(): void {
    const duplicateRepos = this.all<{ repo_id: string }>("SELECT repo_id FROM jobs WHERE status IN ('queued','running') GROUP BY repo_id HAVING COUNT(*) > 1")
    for (const { repo_id: repoId } of duplicateRepos) {
      const running = this.all<{ id: string; user_id: string; work_item_id: string | null }>("SELECT id, user_id, work_item_id FROM jobs WHERE repo_id = ? AND status = 'running' ORDER BY created_at DESC, rowid DESC", repoId)
      const queued = this.all<{ id: string; user_id: string; work_item_id: string | null }>("SELECT id, user_id, work_item_id FROM jobs WHERE repo_id = ? AND status = 'queued' ORDER BY created_at ASC, rowid ASC", repoId)
      const demoted = running.length > 0 ? [...running.slice(1), ...queued] : queued.slice(1)
      for (const row of demoted) {
        this.run("UPDATE jobs SET status = 'failed', error = 'JOB_DUPLICATE_ACTIVE_SUPERSEDED', finished_at = ? WHERE id = ?", nowIso(), row.id)
        const workItemId = row.work_item_id
        if (workItemId !== null) this.resetSupersededWorkItem(workItemId)
        this.audit(row.user_id, 'job.duplicate_active_superseded', workItemId === null ? `${row.id}: ${repoId}` : `${row.id}: ${repoId} item=${workItemId}`)
      }
    }
  }

  // The item a failed duplicate was running has to leave `in_progress`: nothing
  // will ever move it, so the board would show work that cannot progress. The
  // reset goes through the published map (`in_progress -> triaged` is already an
  // edge), so it needs no new transition and no schema change; the item simply
  // asks for a new dispatch decision.
  private resetSupersededWorkItem(workItemId: string): void {
    const item = this.getWorkItem(workItemId)
    if (item === undefined) return
    const allowed = WORK_ITEM_TRANSITIONS[item.state as WorkItemState] ?? []
    if (!allowed.includes('triaged')) return
    this.updateWorkItem(workItemId, { state: 'triaged' })
  }

  backfillTokenRepoIds(): void {
    this.run("UPDATE api_tokens SET repo_id = substr(name, 8) WHERE kind = 'instance' AND name LIKE 'flybot:%' AND repo_id IS NULL")
    this.run("UPDATE api_tokens SET repo_id = (SELECT repo_id FROM jobs WHERE jobs.id = substr(api_tokens.name, 5)) WHERE kind = 'job' AND name LIKE 'job:%' AND repo_id IS NULL")
  }

  migrateModelsV2(): void {
    if (this.getSetting('models_v2') !== undefined) return
    this.transaction(() => {
      for (const row of this.all<UserModelRow>('SELECT * FROM user_models')) {
        const providerId = `prv_${row.id}`
        this.run('INSERT OR IGNORE INTO model_providers (id, user_id, label, base_url, key_enc, allow_private, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', providerId, row.user_id, row.label, row.base_url, row.key_enc, row.allow_private, row.created_at, row.updated_at)
        this.run('INSERT OR IGNORE INTO provider_models (id, provider_id, model, label, created_at) VALUES (?, ?, ?, ?, ?)', row.id, providerId, row.model, row.label, row.created_at)
      }
      this.run("INSERT OR IGNORE INTO repo_model_selection (repo_id, provider_model_id, is_default, created_at) SELECT repo_id, model_id, is_default, ? FROM repo_models WHERE model_id IN (SELECT id FROM provider_models)", nowIso())
      for (const user of this.all<UserRow>("SELECT * FROM users WHERE own_llm_base_url IS NOT NULL AND own_llm_base_url != '' AND own_llm_key_enc IS NOT NULL")) {
        const providerId = `prv_legacy_${user.id}`
        const modelId = `pvm_legacy_${user.id}`
        const model = user.own_llm_model ?? 'default'
        this.run('INSERT OR IGNORE INTO model_providers (id, user_id, label, base_url, key_enc, allow_private, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)', providerId, user.id, '默认', user.own_llm_base_url, user.own_llm_key_enc, nowIso(), nowIso())
        this.run('INSERT OR IGNORE INTO provider_models (id, provider_id, model, label, created_at) VALUES (?, ?, ?, ?, ?)', modelId, providerId, model, model, nowIso())
      }
      this.setSetting('models_v2', nowIso())
    })
  }

  private migrateWebhookColumns(): void {
    const columns = new Set(this.all<{ name: string }>('PRAGMA table_info(webhook_deliveries)').map((row) => row.name))
    const additions: Array<[string, string]> = [
      ['payload_json', 'TEXT'],
      ['repository_full_name', 'TEXT'],
      ['installation_id', 'INTEGER'],
    ]
    for (const [name, type] of additions) {
      if (!columns.has(name)) this.run(`ALTER TABLE webhook_deliveries ADD COLUMN ${name} ${type}`)
    }
  }

  // ADR 0003 (`#424`): the ledger columns are added to the table that already
  // holds versions, so existing rows keep their evidence and their foreign keys.
  // `kind = 'unspecified'` is the honest value for a row written before the
  // evolvable set existed; it is not silently claimed to be an evolvable kind.
  private migrateArtifactColumns(): void {
    const columns = new Set(this.all<{ name: string }>('PRAGMA table_info(artifact_versions)').map((row) => row.name))
    const additions: Array<[string, string]> = [
      ['kind', "TEXT NOT NULL DEFAULT 'unspecified'"],
      ['scope', "TEXT NOT NULL DEFAULT 'global'"],
      ['repo_id', 'TEXT'],
      ['parent_id', 'TEXT'],
      ['base_version', 'INTEGER'],
      ['frozen', 'INTEGER NOT NULL DEFAULT 0'],
      ['paths_json', 'TEXT'],
    ]
    for (const [name, type] of additions) {
      if (!columns.has(name)) this.run(`ALTER TABLE artifact_versions ADD COLUMN ${name} ${type}`)
    }
    // A promoted row written before the pointer table existed becomes the
    // `stable` pointer, so "what is stable now" has one answer after boot.
    // One row per artifact, not one row for the table: a table with two
    // promoted artifacts has two stable pointers to fill, and a migration is
    // write-once, so a second boot must not be the thing that would have fixed
    // it (#494 finding 3).
    const promoted = this.all<{ id: string; artifact: string; promoted_at: string | null }>(
      `SELECT v.id, v.artifact, v.promoted_at
         FROM artifact_versions v
        WHERE v.status = 'promoted'
          AND v.rowid = (
            SELECT v2.rowid
              FROM artifact_versions v2
             WHERE v2.artifact = v.artifact AND v2.status = 'promoted'
             ORDER BY v2.version DESC, v2.rowid DESC
             LIMIT 1
          )
        ORDER BY v.artifact`,
    )
    for (const row of promoted) {
      const pointer = this.get<{ version_id: string }>(
        "SELECT version_id FROM artifact_pointers WHERE artifact = ? AND channel = 'stable'",
        row.artifact,
      )
      if (pointer !== undefined) continue
      this.run(
        "INSERT OR REPLACE INTO artifact_pointers (artifact, channel, version_id, updated_at) VALUES (?, 'stable', ?, ?)",
        row.artifact,
        row.id,
        // A row can carry status `promoted` without a timestamp: `promoted_at`
        // is only written by `promoteArtifactVersion`. The pointer needs a
        // value, and the honest one is the moment this migration ran.
        row.promoted_at ?? nowIso(),
      )
    }
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
      ['email_job_success', 'INTEGER NOT NULL DEFAULT 0'],
      ['notify_email', 'TEXT'],
      ['allow_private_models', 'INTEGER NOT NULL DEFAULT 0'],
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
      ['stage_mode', "TEXT NOT NULL DEFAULT 'off'"],
      ['models_dirty', 'INTEGER NOT NULL DEFAULT 0'],
      ['credential_state', "TEXT NOT NULL DEFAULT 'ok'"],
      ['consecutive_failures', 'INTEGER NOT NULL DEFAULT 0'],
      ['monthly_budget_cny', 'REAL NOT NULL DEFAULT 0'],
      ['job_budget_cny', 'REAL NOT NULL DEFAULT 0'],
      ['job_budget_action', "TEXT NOT NULL DEFAULT 'alert'"],
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
      ['provider_allowlist', "TEXT NOT NULL DEFAULT ''"],
      ['required_region', "TEXT NOT NULL DEFAULT ''"],
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
    const sessionColumns = new Set(this.all<{ name: string }>('PRAGMA table_info(sessions)').map((row) => row.name))
    if (!sessionColumns.has('recent_auth_at')) this.run('ALTER TABLE sessions ADD COLUMN recent_auth_at TEXT')
    const jobColumns = new Set(this.all<{ name: string }>('PRAGMA table_info(jobs)').map((row) => row.name))
    if (!jobColumns.has('kind')) this.run("ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'iterate'")
    if (!jobColumns.has('work_type')) this.run("ALTER TABLE jobs ADD COLUMN work_type TEXT NOT NULL DEFAULT 'iterate'")
    if (!jobColumns.has('triage_json')) this.run('ALTER TABLE jobs ADD COLUMN triage_json TEXT')
    if (!jobColumns.has('issue_url')) this.run('ALTER TABLE jobs ADD COLUMN issue_url TEXT')
    if (!jobColumns.has('review_score')) this.run('ALTER TABLE jobs ADD COLUMN review_score INTEGER')
    if (!jobColumns.has('attribution_json')) this.run('ALTER TABLE jobs ADD COLUMN attribution_json TEXT')
    if (!jobColumns.has('evidence_json')) this.run('ALTER TABLE jobs ADD COLUMN evidence_json TEXT')
    if (!jobColumns.has('checkpoint')) this.run('ALTER TABLE jobs ADD COLUMN checkpoint TEXT')
    if (!jobColumns.has('team_stats_json')) this.run('ALTER TABLE jobs ADD COLUMN team_stats_json TEXT')
    if (!jobColumns.has('work_item_id')) this.run('ALTER TABLE jobs ADD COLUMN work_item_id TEXT')
    if (!jobColumns.has('priority')) this.run('ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0')
    if (!jobColumns.has('queue_seq')) this.run('ALTER TABLE jobs ADD COLUMN queue_seq INTEGER NOT NULL DEFAULT 0')
    // Backfill the ticket in arrival order, which is the order those rows were
    // ranked by before the column existed, so an upgrade does not reshuffle a
    // queue that is already waiting.
    const unticketed = this.all<{ id: string }>('SELECT id FROM jobs WHERE queue_seq = 0 ORDER BY created_at ASC, id ASC')
    if (unticketed.length > 0) {
      let seq = Number(this.get<{ seq: number }>('SELECT COALESCE(MAX(queue_seq), 0) AS seq FROM jobs')?.seq ?? 0)
      for (const row of unticketed) {
        seq += 1
        this.run('UPDATE jobs SET queue_seq = ? WHERE id = ?', seq, row.id)
      }
    }
    if (!jobColumns.has('plan_approved_at')) this.run('ALTER TABLE jobs ADD COLUMN plan_approved_at TEXT')
    if (!jobColumns.has('plan_approved_by')) this.run('ALTER TABLE jobs ADD COLUMN plan_approved_by TEXT')
    if (!jobColumns.has('plan_rejected_at')) this.run('ALTER TABLE jobs ADD COLUMN plan_rejected_at TEXT')
    if (!jobColumns.has('plan_allow_paths')) this.run('ALTER TABLE jobs ADD COLUMN plan_allow_paths TEXT')
    if (!jobColumns.has('plan_deny_paths')) this.run('ALTER TABLE jobs ADD COLUMN plan_deny_paths TEXT')
    if (!jobColumns.has('base_sha')) this.run('ALTER TABLE jobs ADD COLUMN base_sha TEXT')
    if (!jobColumns.has('callback_fingerprint')) this.run('ALTER TABLE jobs ADD COLUMN callback_fingerprint TEXT')
    if (!jobColumns.has('path_guard_json')) this.run('ALTER TABLE jobs ADD COLUMN path_guard_json TEXT')
    if (!jobColumns.has('verification_json')) this.run('ALTER TABLE jobs ADD COLUMN verification_json TEXT')
    if (!jobColumns.has('continuity_json')) this.run('ALTER TABLE jobs ADD COLUMN continuity_json TEXT')
    if (!jobColumns.has('output_kind')) this.run('ALTER TABLE jobs ADD COLUMN output_kind TEXT')
    if (!jobColumns.has('continuity_used')) this.run('ALTER TABLE jobs ADD COLUMN continuity_used INTEGER NOT NULL DEFAULT 0')
    if (!jobColumns.has('owner_started')) this.run('ALTER TABLE jobs ADD COLUMN owner_started INTEGER NOT NULL DEFAULT 0')
    if (!jobColumns.has('model_json')) this.run('ALTER TABLE jobs ADD COLUMN model_json TEXT')
    if (!jobColumns.has('provider_id')) this.run('ALTER TABLE jobs ADD COLUMN provider_id TEXT')
    if (!jobColumns.has('provider_label')) this.run('ALTER TABLE jobs ADD COLUMN provider_label TEXT')
    if (!jobColumns.has('provider_region')) this.run('ALTER TABLE jobs ADD COLUMN provider_region TEXT')
    if (!jobColumns.has('provider_model')) this.run('ALTER TABLE jobs ADD COLUMN provider_model TEXT')
    if (!jobColumns.has('retry_attempt')) this.run('ALTER TABLE jobs ADD COLUMN retry_attempt INTEGER NOT NULL DEFAULT 0')
    if (!jobColumns.has('retry_of')) this.run('ALTER TABLE jobs ADD COLUMN retry_of TEXT')
    if (!jobColumns.has('last_callback_at')) this.run('ALTER TABLE jobs ADD COLUMN last_callback_at TEXT')
    if (!jobColumns.has('pr_state')) this.run('ALTER TABLE jobs ADD COLUMN pr_state TEXT')
    if (!jobColumns.has('lease_owner')) this.run('ALTER TABLE jobs ADD COLUMN lease_owner TEXT')
    if (!jobColumns.has('lease_until')) this.run('ALTER TABLE jobs ADD COLUMN lease_until TEXT')
    if (!jobColumns.has('callback_secret_enc')) this.run('ALTER TABLE jobs ADD COLUMN callback_secret_enc TEXT')
    if (!jobColumns.has('platform_token_enc')) this.run('ALTER TABLE jobs ADD COLUMN platform_token_enc TEXT')
    if (!jobColumns.has('error_code')) this.run('ALTER TABLE jobs ADD COLUMN error_code TEXT')
    // #359: additive on purpose; every existing row backfills as NULL, which is
    // exactly "no recorded reason", so no close that happened earlier is read as
    // a plan expiry.
    const workItemColumns = new Set(this.all<{ name: string }>('PRAGMA table_info(work_items)').map((row) => row.name))
    if (!workItemColumns.has('closed_reason')) this.run('ALTER TABLE work_items ADD COLUMN closed_reason TEXT')
    const notificationColumns = new Set(this.all<{ name: string }>('PRAGMA table_info(notifications)').map((row) => row.name))
    if (!notificationColumns.has('code')) this.run('ALTER TABLE notifications ADD COLUMN code TEXT')
    const tokenColumns = new Set(this.all<{ name: string }>('PRAGMA table_info(api_tokens)').map((row) => row.name))
    if (!tokenColumns.has('repo_id')) this.run('ALTER TABLE api_tokens ADD COLUMN repo_id TEXT')
    // #355: the column is additive with a default, so existing rows are
    // `gateway` without a second pass; the UPDATE also repairs a row that a
    // partial upgrade left empty.
    if (!tokenColumns.has('scope')) this.run("ALTER TABLE api_tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'gateway'")
    this.run("UPDATE api_tokens SET scope = 'gateway' WHERE scope IS NULL OR scope = ''")
    // A personal token minted before this change has no expiry and would live
    // forever. Give each one a fresh finite window from the upgrade, once, so no
    // token in use dies at the moment of the upgrade. Job and instance tokens
    // keep the expiry their own lifecycle sets.
    if (this.getSetting(PAT_EXPIRY_BACKFILL_KEY) === undefined) {
      this.run(
        "UPDATE api_tokens SET expires_at = ? WHERE kind = 'pat' AND expires_at IS NULL AND revoked_at IS NULL",
        new Date(Date.now() + DEFAULT_PAT_EXPIRY_DAYS * 86_400_000).toISOString(),
      )
      this.setSetting(PAT_EXPIRY_BACKFILL_KEY, nowIso())
    }
    const ledgerColumns = new Set(this.all<{ name: string }>('PRAGMA table_info(quota_ledger)').map((row) => row.name))
    if (!ledgerColumns.has('repo_id')) this.run('ALTER TABLE quota_ledger ADD COLUMN repo_id TEXT')
    if (!jobColumns.has('base_branch')) this.run('ALTER TABLE jobs ADD COLUMN base_branch TEXT')
    this.run("UPDATE jobs SET base_branch = (SELECT upstream_default_branch FROM repos WHERE repos.id = jobs.repo_id) WHERE base_branch IS NULL")
  }

  private migrateProviderColumns(): void {
    const columns = new Set(this.all<{ name: string }>('PRAGMA table_info(model_providers)').map((row) => row.name))
    const additions: Array<[string, string]> = [
      ['region', "TEXT NOT NULL DEFAULT ''"],
      ['data_policy_url', "TEXT NOT NULL DEFAULT ''"],
      ['allowed', 'INTEGER NOT NULL DEFAULT 1'],
    ]
    for (const [name, type] of additions) {
      if (!columns.has(name)) this.run(`ALTER TABLE model_providers ADD COLUMN ${name} ${type}`)
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

  // The newest failed approval-mail attempt per user. The admin page compares it
  // with users.approval_sent_at, which only a successful send sets, so a later
  // successful send clears the marker without rewriting the audit history.
  approvalMailFailures(): Map<string, string> {
    const rows = this.all<{ user_id: string | null; at: string }>(
      "SELECT user_id, MAX(at) AS at FROM audit_log WHERE action = 'approval.mail_failed' AND user_id IS NOT NULL GROUP BY user_id",
    )
    return new Map(rows.filter((row) => row.user_id !== null).map((row) => [row.user_id as string, row.at]))
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

  // #279: the preview-trial sweep (#265) writes a `trial.expired` audit row, and
  // the admin console had no read path for it. One query, because the view needs
  // the same three counts for every user and a per-row loop would be N+1.
  trialCandidates(): TrialCandidate[] {
    return this.all<TrialCandidate>(
      `SELECT u.id, u.login, u.created_at, u.last_login_at, u.status, u.role,
              (SELECT COUNT(*) FROM repos r WHERE r.user_id = u.id) AS repos,
              (SELECT MAX(a.at) FROM audit_log a WHERE a.user_id = u.id AND a.action = 'repo.added') AS repo_added_at,
              (SELECT MAX(a.at) FROM audit_log a WHERE a.user_id = u.id AND a.action = 'trial.expired') AS expired_at
         FROM users u
        ORDER BY u.created_at ASC`,
    )
  }

  // #265: the sweep's own selection, one query so eligibility cannot drift from
  // the console's rule (`src/lib/trials.ts`). `trial.expired` in the audit log is
  // the idempotency record, so an account that already carries one is never
  // offered again, and an account whose status is written back to approved by
  // hand is still skipped.
  trialExpiryCandidates(cutoffIso: string, login?: string): TrialExpiryCandidate[] {
    const filter = login === undefined ? '' : ' AND u.login = ?'
    const args: unknown[] = login === undefined ? [cutoffIso] : [cutoffIso, login]
    return this.all<TrialExpiryCandidate>(
      `SELECT u.id, u.login, u.created_at
         FROM users u
        WHERE u.status = 'approved'
          AND u.role = 'user'
          AND u.created_at <= ?
          AND NOT EXISTS (SELECT 1 FROM repos r WHERE r.user_id = u.id)
          AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.user_id = u.id AND a.action = 'repo.added')
          AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.user_id = u.id AND a.action = 'trial.expired')
          AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.user_id = u.id)${filter}
        ORDER BY u.created_at ASC`,
      ...args,
    )
  }

  userActivity(id: string): { repos: number; jobs: number; lastJobAt: string | null } {    const row = this.get<{ repos: number; jobs: number; last_job_at: string | null }>(
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

  setEmailJobSuccess(id: string, enabled: boolean): void {
    this.run('UPDATE users SET email_job_success = ? WHERE id = ?', enabled ? 1 : 0, id)
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

  recordJobEvent(input: {
    jobId: string
    repoId?: string | null
    userId?: string | null
    kind: string
    role?: string | null
    step?: string | null
    meta?: string | null
    at?: string
  }): void {
    this.run(
      'INSERT INTO job_events (at, job_id, repo_id, user_id, kind, role, step, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      input.at ?? nowIso(),
      input.jobId,
      input.repoId ?? null,
      input.userId ?? null,
      input.kind,
      input.role ?? null,
      input.step ?? null,
      input.meta === undefined || input.meta === null ? null : input.meta.slice(0, 4000),
    )
  }

  listJobEvents(jobId: string, limit = 200): JobEventRow[] {
    return this.all<JobEventRow>('SELECT * FROM job_events WHERE job_id = ? ORDER BY id DESC LIMIT ?', jobId, limit)
  }

  getPostmortem(id: string): PostmortemRow | undefined {
    return this.get<PostmortemRow>('SELECT * FROM postmortems WHERE id = ?', id)
  }

  getPostmortemForJob(jobId: string): PostmortemRow | undefined {
    return this.get<PostmortemRow>('SELECT * FROM postmortems WHERE job_id = ?', jobId)
  }

  getPostmortemRecurrence(recurrenceKey: string): PostmortemRecurrenceRow | undefined {
    return this.get<PostmortemRecurrenceRow>('SELECT * FROM postmortem_recurrences WHERE recurrence_key = ?', recurrenceKey)
  }

  listPostmortemsForRepo(repoId: string, options: { openOnly?: boolean } = {}): PostmortemRow[] {
    const openClause = options.openOnly === true ? " AND status = 'open'" : ''
    return this.all<PostmortemRow>(`SELECT * FROM postmortems WHERE repo_id = ?${openClause} ORDER BY last_seen_at DESC, rowid DESC`, repoId)
  }

  listPostmortemRecurrences(repoId?: string): PostmortemRecurrenceRow[] {
    if (repoId === undefined) {
      return this.all<PostmortemRecurrenceRow>('SELECT * FROM postmortem_recurrences ORDER BY last_seen_at DESC')
    }
    return this.all<PostmortemRecurrenceRow>(
      `SELECT * FROM postmortem_recurrences
        WHERE recurrence_key IN (SELECT recurrence_key FROM postmortems WHERE repo_id = ?)
        ORDER BY last_seen_at DESC`,
      repoId,
    )
  }

  // #542: intake only. The insert conflicts on (repo, run, attempt) so a
  // redelivered webhook or a restarted process cannot record the same failure
  // twice; `created` says whether this delivery was the first to see it.
  recordWorkflowFailure(input: {
    id: string
    repoId: string
    runId: number
    attempt: number
    workflowName: string
    headSha: string
    headBranch: string
    event: string
    status: WorkflowFailureStatus
    reason: string | null
    runUrl: string
  }): { row: WorkflowFailureRow; created: boolean } {
    const at = nowIso()
    this.run(
      `INSERT INTO workflow_failures (id, repo_id, run_id, attempt, workflow_name, head_sha, head_branch, event, status, reason, run_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_id, run_id, attempt) DO NOTHING`,
      input.id, input.repoId, input.runId, input.attempt, input.workflowName, input.headSha,
      input.headBranch, input.event, input.status, input.reason, input.runUrl, at, at,
    )
    const row = this.get<WorkflowFailureRow>(
      'SELECT * FROM workflow_failures WHERE repo_id = ? AND run_id = ? AND attempt = ?',
      input.repoId, input.runId, input.attempt,
    )
    // `created` is whether the row carries the id this call tried to insert; a
    // lost race selects the winner's row instead of claiming a second write.
    return { row: row as WorkflowFailureRow, created: row?.id === input.id }
  }

  listWorkflowFailuresForRepo(repoId: string, limit = 10): WorkflowFailureRow[] {
    return this.all<WorkflowFailureRow>(
      'SELECT * FROM workflow_failures WHERE repo_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
      repoId, limit,
    )
  }

  getWorkflowFailure(id: string): WorkflowFailureRow | undefined {
    return this.get<WorkflowFailureRow>('SELECT * FROM workflow_failures WHERE id = ?', id)
  }

  // #539: the project-memory store. Every write goes through the revision fence
  // in `writeMemory`; reads are plain selects so a caller can apply the audience
  // rule (`audienceVisible`) before it shows anything.
  listMemoriesForRepo(repoId: string): ProjectMemoryRow[] {
    return this.all<ProjectMemoryRow>(
      'SELECT * FROM project_memories WHERE repo_id = ? ORDER BY updated_at DESC, rowid DESC',
      repoId,
    )
  }

  getMemory(repoId: string, key: string): ProjectMemoryRow | undefined {
    return this.get<ProjectMemoryRow>('SELECT * FROM project_memories WHERE repo_id = ? AND key = ?', repoId, key)
  }

  getMemoryVersion(memoryId: string, revision: number): ProjectMemoryVersionRow | undefined {
    return this.get<ProjectMemoryVersionRow>(
      'SELECT * FROM project_memory_versions WHERE memory_id = ? AND revision = ?',
      memoryId,
      revision,
    )
  }

  listMemoryVersions(memoryId: string): ProjectMemoryVersionRow[] {
    return this.all<ProjectMemoryVersionRow>(
      'SELECT * FROM project_memory_versions WHERE memory_id = ? ORDER BY revision DESC',
      memoryId,
    )
  }

  writeMemory(input: MemoryWriteInput): MemoryWriteResult {
    const at = nowIso()
    return this.transaction<MemoryWriteResult>(() => {
      const current = this.getMemory(input.repoId, input.key)
      if (current === undefined) {
        if (input.expectedRevision !== 0) {
          return { ok: false, code: 'memory_not_found', current: null, revision: 0 }
        }
        const id = `mem_${randomBytes(8).toString('hex')}`
        this.run(
          `INSERT INTO project_memories
            (id, repo_id, key, kind, status, verification, audience, scope, body, digest, sources_json,
             owner_type, owner_id, source_job_id, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          id,
          input.repoId,
          input.key,
          input.kind,
          input.status,
          input.verification,
          input.audience,
          input.scope,
          input.body,
          input.digest,
          input.sourcesJson,
          input.actorType,
          input.actorId,
          input.sourceJobId,
          at,
          at,
        )
        this.insertMemoryVersion(id, 1, input, at)
        const row = this.getMemory(input.repoId, input.key)
        if (row === undefined) throw new Error('memory entry disappeared inside its own insert')
        return { ok: true, created: true, noop: false, row }
      }
      // A stale writer is refused by name and the current entry is untouched.
      if (current.revision !== input.expectedRevision) {
        return { ok: false, code: 'memory_revision_conflict', current, revision: current.revision }
      }
      const unchanged =
        current.kind === input.kind &&
        current.status === input.status &&
        current.verification === input.verification &&
        current.audience === input.audience &&
        current.scope === input.scope &&
        current.body === input.body &&
        current.sources_json === input.sourcesJson
      if (unchanged) return { ok: true, created: false, noop: true, row: current }
      const next = current.revision + 1
      this.run(
        `UPDATE project_memories
            SET kind = ?, status = ?, verification = ?, audience = ?, scope = ?, body = ?, digest = ?,
                sources_json = ?, revision = ?, updated_at = ?
          WHERE id = ? AND revision = ?`,
        input.kind,
        input.status,
        input.verification,
        input.audience,
        input.scope,
        input.body,
        input.digest,
        input.sourcesJson,
        next,
        at,
        current.id,
        current.revision,
      )
      this.insertMemoryVersion(current.id, next, input, at)
      const row = this.getMemory(input.repoId, input.key)
      if (row === undefined) throw new Error('memory entry disappeared inside its own update')
      return { ok: true, created: false, noop: false, row }
    })
  }

  private insertMemoryVersion(memoryId: string, revision: number, input: MemoryWriteInput, at: string): void {
    this.run(
      `INSERT INTO project_memory_versions
        (memory_id, revision, kind, status, verification, audience, scope, body, digest, sources_json,
         actor_type, actor_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      memoryId,
      revision,
      input.kind,
      input.status,
      input.verification,
      input.audience,
      input.scope,
      input.body,
      input.digest,
      input.sourcesJson,
      input.actorType,
      input.actorId,
      input.reason,
      at,
    )
  }

  createPostmortemForJob(jobId: string): PostmortemRecord | undefined {
    const job = this.getJob(jobId)
    if (job === undefined) return undefined
    if (job.status !== 'failed' && job.status !== 'cancelled') return undefined
    const existing = this.getPostmortemForJob(jobId)
    if (existing !== undefined) {
      const recurrence = this.getPostmortemRecurrence(existing.recurrence_key)
      return recurrence === undefined ? undefined : { postmortem: existing, recurrence, created: false, escalated: false }
    }
    const analysis = buildPostmortem({
      job,
      events: [...this.listJobEvents(jobId, 200)].reverse(),
      instance: this.getRepoInstance(job.repo_id),
    })
    const repo = this.getRepo(job.repo_id)
    const user = this.userById(job.user_id)
    const owner = user?.login ?? repo?.owner ?? job.user_id
    const at = nowIso()
    return this.transaction(() => {
      const raced = this.getPostmortemForJob(jobId)
      if (raced !== undefined) {
        const recurrence = this.getPostmortemRecurrence(raced.recurrence_key)!
        return { postmortem: raced, recurrence, created: false, escalated: false }
      }
      const id = `pm_${randomBytes(6).toString('hex')}`
      this.run(
        `INSERT INTO postmortems (
           id, job_id, repo_id, user_id, status, category, outcome, recurrence_key,
           evidence_state, evidence_json, timeline_json, suspected_cause, owner,
           preventive_action, preventive_kind, preventive_verified, preventive_verified_at,
           first_seen_at, last_seen_at, closed_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL, ?, ?, NULL, ?, ?)`,
        id,
        jobId,
        job.repo_id,
        job.user_id,
        analysis.category,
        analysis.outcome,
        analysis.recurrenceKey,
        analysis.evidenceState,
        JSON.stringify(analysis.evidence),
        JSON.stringify(analysis.evidence.timeline),
        analysis.suspectedCause,
        owner,
        at,
        at,
        at,
        at,
      )
      let recurrence = this.getPostmortemRecurrence(analysis.recurrenceKey)
      let escalated = false
      if (recurrence === undefined) {
        this.run(
          'INSERT INTO postmortem_recurrences (recurrence_key, category, count, first_seen_at, last_seen_at, repositories_json, escalated_at, representative_id, updated_at) VALUES (?, ?, 1, ?, ?, ?, NULL, ?, ?)',
          analysis.recurrenceKey,
          analysis.category,
          at,
          at,
          JSON.stringify([job.repo_id]),
          id,
          at,
        )
        recurrence = this.getPostmortemRecurrence(analysis.recurrenceKey)!
      } else {
        const repositories = new Set(postmortemRepositories(recurrence.repositories_json))
        repositories.add(job.repo_id)
        this.run(
          'UPDATE postmortem_recurrences SET category = ?, count = count + 1, last_seen_at = ?, repositories_json = ?, representative_id = COALESCE(representative_id, ?), updated_at = ? WHERE recurrence_key = ?',
          analysis.category,
          at,
          JSON.stringify([...repositories]),
          id,
          at,
          analysis.recurrenceKey,
        )
        recurrence = this.getPostmortemRecurrence(analysis.recurrenceKey)!
        if (recurrence.count >= 2 && recurrence.escalated_at === null) {
          this.run(
            'UPDATE postmortem_recurrences SET escalated_at = ?, updated_at = ? WHERE recurrence_key = ?',
            at,
            at,
            analysis.recurrenceKey,
          )
          escalated = true
          recurrence = this.getPostmortemRecurrence(analysis.recurrenceKey)!
          this.notify(
            job.user_id,
            'ops',
            `重复故障复发：${analysis.category} 已在 ${recurrence.count} 个任务中复现（${analysis.recurrenceKey}），请先落实预防措施。`,
            'POSTMORTEM_RECURRING',
          )
          this.audit(job.user_id, 'postmortem.escalated', `${analysis.recurrenceKey}: ${recurrence.count} occurrences`)
          this.event('postmortem_escalated', { userId: job.user_id, repoId: job.repo_id, jobId, meta: analysis.recurrenceKey })
        }
      }
      return { postmortem: this.getPostmortem(id)!, recurrence, created: true, escalated }
    })
  }

  linkPreventiveAction(id: string, input: { kind: string; reference: string }): PostmortemRow | undefined {
    const existing = this.getPostmortem(id)
    if (existing === undefined) return undefined
    const reference = input.reference.trim().slice(0, 1000)
    if (reference === '' || !isPreventiveActionKind(input.kind)) return undefined
    this.run(
      'UPDATE postmortems SET preventive_kind = ?, preventive_action = ?, preventive_verified = 0, preventive_verified_at = NULL, updated_at = ? WHERE id = ?',
      input.kind,
      reference,
      nowIso(),
      id,
    )
    return this.getPostmortem(id)
  }

  verifyPreventiveAction(id: string, verifiedAt = nowIso()): { ok: boolean; error?: string; postmortem?: PostmortemRow } {
    const existing = this.getPostmortem(id)
    if (existing === undefined) return { ok: false, error: 'postmortem not found' }
    if (existing.preventive_action === null || existing.preventive_kind === null) {
      return { ok: false, error: 'a linked preventive action is required' }
    }
    this.run(
      "UPDATE postmortems SET preventive_verified = 1, preventive_verified_at = ?, status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?",
      verifiedAt,
      verifiedAt,
      verifiedAt,
      id,
    )
    return { ok: true, postmortem: this.getPostmortem(id) }
  }

  resolvePostmortem(id: string, input: { kind: PreventiveActionKind; reference: string; verifiedAt?: string }): { ok: boolean; error?: string; postmortem?: PostmortemRow } {
    const linked = this.linkPreventiveAction(id, input)
    if (linked === undefined) return { ok: false, error: 'a linked preventive action is required' }
    return this.verifyPreventiveAction(id, input.verifiedAt)
  }

  createArtifactVersion(input: {
    id: string
    artifact: string
    version: number
    hash: string
    content: string
    status?: string
    evidenceJson?: string | null
  }): ArtifactVersionRow {
    this.run(
      'INSERT INTO artifact_versions (id, artifact, version, hash, content, status, evidence_json, created_at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)',
      input.id,
      input.artifact,
      input.version,
      input.hash,
      input.content,
      input.status ?? 'candidate',
      input.evidenceJson ?? null,
      nowIso(),
    )
    return this.get<ArtifactVersionRow>('SELECT * FROM artifact_versions WHERE id = ?', input.id)!
  }

  listArtifactVersions(artifact?: string, limit = 50): ArtifactVersionRow[] {
    return artifact === undefined
      ? this.all<ArtifactVersionRow>('SELECT * FROM artifact_versions ORDER BY created_at DESC, rowid DESC LIMIT ?', limit)
      : this.all<ArtifactVersionRow>('SELECT * FROM artifact_versions WHERE artifact = ? ORDER BY version DESC LIMIT ?', artifact, limit)
  }

  promoteArtifactVersion(id: string, status = 'promoted'): void {
    this.run('UPDATE artifact_versions SET status = ?, promoted_at = ? WHERE id = ?', status, nowIso(), id)
  }

  // --- ADR 0003 ledger (#424) ------------------------------------------------
  //
  // A version row is immutable once written; the pointer is what moves. The
  // compare-and-swap compares the candidate's declared base against the head of
  // its own lineage, so a candidate built on a stale version is refused instead
  // of being silently re-based and evaluated as a diff nobody reviewed.

  artifactHead(artifact: string): number {
    const row = this.get<{ version: number | null }>('SELECT MAX(version) AS version FROM artifact_versions WHERE artifact = ?', artifact)
    return row?.version ?? 0
  }

  artifactPointer(artifact: string, channel: 'dev' | 'stable' = 'dev'): ArtifactVersionRow | null {
    const pointer = this.get<ArtifactPointerRow>('SELECT * FROM artifact_pointers WHERE artifact = ? AND channel = ?', artifact, channel)
    if (pointer === undefined) return null
    return this.get<ArtifactVersionRow>('SELECT * FROM artifact_versions WHERE id = ?', pointer.version_id) ?? null
  }

  createArtifactCandidate(input: {
    id: string
    kind: string
    scope: 'global' | 'repository'
    repoId?: string | null
    content: string
    hash: string
    baseVersion: number
    paths: readonly string[]
    evidenceJson?: string | null
  }): ArtifactWriteResult {
    const repoId = input.repoId ?? null
    // Decide the refusal before building the key: `artifactKey()` throws when a
    // repository-scoped candidate carries no repository, and a refusal is a
    // value here, not an exception (#494 finding 4). The head is only needed
    // for the compare-and-swap, so the pre-check passes the declared base as
    // the head and the CAS runs on its own afterwards.
    const label = input.scope === 'repository' && (repoId === null || repoId === '') ? `${input.kind}@?` : input.kind
    const preRefusal = candidateRefusal({
      kind: input.kind,
      scope: input.scope,
      repoId,
      paths: input.paths,
      baseVersion: input.baseVersion,
      headVersion: input.baseVersion,
    })
    if (preRefusal !== null) {
      this.audit(null, 'evolution.candidate.refused', `${label}: ${preRefusal.code} — ${preRefusal.detail}`)
      return { ok: false, refusal: preRefusal }
    }
    const artifact = artifactKey({ kind: input.kind, scope: input.scope, repoId })
    const head = this.artifactHead(artifact)
    if (input.baseVersion !== head) {
      // Compare-and-swap: the candidate declares the version it was built
      // against; a stale candidate is refused rather than re-based.
      const refusal: CandidateRefusal = {
        code: 'STALE_BASE',
        detail: `declared base ${String(input.baseVersion)} but the head is ${String(head)}`,
      }
      this.audit(null, 'evolution.candidate.refused', `${artifact}: ${refusal.code} — ${refusal.detail}`)
      return { ok: false, refusal }
    }
    const parent = head === 0
      ? null
      : this.get<{ id: string }>('SELECT id FROM artifact_versions WHERE artifact = ? AND version = ?', artifact, input.baseVersion) ?? null
    return this.transaction(() => {
      this.run(
        'INSERT INTO artifact_versions (id, artifact, version, hash, content, status, evidence_json, created_at, promoted_at, kind, scope, repo_id, parent_id, base_version, frozen, paths_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, ?)',
        input.id,
        artifact,
        head + 1,
        input.hash,
        input.content,
        'candidate',
        input.evidenceJson ?? null,
        nowIso(),
        input.kind,
        input.scope,
        repoId,
        parent?.id ?? null,
        head,
        JSON.stringify(input.paths),
      )
      return { ok: true as const, row: this.get<ArtifactVersionRow>('SELECT * FROM artifact_versions WHERE id = ?', input.id)! }
    })
  }

  /**
   * Move a candidate onto a channel. `repoId` is the caller's own repository:
   * a repository-scoped artifact may only be accepted by that repository, and a
   * global artifact carries no repository at all.
   */
  acceptArtifactCandidate(input: { id: string; repoId?: string | null; channel?: 'dev' | 'stable' }): ArtifactWriteResult {
    const row = this.get<ArtifactVersionRow>('SELECT * FROM artifact_versions WHERE id = ?', input.id)
    if (row === undefined) return { ok: false, refusal: { code: 'NOT_FOUND', detail: `no artifact version ${input.id}` } }
    const repoId = input.repoId ?? null
    if (row.scope === 'repository' && row.repo_id !== repoId) {
      return { ok: false, refusal: { code: 'SCOPE_MISMATCH', detail: `artifact ${row.artifact} belongs to another repository` } }
    }
    if (row.scope === 'global' && repoId !== null) {
      return { ok: false, refusal: { code: 'SCOPE_MISMATCH', detail: `artifact ${row.artifact} is global` } }
    }
    const channel = input.channel ?? 'dev'
    return this.transaction(() => {
      this.run('UPDATE artifact_versions SET status = ?, promoted_at = ? WHERE id = ?', channel === 'stable' ? 'promoted' : 'accepted', nowIso(), row.id)
      this.run(
        'INSERT INTO artifact_pointers (artifact, channel, version_id, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(artifact, channel) DO UPDATE SET version_id = excluded.version_id, updated_at = excluded.updated_at',
        row.artifact,
        channel,
        row.id,
        nowIso(),
      )
      return { ok: true as const, row: this.get<ArtifactVersionRow>('SELECT * FROM artifact_versions WHERE id = ?', row.id)! }
    })
  }

  /**
   * Point a channel back at an earlier version of the same artifact. The rows
   * in between stay readable: a rollback is a pointer move, not a delete, which
   * is what makes "both versions readable" true after one.
   */
  rollbackArtifact(input: { artifact: string; toVersionId: string; channel?: 'dev' | 'stable' }): ArtifactWriteResult {
    const target = this.get<ArtifactVersionRow>('SELECT * FROM artifact_versions WHERE id = ?', input.toVersionId)
    if (target === undefined) return { ok: false, refusal: { code: 'NOT_FOUND', detail: `no artifact version ${input.toVersionId}` } }
    if (target.artifact !== input.artifact) {
      return { ok: false, refusal: { code: 'SCOPE_MISMATCH', detail: `artifact ${input.toVersionId} belongs to ${target.artifact}, not ${input.artifact}` } }
    }
    const channel = input.channel ?? 'dev'
    return this.transaction(() => {
      this.run(
        'INSERT INTO artifact_pointers (artifact, channel, version_id, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(artifact, channel) DO UPDATE SET version_id = excluded.version_id, updated_at = excluded.updated_at',
        input.artifact,
        channel,
        target.id,
        nowIso(),
      )
      return { ok: true as const, row: this.get<ArtifactVersionRow>('SELECT * FROM artifact_versions WHERE id = ?', target.id)! }
    })
  }

  /** The lineage from a version back to its root, newest first. */
  artifactLineage(id: string): ArtifactVersionRow[] {
    const lineage: ArtifactVersionRow[] = []
    let current = this.get<ArtifactVersionRow>('SELECT * FROM artifact_versions WHERE id = ?', id)
    const seen = new Set<string>()
    while (current !== undefined && !seen.has(current.id)) {
      seen.add(current.id)
      lineage.push(current)
      current = current.parent_id === null
        ? undefined
        : this.get<ArtifactVersionRow>('SELECT * FROM artifact_versions WHERE id = ?', current.parent_id)
    }
    return lineage
  }

  createEvaluation(input: {
    id: string
    artifactId: string
    dataset: string
    metric: string
    value: number
    ciLow?: number | null
    ciHigh?: number | null
    samples?: number
  }): EvaluationRow {
    this.run(
      'INSERT INTO evaluations (id, artifact_id, dataset, metric, value, ci_low, ci_high, samples, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      input.id,
      input.artifactId,
      input.dataset,
      input.metric,
      input.value,
      input.ciLow ?? null,
      input.ciHigh ?? null,
      input.samples ?? 0,
      nowIso(),
    )
    return this.get<EvaluationRow>('SELECT * FROM evaluations WHERE id = ?', input.id)!
  }

  listEvaluations(artifactId: string): EvaluationRow[] {
    return this.all<EvaluationRow>('SELECT * FROM evaluations WHERE artifact_id = ? ORDER BY created_at DESC', artifactId)
  }

  createPromotion(input: {
    id: string
    artifactId: string
    decision: 'promote' | 'defer' | 'reject' | 'rollback'
    reason?: string | null
    evidenceHash?: string | null
    approvedBy?: string | null
  }): PromotionRow {
    this.run(
      'INSERT INTO promotions (id, artifact_id, decision, reason, evidence_hash, approved_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      input.id,
      input.artifactId,
      input.decision,
      input.reason ?? null,
      input.evidenceHash ?? null,
      input.approvedBy ?? null,
      nowIso(),
    )
    return this.get<PromotionRow>('SELECT * FROM promotions WHERE id = ?', input.id)!
  }

  listPromotions(artifactId?: string): PromotionRow[] {
    return artifactId === undefined
      ? this.all<PromotionRow>('SELECT * FROM promotions ORDER BY created_at DESC')
      : this.all<PromotionRow>('SELECT * FROM promotions WHERE artifact_id = ? ORDER BY created_at DESC', artifactId)
  }

  recordDeployment(input: DeploymentInput): DeploymentRow {
    const id = `dep_${randomBytes(6).toString('hex')}`
    this.run(
      'INSERT INTO deployments (id, environment, version, commit_sha, image_digest, deployed_at, operator, healthz_ok, healthz_status, healthz_version, healthz_commit, readyz_ok, readyz_status, release_url, gate_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      input.environment,
      input.version,
      input.commit,
      input.imageDigest,
      input.deployedAt,
      input.operator,
      input.healthz.ok ? 1 : 0,
      input.healthz.status,
      input.healthz.version ?? null,
      input.healthz.commit ?? null,
      input.readyz.ok ? 1 : 0,
      input.readyz.status,
      input.releaseUrl,
      JSON.stringify(input.gate ?? null),
      nowIso(),
    )
    return this.get<DeploymentRow>('SELECT * FROM deployments WHERE id = ?', id)!
  }

  listDeployments(environment: string | null = null, limit = 100): DeploymentRow[] {
    return environment === null
      ? this.all<DeploymentRow>('SELECT * FROM deployments ORDER BY created_at DESC, rowid DESC LIMIT ?', limit)
      : this.all<DeploymentRow>('SELECT * FROM deployments WHERE environment = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', environment, limit)
  }

  latestDeployment(environment: string): DeploymentRow | undefined {
    return this.get<DeploymentRow>('SELECT * FROM deployments WHERE environment = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', environment)
  }

  listDeploymentEnvironments(): string[] {
    return this.all<{ environment: string }>('SELECT DISTINCT environment FROM deployments ORDER BY environment').map((row) => row.environment)
  }

  recordDeploymentRollback(input: DeploymentRollbackInput): DeploymentRollbackRow {
    const id = `rbk_${randomBytes(6).toString('hex')}`
    this.run(
      'INSERT INTO deployment_rollbacks (id, environment, from_deployment_id, previous_deployment_id, previous_digest, previous_commit, owner, command, decision, healthz_ok, healthz_status, healthz_commit, verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      input.environment,
      input.fromDeploymentId,
      input.previousDeploymentId,
      input.previousDigest,
      input.previousCommit,
      input.owner,
      input.command,
      input.decision,
      input.healthz.ok ? 1 : 0,
      input.healthz.status,
      input.healthz.commit ?? null,
      input.verified ? 1 : 0,
      nowIso(),
    )
    return this.get<DeploymentRollbackRow>('SELECT * FROM deployment_rollbacks WHERE id = ?', id)!
  }

  listDeploymentRollbacks(environment: string | null = null, limit = 50): DeploymentRollbackRow[] {
    return environment === null
      ? this.all<DeploymentRollbackRow>('SELECT * FROM deployment_rollbacks ORDER BY created_at DESC, rowid DESC LIMIT ?', limit)
      : this.all<DeploymentRollbackRow>('SELECT * FROM deployment_rollbacks WHERE environment = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', environment, limit)
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
      users: count('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?', sinceIso),
      approved: count("SELECT COUNT(*) AS n FROM users WHERE status = 'approved' AND created_at >= ?", sinceIso),
      repos: count('SELECT COUNT(*) AS n FROM repos WHERE created_at >= ?', sinceIso),
      jobs: count('SELECT COUNT(*) AS n FROM jobs WHERE created_at >= ?', sinceIso),
      succeeded: count("SELECT COUNT(*) AS n FROM jobs WHERE status = 'succeeded' AND created_at >= ?", sinceIso),
      failed: count("SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed' AND created_at >= ?", sinceIso),
      usersWithJobs: count('SELECT COUNT(DISTINCT user_id) AS n FROM jobs WHERE created_at >= ?', sinceIso),
      usersWithPr: count("SELECT COUNT(DISTINCT user_id) AS n FROM jobs WHERE pr_url IS NOT NULL AND created_at >= ?", sinceIso),
      costUsd: Number(this.get<{ n: number | null }>("SELECT SUM(cost_usd) AS n FROM jobs WHERE created_at >= ?", sinceIso)?.n ?? 0),
      events: this.all<{ name: string; n: number }>('SELECT name, COUNT(*) AS n FROM events WHERE at >= ? GROUP BY name ORDER BY n DESC', sinceIso),
    }
  }

  deliveryMetrics(sinceIso: string): {
    jobs: number
    succeeded: number
    failed: number
    successRate: number
    prs: number
    merged: number
    mergeRate: number
    changesRequested: number
    reviewAverage: number | null
    reviewCount: number
    medianJobMs: number | null
    medianMergeMs: number | null
    medianReviewMs: number | null
  } {
    const jobs = this.all<JobRow>('SELECT * FROM jobs WHERE created_at >= ?', sinceIso)
    const succeeded = jobs.filter((job) => job.status === 'succeeded').length
    const failed = jobs.filter((job) => job.status === 'failed').length
    const prJobs = jobs.filter((job) => job.pr_url !== null)
    const merged = jobs.filter((job) => job.pr_state === 'merged').length
    const reviewScores = jobs.flatMap((job) => (job.kind === 'review' && job.review_score !== null ? [job.review_score] : []))
    const jobDurations = jobs.flatMap((job) => {
      const value = durationMs(job.started_at ?? job.created_at, job.finished_at)
      return value === null ? [] : [value]
    })
    const reviewDurations = jobs.flatMap((job) => {
      if (job.kind !== 'review') return []
      const value = durationMs(job.started_at ?? job.created_at, job.finished_at)
      return value === null ? [] : [value]
    })
    const mergedItems = this.all<WorkItemRow>('SELECT * FROM work_items WHERE merged_at IS NOT NULL AND merged_at >= ?', sinceIso)
    const mergeDurations = mergedItems.flatMap((item) => {
      const value = durationMs(item.created_at, item.merged_at)
      return value === null ? [] : [value]
    })
    return {
      jobs: jobs.length,
      succeeded,
      failed,
      successRate: jobs.length === 0 ? 0 : Math.round((succeeded / jobs.length) * 1000) / 10,
      prs: prJobs.length,
      merged,
      mergeRate: prJobs.length === 0 ? 0 : Math.round((merged / prJobs.length) * 1000) / 10,
      changesRequested: Number(this.get<{ n: number }>("SELECT COUNT(*) AS n FROM work_items WHERE state = 'changes_requested' AND updated_at >= ?", sinceIso)?.n ?? 0),
      reviewAverage: reviewScores.length === 0 ? null : Math.round((reviewScores.reduce((sum, score) => sum + score, 0) / reviewScores.length) * 10) / 10,
      reviewCount: reviewScores.length,
      medianJobMs: median(jobDurations),
      medianMergeMs: median(mergeDurations),
      medianReviewMs: median(reviewDurations),
    }
  }

  reviewTrend(repoId: string, sinceIso: string): ReviewTrendWindow {
    const reviewJobs = this.all<JobRow>(
      `SELECT * FROM jobs
        WHERE repo_id = ? AND kind = 'review' AND status = 'succeeded'
          AND review_score IS NOT NULL AND finished_at IS NOT NULL AND finished_at >= ?`,
      repoId,
      sinceIso,
    )
    const scores = reviewJobs.flatMap((job) => (job.review_score === null ? [] : [job.review_score]))
    const averageScore = scores.length === 0 ? null : Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 10) / 10
    const outcomes = this.all<{ outcome: string }>(
      `SELECT CASE WHEN a.detail LIKE '%: changes_requested score=%' THEN 'changes_requested' ELSE 'approved' END AS outcome
         FROM audit_log a
         JOIN work_items w ON w.id = substr(a.detail, 1, instr(a.detail, ':') - 1)
        WHERE a.action = 'work_item.review_outcome' AND a.at >= ? AND w.repo_id = ?
          AND (a.detail LIKE '%: changes_requested score=%' OR a.detail LIKE '%: approved score=%')`,
      sinceIso,
      repoId,
    )
    const changesRequested = outcomes.filter((row) => row.outcome === 'changes_requested').length
    const reviewDelays = this.all<{ opened: string; reviewed: string }>(
      `SELECT w.created_at AS opened, j.finished_at AS reviewed
         FROM jobs j
         JOIN work_items w ON w.id = j.work_item_id
        WHERE j.repo_id = ? AND j.kind = 'review' AND j.status = 'succeeded'
          AND j.finished_at IS NOT NULL AND j.finished_at >= ? AND w.pr_url IS NOT NULL`,
      repoId,
      sinceIso,
    ).flatMap((row) => {
      const value = durationMs(row.opened, row.reviewed)
      return value === null ? [] : [value]
    })
    const mergeDelays = this.all<WorkItemRow>('SELECT * FROM work_items WHERE repo_id = ? AND merged_at IS NOT NULL AND merged_at >= ?', repoId, sinceIso).flatMap((item) => {
      const value = durationMs(item.created_at, item.merged_at)
      return value === null ? [] : [value]
    })
    const byModel = new Map<string, number>()
    for (const job of reviewJobs) {
      const label = parseModelRun(job.model_json)?.model?.label
      if (label === undefined) continue
      byModel.set(label, (byModel.get(label) ?? 0) + 1)
    }
    return {
      reviews: reviewJobs.length,
      averageScore,
      outcomes: outcomes.length,
      changesRequested,
      changesRequestedRate: outcomes.length === 0 ? null : Math.round((changesRequested / outcomes.length) * 1000) / 10,
      medianPrOpenToReviewMs: median(reviewDelays),
      medianPrOpenToMergeMs: median(mergeDelays),
      models: [...byModel.entries()]
        .map(([label, reviews]) => ({ label, reviews }))
        .sort((a, b) => b.reviews - a.reviews || a.label.localeCompare(b.label)),
      smallSample: reviewJobs.length < REVIEW_TREND_SMALL_SAMPLE,
    }
  }

  dailyMetrics(sinceIso: string, limit = 30): Array<{ day: string; jobs: number; succeeded: number; failed: number; merged: number }> {
    return this.all<{ day: string; jobs: number; succeeded: number; failed: number; merged: number }>(
      `SELECT substr(created_at, 1, 10) AS day,
              COUNT(*) AS jobs,
              SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN pr_state = 'merged' THEN 1 ELSE 0 END) AS merged
         FROM jobs
        WHERE created_at >= ?
        GROUP BY day
        ORDER BY day DESC
        LIMIT ?`,
      sinceIso,
      limit,
    ).map((row) => ({ day: row.day, jobs: Number(row.jobs), succeeded: Number(row.succeeded), failed: Number(row.failed), merged: Number(row.merged) }))
  }

  personalMetrics(userId: string, sinceIso: string): {
    repos: number
    jobs: number
    succeeded: number
    failed: number
    prs: number
    merged: number
    costUsd: number
    openWorkItems: number
    lastJobAt: string | null
  } {
    const count = (sql: string): number => Number(this.get<{ n: number }>(sql, userId, sinceIso)?.n ?? 0)
    const last = this.get<{ at: string | null }>('SELECT MAX(created_at) AS at FROM jobs WHERE user_id = ? AND created_at >= ?', userId, sinceIso)
    return {
      repos: Number(this.get<{ n: number }>('SELECT COUNT(*) AS n FROM repos WHERE user_id = ?', userId)?.n ?? 0),
      jobs: count('SELECT COUNT(*) AS n FROM jobs WHERE user_id = ? AND created_at >= ?'),
      succeeded: count("SELECT COUNT(*) AS n FROM jobs WHERE user_id = ? AND status = 'succeeded' AND created_at >= ?"),
      failed: count("SELECT COUNT(*) AS n FROM jobs WHERE user_id = ? AND status = 'failed' AND created_at >= ?"),
      prs: count('SELECT COUNT(*) AS n FROM jobs WHERE user_id = ? AND pr_url IS NOT NULL AND created_at >= ?'),
      merged: count("SELECT COUNT(*) AS n FROM jobs WHERE user_id = ? AND pr_state = 'merged' AND created_at >= ?"),
      costUsd: Number(this.get<{ n: number | null }>('SELECT SUM(cost_usd) AS n FROM quota_ledger WHERE user_id = ? AND at >= ?', userId, sinceIso)?.n ?? 0),
      openWorkItems: Number(this.get<{ n: number }>("SELECT COUNT(*) AS n FROM work_items WHERE user_id = ? AND state NOT IN ('merged', 'closed')", userId)?.n ?? 0),
      lastJobAt: last?.at ?? null,
    }
  }

  repoCostMetrics(sinceIso: string, limit = 20): Array<{ repoId: string; label: string; costUsd: number; calls: number }> {
    return this.all<{ repo_id: string; owner: string; name: string; total: number; calls: number }>(
      `SELECT q.repo_id AS repo_id, COALESCE(r.upstream_owner, r.owner, '') AS owner, COALESCE(r.upstream_name, r.name, '') AS name,
              SUM(q.cost_usd) AS total, COUNT(*) AS calls
         FROM quota_ledger q
         LEFT JOIN repos r ON r.id = q.repo_id
        WHERE q.at >= ? AND q.repo_id IS NOT NULL
        GROUP BY q.repo_id
        ORDER BY total DESC
        LIMIT ?`,
      sinceIso,
      limit,
    ).map((row) => ({ repoId: row.repo_id, label: `${row.owner}/${row.name}`.replace(/^\//, ''), costUsd: Number(row.total ?? 0), calls: Number(row.calls ?? 0) }))
  }

  modelCostMetrics(sinceIso: string, limit = 20): Array<{ model: string; costUsd: number; calls: number }> {
    const rows = this.all<{ meta: string | null; cost_usd: number }>('SELECT meta, cost_usd FROM quota_ledger WHERE at >= ?', sinceIso)
    const byModel = new Map<string, { costUsd: number; calls: number }>()
    for (const row of rows) {
      let model = 'unknown'
      if (row.meta !== null) {
        try {
          const parsed = JSON.parse(row.meta) as { model?: unknown }
          if (typeof parsed.model === 'string' && parsed.model.trim() !== '') model = parsed.model.trim().slice(0, 120)
        } catch {}
      }
      const current = byModel.get(model) ?? { costUsd: 0, calls: 0 }
      current.costUsd += Number(row.cost_usd ?? 0)
      current.calls += 1
      byModel.set(model, current)
    }
    return [...byModel.entries()]
      .map(([model, value]) => ({ model, ...value }))
      .sort((a, b) => b.costUsd - a.costUsd)
      .slice(0, limit)
  }

  alerts(input: { now?: string; stallMinutes?: number; prAgeHours?: number; usdCny?: number; budgetRatio?: number; userId?: string } = {}): AlertView[] {
    const now = input.now ?? nowIso()
    const nowMs = Date.parse(now)
    const stallMs = (input.stallMinutes ?? 30) * 60_000
    const prAgeMs = (input.prAgeHours ?? 24) * 3_600_000
    const ratio = input.budgetRatio ?? 0.8
    const usdCny = input.usdCny ?? 1
    const alerts: AlertView[] = []
    const repos = input.userId === undefined
      ? this.all<RepoRow>('SELECT * FROM repos')
      : this.all<RepoRow>('SELECT * FROM repos WHERE user_id = ?', input.userId)
    const repoLabels = new Map(repos.map((repo) => [repo.id, `${repo.upstream_owner || repo.owner}/${repo.upstream_name || repo.name}`]))
    const running = input.userId === undefined
      ? this.all<JobRow>("SELECT * FROM jobs WHERE status = 'running'")
      : this.all<JobRow>("SELECT * FROM jobs WHERE status = 'running' AND user_id = ?", input.userId)
    for (const job of running) {
      const last = job.last_callback_at ?? job.started_at ?? job.created_at
      const at = Date.parse(last)
      if (!Number.isFinite(at)) continue
      const minutes = Math.round((nowMs - at) / 60_000)
      if (nowMs - at >= stallMs * 2) {
        alerts.push({ kind: 'job_stalled', level: 'critical', repoId: job.repo_id, repoLabel: repoLabels.get(job.repo_id), jobId: job.id, minutes, message: `job ${job.id} has no callback for ${minutes}m` })
      } else if (nowMs - at >= stallMs) {
        alerts.push({ kind: 'job_slow', level: 'warning', repoId: job.repo_id, repoLabel: repoLabels.get(job.repo_id), jobId: job.id, minutes, message: `job ${job.id} has no callback for ${minutes}m` })
      }
    }
    const prJobs = input.userId === undefined
      ? this.all<JobRow>("SELECT * FROM jobs WHERE pr_url IS NOT NULL AND (pr_state IS NULL OR pr_state = 'open')")
      : this.all<JobRow>("SELECT * FROM jobs WHERE user_id = ? AND pr_url IS NOT NULL AND (pr_state IS NULL OR pr_state = 'open')", input.userId)
    for (const job of prJobs) {
      const at = Date.parse(job.created_at)
      if (!Number.isFinite(at) || nowMs - at < prAgeMs) continue
      const hours = Math.round((nowMs - at) / 3_600_000)
      alerts.push({ kind: 'pr_stale', level: 'warning', repoId: job.repo_id, repoLabel: repoLabels.get(job.repo_id), jobId: job.id, prUrl: job.pr_url ?? undefined, hours, message: `PR ${job.pr_url} has been open for ${hours}h` })
    }
    const since = new Date(nowMs - 30 * 86_400_000).toISOString()
    for (const repo of repos) {
      const label = repoLabels.get(repo.id) ?? repo.id
      if (repo.credential_state !== 'ok') {
        alerts.push({ kind: 'credential_invalid', level: 'critical', repoId: repo.id, repoLabel: label, state: repo.credential_state, message: `${label}: GitHub credential is ${repo.credential_state}` })
      }
      if (repo.monthly_budget_cny > 0) {
        const spentCny = this.repoUsageSince(repo.id, since) * usdCny
        if (spentCny >= repo.monthly_budget_cny * ratio) {
          alerts.push({
            kind: 'budget_near_limit',
            level: spentCny >= repo.monthly_budget_cny ? 'critical' : 'warning',
            repoId: repo.id,
            repoLabel: label,
            spentCny,
            budgetCny: repo.monthly_budget_cny,
            message: `${label}: spent ${spentCny.toFixed(2)} of ${repo.monthly_budget_cny.toFixed(2)} CNY in 30 days`,
          })
        }
      }
    }
    const rank: Record<string, number> = { critical: 0, warning: 1, info: 2 }
    return alerts.sort((a, b) => (rank[a.level] ?? 9) - (rank[b.level] ?? 9))
  }

  setUserGithubToken(id: string, encrypted: string | null, scopes = ''): void {
    this.run('UPDATE users SET github_token_enc = ?, github_token_scopes = ? WHERE id = ?', encrypted, scopes, id)
  }

  setUserOwnModel(id: string, baseUrl: string | null, keyEnc: string | null, model: string | null): void {
    this.run('UPDATE users SET own_llm_base_url = ?, own_llm_key_enc = ?, own_llm_model = ? WHERE id = ?', baseUrl, keyEnc, model, id)
  }

  setUserAllowPrivateModels(id: string, allow: boolean): void {
    this.run('UPDATE users SET allow_private_models = ? WHERE id = ?', allow ? 1 : 0, id)
  }

  listUserModels(userId: string): UserModelRow[] {
    return this.all<UserModelRow>('SELECT * FROM user_models WHERE user_id = ? ORDER BY created_at ASC', userId)
  }

  userModelById(id: string, userId: string): UserModelRow | undefined {
    return this.get<UserModelRow>('SELECT * FROM user_models WHERE id = ? AND user_id = ?', id, userId)
  }

  createUserModel(input: { id: string; userId: string; label: string; baseUrl: string; keyEnc: string; model: string; allowPrivate: boolean }): UserModelRow {
    this.run(
      'INSERT INTO user_models (id, user_id, label, base_url, key_enc, model, allow_private, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      input.id, input.userId, input.label, input.baseUrl, input.keyEnc, input.model, input.allowPrivate ? 1 : 0, nowIso(), nowIso(),
    )
    return this.get<UserModelRow>('SELECT * FROM user_models WHERE id = ?', input.id)!
  }

  updateUserModel(id: string, userId: string, patch: Partial<Pick<UserModelRow, 'label' | 'base_url' | 'key_enc' | 'model' | 'allow_private'>>): void {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined)
    if (entries.length === 0) return
    const sets = entries.map(([key]) => `${key} = ?`).join(', ')
    this.run(`UPDATE user_models SET ${sets}, updated_at = ? WHERE id = ? AND user_id = ?`, ...entries.map(([, value]) => value), nowIso(), id, userId)
  }

  deleteUserModel(id: string, userId: string): void {
    this.run('DELETE FROM user_models WHERE id = ? AND user_id = ?', id, userId)
  }

  listRepoModels(repoId: string): Array<UserModelRow & { is_default: number }> {
    return this.all<UserModelRow & { is_default: number }>(
      'SELECT m.*, rm.is_default FROM repo_models rm JOIN user_models m ON m.id = rm.model_id WHERE rm.repo_id = ? ORDER BY m.created_at ASC',
      repoId,
    )
  }

  repoModelForRun(repoId: string, alias: string): UserModelRow | undefined {
    return this.get<UserModelRow>('SELECT m.* FROM repo_models rm JOIN user_models m ON m.id = rm.model_id WHERE rm.repo_id = ? AND m.id = ?', repoId, alias)
  }

  setRepoModels(repoId: string, modelIds: string[], defaultId: string | null): void {
    const unique = [...new Set(modelIds)]
    const fallback = unique[0] ?? null
    const chosen = defaultId !== null && unique.includes(defaultId) ? defaultId : fallback
    this.transaction(() => {
      this.run('DELETE FROM repo_models WHERE repo_id = ?', repoId)
      for (const modelId of unique) {
        this.run('INSERT INTO repo_models (repo_id, model_id, is_default, created_at) VALUES (?, ?, ?, ?)', repoId, modelId, modelId === chosen ? 1 : 0, nowIso())
      }
      this.run('UPDATE repos SET models_dirty = 1 WHERE id = ?', repoId)
    })
  }

  markRepoModelsApplied(repoId: string): void {
    this.run('UPDATE repos SET models_dirty = 0 WHERE id = ?', repoId)
  }

  listModelProviders(userId: string): ModelProviderRow[] {
    return this.all<ModelProviderRow>('SELECT * FROM model_providers WHERE user_id = ? ORDER BY created_at ASC', userId)
  }

  modelProviderById(id: string, userId: string): ModelProviderRow | undefined {
    return this.get<ModelProviderRow>('SELECT * FROM model_providers WHERE id = ? AND user_id = ?', id, userId)
  }

  createModelProvider(input: { id: string; userId: string; label: string; baseUrl: string; keyEnc: string; allowPrivate: boolean; region?: string; dataPolicyUrl?: string; allowed?: boolean }): ModelProviderRow {
    this.run(
      'INSERT INTO model_providers (id, user_id, label, base_url, key_enc, allow_private, region, data_policy_url, allowed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      input.id, input.userId, input.label, input.baseUrl, input.keyEnc, input.allowPrivate ? 1 : 0, input.region ?? '', input.dataPolicyUrl ?? '', input.allowed === false ? 0 : 1, nowIso(), nowIso(),
    )
    return this.get<ModelProviderRow>('SELECT * FROM model_providers WHERE id = ?', input.id)!
  }

  updateModelProvider(id: string, userId: string, patch: Partial<Pick<ModelProviderRow, 'label' | 'base_url' | 'key_enc' | 'allow_private' | 'region' | 'data_policy_url' | 'allowed'>>): void {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined)
    if (entries.length === 0) return
    const sets = entries.map(([key]) => `${key} = ?`).join(', ')
    this.run(`UPDATE model_providers SET ${sets}, updated_at = ? WHERE id = ? AND user_id = ?`, ...entries.map(([, value]) => value), nowIso(), id, userId)
  }

  deleteModelProvider(id: string, userId: string): void {
    this.run('DELETE FROM model_providers WHERE id = ? AND user_id = ?', id, userId)
  }

  listProviderModels(providerId: string): ProviderModelRow[] {
    return this.all<ProviderModelRow>('SELECT * FROM provider_models WHERE provider_id = ? ORDER BY created_at ASC', providerId)
  }

  listUserProviderModels(userId: string): Array<ProviderModelRow & { provider_label: string; provider_region: string; provider_data_policy_url: string; provider_allowed: number }> {
    return this.all<ProviderModelRow & { provider_label: string; provider_region: string; provider_data_policy_url: string; provider_allowed: number }>(
      'SELECT pm.*, mp.label AS provider_label, mp.region AS provider_region, mp.data_policy_url AS provider_data_policy_url, mp.allowed AS provider_allowed FROM provider_models pm JOIN model_providers mp ON mp.id = pm.provider_id WHERE mp.user_id = ? ORDER BY mp.created_at ASC, pm.created_at ASC',
      userId,
    )
  }

  createProviderModel(input: { id: string; providerId: string; model: string; label: string }): ProviderModelRow {
    this.run('INSERT INTO provider_models (id, provider_id, model, label, created_at) VALUES (?, ?, ?, ?, ?)', input.id, input.providerId, input.model, input.label, nowIso())
    return this.get<ProviderModelRow>('SELECT * FROM provider_models WHERE id = ?', input.id)!
  }

  deleteProviderModel(id: string, userId: string): boolean {
    const row = this.get<{ id: string }>('SELECT pm.id FROM provider_models pm JOIN model_providers mp ON mp.id = pm.provider_id WHERE pm.id = ? AND mp.user_id = ?', id, userId)
    if (row === undefined) return false
    this.run('DELETE FROM provider_models WHERE id = ?', id)
    return true
  }

  repoProviderPolicy(repoId: string): { allowlist: string[]; requiredRegion: string } {
    const repo = this.getRepo(repoId)
    return {
      allowlist: parseProviderAllowlist(repo?.provider_allowlist),
      requiredRegion: normalizeProviderRegion(repo?.required_region),
    }
  }

  setRepoProviderPolicy(repoId: string, providerIds: string[], requiredRegion: string): void {
    const allowlist = [...new Set(parseProviderAllowlist(providerIds.join(',')))]
    this.updateRepo(repoId, {
      provider_allowlist: allowlist.join(','),
      required_region: normalizeProviderRegion(requiredRegion),
    })
  }

  listRepoModelSelection(repoId: string): RepoProviderModelRow[] {
    return this.all<RepoProviderModelRow>(
      'SELECT pm.*, mp.label AS provider_label, mp.region AS provider_region, mp.data_policy_url AS provider_data_policy_url, mp.allowed AS provider_allowed, mp.base_url, mp.key_enc, mp.allow_private, rms.is_default FROM repo_model_selection rms JOIN provider_models pm ON pm.id = rms.provider_model_id JOIN model_providers mp ON mp.id = pm.provider_id WHERE rms.repo_id = ? ORDER BY mp.created_at ASC, pm.created_at ASC',
      repoId,
    )
  }

  providerModelForRun(repoId: string, alias: string): RepoProviderModelRow | undefined {
    return this.get<RepoProviderModelRow>(
      'SELECT pm.*, mp.label AS provider_label, mp.region AS provider_region, mp.data_policy_url AS provider_data_policy_url, mp.allowed AS provider_allowed, mp.base_url, mp.key_enc, mp.allow_private, rms.is_default FROM repo_model_selection rms JOIN provider_models pm ON pm.id = rms.provider_model_id JOIN model_providers mp ON mp.id = pm.provider_id WHERE rms.repo_id = ? AND pm.id = ?',
      repoId, alias,
    )
  }

  setRepoModelSelection(repoId: string, providerModelIds: string[], defaultId: string | null): void {
    const unique = [...new Set(providerModelIds)]
    const chosen = defaultId !== null && unique.includes(defaultId) ? defaultId : unique[0] ?? null
    this.transaction(() => {
      this.run('DELETE FROM repo_model_selection WHERE repo_id = ?', repoId)
      for (const modelId of unique) {
        this.run('INSERT INTO repo_model_selection (repo_id, provider_model_id, is_default, created_at) VALUES (?, ?, ?, ?)', repoId, modelId, modelId === chosen ? 1 : 0, nowIso())
      }
      this.run('DELETE FROM repo_bot_models WHERE repo_id = ? AND provider_model_id NOT IN (SELECT provider_model_id FROM repo_model_selection WHERE repo_id = ?)', repoId, repoId)
      this.run('UPDATE repos SET models_dirty = 1 WHERE id = ?', repoId)
    })
  }

  listRepoBotModels(repoId: string): RepoBotModelRow[] {
    return this.all<RepoBotModelRow>('SELECT * FROM repo_bot_models WHERE repo_id = ? ORDER BY role ASC', repoId)
  }

  setRepoBotModel(repoId: string, role: string, providerModelId: string | null): void {
    if (providerModelId === null || providerModelId === '') {
      this.run('DELETE FROM repo_bot_models WHERE repo_id = ? AND role = ?', repoId, role)
      return
    }
    this.run(
      'INSERT INTO repo_bot_models (repo_id, role, provider_model_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(repo_id, role) DO UPDATE SET provider_model_id = excluded.provider_model_id, created_at = excluded.created_at',
      repoId, role, providerModelId, nowIso(),
    )
  }

  createSession(input: { idHash: string; userId: string; expiresAt: string; recentAuthAt: string; ip: string | null; userAgent: string | null }): void {
    this.run(
      'INSERT INTO sessions (id_hash, user_id, created_at, expires_at, recent_auth_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
      input.idHash,
      input.userId,
      nowIso(),
      input.expiresAt,
      input.recentAuthAt,
      input.ip,
      input.userAgent,
    )
  }

  /** Records a fresh GitHub re-authentication on an existing session. */
  markRecentAuth(idHash: string, at: string = nowIso()): void {
    this.run('UPDATE sessions SET recent_auth_at = ? WHERE id_hash = ?', at, idHash)
  }

  getSession(idHash: string): SessionRow | undefined {
    return this.get<SessionRow>('SELECT * FROM sessions WHERE id_hash = ? AND expires_at > ?', idHash, nowIso())
  }

  deleteSession(idHash: string): void {
    this.run('DELETE FROM sessions WHERE id_hash = ?', idHash)
  }

  // #356: the settings page lists a user's live sessions and revokes them. Every
  // read and every delete is scoped to `user_id`, so one user's handle can never
  // address another user's row: a wrong or foreign hash deletes nothing and the
  // caller cannot tell the two apart.
  listSessions(userId: string): SessionRow[] {
    return this.all<SessionRow>(
      'SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC',
      userId,
      nowIso(),
    )
  }

  deleteSessionOfUser(userId: string, idHash: string): boolean {
    return this.runChanges('DELETE FROM sessions WHERE id_hash = ? AND user_id = ?', idHash, userId) > 0
  }

  deleteOtherSessions(userId: string, keepIdHash: string): number {
    return this.runChanges('DELETE FROM sessions WHERE user_id = ? AND id_hash <> ?', userId, keepIdHash)
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
    stageMode?: string
    monthlyBudgetCny?: number
    jobBudgetCny?: number
    jobBudgetAction?: string
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
         repo_role, auto_merge, role_checked_at, plan_required, allow_paths, deny_paths, merge_method, require_protection, stage_mode, monthly_budget_cny, job_budget_cny, job_budget_action, protection_state, protection_checked_at,
         is_fork, fork_created, permission, can_review, can_create_issue, reviewer_enabled, review_interval_minutes, upstream_html_url, fork_html_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      input.stageMode ?? 'off',
      input.monthlyBudgetCny ?? 0,
      input.jobBudgetCny ?? 0,
      input.jobBudgetAction === 'pause' || input.jobBudgetAction === 'cancel' ? input.jobBudgetAction : 'alert',
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
    return this.all<RepoRow>('SELECT * FROM repos WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?', userId, limit, offset)
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

  updateRepo(id: string, patch: Partial<Pick<RepoRow, 'goal' | 'enabled' | 'auto_iterate' | 'interval_minutes' | 'last_run_at' | 'last_status' | 'default_branch' | 'repo_role' | 'auto_merge' | 'role_checked_at' | 'plan_required' | 'allow_paths' | 'deny_paths' | 'merge_method' | 'require_protection' | 'stage_mode' | 'models_dirty' | 'credential_state' | 'consecutive_failures' | 'monthly_budget_cny' | 'job_budget_cny' | 'job_budget_action' | 'protection_state' | 'protection_checked_at' | 'permission' | 'can_review' | 'can_create_issue' | 'reviewer_enabled' | 'review_interval_minutes' | 'last_review_at' | 'last_review_status' | 'target_branch' | 'is_fork' | 'fork_created' | 'upstream_owner' | 'upstream_name' | 'fork_owner' | 'fork_name' | 'upstream_default_branch' | 'fork_default_branch' | 'upstream_html_url' | 'fork_html_url' | 'provider_allowlist' | 'required_region'>>): void {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined)
    if (entries.length === 0) return
    const sets = entries.map(([key]) => `${key} = ?`).join(', ')
    this.run(`UPDATE repos SET ${sets} WHERE id = ?`, ...entries.map(([, value]) => value), id)
  }

  deleteRepo(id: string): void {
    this.run('DELETE FROM repos WHERE id = ?', id)
  }

  listAutoMergeRepos(): RepoRow[] {
    return this.all<RepoRow>('SELECT * FROM repos WHERE enabled = 1 AND auto_merge = 1 ORDER BY created_at ASC')
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

  // #457 review: the ceiling counts instances that occupy a slot, not rows.
  // `stop()` keeps the row with `status = 'stopped'` and a failed provision
  // leaves one behind, so counting every row would refuse a user at the cap the
  // restart of their own stopped instance. `excludeRepoId` is the repository
  // being provisioned: its own row must not count against its restart either.
  countRepoInstancesForUser(userId: string, excludeRepoId = ''): number {
    return this.get<{ total: number }>(
      `SELECT COUNT(*) AS total FROM repo_instances
       WHERE user_id = ? AND status IN ('starting', 'provisioning', 'ready') AND repo_id <> ?`,
      userId,
      excludeRepoId,
    )?.total ?? 0
  }

  countRepoInstances(excludeRepoId = ''): number {
    return this.get<{ total: number }>(
      `SELECT COUNT(*) AS total FROM repo_instances
       WHERE status IN ('starting', 'provisioning', 'ready') AND repo_id <> ?`,
      excludeRepoId,
    )?.total ?? 0
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

  createJob(input: { id: string; repoId: string; userId: string; trigger: string; goal: string; callbackHash: string; platformTokenHash: string; kind?: string; workType?: string; baseBranch?: string | null; workItemId?: string | null; priority?: number; baseSha?: string | null; retryAttempt?: number; retryOf?: string | null; ownerStarted?: boolean; createdAt?: string }): JobRow {
    // The ticket is taken inside the insert, so two jobs created at the same
    // instant cannot be handed the same one (#545).
    this.run(
      `INSERT INTO jobs (id, repo_id, user_id, status, trigger, goal, callback_hash, platform_token_hash, kind, work_type, base_branch, work_item_id, priority, queue_seq, base_sha, retry_attempt, retry_of, owner_started, created_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(queue_seq), 0) + 1 FROM jobs), ?, ?, ?, ?, ?)`,
      input.id,
      input.repoId,
      input.userId,
      input.trigger,
      input.goal,
      input.callbackHash,
      input.platformTokenHash,
      input.kind ?? 'iterate',
      input.workType ?? 'iterate',
      input.baseBranch ?? null,
      input.workItemId ?? null,
      input.priority ?? 0,
      input.baseSha ?? null,
      input.retryAttempt ?? 0,
      input.retryOf ?? null,
      input.ownerStarted === true ? 1 : 0,
      input.createdAt ?? nowIso(),
    )
    return this.getJob(input.id)!
  }

  getJob(id: string): JobRow | undefined {
    return this.get<JobRow>('SELECT * FROM jobs WHERE id = ?', id)
  }

  saveJobContext(input: {
    jobId: string
    repoId: string
    commitSha: string
    rulesJson: string
    manifestJson: string
    files: Array<{ path: string; sha256: string; bytes: number; content: string }>
  }): void {
    this.transaction(() => {
      this.run(
        `INSERT INTO job_contexts (job_id, repo_id, commit_sha, rules_json, manifest_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET repo_id = excluded.repo_id, commit_sha = excluded.commit_sha, rules_json = excluded.rules_json, manifest_json = excluded.manifest_json`,
        input.jobId,
        input.repoId,
        input.commitSha,
        input.rulesJson,
        input.manifestJson,
        nowIso(),
      )
      this.run('DELETE FROM job_context_files WHERE job_id = ?', input.jobId)
      for (const file of input.files) {
        this.run(
          'INSERT INTO job_context_files (job_id, path, sha256, bytes, content) VALUES (?, ?, ?, ?, ?)',
          input.jobId,
          file.path,
          file.sha256,
          file.bytes,
          file.content,
        )
      }
    })
  }

  getJobContext(jobId: string): JobContextRow | undefined {
    return this.get<JobContextRow>('SELECT * FROM job_contexts WHERE job_id = ?', jobId)
  }

  getJobContextFile(jobId: string, path: string): JobContextFileRow | undefined {
    return this.get<JobContextFileRow>('SELECT * FROM job_context_files WHERE job_id = ? AND path = ?', jobId, path)
  }

  listRepoRuleOverrides(repoId: string): RepoRuleOverrideRow[] {
    return this.all<RepoRuleOverrideRow>('SELECT * FROM repo_rule_overrides WHERE repo_id = ? ORDER BY path', repoId)
  }

  getRepoRuleOverride(repoId: string, path: string): RepoRuleOverrideRow | undefined {
    return this.get<RepoRuleOverrideRow>('SELECT * FROM repo_rule_overrides WHERE repo_id = ? AND path = ?', repoId, path)
  }

  upsertRepoRuleOverride(input: {
    repoId: string
    path: string
    content: string
    updatedBy: string
    expectedRevision: number
  }): { ok: true; row: RepoRuleOverrideRow } | { ok: false; code: 'rule_override_conflict'; current: RepoRuleOverrideRow | null; revision: number } {
    return this.transaction(() => {
      const current = this.getRepoRuleOverride(input.repoId, input.path) ?? null
      const revision = current?.revision ?? 0
      if (input.expectedRevision !== revision) {
        return { ok: false as const, code: 'rule_override_conflict' as const, current, revision }
      }
      const next = revision + 1
      this.run(
        `INSERT INTO repo_rule_overrides (repo_id, path, content, revision, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_id, path) DO UPDATE SET content = excluded.content, revision = excluded.revision, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        input.repoId,
        input.path,
        input.content,
        next,
        input.updatedBy,
        nowIso(),
      )
      return { ok: true as const, row: this.getRepoRuleOverride(input.repoId, input.path)! }
    })
  }

  deleteRepoRuleOverride(input: {
    repoId: string
    path: string
    expectedRevision: number
  }): { ok: true } | { ok: false; code: 'rule_override_conflict' | 'rule_override_missing'; current: RepoRuleOverrideRow | null; revision: number } {
    return this.transaction(() => {
      const current = this.getRepoRuleOverride(input.repoId, input.path) ?? null
      if (current === null) return { ok: false as const, code: 'rule_override_missing' as const, current, revision: 0 }
      if (input.expectedRevision !== current.revision) {
        return { ok: false as const, code: 'rule_override_conflict' as const, current, revision: current.revision }
      }
      this.run('DELETE FROM repo_rule_overrides WHERE repo_id = ? AND path = ?', input.repoId, input.path)
      return { ok: true as const }
    })
  }

  listJobs(userId: string, limit = 20): JobRow[] {
    return this.all<JobRow>('SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', userId, limit)
  }

  // #232: the dashboard filters by repository, status and kind in SQL so the
  // count and the page agree, and so the filters compose with the pagination
  // offset instead of slicing a filtered array in memory.
  private jobsForUserWhere(userId: string, filter?: { repo?: string; status?: string; kind?: string }): { sql: string; params: unknown[] } {
    const clauses = ['user_id = ?']
    const params: unknown[] = [userId]
    if (filter?.repo !== undefined && filter.repo !== '') {
      clauses.push('repo_id = ?')
      params.push(filter.repo)
    }
    if (filter?.status !== undefined && filter.status !== '') {
      clauses.push('status = ?')
      params.push(filter.status)
    }
    if (filter?.kind !== undefined && filter.kind !== '') {
      clauses.push('kind = ?')
      params.push(filter.kind)
    }
    return { sql: clauses.join(' AND '), params }
  }

  listJobsPageForUser(userId: string, limit: number, offset: number, filter?: { repo?: string; status?: string; kind?: string }): JobRow[] {
    const where = this.jobsForUserWhere(userId, filter)
    // #232: `created_at` is not unique — a batch of jobs seeded in the same
    // millisecond ties, and SQLite then has no stable order, so the same row can
    // leave page 1 and never appear on page 2. The shared `newestJobOrder` is
    // what the other job reads use, so a page and a "newest job" query agree.
    return this.all<JobRow>(`SELECT * FROM jobs WHERE ${where.sql} ORDER BY ${newestJobOrder('jobs')} LIMIT ? OFFSET ?`, ...where.params, limit, offset)
  }

  countJobsForUser(userId: string, filter?: { repo?: string; status?: string; kind?: string }): number {
    const where = this.jobsForUserWhere(userId, filter)
    return Number(this.get<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs WHERE ${where.sql}`, ...where.params)?.n ?? 0)
  }

  // #227: the first-run summary asks about this account's first job, not about a
  // page of recent jobs, so it reads the oldest row by created_at. The read is
  // all-time on purpose: a window-scoped count would give the same account two
  // different first-run conclusions depending on ?window. SQLite serves it from
  // jobs_user_idx (user_id, created_at DESC) by a reverse scan, so this is a
  // LIMIT 1 against an existing index and not a scan of the history.
  firstJobForUser(userId: string): JobRow | undefined {
    return this.get<JobRow>('SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at ASC LIMIT 1', userId)
  }

  listJobsSince(userId: string, sinceIso: string): JobRow[] {
    return this.all<JobRow>('SELECT * FROM jobs WHERE user_id = ? AND (created_at >= ? OR finished_at >= ?) ORDER BY created_at DESC', userId, sinceIso, sinceIso)
  }

  listJobsForRepo(repoId: string, limit = 20): JobRow[] {
    return this.all<JobRow>('SELECT * FROM jobs WHERE repo_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', repoId, limit)
  }

  // #360 review: a work item's job is looked up by the item, not through a window
  // of the repository's newest jobs. The window said "no job is attached" for a
  // work item whose job was older than the limit — a false statement, and a
  // refused control command. The newest row for the item is the one the console
  // shows, so `created_at DESC, rowid DESC` keeps the two surfaces agreeing.
  latestJobForWorkItem(workItemId: string): JobRow | undefined {
    return this.get<JobRow>('SELECT * FROM jobs WHERE work_item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', workItemId)
  }

  listPrJobsForRepo(repoId: string, limit = 20): JobRow[] {
    return this.all<JobRow>("SELECT * FROM jobs WHERE repo_id = ? AND pr_url IS NOT NULL AND kind = 'iterate' AND (pr_state IS NULL OR pr_state != 'merged') ORDER BY created_at DESC, rowid DESC LIMIT ?", repoId, limit)
  }

  // For each pull request URL, the one iterate job that decides its merge:
  // newer than every other row for that URL, with rowid breaking a tie. A pull
  // request that is already merged or closed is not a merge candidate at all —
  // the bulk merge would otherwise re-check it on every pass and report it as
  // skipped, and the scheduled reconciler already skips both states.
  listNewestPrJobsForRepo(repoId: string, limit = 20): JobRow[] {
    return this.all<JobRow>(
      `SELECT j.* FROM jobs AS j
       WHERE j.repo_id = ? AND j.pr_url IS NOT NULL AND j.kind = 'iterate'
         AND (j.pr_state IS NULL OR j.pr_state NOT IN ('merged', 'closed'))
         AND j.rowid = (SELECT j2.rowid FROM jobs AS j2
                        WHERE j2.repo_id = j.repo_id AND j2.pr_url = j.pr_url AND j2.kind = 'iterate'
                        ORDER BY ${newestJobOrder('j2')} LIMIT 1)
       ORDER BY ${newestJobOrder('j')} LIMIT ?`,
      repoId, limit,
    )
  }

  updateJobsPrState(prUrl: string, state: string): void {
    this.run('UPDATE jobs SET pr_state = ? WHERE pr_url = ?', state, prUrl)
  }

  listJobsPageForRepo(repoId: string, limit: number, offset: number): JobRow[] {
    return this.all<JobRow>('SELECT * FROM jobs WHERE repo_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?', repoId, limit, offset)
  }

  countJobsForRepo(repoId: string): number {
    return Number(this.get<{ n: number }>('SELECT COUNT(*) AS n FROM jobs WHERE repo_id = ?', repoId)?.n ?? 0)
  }

  latestJobByPrUrl(userId: string, prUrl: string): JobRow | undefined {
    return this.get<JobRow>(`SELECT * FROM jobs AS j WHERE j.user_id = ? AND j.pr_url = ? ORDER BY ${newestJobOrder('j')} LIMIT 1`, userId, prUrl)
  }

  newestIterateJobByPrUrl(userId: string, prUrl: string): JobRow | undefined {
    return this.get<JobRow>(`SELECT * FROM jobs AS j WHERE j.user_id = ? AND j.pr_url = ? AND j.kind = 'iterate' ORDER BY ${newestJobOrder('j')} LIMIT 1`, userId, prUrl)
  }

  createWorkItem(input: { id: string; repoId: string; userId: string; title: string; detail?: string; issueUrl?: string | null; prUrl?: string | null; state?: string; closedReason?: string | null; priority?: number; assigneeUserId?: string | null; jobId?: string | null; prState?: string | null; mergedAt?: string | null; mergeCommit?: string | null }): WorkItemRow {
    const at = nowIso()
    this.run(
      `INSERT INTO work_items (id, repo_id, user_id, title, detail, issue_url, pr_url, state, closed_reason, priority, assignee_user_id, job_id, pr_state, merged_at, merge_commit, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id, input.repoId, input.userId, input.title, input.detail ?? '', input.issueUrl ?? null, input.prUrl ?? null,
      input.state ?? 'proposed', input.closedReason ?? null, input.priority ?? 0, input.assigneeUserId ?? null, input.jobId ?? null,
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

  listOpenWorkItems(repoId: string): WorkItemRow[] {
    return this.all<WorkItemRow>("SELECT * FROM work_items WHERE repo_id = ? AND state NOT IN ('merged', 'closed') ORDER BY priority DESC, updated_at DESC", repoId)
  }

  // #359: every plan job that has waited for a decision since `finishedBeforeIso`,
  // oldest first. Approval and rejection are both decisions, so neither row is
  // returned: only a plan nobody answered can expire.
  unapprovedPlanJobs(finishedBeforeIso: string): JobRow[] {
    return this.all<JobRow>(
      "SELECT * FROM jobs WHERE kind = 'plan' AND status = 'succeeded' AND plan_approved_at IS NULL AND plan_rejected_at IS NULL AND finished_at IS NOT NULL AND finished_at <= ? ORDER BY finished_at ASC, rowid ASC",
      finishedBeforeIso,
    )
  }

  // #359: `finishedAfterIso` is the deadline cutoff, not a formatting choice.
  // Completion never clears `plan_approved_at`, so without it an expired plan
  // stays the oldest unapproved row forever and the page keeps naming a plan
  // whose deadline has already passed - even after a new plan exists.
  pendingPlanJob(repoId: string, finishedAfterIso: string): JobRow | undefined {
    return this.get<JobRow>(
      "SELECT * FROM jobs WHERE repo_id = ? AND kind = 'plan' AND status = 'succeeded' AND plan_approved_at IS NULL AND plan_rejected_at IS NULL AND finished_at IS NOT NULL AND finished_at > ? ORDER BY finished_at ASC, rowid ASC LIMIT 1",
      repoId,
      finishedAfterIso,
    )
  }

  updateWorkItem(id: string, patch: Partial<Pick<WorkItemRow, 'title' | 'detail' | 'issue_url' | 'pr_url' | 'state' | 'closed_reason' | 'priority' | 'assignee_user_id' | 'job_id' | 'pr_state' | 'merged_at' | 'merge_commit'>>): void {
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

  failedJobsSince(sinceIso: string, limit = 5000): JobRow[] {
    return this.all<JobRow>("SELECT * FROM jobs WHERE created_at >= ? AND status IN ('failed', 'quota_exhausted') ORDER BY created_at DESC, rowid DESC LIMIT ?", sinceIso, limit)
  }

  activeJobForRepo(repoId: string): JobRow | undefined {
    return this.get<JobRow>("SELECT * FROM jobs WHERE repo_id = ? AND status IN ('queued','running') ORDER BY created_at DESC, rowid DESC LIMIT 1", repoId)
  }

  listActiveJobsForUser(userId: string): JobRow[] {
    return this.all<JobRow>("SELECT * FROM jobs WHERE user_id = ? AND status IN ('queued','running') ORDER BY created_at DESC", userId)
  }

  // Priority, then ticket, then id: the ticket is the arrival order inside a
  // level, so two jobs created at the same instant still have a stable order and
  // a priority change is visible as a move to the tail (#545).
  listActiveJobs(): JobRow[] {
    return this.all<JobRow>("SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY priority DESC, queue_seq ASC, id ASC")
  }

  listQueuedJobs(): JobRow[] {
    return this.all<JobRow>("SELECT * FROM jobs WHERE status = 'queued' ORDER BY priority DESC, queue_seq ASC, id ASC")
  }

  // Durable dispatch foundation: one worker claims one queued job. The guarded
  // UPDATE repeats the lease predicate from the SELECT, so two workers cannot
  // claim the same row; BEGIN IMMEDIATE serializes SQLite writers.
  claimQueuedJob(owner: string, leaseMs: number): JobRow | undefined {
    return this.transaction(() => {
      const now = nowIso()
      const until = new Date(Date.now() + Math.max(1, leaseMs)).toISOString()
      const row = this.get<JobRow>(
        `SELECT * FROM jobs j
         WHERE j.status = 'queued' AND (j.lease_until IS NULL OR j.lease_until < ?)
           AND NOT EXISTS (
             SELECT 1 FROM jobs x
             WHERE x.repo_id = j.repo_id AND x.id != j.id AND (
               x.status = 'running'
               OR (x.status = 'queued' AND (
                 x.priority > j.priority
                 OR (x.priority = j.priority AND (
                   x.queue_seq < j.queue_seq
                   OR (x.queue_seq = j.queue_seq AND x.id < j.id)
                 ))
               ))
             )
           )
         ORDER BY j.priority DESC, j.queue_seq ASC, j.id ASC LIMIT 1`,
        now,
      )
      if (row === undefined) return undefined
      const changes = this.runChanges(
        "UPDATE jobs SET lease_owner = ?, lease_until = ? WHERE id = ? AND status = 'queued' AND (lease_until IS NULL OR lease_until < ?)",
        owner,
        until,
        row.id,
        now,
      )
      return changes === 1 ? this.getJob(row.id) : undefined
    })
  }

  countRunningJobs(): number {
    return this.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'running'")?.n ?? 0
  }

  countQueuedJobs(): number {
    return this.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'")?.n ?? 0
  }

  countQueuedJobsForUser(userId: string): number {
    return this.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued' AND user_id = ?", userId)?.n ?? 0
  }

  renewJobLease(id: string, owner: string, leaseMs: number): boolean {
    const until = new Date(Date.now() + Math.max(1, leaseMs)).toISOString()
    return this.runChanges(
      "UPDATE jobs SET lease_until = ? WHERE id = ? AND lease_owner = ? AND status IN ('queued','running')",
      until,
      id,
      owner,
    ) === 1
  }

  releaseJobLease(id: string): void {
    this.run('UPDATE jobs SET lease_owner = NULL, lease_until = NULL WHERE id = ?', id)
  }

  expiredLeaseJobs(beforeIso: string): JobRow[] {
    return this.all<JobRow>(
      "SELECT * FROM jobs WHERE status IN ('queued','running') AND lease_until IS NOT NULL AND lease_until < ?",
      beforeIso,
    )
  }


  updateJob(id: string, patch: Partial<Pick<JobRow, 'status' | 'branch' | 'pr_url' | 'issue_url' | 'pr_state' | 'review_score' | 'attribution_json' | 'evidence_json' | 'checkpoint' | 'team_stats_json' | 'summary' | 'error' | 'error_code' | 'cost_usd' | 'started_at' | 'last_callback_at' | 'finished_at' | 'base_branch' | 'work_item_id' | 'priority' | 'plan_approved_at' | 'plan_approved_by' | 'plan_rejected_at' | 'plan_allow_paths' | 'plan_deny_paths' | 'base_sha' | 'path_guard_json' | 'verification_json' | 'continuity_json' | 'model_json' | 'provider_model' | 'provider_region' | 'provider_label' | 'provider_id' | 'output_kind' | 'work_type' | 'triage_json' | 'continuity_used' | 'retry_attempt' | 'retry_of' | 'lease_owner' | 'lease_until' | 'callback_secret_enc' | 'platform_token_enc'>>): void {
    const entries = Object.entries(redactJobText(patch as Record<string, unknown>)).filter(([, value]) => value !== undefined)
    if (entries.length === 0) return
    const sets: string[] = []
    const values: unknown[] = []
    for (const [key, value] of entries) {
      // A real priority change is an arrival at the new level, so it takes a
      // ticket at that level's tail; saving the same value again is not a move
      // and keeps the ticket the row already holds (#545).
      if (key === 'priority') {
        const current = this.get<{ priority: number }>('SELECT priority FROM jobs WHERE id = ?', id)?.priority
        sets.push('priority = ?')
        values.push(value)
        if (current !== undefined && current !== value) sets.push('queue_seq = (SELECT COALESCE(MAX(queue_seq), 0) + 1 FROM jobs)')
        continue
      }
      sets.push(`${key} = ?`)
      values.push(value)
    }
    this.run(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`, ...values, id)
  }

  // Returns the number of rows the statement changed, which is how a guarded
  // transition reports whether this caller won it.
  runChanges(sql: string, ...params: unknown[]): number {
    return Number(this.db.prepare(sql).run(...clean(params)).changes ?? 0)
  }

  // The terminal transition is the callback idempotency key: only the delivery
  // that moves the row out of queued/running may run side effects.
  claimJobTerminal(jobId: string, status: string, fingerprint: string | null, patch: Record<string, unknown>): boolean {
    const entries = Object.entries(redactJobText({ ...patch, status, ...(fingerprint === null ? {} : { callback_fingerprint: fingerprint }) })).filter(([, value]) => value !== undefined)
    const sets = entries.map(([key]) => `${key} = ?`).join(', ')
    const changes = this.runChanges(
      `UPDATE jobs SET ${sets} WHERE id = ? AND status IN ('queued','running')`,
      ...entries.map(([, value]) => value),
      jobId,
    )
    return changes === 1
  }

  countActiveJobs(): number {
    const row = this.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')")
    return Number(row?.n ?? 0)
  }

  staleRunningJobs(beforeIso: string): JobRow[] {
    return this.all<JobRow>("SELECT * FROM jobs WHERE status = 'running' AND COALESCE(started_at, created_at) < ?", beforeIso)
  }

  stalledRunningJobs(beforeIso: string): JobRow[] {
    return this.all<JobRow>("SELECT * FROM jobs WHERE status = 'running' AND COALESCE(last_callback_at, started_at, created_at) < ?", beforeIso)
  }

  touchJobCallback(jobId: string): void {
    this.run('UPDATE jobs SET last_callback_at = ? WHERE id = ?', nowIso(), jobId)
  }

  markRepoCredential(repoId: string, state: 'ok' | 'invalid'): void {
    this.run('UPDATE repos SET credential_state = ? WHERE id = ?', state, repoId)
  }

  incrementRepoFailures(repoId: string): number {
    return this.transaction(() => {
      this.run('UPDATE repos SET consecutive_failures = consecutive_failures + 1 WHERE id = ?', repoId)
      return Number(this.get<{ n: number }>('SELECT consecutive_failures AS n FROM repos WHERE id = ?', repoId)?.n ?? 0)
    })
  }

  resetRepoFailures(repoId: string): void {
    this.run('UPDATE repos SET consecutive_failures = 0 WHERE id = ?', repoId)
  }

  staleQueuedJobs(beforeIso: string): JobRow[] {
    return this.all<JobRow>("SELECT * FROM jobs WHERE status = 'queued' AND created_at < ?", beforeIso)
  }

  createApiToken(input: { id: string; userId: string; kind: string; name: string; tokenHash: string; prefix: string; repoId?: string | null; scope?: string; expiresAt: string | null }): ApiTokenRow {
    this.run(
      'INSERT INTO api_tokens (id, user_id, kind, name, token_hash, prefix, repo_id, scope, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      input.id,
      input.userId,
      input.kind,
      input.name,
      input.tokenHash,
      input.prefix,
      input.repoId ?? null,
      input.scope ?? 'gateway',
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

  claimWebhookDelivery(deliveryId: string, event: string, action: string | null, input: { payloadJson?: string | null; repositoryFullName?: string | null; installationId?: number | null } = {}): boolean {
    const existing = this.get<{ status: string; received_at: string }>('SELECT status, received_at FROM webhook_deliveries WHERE delivery_id = ?', deliveryId)
    if (existing !== undefined && existing.status === 'processing' && Date.now() - Date.parse(existing.received_at) > 5 * 60_000) {
      this.run("UPDATE webhook_deliveries SET received_at = ?, processed_at = NULL, error = NULL WHERE delivery_id = ?", nowIso(), deliveryId)
      return true
    }
    if (existing === undefined) {
      this.run(
        'INSERT INTO webhook_deliveries (delivery_id, event, action, received_at, processed_at, status, error, payload_json, repository_full_name, installation_id) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?)',
        deliveryId,
        event,
        action,
        nowIso(),
        'processing',
        input.payloadJson === undefined ? null : input.payloadJson,
        input.repositoryFullName ?? null,
        input.installationId ?? null,
      )
      return true
    }
    if (existing.status === 'failed') {
      this.run("UPDATE webhook_deliveries SET status = 'processing', received_at = ?, processed_at = NULL, error = NULL WHERE delivery_id = ?", nowIso(), deliveryId)
      return true
    }
    return false
  }

  getWebhookDelivery(deliveryId: string): { delivery_id: string; event: string; action: string | null; received_at: string; processed_at: string | null; status: string; error: string | null; payload_json: string | null; repository_full_name: string | null; installation_id: number | null } | undefined {
    return this.get('SELECT * FROM webhook_deliveries WHERE delivery_id = ?', deliveryId) as never
  }

  listWebhookDeliveries(filters: { status?: string; event?: string }, limit: number, offset: number): Array<{ delivery_id: string; event: string; action: string | null; received_at: string; processed_at: string | null; status: string; error: string | null; payload_json: string | null; repository_full_name: string | null; installation_id: number | null }> {
    const where: string[] = []
    const params: unknown[] = []
    if (filters.status !== undefined && filters.status !== '') { where.push('status = ?'); params.push(filters.status) }
    if (filters.event !== undefined && filters.event !== '') { where.push('event = ?'); params.push(filters.event) }
    const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`
    return this.all(`SELECT * FROM webhook_deliveries ${clause} ORDER BY received_at DESC LIMIT ? OFFSET ?`, ...params, limit, offset) as never
  }

  countWebhookDeliveries(filters: { status?: string; event?: string }): number {
    const where: string[] = []
    const params: unknown[] = []
    if (filters.status !== undefined && filters.status !== '') { where.push('status = ?'); params.push(filters.status) }
    if (filters.event !== undefined && filters.event !== '') { where.push('event = ?'); params.push(filters.event) }
    const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`
    return Number(this.get<{ n: number }>(`SELECT COUNT(*) AS n FROM webhook_deliveries ${clause}`, ...params)?.n ?? 0)
  }

  finishWebhookDelivery(deliveryId: string, status: 'processed' | 'ignored' | 'failed', error: string | null = null): void {
    this.run('UPDATE webhook_deliveries SET status = ?, processed_at = ?, error = ? WHERE delivery_id = ?', status, nowIso(), error === null ? null : error.slice(0, 1000), deliveryId)
  }

  cleanupOrphans(): { retries: number; followups: number; jobEvents: number; instances: number } {
    const jobs = new Set(this.all<{ id: string }>('SELECT id FROM jobs').map((row) => row.id))
    const repos = new Set(this.all<{ id: string }>('SELECT id FROM repos').map((row) => row.id))
    let retries = 0
    for (const row of this.listSettings('retry_pending:')) {
      if (jobs.has(row.key.slice('retry_pending:'.length))) continue
      this.deleteSetting(row.key)
      retries += 1
    }
    let followups = 0
    for (const row of this.listSettings('merge_reconcile:')) {
      if (jobs.has(row.key.slice('merge_reconcile:'.length))) continue
      this.deleteSetting(row.key)
      followups += 1
    }
    for (const row of this.listSettings('pending_followup:')) {
      const repoId = row.key.split(':')[1] ?? ''
      if (repos.has(repoId)) continue
      this.deleteSetting(row.key)
      followups += 1
    }
    const jobEvents = this.runChanges('DELETE FROM job_events WHERE job_id NOT IN (SELECT id FROM jobs)')
    const instances = this.runChanges('DELETE FROM repo_instances WHERE repo_id NOT IN (SELECT id FROM repos)')
    this.deleteExpiredJobTokens()
    return { retries, followups, jobEvents, instances }
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
    this.run('DELETE FROM job_events WHERE at < ?', cutoff(365))
    this.run('DELETE FROM webhook_deliveries WHERE received_at < ?', cutoff(30))
    this.run("DELETE FROM jobs WHERE status IN ('succeeded', 'failed', 'quota_exhausted') AND finished_at IS NOT NULL AND finished_at < ?", cutoff(365))
    this.run('DELETE FROM audit_log WHERE at < ?', cutoff(365))
    this.run('DELETE FROM quota_ledger WHERE at < ?', cutoff(730))
    // #419: the prefix list and the cutoff table were two hand-kept copies of
    // one mapping, so a key could be written without either half ever selecting
    // it. `plan_expired:` and `plan_reminded:` are written per unapproved plan
    // by `expirePlans` and sat outside the SELECT, so one row per plan stayed in
    // `settings` forever. One table now feeds both the query and the cutoffs, so
    // a prefix cannot half-exist again.
    //
    // `merge_reconcile:`, `retry_pending:` and `pending_followup:` are not here
    // on purpose: they are reclaimed when the job they name is gone
    // (`reconcileOrphans`), not by age. `merge_reconcile:` also throttles the
    // merge pass, so its age is not a retention signal.
    const SETTINGS_RETENTION: ReadonlyArray<readonly [string, number]> = [
      ['followup:', 30],
      ['question_notified:', 30],
      ['digest_sent:', 14],
      ['email_test:', 1],
      ['webhook_delivery:', 30],
      ['email_reply:', 7],
      ['github_app_state:', 1],
      ['installation_sender:', 30],
      // A plan marker is read only while its job is unapproved, which ends at
      // the plan deadline; the job row itself is kept for 365 days, so the
      // marker gets the same window from the moment it was written.
      ['plan_reminded:', 365],
      ['plan_expired:', 365],
    ]
    const settings = this.all<{ key: string; value: string }>(
      `SELECT key, value FROM settings WHERE ${SETTINGS_RETENTION.map(([prefix]) => `key LIKE '${prefix}%'`).join(' OR ')}`,
    )
    for (const row of settings) {
      const days = SETTINGS_RETENTION.find(([prefix]) => row.key.startsWith(prefix))?.[1]
      if (days === undefined) continue
      const raw = row.value.slice(row.value.lastIndexOf(':') + 1)
      const at = /^\d{4}-\d{2}-\d{2}T/.test(row.value) ? Date.parse(row.value) : Number(raw)
      if (!Number.isFinite(at) || at === 0) continue
      const iso = at > 10_000_000_000 ? new Date(at).toISOString() : row.value
      if (iso < cutoff(days)) this.run('DELETE FROM settings WHERE key = ?', row.key)
    }
  }

  deleteExpiredJobTokens(): void {
    this.run("UPDATE api_tokens SET revoked_at = ? WHERE kind = 'job' AND (expires_at IS NOT NULL AND expires_at <= ?) AND revoked_at IS NULL", nowIso(), nowIso())
  }

  recordUsage(userId: string, jobId: string | null, costUsd: number, meta: string | null = null, repoId: string | null = null): void {
    this.transaction(() => {
      this.run('INSERT INTO quota_ledger (at, user_id, job_id, repo_id, cost_usd, meta) VALUES (?, ?, ?, ?, ?, ?)', nowIso(), userId, jobId, repoId, costUsd, meta)
      this.run('UPDATE users SET quota_used_usd = quota_used_usd + ? WHERE id = ?', costUsd, userId)
    })
  }

  repoUsageSince(repoId: string, sinceIso: string): number {
    const row = this.get<{ total: number | null }>(
      'SELECT SUM(q.cost_usd) AS total FROM quota_ledger q LEFT JOIN jobs j ON j.id = q.job_id WHERE COALESCE(q.repo_id, j.repo_id) = ? AND q.at >= ?',
      repoId, sinceIso,
    )
    return Number(row?.total ?? 0)
  }

  usageAttribution(sinceIso: string): { unattributedCount: number; unattributedUsd: number; attributedUsd: number } {
    const unattributed = this.get<{ n: number; total: number | null }>("SELECT COUNT(*) AS n, SUM(cost_usd) AS total FROM quota_ledger WHERE repo_id IS NULL AND job_id IS NULL AND at >= ?", sinceIso)
    const attributed = this.get<{ total: number | null }>("SELECT SUM(cost_usd) AS total FROM quota_ledger WHERE (repo_id IS NOT NULL OR job_id IS NOT NULL) AND at >= ?", sinceIso)
    return {
      unattributedCount: Number(unattributed?.n ?? 0),
      unattributedUsd: Number(unattributed?.total ?? 0),
      attributedUsd: Number(attributed?.total ?? 0),
    }
  }

  stageMetrics(sinceIso: string): { scope: number; verify: number; iterate: number; review: number; leadOnly: number; grounded: number } {
    const counts = new Map(this.all<{ kind: string; n: number }>('SELECT kind, COUNT(*) AS n FROM jobs WHERE created_at >= ? GROUP BY kind', sinceIso).map((row) => [row.kind, Number(row.n)]))
    const events = new Map(this.all<{ name: string; n: number }>("SELECT name, COUNT(*) AS n FROM events WHERE at >= ? AND name IN ('team_participation_low', 'team_attribution_grounded') GROUP BY name", sinceIso).map((row) => [row.name, Number(row.n)]))
    return {
      scope: counts.get('scope') ?? 0,
      verify: counts.get('verify') ?? 0,
      iterate: counts.get('iterate') ?? 0,
      review: counts.get('review') ?? 0,
      leadOnly: events.get('team_participation_low') ?? 0,
      grounded: events.get('team_attribution_grounded') ?? 0,
    }
  }

  usageTotal(userId: string): number {
    const row = this.get<{ total: number | null }>('SELECT SUM(cost_usd) AS total FROM quota_ledger WHERE user_id = ?', userId)
    return Number(row?.total ?? 0)
  }

  usageSince(userId: string, sinceIso: string): number {
    const row = this.get<{ total: number | null }>('SELECT SUM(cost_usd) AS total FROM quota_ledger WHERE user_id = ? AND at >= ?', userId, sinceIso)
    return Number(row?.total ?? 0)
  }

  usageCountForJob(jobId: string): number {
    return Number(this.get<{ n: number }>('SELECT COUNT(*) AS n FROM quota_ledger WHERE job_id = ?', jobId)?.n ?? 0)
  }

  usageForJob(jobId: string): number {
    const row = this.get<{ total: number | null }>('SELECT SUM(cost_usd) AS total FROM quota_ledger WHERE job_id = ?', jobId)
    return Number(row?.total ?? 0)
  }

  notify(userId: string, kind: string, message: string, code: string | null = null): void {
    this.run('INSERT INTO notifications (id, user_id, kind, message, code, created_at) VALUES (?, ?, ?, ?, ?, ?)', `ntf_${randomBytes(6).toString('hex')}`, userId, kind, message, code, nowIso())
  }

  listNotifications(userId: string, limit = 20): NotificationRow[] {
    return this.all<NotificationRow>('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', userId, limit)
  }

  markNotificationsRead(userId: string): void {
    this.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', nowIso(), userId)
  }

  markQuestionNotificationsRead(userId: string): void {
    this.run("UPDATE notifications SET read_at = ? WHERE user_id = ? AND kind = 'job' AND message LIKE '%团队提问%' AND read_at IS NULL", nowIso(), userId)
  }

  audit(userId: string | null, action: string, detail: string | null = null): void {
    this.run('INSERT INTO audit_log (at, user_id, action, detail) VALUES (?, ?, ?, ?)', nowIso(), userId, action, detail)
  }

  // #540: a resource's revision is 1 until something bumps it, so a page rendered
  // for a row written before this table existed still carries a usable number.
  revisionOf(resourceType: string, resourceId: string): number {
    const row = this.get<{ revision: number }>('SELECT revision FROM resource_revisions WHERE resource_type = ? AND resource_id = ?', resourceType, resourceId)
    return Number(row?.revision ?? 1)
  }

  // The first bump takes a resource from the implicit 1 to 2; later bumps add one.
  // Called inside the write's transaction so a failed write cannot move the fence.
  bumpRevision(resourceType: string, resourceId: string): number {
    this.run(
      `INSERT INTO resource_revisions (resource_type, resource_id, revision, updated_at) VALUES (?, ?, 2, ?)
       ON CONFLICT(resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at`,
      resourceType,
      resourceId,
      nowIso(),
    )
    return this.revisionOf(resourceType, resourceId)
  }

  insertCommandReceipt(input: {
    id: string
    principalId: string
    channel: string
    idempotencyScope: string
    idempotencyKey: string
    requestHash: string
    operation: string
    targetJson: string
    argumentsJson: string
    expectedRevision: number
    beforeRevision: number | null
    sourceConversation?: string | null
    sourceMessage?: string | null
  }): void {
    const at = nowIso()
    this.run(
      `INSERT INTO management_commands (id, principal_id, channel, idempotency_scope, idempotency_key, request_hash, operation, target_json, arguments_json, expected_revision, before_revision, status, source_conversation, source_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?, ?)`,
      input.id,
      input.principalId,
      input.channel,
      input.idempotencyScope,
      input.idempotencyKey,
      input.requestHash,
      input.operation,
      input.targetJson,
      input.argumentsJson,
      input.expectedRevision,
      input.beforeRevision,
      input.sourceConversation ?? null,
      input.sourceMessage ?? null,
      at,
      at,
    )
  }

  updateCommandReceipt(id: string, patch: Partial<Pick<ManagementCommandRow, 'status' | 'result_json' | 'error_code' | 'error_message' | 'after_revision' | 'before_revision'>>): void {
    const columns = ['status', 'result_json', 'error_code', 'error_message', 'after_revision', 'before_revision'] as const
    const entries = columns.filter((column) => patch[column] !== undefined)
    if (entries.length === 0) return
    const assignments = entries.map((column) => `${column} = ?`).join(', ')
    this.run(`UPDATE management_commands SET ${assignments}, updated_at = ? WHERE id = ?`, ...entries.map((column) => patch[column] as string | number | null), nowIso(), id)
  }

  commandReceipt(id: string): ManagementCommandRow | undefined {
    return this.get<ManagementCommandRow>('SELECT * FROM management_commands WHERE id = ?', id)
  }

  // The unique (scope, key) index is what makes a replay safe: two callers race
  // to insert, one wins, and both read the winner's receipt.
  commandReceiptByKey(scope: string, key: string): ManagementCommandRow | undefined {
    return this.get<ManagementCommandRow>('SELECT * FROM management_commands WHERE idempotency_scope = ? AND idempotency_key = ?', scope, key)
  }

  listCommandReceipts(limit = 50): ManagementCommandRow[] {
    return this.all<ManagementCommandRow>('SELECT * FROM management_commands ORDER BY created_at DESC, rowid DESC LIMIT ?', limit)
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

  private auditFilter(userIds: string[] | null, filters: { q?: string; action?: string; from?: string; to?: string }, limit: number, offset: number, count: boolean): { sql: string; params: Array<string | number> } {
    const clauses: string[] = []
    const params: Array<string | number> = []
    if (userIds !== null) {
      if (userIds.length === 0) return { sql: count ? 'SELECT 0 AS n' : 'SELECT * FROM audit_log WHERE 0', params: [] }
      clauses.push(`user_id IN (${userIds.map(() => '?').join(', ')})`)
      params.push(...userIds)
    }
    if (filters.q !== undefined && filters.q !== '') {
      clauses.push('(action LIKE ? OR detail LIKE ?)')
      params.push(`%${filters.q}%`, `%${filters.q}%`)
    }
    if (filters.action !== undefined && filters.action !== '') {
      clauses.push('action LIKE ?')
      params.push(`${filters.action}%`)
    }
    if (filters.from !== undefined && filters.from !== '') {
      clauses.push('at >= ?')
      params.push(filters.from)
    }
    if (filters.to !== undefined && filters.to !== '') {
      clauses.push('at <= ?')
      params.push(filters.to)
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
    if (count) return { sql: `SELECT COUNT(*) AS n FROM audit_log${where}`, params }
    return { sql: `SELECT * FROM audit_log${where} ORDER BY id DESC LIMIT ? OFFSET ?`, params: [...params, limit, offset] }
  }

  searchAudit(userIds: string[] | null, filters: { q?: string; action?: string; from?: string; to?: string }, limit: number, offset: number): AuditRow[] {
    const query = this.auditFilter(userIds, filters, limit, offset, false)
    return this.all<AuditRow>(query.sql, ...query.params)
  }

  countSearchAudit(userIds: string[] | null, filters: { q?: string; action?: string; from?: string; to?: string }): number {
    const query = this.auditFilter(userIds, filters, 0, 0, true)
    return Number(this.get<{ n: number }>(query.sql, ...query.params)?.n ?? 0)
  }

  private jobFilter(userIds: string[] | null, filters: { q?: string; status?: string; kind?: string }, limit: number, offset: number, count: boolean): { sql: string; params: Array<string | number> } {
    const clauses: string[] = []
    const params: Array<string | number> = []
    if (userIds !== null) {
      if (userIds.length === 0) return { sql: count ? 'SELECT 0 AS n' : 'SELECT * FROM jobs WHERE 0', params: [] }
      clauses.push(`user_id IN (${userIds.map(() => '?').join(', ')})`)
      params.push(...userIds)
    }
    if (filters.q !== undefined && filters.q !== '') {
      clauses.push(`(goal LIKE ? OR summary LIKE ? OR pr_url LIKE ? OR issue_url LIKE ? OR repo_id IN (SELECT id FROM repos WHERE lower(owner || '/' || name) LIKE ?))`)
      params.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`)
    }
    if (filters.status !== undefined && filters.status !== '') {
      clauses.push('status = ?')
      params.push(filters.status)
    }
    if (filters.kind !== undefined && filters.kind !== '') {
      clauses.push('kind = ?')
      params.push(filters.kind)
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
    if (count) return { sql: `SELECT COUNT(*) AS n FROM jobs${where}`, params }
    return { sql: `SELECT * FROM jobs${where} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`, params: [...params, limit, offset] }
  }

  searchJobs(userIds: string[] | null, filters: { q?: string; status?: string; kind?: string }, limit: number, offset: number): JobRow[] {
    const query = this.jobFilter(userIds, filters, limit, offset, false)
    return this.all<JobRow>(query.sql, ...query.params)
  }

  countSearchJobs(userIds: string[] | null, filters: { q?: string; status?: string; kind?: string }): number {
    const query = this.jobFilter(userIds, filters, 0, 0, true)
    return Number(this.get<{ n: number }>(query.sql, ...query.params)?.n ?? 0)
  }

  // #362: the owner-facing search. It takes no user list — every clause is anchored
  // on the signed-in `user_id`, so `adminVisibleUserIds` cannot widen it — and
  // `filters.q` is text, so LIKE wildcards are escaped. `cap + 1` rows per section
  // let the page state the cap without a second count query.
  searchOwned(userId: string, filters: OwnedSearchFilters, cap: number): OwnedSearch {
    const like = likePattern(filters.q)
    // The shared tail: the date range on the section's own timestamp, plus the
    // repository clause for the three tables that own one. Audit rows carry no
    // repository, so that filter does not narrow them and the page says so.
    const tail = (column: string, repoColumn: string | null): { sql: string; params: string[] } => {
      const parts: Array<[string, string]> = []
      if (repoColumn !== null && filters.repo !== '') parts.push([`${repoColumn} = ?`, filters.repo])
      if (filters.from !== '') parts.push([`${column} >= ?`, filters.from])
      if (filters.to !== '') parts.push([`${column} <= ?`, filters.to])
      return { sql: parts.map(([clause]) => ` AND ${clause}`).join(''), params: parts.map(([, value]) => value) }
    }
    const section = <T>(rows: T[]): OwnedSearchSection<T> => ({ rows: rows.slice(0, cap), capped: rows.length > cap })
    const read = <T>(sql: string, params: Array<string | number>): OwnedSearchSection<T> => section(this.all<T>(`${sql} LIMIT ?`, ...params, cap + 1))
    const repo = tail('created_at', 'id')
    const job = tail('created_at', 'repo_id')
    const item = tail('updated_at', 'repo_id')
    const audit = tail('at', null)
    return {
      repos: read<SearchRepoRow>(`SELECT id, owner, name, enabled FROM repos WHERE user_id = ? AND (name LIKE ? ESCAPE '\\' OR owner || '/' || name LIKE ? ESCAPE '\\' OR goal LIKE ? ESCAPE '\\')${repo.sql} ORDER BY name, id`, [userId, like, like, like, ...repo.params]),
      jobs: read<SearchJobRow>(`SELECT id, repo_id, status, kind, goal, summary, error, pr_url, issue_url, created_at FROM jobs WHERE user_id = ? AND (id LIKE ? ESCAPE '\\' OR goal LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR error LIKE ? ESCAPE '\\' OR pr_url LIKE ? ESCAPE '\\' OR issue_url LIKE ? ESCAPE '\\')${filters.status === '' ? '' : ' AND status = ?'}${filters.kind === '' ? '' : ' AND kind = ?'}${job.sql} ORDER BY created_at DESC, rowid DESC`, [userId, like, like, like, like, like, like, ...(filters.status === '' ? [] : [filters.status]), ...(filters.kind === '' ? [] : [filters.kind]), ...job.params]),
      workItems: read<SearchWorkItemRow>(`SELECT id, repo_id, title, state, issue_url, pr_url, updated_at FROM work_items WHERE user_id = ? AND (title LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\' OR issue_url LIKE ? ESCAPE '\\' OR pr_url LIKE ? ESCAPE '\\')${item.sql} ORDER BY updated_at DESC`, [userId, like, like, like, like, ...item.params]),
      audit: read<SearchAuditRow>(`SELECT id, at, action, detail FROM audit_log WHERE user_id = ? AND (action LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\')${audit.sql} ORDER BY id DESC`, [userId, like, like, ...audit.params]),
    }
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
