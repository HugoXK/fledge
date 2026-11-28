import { performance } from 'node:perf_hooks'
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

// #1231: the `Store` entry points wrap one prepared call here, so `src/db.ts`
// stays under its size entry; the row count is a callback because each verb
// reports it differently (undefined is 0, a list is its length, a guarded
// UPDATE is `changes`).
export function timedQuery<T>(slowMs: number, sql: string, run: () => T, rows: (value: T) => number): T {
  const started = performance.now()
  const value = run()
  recordQuery(statementName(sql), performance.now() - started, rows(value), slowMs)
  return value
}

// #1231: the read-only snapshot behind the admin card. It uses the raw
// connection so the per-table COUNT(*) calls do not fill the histogram the card
// is about. `handle` is the structural slice of `node:sqlite`'s database this
// needs, so `db.ts` keeps no health code of its own.
export interface HealthHandle {
  prepare(sql: string): { get(): unknown; all(): unknown[] }
}

export function readDatabaseHealth(handle: HealthHandle): DatabaseHealth {
  const pageSize = Number((handle.prepare('PRAGMA page_size').get() as { page_size?: number } | undefined)?.page_size ?? 0)
  const pageCount = Number((handle.prepare('PRAGMA page_count').get() as { page_count?: number } | undefined)?.page_count ?? 0)
  const freelistCount = Number((handle.prepare('PRAGMA freelist_count').get() as { freelist_count?: number } | undefined)?.freelist_count ?? 0)
  const tables = (handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => {
    const name = String(row.name)
    const quoted = name.replaceAll('"', '""')
    const rows = Number((handle.prepare(`SELECT COUNT(*) AS n FROM "${quoted}"`).get() as { n?: number } | undefined)?.n ?? 0)
    return { name, rows }
  })
  tables.sort((left, right) => right.rows - left.rows || left.name.localeCompare(right.name))
  return { pageSize, pageCount, freelistCount, bytes: pageSize * pageCount, tables }
}
