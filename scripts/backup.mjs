#!/usr/bin/env node
// Online SQLite backup; safe to run while Fledge is serving. Every copy is
// verified with integrity_check before it is reported, then old copies are
// pruned to the retention count.
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { encryptBackupFile, loadBackupKey } from './lib/backup-crypto.mjs'
import {
  DEFAULT_KEEP_ENCRYPTED,
  DEFAULT_KEEP_PLAINTEXT,
  copyKind,
  databaseFacts,
  manifestPath,
  writeManifest,
} from './lib/backup-manifest.mjs'
import { INTERMEDIATE_GRACE_MS, backupWorkRoot, createPlaintextWorkDir, isPlaintextIntermediate, removeWorkDir } from './lib/backup-plaintext.mjs'

const require = createRequire(import.meta.url)
const { DatabaseSync, backup } = require('node:sqlite')

const USAGE = 'usage: node scripts/backup.mjs [--db <path>] [--backup-dir <dir>] [--keep <n>]'

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

// A keep count decides what gets deleted, so an invalid one is refused rather
// than clamped — `0` would erase every copy of that class. Same rule and same
// wording as `scripts/backup-prune.mjs` and `loadConfig`.
function keepCount(name, raw, fallback) {
  if (raw === undefined || raw === '') {
    if (fallback !== undefined) return fallback
    fail(2, `${name} must be a positive whole number, got ${raw === '' ? 'an empty value' : 'no value'}`)
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) fail(2, `${name} must be a positive whole number, got ${raw}`)
  return value
}

function prune(dir, keep, target) {
  const entries = readdirSync(dir).map((name) => ({ name, path: join(dir, name) }))
  // A `.plaintext.tmp` here is a crash leftover from a tip that took the copy
  // inside the backup directory. It is a readable database, so it is collected
  // rather than left for an operator to find; the grace window keeps a backup
  // still running from losing its own intermediate mid-write.
  let intermediates = 0
  const now = Date.now()
  for (const entry of entries) {
    if (!isPlaintextIntermediate(entry.name)) continue
    try {
      const stat = statSync(entry.path)
      if (!stat.isFile() || now - stat.mtimeMs < INTERMEDIATE_GRACE_MS) continue
      rmSync(entry.path, { force: true })
      intermediates += 1
    } catch {
      // Vanished between readdir and removal; nothing to collect.
    }
  }
  // #1188: prune each class at its own count. The console and the dry run report
  // `BACKUP_KEEP_PLAINTEXT` / `BACKUP_KEEP_ENCRYPTED`, so one merged list pruned to
  // one number would delete copies the displayed policy says to keep — and keep
  // plaintext copies the displayed policy says to take.
  const copies = { plaintext: [], encrypted: [] }
  for (const entry of entries) {
    const kind = copyKind(entry.name)
    if (kind === null) continue
    copies[kind].push({ path: entry.path, mtime: statSync(entry.path).mtimeMs })
  }
  let pruned = 0
  for (const kind of ['plaintext', 'encrypted']) {
    const sorted = copies[kind].sort((left, right) => right.mtime - left.mtime)
    // The copy this run just wrote is kept by path, not by position. A copy with
    // a future mtime (a clock stepped back, or a set restored with `cp -a`) sorts
    // ahead of it; pruning on mtime alone would then delete the backup this run
    // reports. Pinning it first still keeps the class at its configured count.
    const own = sorted.findIndex((copy) => copy.path === target)
    if (own !== -1) {
      const [written] = sorted.splice(own, 1)
      sorted.unshift(written)
    }
    for (const copy of sorted.slice(keep[kind])) {
      rmSync(copy.path, { force: true })
      // A manifest describes exactly one copy, so it goes with it.
      rmSync(manifestPath(copy.path), { force: true })
      pruned += 1
    }
  }
  return { pruned, intermediates }
}

const args = parseArgs(process.argv.slice(2))
const dbPath = resolve(args.db ?? process.env.DB_PATH ?? join(process.env.DATA_DIR ?? './data', 'fledge.db'))
const outDir = resolve(args.backupDir ?? process.env.BACKUP_DIR ?? join(process.env.DATA_DIR ?? './data', 'backups'))
// `--keep` / `BACKUP_KEEP` is an explicit override of both classes for one run,
// not a second policy. Without it the write-time counts are the same per-class
// counts `loadConfig`, the dry run and the console report, from one definition.
// A value that was supplied is validated even when it is empty: a wrapper whose
// variable expands empty must be refused, not fall through to the defaults and
// delete at counts nobody asked for.
const flagGiven = Object.hasOwn(args, 'keep')
const supplied = flagGiven || process.env.BACKUP_KEEP !== undefined
const overridden = supplied ? keepCount('--keep', flagGiven ? args.keep : process.env.BACKUP_KEEP) : null
const keep =
  overridden === null
    ? {
        plaintext: keepCount('BACKUP_KEEP_PLAINTEXT', process.env.BACKUP_KEEP_PLAINTEXT, DEFAULT_KEEP_PLAINTEXT),
        encrypted: keepCount('BACKUP_KEEP_ENCRYPTED', process.env.BACKUP_KEEP_ENCRYPTED, DEFAULT_KEEP_ENCRYPTED),
      }
    : { plaintext: overridden, encrypted: overridden }
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
// While encrypting, the plaintext copy is a second copy of everything the
// encryption protects, so it never sits in the backup directory: it is taken in
// an owner-only work directory outside it, and removed however this process ends
// (including every `fail()` below, which exits). A crash can still leave it in
// that work directory, which the next run sweeps once it is stale.
let plaintextTarget = target
let workDir = null
if (encrypt) {
  try {
    workDir = createPlaintextWorkDir(backupWorkRoot(process.env))
  } catch (error) {
    fail(2, `cannot create the plaintext work directory: ${error instanceof Error ? error.message : String(error)}`)
  }
  process.on('exit', () => {
    try {
      removeWorkDir(workDir)
    } catch {
      // A cleanup failure must never change this run's exit code.
    }
  })
  plaintextTarget = join(workDir, 'fledge.db.plaintext.tmp')
}

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

const pruned = prune(outDir, keep, target)
// The written copy is pinned into the kept set, so it survives; if it is gone
// anyway the `backup=` line and `backup: OK` would name a file no reader can
// open, and this run refuses instead of reporting success.
if (!existsSync(target)) fail(1, `the backup this run wrote is missing after pruning: ${target}`)
process.stdout.write(`backup=${target}\n`)
process.stdout.write(`manifest=${manifest}\n`)
process.stdout.write('integrity=ok\n')
if (encrypt) {
  process.stdout.write(`encryption=${encryption.algorithm} kdf=${String(encryption.kdf)} key_id=${encryption.keyId} key_version=${encryption.keyVersion}\n`)
} else {
  process.stdout.write('encryption=none\n')
}
process.stdout.write(
  `retention=keep:plaintext=${keep.plaintext},encrypted=${keep.encrypted}${overridden === null ? '' : ' override=--keep'} pruned=${pruned.pruned} intermediates=${pruned.intermediates}\n`,
)
process.stdout.write('backup: OK\n')
