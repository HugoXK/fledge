#!/usr/bin/env node
// Restore drill: restore the newest online backup into a temp path and prove it
// matches the source database. Reads the source read-only, never writes it.
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const { DatabaseSync, backup } = require('node:sqlite')

const USAGE = 'usage: node scripts/restore-drill.mjs [--db <path>] [--backup-dir <dir>] [--work-dir <dir>] [--fresh] [--keep]'

function fail(code, message) {
  process.stderr.write(`restore-drill: ${message}\n`)
  process.exit(code)
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
      fail(1, `corrupt backup ${backupPath}: integrity_check reported ${messages.slice(0, 3).join('; ') || 'no result'}`)
    }
    // A table list runs one more read; a truncated page may still pass the check above.
    tableNames(db)
  } catch (error) {
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
  if (dbPath === backupDir || dirname(dbPath) === backupDir) {
    fail(2, `refusing to use ${backupDir} as --backup-dir: it holds the source database (${basename(dbPath)})`)
  }
  // Every refusal runs before a database is opened or a directory is created.
  const requestedWorkDir = args.workDir === undefined ? null : resolve(args.workDir)
  if (requestedWorkDir !== null) {
    if (isInside(requestedWorkDir, dataDir)) {
      fail(2, `refusing to use ${requestedWorkDir} as --work-dir: it is inside DATA_DIR (${dataDir}), which holds the live database`)
    }
    if (requestedWorkDir === dbPath) {
      fail(2, `refusing to use ${requestedWorkDir} as --work-dir: it is the source database itself`)
    }
    if (requestedWorkDir === dirname(dbPath) || requestedWorkDir === backupDir) {
      fail(2, `refusing to use ${requestedWorkDir} as --work-dir: it holds the source database or the backups`)
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
  } finally {
    if (restored !== undefined) restored.close()
    if (cleanup) rmSync(workDir, { recursive: true, force: true })
  }
}

await main()
