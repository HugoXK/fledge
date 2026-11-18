// #281: the age windows `pruneOldData` enforces, in one table.
//
// The store, the read-only dry-run tool and the admin page all read this file.
// A window that can delete rows and a window that a preview reports must be the
// same number and the same predicate, or the preview is a guess; keeping them in
// one place is what makes `scripts/retention.mjs --days N` honest about what a
// deploy will do.
//
// `defaultDays` is the literal this service shipped with, and it is also the
// effective value when the env var is unset: "unset" must never mean "keep
// forever", because that would silently stop deleting rows that are deleted
// today.

/**
 * One retention class. `where` returns the SQL after `WHERE` plus its params;
 * it receives the run instant and the cutoff so a predicate that compares
 * against "now" (an expired approval token) cannot accidentally compare against
 * the cutoff instead.
 */
export const RETENTION_CLASSES = [
  {
    id: 'oauthStates',
    key: 'oauth_states',
    table: 'oauth_states',
    env: 'RETENTION_OAUTH_STATES_DAYS',
    defaultDays: 7,
    label: ['OAuth 状态', 'OAuth states'],
    where: ({ cutoff }) => ({ sql: 'created_at < ?', params: [cutoff] }),
  },
  {
    id: 'approvalTokens',
    key: 'approval_tokens',
    table: 'approval_tokens',
    env: 'RETENTION_APPROVAL_TOKENS_DAYS',
    defaultDays: 30,
    label: ['审批令牌', 'Approval tokens'],
    where: ({ now, cutoff }) => ({ sql: '(expires_at < ? OR used_at IS NOT NULL) AND created_at < ?', params: [now, cutoff] }),
  },
  {
    id: 'notificationsRead',
    key: 'notifications_read',
    table: 'notifications',
    env: 'RETENTION_NOTIFICATIONS_READ_DAYS',
    defaultDays: 30,
    label: ['已读通知', 'Read notifications'],
    where: ({ cutoff }) => ({ sql: 'read_at IS NOT NULL AND created_at < ?', params: [cutoff] }),
  },
  {
    id: 'notificationsUnread',
    key: 'notifications_unread',
    table: 'notifications',
    env: 'RETENTION_NOTIFICATIONS_UNREAD_DAYS',
    defaultDays: 90,
    label: ['未读通知', 'Unread notifications'],
    where: ({ cutoff }) => ({ sql: 'read_at IS NULL AND created_at < ?', params: [cutoff] }),
  },
  {
    id: 'events',
    key: 'events',
    table: 'events',
    env: 'RETENTION_EVENTS_DAYS',
    defaultDays: 90,
    label: ['事件', 'Events'],
    where: ({ cutoff }) => ({ sql: 'at < ?', params: [cutoff] }),
  },
  {
    id: 'jobEvents',
    key: 'job_events',
    table: 'job_events',
    env: 'RETENTION_JOB_EVENTS_DAYS',
    defaultDays: 365,
    label: ['任务事件', 'Job events'],
    where: ({ cutoff }) => ({ sql: 'at < ?', params: [cutoff] }),
  },
  {
    id: 'webhookDeliveries',
    key: 'webhook_deliveries',
    table: 'webhook_deliveries',
    env: 'RETENTION_WEBHOOK_DELIVERIES_DAYS',
    defaultDays: 30,
    label: ['入站 Webhook 投递', 'Inbound webhook deliveries'],
    where: ({ cutoff }) => ({ sql: 'received_at < ?', params: [cutoff] }),
  },
  // #544 slice 7: a delivered notification is a receipt, so it goes with the
  // other 30-day receipts. The unresolved states are kept longer because they
  // are what a human still has to look at; `unknown` keeps its full window so
  // the duplicate risk stays visible instead of ageing out with the sent rows.
  {
    id: 'outboxSent',
    key: 'outbox_sent',
    table: 'notification_outbox',
    env: 'RETENTION_OUTBOX_SENT_DAYS',
    defaultDays: 30,
    label: ['发件箱 · 已发送', 'Outbox · sent'],
    where: ({ cutoff }) => ({ sql: "state = 'sent' AND created_at < ?", params: [cutoff] }),
  },
  {
    id: 'outboxDead',
    key: 'outbox_dead',
    table: 'notification_outbox',
    env: 'RETENTION_OUTBOX_DEAD_DAYS',
    defaultDays: 90,
    label: ['发件箱 · 受阻', 'Outbox · dead or blocked'],
    where: ({ cutoff }) => ({ sql: "state IN ('dead', 'blocked') AND created_at < ?", params: [cutoff] }),
  },
  {
    id: 'outboxUnknown',
    key: 'outbox_unknown',
    table: 'notification_outbox',
    env: 'RETENTION_OUTBOX_UNKNOWN_DAYS',
    defaultDays: 365,
    label: ['发件箱 · 结果未知', 'Outbox · unknown'],
    where: ({ cutoff }) => ({ sql: "state = 'unknown' AND created_at < ?", params: [cutoff] }),
  },
  {
    id: 'jobs',
    key: 'jobs',
    table: 'jobs',
    env: 'RETENTION_JOBS_DAYS',
    defaultDays: 365,
    label: ['任务', 'Jobs'],
    where: ({ cutoff }) => ({ sql: "status IN ('succeeded', 'failed', 'quota_exhausted') AND finished_at IS NOT NULL AND finished_at < ?", params: [cutoff] }),
  },
  {
    id: 'auditLog',
    key: 'audit_log',
    table: 'audit_log',
    env: 'RETENTION_AUDIT_LOG_DAYS',
    defaultDays: 365,
    label: ['审计日志', 'Audit log'],
    where: ({ cutoff }) => ({ sql: 'at < ?', params: [cutoff] }),
  },
  {
    id: 'quotaLedger',
    key: 'quota_ledger',
    table: 'quota_ledger',
    env: 'RETENTION_QUOTA_LEDGER_DAYS',
    defaultDays: 730,
    label: ['额度流水', 'Quota ledger'],
    where: ({ cutoff }) => ({ sql: 'at < ?', params: [cutoff] }),
  },
]

// #1008: the second retention table. `pruneOldData` also removes markers kept in
// `settings` — ten prefix families, each with its own window — and the preview
// counted none of them, so an operator read "nothing to delete" while a pass
// removed user-visible markers. The table lives here, beside the classes above,
// because the same honesty rule applies: the rows a preview counts are the rows
// a deploy deletes.
//
// A marker's instant is inside its value, not in a column: either an ISO stamp
// at the end of the value (or the value itself) or the epoch milliseconds after
// the last colon. That is why this class is counted in JS rather than SQL — and
// why one function, `settingsMarkerInstant`, serves both the delete and the
// preview.
export const SETTINGS_RETENTION = [
  { prefix: 'followup:', days: 30, label: ['跟进标记', 'Follow-up markers'] },
  { prefix: 'question_notified:', days: 30, label: ['问题通知标记', 'Question-notified markers'] },
  { prefix: 'digest_sent:', days: 14, label: ['摘要发送标记', 'Digest-sent markers'] },
  { prefix: 'email_test:', days: 1, label: ['测试邮件标记', 'Test-mail markers'] },
  { prefix: 'webhook_delivery:', days: 30, label: ['Webhook 投递标记', 'Webhook-delivery markers'] },
  { prefix: 'email_reply:', days: 7, label: ['邮件回复标记', 'Email-reply markers'] },
  { prefix: 'github_app_state:', days: 1, label: ['GitHub App 状态标记', 'GitHub App state markers'] },
  { prefix: 'installation_sender:', days: 30, label: ['安装发送人标记', 'Installation-sender markers'] },
  // A plan marker is read only while its job is unapproved, which ends at the
  // plan deadline; the job row itself is kept for 365 days, so the marker gets
  // the same window from the moment it was written.
  { prefix: 'plan_reminded:', days: 365, label: ['计划提醒标记', 'Plan-reminded markers'] },
  { prefix: 'plan_expired:', days: 365, label: ['计划过期标记', 'Plan-expired markers'] },
]

/** The one class the admin card and the dry-run tool print for `settings`. */
export const RETENTION_SETTINGS_CLASS = {
  id: 'settingsMarkers',
  key: 'settings_markers',
  label: ['设置标记', 'Settings markers'],
}

/** The family a key belongs to, or null when this table does not own the key. */
export function settingsRetentionFamily(key) {
  const name = String(key ?? '')
  return SETTINGS_RETENTION.find((family) => name.startsWith(family.prefix)) ?? null
}

/**
 * True when this marker is past its family's window at `now`.
 *
 * The parse is the prune's original one, kept bit for bit because a second
 * parser would be a second answer: an ISO stamp at the start of the value wins,
 * otherwise the epoch milliseconds after the last colon. A value that carries
 * neither is not a marker the pass can read, so it is neither counted nor
 * deleted — a counted row that survives is the drift this table exists to stop.
 */
export function settingsMarkerExpired(key, value, now = Date.now()) {
  const family = settingsRetentionFamily(key)
  if (family === null) return false
  const text = String(value ?? '')
  const raw = text.slice(text.lastIndexOf(':') + 1)
  const at = /^\d{4}-\d{2}-\d{2}T/.test(text) ? Date.parse(text) : Number(raw)
  if (!Number.isFinite(at) || at === 0) return false
  const stamp = at > 10_000_000_000 ? new Date(at).toISOString() : text
  return stamp < new Date(now - family.days * 86_400_000).toISOString()
}

/** How many `{key, value}` rows the prune would delete at `now`. */
export function countSettingsMarkers(rows, now = Date.now()) {
  let total = 0
  for (const row of rows) if (settingsMarkerExpired(row.key, row.value, now)) total += 1
  return total
}

// These two have no age window at all, and reporting a fabricated number for
// them would be worse than saying so: sessions are reclaimed by `expires_at`
// and `api_tokens` are revoked, or removed by the account cascade. Adding a
// delete path for either is a behaviour change, not a config value.
export const RETENTION_IDLE_TABLES = [
  { id: 'sessions', state: 'expiry-based', label: ['会话', 'Sessions'] },
  { id: 'api_tokens', state: 'no-age-window', label: ['API 令牌', 'API tokens'] },
]

/** Every window at its built-in value. The defaults must equal today's literals. */
export function retentionDefaultWindows() {
  return Object.fromEntries(RETENTION_CLASSES.map((cls) => [cls.id, cls.defaultDays]))
}

/**
 * Parse one configured window. Empty, non-numeric or below one day means the
 * built-in value, and `configured` false is what the operator surface marks as
 * `default`. A window of zero is refused rather than read as "delete
 * everything": that is a data-loss instruction, not a retention window.
 */
export function retentionWindow(raw, fallback) {
  const text = raw === undefined || raw === null ? '' : String(raw).trim()
  if (text === '') return { days: fallback, configured: false }
  const n = Number(text)
  if (!Number.isInteger(n) || n < 1) return { days: fallback, configured: false }
  return { days: n, configured: true }
}

/** The DELETE the scheduler runs for one class. */
export function retentionDeleteSql(cls, at) {
  const { sql, params } = cls.where(at)
  return { sql: `DELETE FROM ${cls.table} WHERE ${sql}`, params }
}

/** The matching COUNT, so a preview cannot select different rows than the delete. */
export function retentionCountSql(cls, at) {
  const { sql, params } = cls.where(at)
  return { sql: `SELECT COUNT(*) AS n FROM ${cls.table} WHERE ${sql}`, params }
}

/**
 * Count what each window would delete at `days`, through the same predicates.
 * `count(sql, params)` returns the scalar, so the store and the plain-node tool
 * share this loop instead of each keeping its own.
 */
export function retentionCountsAt(count, days, now = Date.now()) {
  const at = { now: new Date(now).toISOString(), cutoff: new Date(now - days * 86_400_000).toISOString() }
  return RETENTION_CLASSES.map((cls) => {
    const { sql, params } = retentionCountSql(cls, at)
    return { id: cls.id, key: cls.key, days, count: Number(count(sql, params)) }
  })
}
