#!/usr/bin/env node
// Online SQLite backup; safe to run while Fledge is serving. Every copy is
// verified with integrity_check before it is reported, then old copies are
// pruned to the retention count.
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { encryptBackupFile, loadBackupKey } from './lib/backup-crypto.mjs'
import { databaseFacts, manifestPath, writeManifest } from './lib/backup-manifest.mjs'

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
    .filter((name) => name.startsWith('fledge-') && (name.endsWith('.db') || name.endsWith('.db.enc')))
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

let key
try {
  key = loadBackupKey(process.env)
} catch (error) {
  fail(2, error instanceof Error ? error.message : String(error))
}
const required = /^(1|true)$/i.test(process.env.BACKUP_ENCRYPTION_REQUIRED ?? '')
if (required && key === null) {
  fail(2, 'BACKUP_ENCRYPTION_REQUIRED=true but no backup encryption key is configured; set BACKUP_ENCRYPTION_KEY or BACKUP_ENCRYPTION_KEY_FILE')
}
const encrypt = key !== null

mkdirSync(outDir, { recursive: true, mode: 0o700 })
chmodSync(outDir, 0o700)
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const target = join(outDir, `fledge-${stamp}.db${encrypt ? '.enc' : ''}`)
// While encrypting, the plaintext intermediate deliberately does not end in
// `.db`, so a crash cannot leave a file the drill or /admin calls a backup.
const plaintextTarget = encrypt ? `${target}.plaintext.tmp` : target

const db = new DatabaseSync(dbPath, { readOnly: true })
try {
  await backup(db, plaintextTarget)
} catch (error) {
  rmSync(plaintextTarget, { force: true })
  fail(1, `backup failed: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  db.close()
}
// A backup carries the same data as the live database; keep it owner-only.
chmodSync(plaintextTarget, 0o600)

let integrity = []
try {
  const copy = new DatabaseSync(plaintextTarget, { readOnly: true })
  try {
    integrity = copy.prepare('PRAGMA integrity_check').all().map((row) => String(Object.values(row)[0]))
  } finally {
    copy.close()
  }
} catch (error) {
  rmSync(plaintextTarget, { force: true })
  fail(1, `backup is corrupt: ${error instanceof Error ? error.message : String(error)}`)
}
if (integrity.length !== 1 || integrity[0] !== 'ok') {
  rmSync(plaintextTarget, { force: true })
  fail(1, `backup is corrupt: integrity_check reported ${integrity.slice(0, 3).join('; ') || 'no result'}`)
}

const facts = databaseFacts(plaintextTarget)
let encryption
if (encrypt) {
  try {
    encryption = await encryptBackupFile(plaintextTarget, target, key)
  } catch (error) {
    rmSync(plaintextTarget, { force: true })
    rmSync(target, { force: true })
    fail(1, `encryption failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  // The plaintext copy is only an intermediate while encrypting; the encrypted
  // copy becomes the backup and the only file the manifest describes.
  rmSync(plaintextTarget, { force: true })
}

// The manifest is what lets a later drill prove the file on disk is still the
// database this run wrote, so it is written after the integrity check and
// before pruning may delete this copy.
const manifest = await writeManifest(target, { facts, encryption })

const pruned = prune(outDir, keep)
process.stdout.write(`backup=${target}\n`)
process.stdout.write(`manifest=${manifest}\n`)
process.stdout.write('integrity=ok\n')
if (encrypt) {
  process.stdout.write(`encryption=${encryption.algorithm} kdf=${String(encryption.kdf)} key_id=${encryption.keyId} key_version=${encryption.keyVersion}\n`)
} else {
  process.stdout.write('encryption=none\n')
}
process.stdout.write(`retention=keep:${keep} pruned=${pruned}\n`)
process.stdout.write('backup: OK\n')
