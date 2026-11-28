import { sha256Hex } from './secrets.js'

// #1233: a tamper-evident audit log. Each row commits to the row before it, so an
// edit, delete or reorder that does not recompute the whole chain is visible at
// the first broken id. This is SHA-256 over stored fields, not a signature: a
// database administrator who rewrites every following hash can rebuild a
// consistent chain, which the docs state rather than hide.
export const AUDIT_CHAIN_PREFIX = 'v1'

export interface AuditChainRow {
  id: number
  at: string
  user_id: string | null
  action: string
  detail: string | null
  prev_hash: string | null
  hash: string | null
}

export function auditHash(row: Pick<AuditChainRow, 'id' | 'at' | 'user_id' | 'action' | 'detail' | 'prev_hash'>): string {
  // An array, not an object: key order is part of a JSON object's bytes, and a
  // future field rename would silently change every hash. The prefix versions the
  // canonical form so a later change is a deliberate migration.
  return sha256Hex(`${AUDIT_CHAIN_PREFIX}\n${JSON.stringify([row.id, row.at, row.user_id, row.action, row.detail, row.prev_hash])}`)
}

export interface AuditChainError {
  id: number
  reason: string
}

export interface AuditChainVerification {
  ok: boolean
  total: number
  checked: number
  /** Rows before the first hashed row; they are unverified, never forged. */
  unverifiedBeforeStart: number
  startId: number | null
  errors: AuditChainError[]
}

export function verifyAuditChain(rows: AuditChainRow[], startId: number | null = null): AuditChainVerification {
  const ordered = [...rows].sort((left, right) => left.id - right.id)
  const errors: AuditChainError[] = []
  let previousHash: string | null = null
  let start: number | null = null
  let checked = 0
  let unverifiedBeforeStart = 0

  for (const row of ordered) {
    if (row.hash === null) {
      if (start === null) {
        unverifiedBeforeStart += 1
        continue
      }
      errors.push({ id: row.id, reason: 'an unhashed row appears after the chain started' })
      continue
    }
    if (start === null) {
      start = row.id
      if (row.prev_hash !== null) errors.push({ id: row.id, reason: 'the first hashed row carries a previous hash' })
      previousHash = null
    } else if (row.prev_hash !== previousHash) {
      errors.push({ id: row.id, reason: 'prev_hash does not match the preceding row' })
    }
    if (row.hash !== auditHash(row)) errors.push({ id: row.id, reason: 'hash does not match the stored fields' })
    previousHash = row.hash
    checked += 1
  }

  if (startId !== null) {
    if (start === null) errors.push({ id: startId, reason: `the chain start setting names #${String(startId)} but no hashed row exists` })
    else if (start !== startId) errors.push({ id: startId, reason: `the chain start setting names #${String(startId)} but the first hashed row is #${String(start)}` })
  }

  return { ok: errors.length === 0, total: ordered.length, checked, unverifiedBeforeStart, startId: start, errors }
}
