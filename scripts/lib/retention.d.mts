export type RetentionId =
  | 'oauthStates'
  | 'approvalTokens'
  | 'notificationsRead'
  | 'notificationsUnread'
  | 'events'
  | 'jobEvents'
  | 'webhookDeliveries'
  | 'outboxSent'
  | 'outboxDead'
  | 'outboxUnknown'
  | 'jobs'
  | 'auditLog'
  | 'quotaLedger'

export type RetentionWindows = Record<RetentionId, number>

export interface RetentionAt {
  now: string
  cutoff: string
}

export interface RetentionWhere {
  sql: string
  params: string[]
}

export interface RetentionClass {
  id: RetentionId
  key: string
  table: string
  env: string
  defaultDays: number
  label: readonly [string, string]
  where: (at: RetentionAt) => RetentionWhere
}

export interface RetentionIdleTable {
  id: 'sessions' | 'api_tokens'
  state: 'expiry-based' | 'no-age-window'
  label: readonly [string, string]
}

export interface RetentionCount {
  id: RetentionId
  key: string
  days: number
  count: number
}

export const RETENTION_CLASSES: readonly RetentionClass[]
export const RETENTION_IDLE_TABLES: readonly RetentionIdleTable[]
export function retentionDefaultWindows(): RetentionWindows
export function retentionWindow(raw: string | undefined | null, fallback: number): { days: number; configured: boolean }
export function retentionDeleteSql(cls: RetentionClass, at: RetentionAt): { sql: string; params: string[] }
export function retentionCountSql(cls: RetentionClass, at: RetentionAt): { sql: string; params: string[] }
export function retentionCountsAt(count: (sql: string, params: string[]) => number, days: number, now?: number): RetentionCount[]
