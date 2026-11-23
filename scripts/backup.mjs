#!/usr/bin/env node
// Online SQLite backup; safe to run while Fledge is serving. Every copy is
// verified with integrity_check before it is reported, then old copies are
// pruned to the retention count.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { encryptBackupFile, loadBackupKey } from './lib/backup-crypto.mjs'
import {
  DEFAULT_KEEP_ENCRYPTED,
  DEFAULT_KEEP_PLAINTEXT,
  copyKind,
  databaseFacts,
  manifestPath,
  statOrNull,
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
    // #1196: an entry is a copy only when it is a regular file. A directory (or a
    // symlink) named like a copy used to sort into the class and reach `rmSync`,
    // which threw EISDIR out of the process; an entry that vanished between
    // `readdir` and `stat` threw ENOENT there. Both are `null` here and are left
    // alone — this writer only deletes files it is allowed to delete.
    const stat = statOrNull(entry.path)
    if (stat === null) continue
    copies[kind].push({ path: entry.path, mtime: stat.mtimeMs })
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

// One run per backup directory (#1196). A cron tick and a manual
// `npm run db:backup` used to prune each other's copies: whichever pruned second
// deleted a copy the other had just written and reported. The lock is the shape
// `deploy/fledge-deploy-tag.sh` uses — an exclusive lock file, never a wait —
// except that node has no `flock`, so the file carries the holder's pid and a
// lock whose holder is gone is taken over instead of blocking every later run.
const LOCK_NAME = '.fledge-backup.lock'
// Serialises takeovers of a lock whose holder is gone; see `acquireLock`. It is
// not the lock itself: it is only held across the remove-and-recreate, so two runs
// can never both delete and both create.
const LOCK_TAKEOVER_NAME = '.fledge-backup.lock.takeover'
// A lock file created but not yet written (its pid lands a moment later) looks
// the same as one left by a run that died inside those two calls — and judging a
// dead pid is not the same as owning the delete. Two guards keep a fresh lock out
// of another run's takeover:
//
//   - a lock is takeable only once its own mtime is older than this grace, so a
//     file created milliseconds ago is never a candidate: the run that made it is
//     between `O_EXCL` and its pid write, or its exit handler is about to remove
//     it. 10 s is short enough that a crashed run does not block the next cron
//     tick for long and long enough that no live run is mistaken for a dead one.
//   - the entry is read and stat'ed again immediately before the delete, and the
//     delete happens only when pid, mtime and inode are still the ones judged
//     dead. Otherwise another run already took the directory over.
const LOCK_TAKEOVER_GRACE_MS = 10_000
// A lock that exists but cannot be read has no pid to judge, so it waits longer:
// only a file this old can be the remains of a run killed between create and
// write rather than a run in the middle of those two calls.
const LOCK_UNREADABLE_GRACE_MS = 60_000

function readLockPid(lockPath) {
  try {
    const pid = Number(readFileSync(lockPath, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

// One read of the entry: the pid it names and the identity of the file itself.
// The identity is what tells "the same dead lock I judged" from "a lock another
// run created since".
function lockSnapshot(lockPath) {
  const stat = statOrNull(lockPath)
  if (stat === null) return null
  return { pid: readLockPid(lockPath), mtimeMs: stat.mtimeMs, ino: stat.ino, dev: stat.dev }
}

function sameLock(left, right) {
  return (
    left !== null &&
    right !== null &&
    left.pid === right.pid &&
    left.mtimeMs === right.mtimeMs &&
    left.ino === right.ino &&
    left.dev === right.dev
  )
}

function lockIsStale(snapshot) {
  if (snapshot === null) return false
  const age = Date.now() - snapshot.mtimeMs
  if (snapshot.pid === null) return age > LOCK_UNREADABLE_GRACE_MS
  // A young lock is never stale, dead pid or not: its holder may be one
  // instruction from writing its pid, and its exit handler releases it.
  if (age <= LOCK_TAKEOVER_GRACE_MS) return false
  try {
    process.kill(snapshot.pid, 0)
    return false
  } catch (error) {
    // ESRCH: no such process, so the lock outlived its holder. EPERM: the process
    // exists under another account, which is still a holder.
    return error?.code === 'ESRCH'
  }
}

function acquireLock(dir) {
  const lockPath = join(dir, LOCK_NAME)
  const takeoverPath = join(dir, LOCK_TAKEOVER_NAME)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // O_CREAT|O_EXCL: the first run to create the entry holds the directory.
      writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 })
      return lockPath
    } catch (error) {
      if (error?.code !== 'EEXIST') fail(2, `cannot lock the backup directory: ${error instanceof Error ? error.message : String(error)}`)
      const judged = lockSnapshot(lockPath)
      // The holder released between the failed create and this read: the next
      // attempt can create the lock, and nothing is being taken over.
      if (judged === null) continue
      if (!lockIsStale(judged)) {
        fail(1, `another backup run holds ${dir} (pid ${judged.pid === null ? 'unknown' : String(judged.pid)}); refusing to share the backup directory`)
      }
      // #1196 review: the delete is serialised by a second `O_EXCL` entry, so two
      // runs that judge the same dead lock cannot both reach it. Re-reading and
      // comparing is not enough on its own: `rmSync` removes whatever is at the
      // path by the time it runs, so a fresh lock created between the comparison
      // and the delete would be removed by a run that judged a different file.
      // The marker makes the remove-then-create a critical section; a run that
      // cannot take it lets the holder do the takeover and comes back to see the
      // lock it created.
      try {
        writeFileSync(takeoverPath, String(process.pid), { flag: 'wx', mode: 0o600 })
      } catch (error) {
        if (error?.code !== 'EEXIST') fail(2, `cannot lock the backup directory: ${error instanceof Error ? error.message : String(error)}`)
        // The marker is held only across the two calls below, so an old one is a
        // run that was killed inside them: sweep it and try the takeover again.
        const abandoned = statOrNull(takeoverPath)
        if (abandoned !== null && Date.now() - abandoned.mtimeMs > LOCK_TAKEOVER_GRACE_MS) {
          rmSync(takeoverPath, { force: true })
          continue
        }
        // Another run is taking the dead lock over right now. Waiting is the one
        // thing this lock never does, so this run refuses and names it: the run
        // that holds the marker is about to create the lock this one would have
        // taken. Retrying instead is what turned four runs on one dead lock into
        // `cannot take the backup lock` for all of them.
        const holder = readLockPid(takeoverPath)
        fail(1, `another backup run holds ${dir} (pid ${holder === null ? 'unknown' : String(holder)}); refusing to share the backup directory`)
      }
      let takeoverError = null
      try {
        // Under the marker the entry can only change by this run's own delete:
        // the only other writer of it is a takeover, and takeovers are serialised
        // here. The comparison still runs, because a takeover that finished
        // before this marker was taken has already replaced the dead lock.
        const current = lockSnapshot(lockPath)
        if (current !== null && sameLock(judged, current) && lockIsStale(current)) rmSync(lockPath, { force: true })
      } catch (error) {
        takeoverError = error
      } finally {
        rmSync(takeoverPath, { force: true })
      }
      if (takeoverError !== null) {
        fail(2, `cannot take the backup lock ${lockPath}: ${takeoverError instanceof Error ? takeoverError.message : String(takeoverError)}`)
      }
    }
  }
  fail(1, `cannot take the backup lock ${lockPath}`)
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
// The lock is taken before anything is written, so the rest of the run is the
// only writer in this directory: the copy it writes cannot be pruned by another
// run, and the copy it reports cannot be deleted under it.
const lockPath = acquireLock(outDir)
// Released however the process ends, including every `fail()` below; a run that
// is killed outright leaves the file, and the next run takes it over by pid.
process.on('exit', () => {
  try {
    if (readLockPid(lockPath) === process.pid) rmSync(lockPath, { force: true })
  } catch {
    // A lock that cannot be released must not change this run's exit code; the
    // next run recognises the stale pid.
  }
})
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
