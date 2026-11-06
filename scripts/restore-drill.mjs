#!/usr/bin/env node
// Restore drill: restore the newest online backup into a temp path and prove it
// matches the source database. Reads the source read-only, never writes it.
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const { DatabaseSync, backup } = require('node:sqlite')

const USAGE = 'usage: node scripts/restore-drill.mjs [--db <path>] [--backup-dir <dir>] [--work-dir <dir>] [--fresh] [--keep]'

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

function newestBackup(dir) {
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
    .filter((name) => name.startsWith('fledge-') && name.endsWith('.db'))
    .map((name) => join(dir, name))
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime)
  return files.length === 0 ? null : files[0].path
}

async function writeBackup(sourcePath, dir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = join(dir, `fledge-${stamp}.db`)
  const source = new DatabaseSync(sourcePath, { readOnly: true })
  try {
    await backup(source, target)
  } finally {
    source.close()
  }
  chmodSync(target, 0o600)
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

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(`${USAGE}\n`)
    return
  }
  const dbPath = resolve(args.db ?? process.env.DB_PATH ?? join(process.env.DATA_DIR ?? './data', 'fledge.db'))
  const backupDir = resolve(args.backupDir ?? process.env.BACKUP_DIR ?? join(process.env.DATA_DIR ?? './data', 'backups'))
  const dataDir = resolve(process.env.DATA_DIR ?? './data')
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
  const backupPath = args.fresh || existing === null ? await writeBackup(dbPath, backupDir) : existing
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
    copyFileSync(backupPath, restoredPath)
    chmodSync(restoredPath, 0o600)
    restored = openRestored(restoredPath, backupPath)
    const restoredTables = tableNames(restored)
    const source = new DatabaseSync(dbPath, { readOnly: true })
    const failures = []
    try {
      const sourceTables = tableNames(source)
      const all = [...new Set([...sourceTables, ...restoredTables])].sort()
      const sourceSet = new Set(sourceTables)
      const restoredSet = new Set(restoredTables)
      for (const table of all) {
        const expected = sourceSet.has(table) ? rowCount(source, table) : 0
        const actual = restoredSet.has(table) ? rowCount(restored, table) : 0
        process.stdout.write(`table=${table} expected=${expected} actual=${actual}\n`)
        if (!sourceSet.has(table)) failures.push(`table ${table} exists only in the restore`)
        else if (!restoredSet.has(table)) failures.push(`table ${table} is missing from the restore`)
        else if (expected !== actual) failures.push(`table ${table} expected=${expected} actual=${actual}`)
      }
      const expectedVersion = schemaVersion(source)
      const actualVersion = schemaVersion(restored)
      process.stdout.write(`schema_version expected=${expectedVersion} actual=${actualVersion}\n`)
      if (expectedVersion !== actualVersion) failures.push(`schema_version expected=${expectedVersion} actual=${actualVersion}`)
    } finally {
      source.close()
    }
    const rtoSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9
    process.stdout.write(`backup=${backupPath}\n`)
    process.stdout.write(`restored=${restoredPath}\n`)
    process.stdout.write(`RTO=${rtoSeconds.toFixed(3)}s\n`)
    process.stdout.write(`RPO=${backupAgeSeconds.toFixed(3)}s\n`)
    if (failures.length > 0) fail(1, `restore does not match the source\n${failures.join('\n')}`)
    process.stdout.write('restore-drill: OK\n')
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
  if (error instanceof DrillError) {
    process.stderr.write(`restore-drill: ${error.message}\n`)
    process.exitCode = error.code
  } else {
    process.stderr.write(`restore-drill: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
