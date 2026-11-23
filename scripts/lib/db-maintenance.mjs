// #1261: the pure half of `scripts/db-maintenance.mjs` — counters, the plan and
// the report shape — so the suite drives them without a process. The CLI keeps
// argv, the lock probe, the backup precondition, the audit write and the exit
// codes; nothing here opens a file, reads the clock or calls `process.exit`.
//
// The plan is deliberately separate from its execution: a dry run prints exactly
// these three steps and runs none of them. `PRAGMA optimize` is not one of them
// because it writes a `sqlite_stat1` row, and then "the dry run wrote nothing"
// and "optimize always" could not both be true (the seat's probe on `#1232`:
// absent -> 1 row). A dry run promises the plan, a real run promises the steps.
export const BUSY_TIMEOUT_MS = 5000

/** One user table's row count, as `SELECT COUNT(*)` reports it. */
export function readCounters(db) {
  const pageCount = Number(db.prepare('PRAGMA page_count').get()?.page_count ?? 0)
  const freelistCount = Number(db.prepare('PRAGMA freelist_count').get()?.freelist_count ?? 0)
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => {
      const name = String(row.name)
      // A table name is an identifier, so it cannot be bound as a parameter; the
      // only safe interpolation is the quoted form every other script here uses.
      const quoted = name.replaceAll('"', '""')
      return { name, rows: Number(db.prepare(`SELECT COUNT(*) AS n FROM "${quoted}"`).get()?.n ?? 0) }
    })
  // `sqlite_stat1` exists only after something ran `ANALYZE`, so "no such table"
  // is the same fact as "no rows" and must not be an error.
  let stat1Rows = 0
  try {
    stat1Rows = Number(db.prepare('SELECT COUNT(*) AS n FROM sqlite_stat1').get()?.n ?? 0)
  } catch {
    stat1Rows = 0
  }
  return { pageCount, freelistCount, stat1Rows, tables }
}

/**
 * The three statements a maintenance run executes, in order. `executes` is false
 * in the plan a dry run prints; the CLI sets it true on the steps it ran.
 */
export function planSteps() {
  return {
    steps: [
      { name: 'wal-checkpoint', sql: 'PRAGMA wal_checkpoint(TRUNCATE)', executes: false },
      { name: 'analyze', sql: 'ANALYZE', executes: false },
      { name: 'vacuum', sql: 'VACUUM', executes: false },
    ],
  }
}

/** The one sentence per refusal code; the CLI prints it and the report stores it. */
export function refusalSentence(code, detail = {}) {
  if (code === 'no-backup') {
    return 'refused: no-backup — a real run needs --backup <file> naming the newest copy readBackupStatus reports'
  }
  if (code === 'backup-too-old') {
    const name = String(detail.name ?? 'the named copy')
    const age = Number.isFinite(detail.ageHours) ? `${Math.round(detail.ageHours)}h` : 'an unknown number of hours'
    const windowHours = String(detail.windowHours ?? '')
    return `refused: backup-too-old — ${name} is ${age} old or its manifest is ${String(detail.manifest ?? 'unknown')}; window is ${windowHours}h, take a fresh copy with npm run db:backup`
  }
  if (code === 'db-busy') {
    return `refused: db-busy — another connection held a write lock for ${BUSY_TIMEOUT_MS} ms; nothing was written`
  }
  throw new Error(`unknown refusal code: ${String(code)}`)
}

/**
 * One report per invocation, in the field order `docs/deploy.md` documents.
 * `after` is null on a dry run; `refusal` is set when the run ended at exit 3
 * and the report exists anyway — "nothing was written" always means the
 * database, never the report.
 */
export function buildReport(input) {
  return {
    at: input.at,
    mode: input.mode,
    db: input.dbPath,
    busyTimeoutMs: BUSY_TIMEOUT_MS,
    before: input.before,
    after: input.after ?? null,
    plan: input.plan,
    backup: input.backup ?? null,
    refusal: input.refusal ?? null,
    report: input.reportPath,
    exit: input.exit,
  }
}
