import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { writeManifest } from '../scripts/lib/backup-manifest.mjs'
import { BUSY_TIMEOUT_MS, planSteps, readCounters, type Counters } from '../scripts/lib/db-maintenance.mjs'

// #1261: the platform's SQLite file had no supported maintenance path, so an
// operator could take a copy but never plan or run `VACUUM`/`ANALYZE` on the
// live file. The three properties this suite pins, in the order the card states
// them: a dry run plans and writes nothing; a real run refuses without a fresh,
// intact backup; a locked database is refused instead of hung.
//
// "Writes nothing" is asserted as counters, never as file bytes: the database is
// WAL, so a connection creates or updates the `-shm` shared-memory index even
// when it writes no page. The `sqlite_stat1` row count is part of the assertion
// because `PRAGMA optimize` writes one, which is why the dry run never runs it.
const TOOL = fileURLToPath(new URL('../scripts/db-maintenance.mjs', import.meta.url))
// The CLI reads `readBackupStatus` from `src/lib/backupStatus.ts`, so it runs
// under the repository's TypeScript loader — the same one `npm run db:maintenance`
// uses. Spawning plain `node` here would test a command the runbook never runs.
const LOADER = '--import'
const LOADER_MODULE = 'tsx'

const HOUR = 3_600_000
const NOW = new Date('2026-11-23T22:00:00.000Z')

function runTool(dbPath: string, args: string[], options: { backupDir?: string; reportPath: string }): { status: number | null; stdout: string; stderr: string; ms: number } {
  const started = Date.now()
  const result = spawnSync(process.execPath, [LOADER, LOADER_MODULE, TOOL, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    env: {
      ...process.env,
      DB_PATH: dbPath,
      BACKUP_DIR: options.backupDir ?? join(tmpdir(), 'db-maintenance-no-backups'),
      REPORT_PATH: options.reportPath,
    },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', ms: Date.now() - started }
}

function countersOf(dbPath: string): Counters {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return readCounters(db)
  } finally {
    db.close()
  }
}

function auditRows(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return Number(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get()?.n ?? 0)
  } finally {
    db.close()
  }
}

// The shape the live file has: the audit table this tool writes one row into,
// one table with rows to count, and no `sqlite_stat1` until something runs
// `ANALYZE`. `padBytes` grows the file above `SHA256_MAX_BYTES` (4 MiB), the cap
// below which `readBackupStatus` certifies a copy's bytes itself; the host's copy
// is 235 MB, so the above-cap path is the only one a real run ever takes here.
function makeDb(dbPath: string, options: { padBytes?: number } = {}): void {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec(`
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        user_id TEXT,
        action TEXT NOT NULL,
        detail TEXT
      );
      CREATE TABLE jobs (id INTEGER PRIMARY KEY, note TEXT);
      INSERT INTO jobs (note) VALUES ('a'), ('b'), ('c'), ('d');
    `)
    if (options.padBytes !== undefined) {
      db.exec('CREATE TABLE pad (id INTEGER PRIMARY KEY, blob BLOB)')
      db.prepare('INSERT INTO pad (blob) VALUES (?)').run(Buffer.alloc(options.padBytes, 7))
    }
  } finally {
    db.close()
  }
}

// Change one byte in the middle of a copy, which keeps its size (so
// `readBackupStatus` still says `not-checked` above the cap instead of `differs`)
// and leaves it a valid SQLite file. Only the bytes stop being the bytes the
// manifest named.
function flipByte(path: string): void {
  const offset = Math.floor(statSync(path).size / 2)
  const fd = openSync(path, 'r+')
  try {
    const byte = Buffer.alloc(1)
    readSync(fd, byte, 0, 1, offset)
    byte[0] = (byte[0] ?? 0) ^ 0xff
    writeSync(fd, byte, 0, 1, offset)
  } finally {
    closeSync(fd)
  }
}

// `fledge-<ISO with : and . replaced>.db` — the writer's own file-name stamp
// (`scripts/backup.mjs`), which is how `readBackupStatus` dates a copy.
function stampFor(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

async function makeBackup(dir: string, source: string, at: Date): Promise<string> {
  mkdirSync(dir, { recursive: true })
  const copyPath = join(dir, `fledge-${stampFor(at)}.db`)
  copyFileSync(source, copyPath)
  await writeManifest(copyPath)
  return copyPath
}

function readReport(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

test('#1261 a dry run leaves page_count, freelist_count, every table count and the sqlite_stat1 row count unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-maintenance-dry-'))
  try {
    const dbPath = join(dir, 'fledge.db')
    makeDb(dbPath)
    const before = countersOf(dbPath)
    // The plan comes from the same module the CLI prints it from, so a plan that
    // drops a step fails here rather than in a report nobody diffs.
    const plan = planSteps()
    assert.deepEqual(plan.steps.map((step) => step.name), ['wal-checkpoint', 'analyze', 'vacuum'])
    assert.ok(plan.steps.every((step) => step.executes === false))

    const run = runTool(dbPath, ['--dry-run', '--now', NOW.toISOString()], { reportPath: join(dir, 'report.json') })
    assert.equal(run.status, 0, run.stderr)

    const after = countersOf(dbPath)
    assert.equal(after.pageCount, before.pageCount)
    assert.equal(after.freelistCount, before.freelistCount)
    assert.equal(after.stat1Rows, 0)
    assert.deepEqual(after.tables, before.tables)
    assert.equal(existsSync(`${dbPath}-journal`), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#1261 a dry run writes no audit_log row and reports mode dry-run with after null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-maintenance-report-'))
  try {
    const dbPath = join(dir, 'fledge.db')
    makeDb(dbPath)
    const reportPath = join(dir, 'report.json')
    const run = runTool(dbPath, ['--dry-run', '--now', NOW.toISOString()], { reportPath })
    assert.equal(run.status, 0, run.stderr)
    assert.equal(auditRows(dbPath), 0)

    const report = readReport(reportPath)
    assert.equal(report.mode, 'dry-run')
    assert.equal(report.after, null)
    assert.equal(report.at, NOW.toISOString())
    assert.equal(report.busyTimeoutMs, BUSY_TIMEOUT_MS)
    assert.equal(report.report, reportPath)
    assert.equal(report.exit, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#1261 a real run without --backup exits 3 with the no-backup sentence and changes no counter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-maintenance-nobackup-'))
  try {
    const dbPath = join(dir, 'fledge.db')
    makeDb(dbPath)
    const before = countersOf(dbPath)
    const reportPath = join(dir, 'report.json')
    const run = runTool(dbPath, ['--now', NOW.toISOString()], { reportPath })
    assert.equal(run.status, 3, `expected exit 3, got ${String(run.status)}: ${run.stderr}`)
    assert.match(run.stderr, /refused: no-backup — a real run needs --backup <file>/)

    const after = countersOf(dbPath)
    assert.equal(after.pageCount, before.pageCount)
    assert.equal(after.freelistCount, before.freelistCount)
    assert.deepEqual(after.tables, before.tables)
    assert.equal(auditRows(dbPath), 0)

    // "Nothing was written" is about the database; the report is still written.
    const report = readReport(reportPath)
    assert.equal(report.mode, 'real')
    assert.equal((report.refusal as { code: string }).code, 'no-backup')
    assert.equal(report.exit, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#1261 a copy older than the window exits 3 with backup-too-old and writes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-maintenance-too-old-'))
  try {
    const dbPath = join(dir, 'fledge.db')
    makeDb(dbPath)
    const backupDir = join(dir, 'backups')
    const copyPath = await makeBackup(backupDir, dbPath, new Date(NOW.getTime() - 30 * HOUR))
    const before = countersOf(dbPath)
    const reportPath = join(dir, 'report.json')
    const run = runTool(dbPath, ['--backup', copyPath, '--now', NOW.toISOString()], { reportPath, backupDir })
    assert.equal(run.status, 3, `expected exit 3, got ${String(run.status)}: ${run.stderr}`)
    assert.match(run.stderr, /refused: backup-too-old — /)
    assert.match(run.stderr, /window is 26h/)

    const after = countersOf(dbPath)
    assert.equal(after.pageCount, before.pageCount)
    assert.equal(after.freelistCount, before.freelistCount)
    assert.deepEqual(after.tables, before.tables)
    assert.equal(auditRows(dbPath), 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#1261 a second writer holding the lock is refused with db-busy inside the busy timeout, not hung', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-maintenance-busy-'))
  try {
    const dbPath = join(dir, 'fledge.db')
    makeDb(dbPath)
    const backupDir = join(dir, 'backups')
    // A valid, fresh backup: otherwise the run refuses `no-backup` before it can
    // ever reach the lock.
    const copyPath = await makeBackup(backupDir, dbPath, NOW)
    const before = countersOf(dbPath)

    const holder = new DatabaseSync(dbPath)
    try {
      holder.exec('BEGIN IMMEDIATE')
      const reportPath = join(dir, 'report.json')
      const run = runTool(dbPath, ['--backup', copyPath, '--now', NOW.toISOString()], { reportPath, backupDir })
      assert.equal(run.status, 3, `expected exit 3, got ${String(run.status)}: ${run.stderr}`)
      assert.match(run.stderr, /refused: db-busy — another connection held a write lock for 5000 ms; nothing was written/)
      assert.ok(run.ms < 10_000, `refused after ${String(run.ms)} ms, which is a hang, not a busy timeout`)

      const after = countersOf(dbPath)
      assert.equal(after.pageCount, before.pageCount)
      assert.equal(after.freelistCount, before.freelistCount)
      assert.deepEqual(after.tables, before.tables)
      assert.equal(auditRows(dbPath), 0)
    } finally {
      try {
        holder.exec('ROLLBACK')
      } catch {
        // The transaction may already be gone; the handle still has to close.
      }
      holder.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#1261 a real run with a fresh, matching copy executes the plan and writes exactly one audit row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-maintenance-real-'))
  try {
    const dbPath = join(dir, 'fledge.db')
    makeDb(dbPath)
    const backupDir = join(dir, 'backups')
    const copyPath = await makeBackup(backupDir, dbPath, NOW)
    const reportPath = join(dir, 'report.json')
    const run = runTool(dbPath, ['--backup', copyPath, '--now', NOW.toISOString()], { reportPath, backupDir })
    assert.equal(run.status, 0, `expected exit 0, got ${String(run.status)}: ${run.stderr}`)

    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const rows = db.prepare('SELECT at, user_id, action, detail FROM audit_log').all()
      assert.equal(rows.length, 1)
      assert.equal(rows[0]?.user_id, null)
      assert.equal(rows[0]?.action, 'db.maintenance')
      const detail = JSON.parse(String(rows[0]?.detail)) as { before: Counters; after: Counters; report: string }
      assert.equal(detail.report, reportPath)
      assert.ok(detail.after.tables.length > 0)
    } finally {
      db.close()
    }

    // A real run is the one place `sqlite_stat1` gains a row: `ANALYZE` runs.
    const after = countersOf(dbPath)
    assert.ok(after.stat1Rows > 0)

    const report = readReport(reportPath)
    assert.equal(report.mode, 'real')
    assert.equal(report.exit, 0)
    assert.equal(report.refusal, null)
    assert.notEqual(report.after, null)
    assert.equal((report.backup as { manifest: string }).manifest, 'matches')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// #1264 verdict: the live copy is 235,327,488 B, above `SHA256_MAX_BYTES`
// (4 MiB), where `readBackupStatus` reports `not-checked` because `/admin` must
// not read a copy that large on a render path. Before the fix every genuine run
// refused `backup-too-old` / `not-checked` immediately after telling the operator
// to take a copy it already had. The tool now hashes the named copy itself,
// streamed — so the case that must accept is this one, not the 16 KiB fixture.
const ABOVE_CAP_BYTES = 5 * 1024 * 1024

test('#1261 a fresh copy above the hashing cap is accepted once the tool hashes it itself', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-maintenance-large-'))
  try {
    const dbPath = join(dir, 'fledge.db')
    makeDb(dbPath, { padBytes: ABOVE_CAP_BYTES })
    const backupDir = join(dir, 'backups')
    const copyPath = await makeBackup(backupDir, dbPath, NOW)
    assert.ok(statSync(copyPath).size > 4 * 1024 * 1024, 'the fixture must be above the render-path cap')
    const reportPath = join(dir, 'report.json')
    const run = runTool(dbPath, ['--backup', copyPath, '--now', NOW.toISOString()], { reportPath, backupDir })
    assert.equal(run.status, 0, `expected exit 0, got ${String(run.status)}: ${run.stderr}`)
    assert.equal(auditRows(dbPath), 1)

    const report = readReport(reportPath)
    assert.equal(report.exit, 0)
    assert.equal(report.refusal, null)
    const backup = report.backup as { manifest: string; file: string }
    assert.equal(backup.manifest, 'matches')
    assert.equal(backup.file, copyPath.slice(copyPath.lastIndexOf('/') + 1))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#1261 a copy above the hashing cap whose bytes disagree with its manifest is refused and writes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-maintenance-large-tampered-'))
  try {
    const dbPath = join(dir, 'fledge.db')
    makeDb(dbPath, { padBytes: ABOVE_CAP_BYTES })
    const backupDir = join(dir, 'backups')
    const copyPath = await makeBackup(backupDir, dbPath, NOW)
    // Same size, different bytes: `readBackupStatus` alone can only say
    // `not-checked` here, so only the tool's own hash can catch this.
    flipByte(copyPath)
    const before = countersOf(dbPath)
    const reportPath = join(dir, 'report.json')
    const run = runTool(dbPath, ['--backup', copyPath, '--now', NOW.toISOString()], { reportPath, backupDir })
    assert.equal(run.status, 3, `expected exit 3, got ${String(run.status)}: ${run.stderr}`)
    assert.match(run.stderr, /refused: backup-too-old — /)
    assert.match(run.stderr, /manifest sha256 differs from the bytes/)

    const after = countersOf(dbPath)
    assert.equal(after.pageCount, before.pageCount)
    assert.equal(after.freelistCount, before.freelistCount)
    assert.deepEqual(after.tables, before.tables)
    assert.equal(auditRows(dbPath), 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#1261 a small copy whose bytes disagree with its manifest is still refused by readBackupStatus', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-maintenance-small-tampered-'))
  try {
    const dbPath = join(dir, 'fledge.db')
    makeDb(dbPath)
    const backupDir = join(dir, 'backups')
    // Below the cap `readBackupStatus` hashes the newest copy itself, so this
    // path must not have been replaced by the tool's own hash.
    const copyPath = await makeBackup(backupDir, dbPath, NOW)
    flipByte(copyPath)
    const before = countersOf(dbPath)
    const reportPath = join(dir, 'report.json')
    const run = runTool(dbPath, ['--backup', copyPath, '--now', NOW.toISOString()], { reportPath, backupDir })
    assert.equal(run.status, 3, `expected exit 3, got ${String(run.status)}: ${run.stderr}`)
    assert.match(run.stderr, /refused: backup-too-old — /)
    assert.match(run.stderr, /manifest sha256 differs from the bytes/)

    const after = countersOf(dbPath)
    assert.equal(after.pageCount, before.pageCount)
    assert.equal(after.freelistCount, before.freelistCount)
    assert.deepEqual(after.tables, before.tables)
    assert.equal(auditRows(dbPath), 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
