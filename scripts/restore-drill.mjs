#!/usr/bin/env node
// Restore drill: restore the newest online backup into a temp path and prove the
// restored copy is the backup it came from, holds the application schema, and
// still holds what its manifest recorded. The live source is read read-only and
// only reported on: drift since the copy was taken is normal and is never a
// failure.
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { decryptBackupFile, encryptBackupFile, loadBackupKey } from './lib/backup-crypto.mjs'
import { databaseFacts, manifestPath, readManifest, sha256File, writeManifest } from './lib/backup-manifest.mjs'

const require = createRequire(import.meta.url)
const { DatabaseSync, backup } = require('node:sqlite')

const USAGE = 'usage: node scripts/restore-drill.mjs [--db <path>] [--backup-dir <dir>] [--work-dir <dir>] [--status-file <path>] [--fresh] [--keep]'

// Where the last drill result is recorded for `/admin`. The host passes an
// explicit path; with only DATA_DIR set, the default is the same file the card
// reads. CI and unit runs with neither write nothing.
let statusTarget = null

function writeDrillStatus(ok, detail) {
  if (statusTarget === null) return
  const record = { at: new Date().toISOString(), ok, detail: String(detail).slice(0, 500) }
  const temp = `${statusTarget}.tmp`
  mkdirSync(dirname(statusTarget), { recursive: true, mode: 0o700 })
  writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, statusTarget)
}

// A drift failure is thrown rather than exited on, so every try/finally between
// the failure and the entry point still runs its cleanup.
class DrillError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function fail(code, message) {
  throw new DrillError(code, message)
}

function parseArgs(argv) {
  const parsed = { fresh: false, keep: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') parsed.help = true
    else if (arg === '--fresh') parsed.fresh = true
    else if (arg === '--keep') parsed.keep = true
    else if (arg === '--db') { index += 1; parsed.db = argv[index] }
    else if (arg === '--backup-dir') { index += 1; parsed.backupDir = argv[index] }
    else if (arg === '--work-dir') { index += 1; parsed.workDir = argv[index] }
    else if (arg === '--status-file') { index += 1; parsed.statusFile = argv[index] }
    else fail(2, `unknown argument ${arg}\n${USAGE}`)
  }
  return parsed
}

// A drill target may never land in the live data directory, so a typo cannot
// overwrite the database it is meant to protect.
// The path may not exist yet and any component may be a symlink, so resolve what
// exists and append the rest: a link pointing into the live area is still inside it.
function realTarget(candidate) {
  const absolute = resolve(candidate)
  const missing = []
  let current = absolute
  for (;;) {
    try {
      const real = realpathSync(current)
      return missing.length === 0 ? real : join(real, ...missing)
    } catch {
      const parent = dirname(current)
      if (parent === current) return absolute
      missing.unshift(basename(current))
      current = parent
    }
  }
}

function isInside(candidate, parent) {
  const rest = relative(parent, candidate)
  return rest === '' || (!rest.startsWith('..') && !isAbsolute(rest))
}

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => String(row.name))
}

function rowCount(db, table) {
  const quoted = table.replaceAll('"', '""')
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM "${quoted}"`).all()[0]?.n ?? 0)
}

function schemaVersion(db) {
  return Number(db.prepare('PRAGMA user_version').all()[0]?.user_version ?? 0)
}

// One definition for every copy, with or without a manifest. `Store` creates
// these tables and sets `user_version` on construction, so a real Fledge
// database always holds them — a copy that does not cannot be a restore. A
// fresh instance is schema with zero rows and stays valid: only tables and the
// schema version are required, never rows.
const APPLICATION_TABLES = ['jobs', 'repos', 'users']

function assertApplicationSchema(db, tables, backupPath, manifest) {
  const present = new Set(tables)
  const problems = []
  const missing = APPLICATION_TABLES.filter((table) => !present.has(table))
  if (missing.length > 0) problems.push(`missing tables: ${missing.join(', ')}`)
  const version = schemaVersion(db)
  if (version <= 0) problems.push(`PRAGMA user_version is ${version}, expected a positive schema version`)
  if (problems.length === 0) return
  // A copy without a manifest carries only the byte comparison, so say so: the
  // schema guard is what refuses it, not the missing manifest.
  const skipped = manifest === null
    ? '\nthe byte size and sha256 are the only checks a copy without a manifest carries, and this copy does not hold the application schema'
    : ''
  fail(1, `corrupt or incomplete copy ${backupPath}: the copy does not hold the application schema\n${problems.join('\n')}${skipped}`)
}

function newestBackup(dir) {
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
    .filter((name) => name.startsWith('fledge-') && (name.endsWith('.db') || name.endsWith('.db.enc')))
    .map((name) => join(dir, name))
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime)
  return files.length === 0 ? null : files[0].path
}

function configuredBackupKey() {
  try {
    return loadBackupKey(process.env)
  } catch (error) {
    fail(2, error instanceof Error ? error.message : String(error))
  }
}

function encryptionKeyForDrill() {
  // Restoring is not writing: a copy that already exists under a base64-shaped
  // passphrase must stay readable, and the only way to read it is the derivation
  // it actually used. GCM authentication and the key id decide whether the value
  // reproduces it, so the 16–31 byte write-side window is not applied here.
  let key
  try {
    key = loadBackupKey(process.env, { rejectTruncatedBase64Key: false })
  } catch (error) {
    fail(2, error instanceof Error ? error.message : String(error))
  }
  if (key === null) {
    fail(1, 'the backup is encrypted but no backup encryption key is configured; without the key the copy cannot be restored (lost key). Set BACKUP_ENCRYPTION_KEY or BACKUP_ENCRYPTION_KEY_FILE to the key the copy was written with')
  }
  return key
}

async function writeBackup(sourcePath, dir, key) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = join(dir, `fledge-${stamp}.db${key === null ? '' : '.enc'}`)
  // Same rule as the backup script: a plaintext intermediate never looks like a
  // finished backup while the encrypted copy is being written.
  const plaintextTarget = key === null ? target : `${target}.plaintext.tmp`
  const source = new DatabaseSync(sourcePath, { readOnly: true })
  try {
    await backup(source, plaintextTarget)
  } finally {
    source.close()
  }
  chmodSync(plaintextTarget, 0o600)
  let facts
  // A copy taken by the drill is a normal backup: it is verified and gets the
  // same manifest, so the checks below are exact on the very first run of an
  // instance. The manifest records what this run wrote, so the copy is verified
  // before it is described - a manifest over a file that cannot be opened would
  // launder a bad backup - and an unreadable copy is removed rather than left
  // looking usable.
  try {
    const fresh = openRestored(plaintextTarget, plaintextTarget)
    fresh.close()
    facts = databaseFacts(plaintextTarget)
  } catch (error) {
    rmSync(plaintextTarget, { force: true })
    throw error
  }
  let encryption
  if (key !== null) {
    try {
      encryption = await encryptBackupFile(plaintextTarget, target, key)
    } catch (error) {
      rmSync(plaintextTarget, { force: true })
      rmSync(target, { force: true })
      throw error
    }
    rmSync(plaintextTarget, { force: true })
  }
  await writeManifest(target, { facts, encryption })
  return target
}

function openRestored(restoredPath, backupPath) {
  let db
  try {
    db = new DatabaseSync(restoredPath, { readOnly: true })
    const rows = db.prepare('PRAGMA integrity_check').all()
    const messages = rows.map((row) => String(Object.values(row)[0]))
    if (messages.length !== 1 || messages[0] !== 'ok') {
      db.close()
      fail(1, `corrupt backup ${backupPath}: integrity_check reported ${messages.slice(0, 3).join('; ') || 'no result'}`)
    }
    // A table list runs one more read; a truncated page may still pass the check above.
    tableNames(db)
  } catch (error) {
    if (db !== undefined) {
      try {
        db.close()
      } catch {
        // Already closed by the integrity branch above.
      }
    }
    if (error instanceof DrillError) throw error
    fail(1, `corrupt backup ${backupPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return db
}

// 1. Exact: the restored file must be the copy it was made from, byte for byte.
// The copy is still on disk next to it, so this needs no manifest and holds for
// every backup ever taken, including copies written before manifests existed.
async function verifyRestoredCopy(restoredPath, backupPath) {
  const restoredSize = statSync(restoredPath).size
  const backupSize = statSync(backupPath).size
  const restoredHash = await sha256File(restoredPath)
  const backupHash = await sha256File(backupPath)
  if (restoredSize !== backupSize || restoredHash !== backupHash) {
    fail(1, `restored copy differs from ${backupPath}\nrestored size=${restoredSize} sha256=${restoredHash}\nbackup size=${backupSize} sha256=${backupHash}`)
  }
  return { size: restoredSize, sha256: restoredHash }
}

function readManifestOrFail(backupPath) {
  try {
    return readManifest(backupPath)
  } catch (error) {
    fail(1, `manifest unreadable ${manifestPath(backupPath)}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// 2a. The manifest describes bytes, so this runs before the database is opened:
// a file that is shorter than its manifest was interrupted or truncated at
// backup time, and SQLite's opinion of it is not what proves that.
function verifyManifestBytes(manifest, backupPath, copy) {
  const failures = []
  if (manifest.size !== copy.size) failures.push(`manifest says size=${manifest.size}, the restored copy has ${copy.size}`)
  if (manifest.sha256 !== copy.sha256) failures.push(`manifest says sha256=${manifest.sha256}, the restored copy has ${copy.sha256}`)
  if (failures.length > 0) fail(1, `corrupt or incomplete copy ${backupPath}: restored copy does not match its manifest\n${failures.join('\n')}`)
}

// 2b. And what it held: schema version and per-table counts.
function verifyManifestDatabase(manifest, backupPath, restored, restoredTables, restoredCounts) {
  const failures = []
  const version = schemaVersion(restored)
  process.stdout.write(`schema_version expected=${manifest.schemaVersion} actual=${version}\n`)
  if (manifest.schemaVersion !== version) failures.push(`manifest says schema_version=${manifest.schemaVersion}, restored has ${version}`)
  const restoredSet = new Set(restoredTables)
  for (const table of [...new Set([...Object.keys(manifest.tables), ...restoredTables])].sort()) {
    const expected = manifest.tables[table]
    if (!restoredSet.has(table)) {
      failures.push(`manifest says ${table}=${expected}, restored is missing ${table}`)
      continue
    }
    const actual = restoredCounts.get(table) ?? 0
    if (expected === undefined) {
      failures.push(`restored has ${table}=${actual}, which the manifest does not list`)
      continue
    }
    process.stdout.write(`table=${table} expected=${expected} actual=${actual}\n`)
    if (expected !== actual) failures.push(`manifest says ${table}=${expected}, restored has ${actual}`)
  }
  if (failures.length > 0) fail(1, `corrupt or incomplete copy ${backupPath}: restored copy does not match its manifest\n${failures.join('\n')}`)
}

// 3. The live source only informs. A serving instance writes after the copy is
// taken, and a migration may add a table, so neither is a failure: a red drill
// must mean "this backup is bad", never "the database moved on".
// The source is the one part of this drill that is allowed to be broken: an
// operator runs a drill *because* the live database may be damaged, so a source
// that cannot be opened or read is reported and never fails a verified copy.
function reportSourceDrift(dbPath, restoredTables, restoredCounts) {
  try {
    const source = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const sourceTables = tableNames(source)
      const sourceSet = new Set(sourceTables)
      const restoredSet = new Set(restoredTables)
      const schemaNotes = []
      let drift = 0
      for (const table of [...new Set([...sourceTables, ...restoredTables])].sort()) {
        if (!sourceSet.has(table)) {
          schemaNotes.push(`extra:${table}`)
          continue
        }
        if (!restoredSet.has(table)) {
          schemaNotes.push(`missing:${table}`)
          continue
        }
        const live = rowCount(source, table)
        const copy = restoredCounts.get(table) ?? 0
        drift += live - copy
        process.stdout.write(`source_table=${table} source=${live} restored=${copy}\n`)
      }
      process.stdout.write(`schema_drift=${schemaNotes.length === 0 ? 'none' : schemaNotes.join(',')}\n`)
      process.stdout.write(`source_drift=${drift > 0 ? '+' : ''}${drift}\n`)
    } finally {
      source.close()
    }
  } catch (error) {
    process.stdout.write('schema_drift=unavailable\nsource_drift=unavailable\n')
    process.stderr.write(`restore-drill: the live source could not be read, so drift is not reported and the restore stands: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(`${USAGE}\n`)
    return
  }
  const dbPath = resolve(args.db ?? process.env.DB_PATH ?? join(process.env.DATA_DIR ?? './data', 'fledge.db'))
  const backupDir = resolve(args.backupDir ?? process.env.BACKUP_DIR ?? join(process.env.DATA_DIR ?? './data', 'backups'))
  const dataDir = resolve(process.env.DATA_DIR ?? './data')
  const statusDir = process.env.DATA_DIR?.trim()
  statusTarget = args.statusFile === undefined
    ? (statusDir ? join(resolve(statusDir), 'backup-drill.json') : null)
    : resolve(args.statusFile)
  if (!existsSync(dbPath)) fail(2, `source database not found: ${dbPath}`)
  const realDbPath = realTarget(dbPath)
  const realBackupDir = realTarget(backupDir)
  const realDataDir = realTarget(dataDir)
  if (realDbPath === realBackupDir || dirname(realDbPath) === realBackupDir) {
    fail(2, `refusing to use ${backupDir} as --backup-dir: it holds the source database (${basename(dbPath)})`)
  }
  // Every refusal runs before a database is opened or a directory is created.
  const requestedWorkDir = args.workDir === undefined ? null : resolve(args.workDir)
  if (requestedWorkDir !== null) {
    const realWorkDir = realTarget(requestedWorkDir)
    if (isInside(realWorkDir, realDataDir)) {
      fail(2, `refusing to use ${requestedWorkDir} as --work-dir: it resolves inside DATA_DIR (${realDataDir}), which holds the live database`)
    }
    if (realWorkDir === realDbPath) {
      fail(2, `refusing to use ${requestedWorkDir} as --work-dir: it is the source database itself`)
    }
    // Not every host exports DATA_DIR; the source database's own directory is
    // the live area either way, so a drill may never write into it.
    if (isInside(realWorkDir, dirname(realDbPath))) {
      fail(2, `refusing to use ${requestedWorkDir} as --work-dir: it resolves inside ${dirname(realDbPath)}, which holds the source database`)
    }
    if (realWorkDir === realBackupDir) {
      fail(2, `refusing to use ${requestedWorkDir} as --work-dir: it holds the backups`)
    }
  }

  mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  chmodSync(backupDir, 0o700)
  const existing = newestBackup(backupDir)
  let backupPath
  if (args.fresh || existing === null) {
    const key = configuredBackupKey()
    const required = /^(1|true)$/i.test(process.env.BACKUP_ENCRYPTION_REQUIRED ?? '')
    if (required && key === null) {
      fail(2, 'BACKUP_ENCRYPTION_REQUIRED=true but no backup encryption key is configured; set BACKUP_ENCRYPTION_KEY or BACKUP_ENCRYPTION_KEY_FILE')
    }
    backupPath = await writeBackup(dbPath, backupDir, key)
  } else {
    backupPath = existing
  }
  const backupAgeSeconds = Math.max(0, (Date.now() - statSync(backupPath).mtimeMs) / 1000)

  let workDir
  if (requestedWorkDir === null) {
    workDir = mkdtempSync(join(tmpdir(), 'fledge-restore-drill-'))
  } else {
    const parent = dirname(requestedWorkDir)
    if (!existsSync(parent)) fail(2, `work directory parent does not exist: ${parent}`)
    if (existsSync(requestedWorkDir)) {
      if (!statSync(requestedWorkDir).isDirectory()) fail(2, `--work-dir is not a directory: ${requestedWorkDir}`)
    } else {
      mkdirSync(requestedWorkDir, { mode: 0o700 })
    }
    chmodSync(requestedWorkDir, 0o700)
    workDir = requestedWorkDir
  }
  const cleanup = requestedWorkDir === null && !args.keep
  const restoredPath = join(workDir, 'restored.db')
  let restored
  let succeeded = false
  try {
    const startedAt = process.hrtime.bigint()
    const encrypted = backupPath.endsWith('.enc')
    const manifest = readManifestOrFail(backupPath)
    if (encrypted) {
      if (manifest !== null) {
        process.stdout.write(`manifest=${manifestPath(backupPath)}\n`)
        // The manifest hashes the encrypted file, not the plaintext it holds;
        // check the copy on disk before spending the key on it.
        const ciphertext = { size: statSync(backupPath).size, sha256: await sha256File(backupPath) }
        verifyManifestBytes(manifest, backupPath, ciphertext)
      }
      const key = encryptionKeyForDrill()
      let encryption
      try {
        encryption = await decryptBackupFile(backupPath, restoredPath, key)
      } catch (error) {
        fail(1, `cannot decrypt ${backupPath}: ${error instanceof Error ? error.message : String(error)}`)
      }
      process.stdout.write(`encryption=${encryption.algorithm} kdf=${String(encryption.kdf)} key_id=${encryption.keyId} key_version=${encryption.keyVersion}\n`)
    } else {
      copyFileSync(backupPath, restoredPath)
      chmodSync(restoredPath, 0o600)
      const copy = await verifyRestoredCopy(restoredPath, backupPath)
      if (manifest !== null) {
        process.stdout.write(`manifest=${manifestPath(backupPath)}\n`)
        verifyManifestBytes(manifest, backupPath, copy)
      }
    }
    restored = openRestored(restoredPath, backupPath)
    const restoredTables = tableNames(restored)
    assertApplicationSchema(restored, restoredTables, backupPath, manifest)
    if (manifest === null) {
      // An older backup tool wrote the copy only; the exact check above already
      // passed, and row counts are never compared with the live source. Printed
      // after the schema guard so a refused run does not lead with this warning.
      process.stdout.write(`manifest=missing\n`)
    }
    const restoredCounts = new Map(restoredTables.map((table) => [table, rowCount(restored, table)]))
    if (manifest !== null) verifyManifestDatabase(manifest, backupPath, restored, restoredTables, restoredCounts)
    reportSourceDrift(dbPath, restoredTables, restoredCounts)
    const rtoSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9
    process.stdout.write(`backup=${backupPath}\n`)
    process.stdout.write(`restored=${restoredPath}\n`)
    process.stdout.write(`RTO=${rtoSeconds.toFixed(3)}s\n`)
    process.stdout.write(`RPO=${backupAgeSeconds.toFixed(3)}s\n`)
    process.stdout.write('restore-drill: OK\n')
    try {
      writeDrillStatus(true, `RTO=${rtoSeconds.toFixed(3)}s RPO=${backupAgeSeconds.toFixed(3)}s`)
    } catch (error) {
      // A status write is for the console; it must not turn a successful restore
      // into a failed drill.
      process.stderr.write(`restore-drill: could not write ${statusTarget}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
    succeeded = true
  } finally {
    if (restored !== undefined) restored.close()
    // docs/deploy.md restores from <work-dir>/restored.db, so a failed drill must
    // not leave a copy there: rename it out of the way and drop the temp dir.
    if (!succeeded && existsSync(restoredPath)) {
      const failedPath = `${restoredPath}.failed`
      rmSync(failedPath, { force: true })
      renameSync(restoredPath, failedPath)
    }
    if (cleanup) rmSync(workDir, { recursive: true, force: true })
  }
}

try {
  await main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  try {
    writeDrillStatus(false, message)
  } catch {
    // The drill failure is the fact to report; a broken status path must not hide it.
  }
  if (error instanceof DrillError) {
    process.stderr.write(`restore-drill: ${message}\n`)
    process.exitCode = error.code
  } else {
    process.stderr.write(`restore-drill: ${error instanceof Error ? error.stack ?? message : message}\n`)
    process.exitCode = 1
  }
}
