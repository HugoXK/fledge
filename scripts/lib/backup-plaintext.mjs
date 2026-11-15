#!/usr/bin/env node
// The plaintext copy a backup is taken from is a second copy of everything the
// encryption protects. While it exists it therefore lives in an owner-only work
// directory outside the backup directory - the artifact an operator copies
// off-host - and it is removed however the process ends. `prune` still collects
// a `.plaintext.tmp` an older tip left in the backup directory, after a grace
// window long enough that an in-flight backup is never mistaken for garbage.
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// A file younger than this may belong to a backup still running - including one
// started by the previous version during a rollout - so it is never collected.
// One hour is far longer than any backup's write phase and short enough that a
// crash leftover never survives the next scheduled run.
export const INTERMEDIATE_GRACE_MS = 60 * 60 * 1000

const INTERMEDIATE_SUFFIX = '.plaintext.tmp'
const WORK_DIR_PREFIXES = ['fledge-backup-', 'fledge-drill-']

// The names an interrupted encrypted backup could leave in the backup directory:
// `fledge-<stamp>.db.enc.plaintext.tmp` from the backup script and the drill's
// `--fresh` path. A finished copy never takes this shape.
export function isPlaintextIntermediate(name) {
  return name.startsWith('fledge-') && name.endsWith(INTERMEDIATE_SUFFIX)
}

// TMPDIR is not always a place a large copy fits (a tmpfs, or a container with a
// small /tmp), so the operator can move it; the default stays the system one.
export function backupWorkRoot(env = process.env) {
  return resolve(env.BACKUP_WORK_DIR ?? tmpdir())
}

// The work directory itself is `0700`: whatever mode the root has, no other
// account on the host can read the copy through the path this returns.
export function createPlaintextWorkDir(root, now = Date.now()) {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  sweepStaleWorkDirs(root, now)
  const dir = mkdtempSync(join(root, 'fledge-backup-'))
  chmodSync(dir, 0o700)
  return dir
}

export function removeWorkDir(dir) {
  rmSync(dir, { recursive: true, force: true })
}

// A process killed outright cannot clean up after itself, so the next backup
// collects what a previous crash left behind. Best effort: an unreadable or
// already-gone entry must never stop a backup from being taken.
export function sweepStaleWorkDirs(root, now = Date.now()) {
  let names
  try {
    names = readdirSync(root)
  } catch {
    return 0
  }
  let swept = 0
  for (const name of names) {
    if (!WORK_DIR_PREFIXES.some((prefix) => name.startsWith(prefix))) continue
    const path = join(root, name)
    try {
      const stat = statSync(path)
      if (!stat.isDirectory()) continue
      if (now - stat.mtimeMs < INTERMEDIATE_GRACE_MS) continue
      removeWorkDir(path)
      swept += 1
    } catch {
      // A directory that vanished between readdir and stat, or that the operator
      // made unreadable, is not this run's problem.
    }
  }
  return swept
}
