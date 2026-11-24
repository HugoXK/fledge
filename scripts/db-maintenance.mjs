#!/usr/bin/env node
// #1261: plan and run SQLite maintenance on the platform's own database.
//
// A dry run reads the file and prints the steps it would run; it executes none
// of them, and none is `PRAGMA optimize`, because that writes a `sqlite_stat1`
// row and would make "the dry run wrote nothing" false. A real run executes the
// three steps, but only after a copy that `readBackupStatus` calls the newest,
// intact and inside the window — `VACUUM` on a file whose last good copy is
// missing is not a maintenance operation, it is a bet.
//
// Every run that reaches a decision writes one JSON report, refusals included:
// "nothing was written" always means the database, never the report. A usage
// error (exit 2) and a database that cannot be opened (exit 1) write none,
// because the first never named a run and the second has no counters to record.
//
//   npm run db:maintenance -- --dry-run
//   npm run db:maintenance -- --backup data/backups/fledge-2026-11-23T22-00-00-000Z.db
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DEFAULT_EXPECTED_HOURS, readBackupStatus } from '../src/lib/backupStatus.js'
import { readManifest, sha256File } from './lib/backup-manifest.mjs'
import { BUSY_TIMEOUT_MS, buildReport, planSteps, readCounters, refusalSentence } from './lib/db-maintenance.mjs'

const USAGE =
  'usage: node scripts/db-maintenance.mjs [--dry-run] [--db <path>] [--backup <file>] [--report <file>] [--now <iso>] [--expected-hours <n>]'
const EXIT_UNEXPECTED = 1
const EXIT_USAGE = 2
const EXIT_REFUSED = 3

function usageError(message) {
  process.stderr.write(`${USAGE}\n${message}\n`)
  process.exit(EXIT_USAGE)
}

const args = {}
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index]
  if (arg === '--dry-run') {
    args.dryRun = true
  } else if (arg === '--help' || arg === '-h') {
    process.stdout.write(`${USAGE}\n`)
    process.exit(0)
  } else if (arg === '--db' || arg === '--backup' || arg === '--report' || arg === '--now' || arg === '--expected-hours') {
    const raw = process.argv[index + 1]
    if (raw === undefined || raw === '') usageError(`${arg} needs a value`)
    args[arg.slice(2)] = raw
    index += 1
  } else {
    usageError(`unknown argument: ${arg}`)
  }
}

const dataDir = process.env.DATA_DIR ?? './data'
const dbPath = resolve(args.db ?? process.env.DB_PATH ?? join(dataDir, 'fledge.db'))
const backupDir = resolve(process.env.BACKUP_DIR ?? join(dataDir, 'backups'))
const reportPath = resolve(args.report ?? process.env.REPORT_PATH ?? join(dataDir, 'db-maintenance.json'))
// The window is a parameter with a default, not a constant: the suite pins the
// age with `--now` instead of waiting 26 hours, and an instance with a different
// backup interval can state its own without editing the script.
const expectedHours = args['expected-hours'] === undefined ? DEFAULT_EXPECTED_HOURS : Number(args['expected-hours'])
if (!Number.isFinite(expectedHours) || expectedHours <= 0) {
  usageError(`--expected-hours must be a positive number, got "${String(args['expected-hours'])}"`)
}
const at = args.now ?? new Date().toISOString()
const nowMs = Date.parse(at)
if (Number.isNaN(nowMs)) usageError(`--now must be an ISO timestamp, got "${at}"`)
const mode = args.dryRun === true ? 'dry-run' : 'real'

function writeReport(report) {
  mkdirSync(dirname(report.report), { recursive: true })
  // 0600 like the backup manifest: counters and paths, never a row body. The
  // `mode` only applies when the file is created, so a report left from an
  // earlier run keeps its old permissions unless it is chmod-ed explicitly —
  // `scripts/lib/backup-manifest.mjs:62` does the same for the same reason.
  writeFileSync(report.report, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  chmodSync(report.report, 0o600)
}

function fail(message, error) {
  process.stderr.write(`db-maintenance: ${message}${error === undefined ? '' : `: ${error instanceof Error ? error.message : String(error)}`}\n`)
  process.exit(EXIT_UNEXPECTED)
}

let db
try {
  // Read-only for a dry run, like `scripts/retention.mjs`: the planning path has
  // no write handle at all, so "it plans and does not execute" is a property of
  // the handle and not only of the code path.
  db = mode === 'dry-run' ? new DatabaseSync(dbPath, { readOnly: true }) : new DatabaseSync(dbPath)
} catch (error) {
  fail(`cannot open ${dbPath}`, error)
}
// The app's own value, on this process's own connection: a pragma does not
// travel to a new process, so a run started by cron would otherwise wait the
// default and hang instead of refusing.
db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)

const plan = planSteps()
const before = readCounters(db)

if (mode === 'dry-run') {
  for (const step of plan.steps) process.stdout.write(`plan: ${step.name} ${step.sql}\n`)
  process.stdout.write(
    `counters: page_count=${before.pageCount} freelist_count=${before.freelistCount} stat1_rows=${before.stat1Rows} tables=${before.tables.length}\n`,
  )
  const report = buildReport({ at, mode, dbPath, before, after: null, plan, reportPath, exit: 0 })
  writeReport(report)
  process.stdout.write(`report: ${reportPath}\n`)
  db.close()
  process.exit(0)
}

function refuse(code, detail, beforeCounters) {
  const refusal = { code, sentence: refusalSentence(code, detail) }
  const report = buildReport({ at, mode, dbPath, before: beforeCounters, plan, refusal, reportPath, exit: EXIT_REFUSED })
  writeReport(report)
  process.stderr.write(`${refusal.sentence}\n`)
  process.stderr.write(`report: ${reportPath}\n`)
  db.close()
  process.exit(EXIT_REFUSED)
}

// `readBackupStatus` certifies a copy's bytes only while it is at most
// `SHA256_MAX_BYTES` (4 MiB), because `/admin` must not read a large copy on a
// render path; above the cap the newest copy is reported `not-checked` with its
// size already agreed. The host's copy is 235 MB, so that cap is every real run:
// taken as a refusal, it told an operator to take a fresh copy they already had.
// The two states below are the ones where the bytes were never compared.
const UNHASHED_STATES = new Set(['not-checked', 'size-only'])

// Hash exactly the file that is about to be maintained, streamed: 235 MB once
// per maintenance run is nothing, and `readFileSync` on it is not. Only the named
// copy is read — the cap stays in `/admin`, where it belongs.
async function hashAgainstManifest(copyPath) {
  let manifest
  try {
    manifest = readManifest(copyPath)
  } catch {
    return 'unreadable'
  }
  // No sidecar is still a refusal: this tool does not vouch for a copy the writer
  // never described.
  if (manifest === null) return 'missing'
  try {
    return (await sha256File(copyPath)) === manifest.sha256 ? 'matches' : 'differs'
  } catch {
    return 'unreadable'
  }
}

// A copy is a precondition only if it is the newest one, its manifest agrees
// with its bytes, and it is inside the window — the same three judgements
// `/admin` makes, from the same function, so the CLI cannot call "fresh" what
// the console calls stale. The one addition is the bytes of an above-cap copy,
// which that function leaves `not-checked`; the tool hashes them itself, and only
// after the cheap two checks pass and only when the bytes were not already
// certified, so a `matches` copy is never re-read.
async function checkBackup() {
  if (args.backup === undefined) return { refusal: 'no-backup' }
  const wanted = resolve(args.backup)
  const status = readBackupStatus({ dir: backupDir, now: nowMs, expectedHours })
  const copy = status.copies.find((entry) => resolve(join(backupDir, entry.name)) === wanted)
  if (copy === undefined) return { refusal: 'no-backup' }
  const newest = status.newest !== null && status.newest.name === copy.name
  const fresh = copy.ageHours !== null && copy.ageHours <= expectedHours
  let manifest = copy.manifest
  // Which half of the manifest disagreed, when it did: a size mismatch means no
  // sha256 was ever computed, so a refusal that says "sha256 differs" is false.
  let manifestDetail = copy.manifestDetail
  if (newest && fresh && UNHASHED_STATES.has(manifest)) {
    manifest = await hashAgainstManifest(wanted)
    if (manifest === 'differs') manifestDetail = 'sha256'
  }
  if (!newest || !fresh || manifest !== 'matches') {
    return {
      refusal: 'backup-too-old',
      detail: { name: copy.name, ageHours: copy.ageHours, manifest, manifestDetail, windowHours: expectedHours, newest, fresh },
    }
  }
  return { backup: { file: copy.name, ageHours: copy.ageHours, manifest, verifiedBytes: UNHASHED_STATES.has(copy.manifest) ? 'db-maintenance' : 'readBackupStatus', windowHours: expectedHours } }
}

const checked = await checkBackup()
if (checked.refusal !== undefined) refuse(checked.refusal, checked.detail, before)

function isBusy(error) {
  const errcode = Number(error?.errcode ?? 0)
  if (errcode === 5 || errcode === 6) return true
  return /database is locked|database table is locked|SQLITE_BUSY/i.test(String(error?.message ?? error))
}

// The write lock is taken and released before any step runs, so a database
// another writer holds is refused with nothing written — not with `ANALYZE`
// applied and `VACUUM` failed. `VACUUM` cannot run inside a transaction, so the
// probe rolls back rather than wrapping the steps.
try {
  db.exec('BEGIN IMMEDIATE')
  db.exec('ROLLBACK')
} catch (error) {
  if (isBusy(error)) refuse('db-busy', {}, before)
  fail('cannot take the write lock', error)
}

try {
  for (const step of plan.steps) {
    if (step.name === 'wal-checkpoint') db.prepare(step.sql).all()
    else db.exec(step.sql)
    step.executes = true
  }
} catch (error) {
  fail('maintenance step failed', error)
}

const after = readCounters(db)
const detail = JSON.stringify({ before, after, report: reportPath })
try {
  // One row, `user_id` NULL: this is not a user action, and the app's per-user
  // counts filter on that column, so the row stays out of them.
  db.prepare('INSERT INTO audit_log (at, user_id, action, detail) VALUES (?, NULL, ?, ?)').run(at, 'db.maintenance', detail)
} catch (error) {
  fail('cannot write the audit row', error)
}

const report = buildReport({ at, mode, dbPath, before, after, plan, backup: checked.backup, reportPath, exit: 0 })
writeReport(report)
process.stdout.write(
  `maintenance: real db=${dbPath} page_count ${before.pageCount} -> ${after.pageCount} freelist_count ${before.freelistCount} -> ${after.freelistCount} stat1_rows ${before.stat1Rows} -> ${after.stat1Rows}\n`,
)
process.stdout.write(`report: ${reportPath}\n`)
db.close()
process.exit(0)
