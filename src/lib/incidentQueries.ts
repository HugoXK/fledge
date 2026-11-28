import type { AuditRow, JobEventRow, Store } from '../db.js'

// #1234: the bounded reads behind the incident bundle. They live beside the
// builder instead of on `Store` so the grandfathered store file does not grow
// for one read-only export; `src/db.ts` stays at its recorded size.

export function readSchemaVersion(store: Store): number {
  const row = store.get<{ user_version?: number }>('PRAGMA user_version')
  return Number(row?.user_version ?? 0)
}

export function readIncidentCounts(store: Store): { users: number; repos: number; jobs: number } {
  const count = (table: 'users' | 'repos' | 'jobs'): number => {
    const row = store.get<{ n?: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
    return Number(row?.n ?? 0)
  }
  return { users: count('users'), repos: count('repos'), jobs: count('jobs') }
}

// The caller caps the window at 24h and the rows, so the limit is a ceiling on
// this read and never a page cursor.
export function readJobEventsSince(store: Store, sinceIso: string, limit: number): JobEventRow[] {
  return store.all<JobEventRow>('SELECT * FROM job_events WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?', sinceIso, limit)
}

export function readAuditSince(store: Store, sinceIso: string, limit: number): AuditRow[] {
  return store.all<AuditRow>('SELECT * FROM audit_log WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?', sinceIso, limit)
}
