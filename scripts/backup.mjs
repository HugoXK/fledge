#!/usr/bin/env node
// Online SQLite backup; safe to run while Fledge is serving. Every copy is
// verified with integrity_check before it is reported, then old copies are
// pruned to the retention count.
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { manifestPath, writeManifest } from './lib/backup-manifest.mjs'

const require = createRequire(import.meta.url)
const { DatabaseSync, backup } = require('node:sqlite')

const USAGE = 'usage: node scripts/backup.mjs [--db <path>] [--backup-dir <dir>] [--keep <n>]'
const DEFAULT_KEEP = 14

function fail(code, message) {
  process.stderr.write(`backup: ${message}\n`)
  process.exit(code)
}

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${USAGE}\n`)
      process.exit(0)
    } else if (arg === '--db') {
      index += 1
      parsed.db = argv[index]
    } else if (arg === '--backup-dir') {
      index += 1
      parsed.backupDir = argv[index]
    } else if (arg === '--keep') {
      index += 1
      parsed.keep = argv[index]
    } else {
      fail(2, `unknown argument ${arg}\n${USAGE}`)
    }
  }
  return parsed
}

function prune(dir, keep) {
  const copies = readdirSync(dir)
    .filter((name) => name.startsWith('fledge-') && name.endsWith('.db'))
    .map((name) => join(dir, name))
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime)
  const stale = copies.slice(keep)
  for (const copy of stale) {
    rmSync(copy.path, { force: true })
    // A manifest describes exactly one copy, so it goes with it.
    rmSync(manifestPath(copy.path), { force: true })
  }
  return stale.length
}

const args = parseArgs(process.argv.slice(2))
const dbPath = resolve(args.db ?? process.env.DB_PATH ?? join(process.env.DATA_DIR ?? './data', 'fledge.db'))
const outDir = resolve(args.backupDir ?? process.env.BACKUP_DIR ?? join(process.env.DATA_DIR ?? './data', 'backups'))
const rawKeep = args.keep ?? process.env.BACKUP_KEEP ?? String(DEFAULT_KEEP)
const keep = Number(rawKeep)
if (!Number.isInteger(keep) || keep < 1) fail(2, `--keep must be a positive whole number, got ${rawKeep}`)
if (!existsSync(dbPath)) fail(2, `source database not found: ${dbPath}`)

mkdirSync(outDir, { recursive: true, mode: 0o700 })
chmodSync(outDir, 0o700)
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const target = join(outDir, `fledge-${stamp}.db`)

const db = new DatabaseSync(dbPath, { readOnly: true })
try {
  await backup(db, target)
} catch (error) {
  rmSync(target, { force: true })
  fail(1, `backup failed: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  db.close()
}
// A backup carries the same data as the live database; keep it owner-only.
chmodSync(target, 0o600)

let integrity = []
try {
  const copy = new DatabaseSync(target, { readOnly: true })
  try {
    integrity = copy.prepare('PRAGMA integrity_check').all().map((row) => String(Object.values(row)[0]))
  } finally {
    copy.close()
  }
} catch (error) {
  rmSync(target, { force: true })
  fail(1, `backup is corrupt: ${error instanceof Error ? error.message : String(error)}`)
}
if (integrity.length !== 1 || integrity[0] !== 'ok') {
  rmSync(target, { force: true })
  fail(1, `backup is corrupt: integrity_check reported ${integrity.slice(0, 3).join('; ') || 'no result'}`)
}

// The manifest is what lets a later drill prove the file on disk is still the
// database this run wrote, so it is written after the integrity check and
// before pruning may delete this copy.
const manifest = writeManifest(target)

const pruned = prune(outDir, keep)
process.stdout.write(`backup=${target}\n`)
process.stdout.write(`manifest=${manifest}\n`)
process.stdout.write('integrity=ok\n')
process.stdout.write(`retention=keep:${keep} pruned=${pruned}\n`)
process.stdout.write('backup: OK\n')
