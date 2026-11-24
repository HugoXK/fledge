import { log } from './log.js'
import { metricsSnapshot, observeHistogram } from './metrics.js'

// #1231: a slow query needs a name a dashboard can group by, and that name must
// not be the SQL text. The label is the verb plus the table (`select:jobs`,
// `insert:quota_ledger`, `pragma:user_version`), so cardinality is bounded by the
// schema and no value, parameter or token can reach it.
//
// The histogram is the window a dashboard reads; the ring is the bounded list an
// operator reads on /admin/metrics. The ring is in-process and starts empty on a
// restart, like every other counter in this tree.
export const DEFAULT_SLOW_QUERY_MS = 200
export const SLOW_QUERY_LIMIT = 20

export interface SlowQuery {
  statement: string
  ms: number
  rows: number
  at: string
}

export interface QueryHealthSummary {
  /** The five statements with the highest observed duration, newest data first. */
  slowest: Array<{ statement: string; count: number; meanMs: number; maxMs: number }>
  /** The newest slow queries, newest first. */
  slow: SlowQuery[]
  /** Every measured statement, summed over their histogram buckets. */
  totalQueries: number
}

export interface DatabaseTableHealth {
  name: string
  rows: number
}

export interface DatabaseHealth {
  pageSize: number
  pageCount: number
  freelistCount: number
  bytes: number
  /** Every user table, largest first. */
  tables: DatabaseTableHealth[]
}

const slow: SlowQuery[] = []
const maxByStatement = new Map<string, number>()

const TABLE_AFTER = /\b(?:from|into|update|join)\s+["'`]?([a-z_][a-z0-9_]*)["'`]?/i
const CREATE_TABLE = /\btable\s+(?:if\s+not\s+exists\s+)?["'`]?([a-z_][a-z0-9_]*)["'`]?/i
const TABLE_AFTER_ALTER = /\btable\s+(?:if\s+exists\s+)?["'`]?([a-z_][a-z0-9_]*)["'`]?/i
const PRAGMA_NAME = /^pragma\s+([a-z_]+)/i

function tableOf(sql: string, verb: string): string {
  if (verb === 'create') return CREATE_TABLE.exec(sql)?.[1] ?? ''
  if (verb === 'alter' || verb === 'drop') return TABLE_AFTER_ALTER.exec(sql)?.[1] ?? ''
  return TABLE_AFTER.exec(sql)?.[1] ?? ''
}

/** A stable, low-cardinality name for a statement; never the SQL or its parameters. */
export function statementName(sql: string): string {
  const text = String(sql).trim().replace(/\s+/g, ' ')
  const verb = (/^([a-z]+)/i.exec(text)?.[1] ?? 'statement').toLowerCase()
  if (verb === 'pragma') return `pragma:${(PRAGMA_NAME.exec(text)?.[1] ?? 'unknown').toLowerCase()}`
  if (verb === 'begin' || verb === 'commit' || verb === 'rollback' || verb === 'savepoint' || verb === 'release') {
    return `transaction:${verb}`
  }
  const table = tableOf(text, verb)
  return `${verb}:${(table === '' ? 'unknown' : table).toLowerCase()}`
}

export function recordQuery(statement: string, ms: number, rows: number, slowMs = DEFAULT_SLOW_QUERY_MS): void {
  if (!Number.isFinite(ms) || ms < 0) return
  observeHistogram('fledge_db_query_seconds', ms / 1_000, { statement }, 'Database statement duration by statement name')
  if (ms > (maxByStatement.get(statement) ?? 0)) maxByStatement.set(statement, ms)
  if (ms < slowMs) return
  slow.unshift({ statement, ms: Math.round(ms), rows, at: new Date().toISOString() })
  if (slow.length > SLOW_QUERY_LIMIT) slow.length = SLOW_QUERY_LIMIT
  // The logger redacts its fields; the statement is a generated name, and the
  // numbers are not text. No SQL, parameter, row body or token is passed here.
  log.warn('slow query', { statement, ms: Math.round(ms), rows })
}

export function queryHealthSummary(): QueryHealthSummary {
  const snapshot = metricsSnapshot()
  const slowest = snapshot.histograms
    .filter((entry) => entry.name === 'fledge_db_query_seconds')
    .map((entry) => {
      const statement = String(entry.labels.statement ?? '')
      const meanMs = entry.count === 0 ? 0 : (entry.sum / entry.count) * 1_000
      return {
        statement,
        count: entry.count,
        meanMs: Math.round(meanMs * 10) / 10,
        maxMs: Math.round((maxByStatement.get(statement) ?? 0) * 10) / 10,
      }
    })
    .sort((left, right) => right.maxMs - left.maxMs || right.meanMs - left.meanMs || left.statement.localeCompare(right.statement))
    .slice(0, 5)
  return {
    slowest,
    slow: [...slow],
    totalQueries: snapshot.histograms
      .filter((entry) => entry.name === 'fledge_db_query_seconds')
      .reduce((total, entry) => total + entry.count, 0),
  }
}

/** Test-only: the ring and the per-statement maxima are process state. */
export function resetQueryHealth(): void {
  slow.length = 0
  maxByStatement.clear()
}
