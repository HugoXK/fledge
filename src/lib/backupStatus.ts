import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// What `/admin` can say about backups without opening the database that is
// being backed up: the copies `npm run db:backup` wrote, the manifest it left
// beside each one, and the age of the newest. Read-only by construction: this
// module lists and reads files and never touches `fledge.db`.
export const DEFAULT_EXPECTED_HOURS = 26

// Hashing is the only read of a copy's bytes during a page render, so it is
// bounded: 4 MiB is a short burst even on a slow disk, and a larger copy is
// reported as not checked. `npm run db:restore-drill` is what verifies a big
// copy; this page must not stall to repeat it.
export const SHA256_MAX_BYTES = 4 * 1024 * 1024

export type ManifestState = 'matches' | 'differs' | 'not-checked' | 'missing' | 'unreadable'

export interface BackupCopyStatus {
  name: string
  /** When the writer finished the copy, from its file-name stamp. */
  createdAt: string | null
  sizeBytes: number
  /** Hours between the copy and the page render; null when the stamp is unreadable. */
  ageHours: number | null
  manifest: ManifestState
  /** Which half of the manifest disagrees, when `manifest` is `differs`. */
  manifestDetail: 'size' | 'sha256' | null
}

export interface BackupStatus {
  dir: string
  /** False when the directory does not exist: no copy has ever been written. */
  present: boolean
  /** Newest first. */
  copies: BackupCopyStatus[]
  newest: BackupCopyStatus | null
  /** True only when a copy exists and is older than the expected interval. */
  stale: boolean
  expectedHours: number
  /** Copies a manifest vouches for, and copies it does not. */
  matching: number
  mismatched: number
}

// `fledge-2026-11-09T02-00-00-000Z.db`: the writer's ISO stamp with the colons
// and the dot replaced, because a file name cannot hold them.
const STAMP = /^fledge-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.db$/

function stampOf(name: string): { createdAt: string; time: number } | null {
  const match = STAMP.exec(name)
  if (match === null) return null
  const createdAt = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`
  const time = Date.parse(createdAt)
  return Number.isNaN(time) ? null : { createdAt, time }
}

// The manifest shape `scripts/lib/backup-manifest.mjs` writes, validated here
// rather than trusted: a half-written or hand-edited file must read as a
// mismatch, not as a claim. That writer owns the format; this only reads it.
interface ManifestRecord {
  copy: string
  size: number
  sha256: string
}

function manifestOf(copyPath: string, name: string): ManifestRecord | 'missing' | 'unreadable' {
  const path = `${copyPath}.json`
  if (!existsSync(path)) return 'missing'
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ManifestRecord>
    if (parsed.copy !== name || typeof parsed.size !== 'number' || typeof parsed.sha256 !== 'string') return 'unreadable'
    return { copy: parsed.copy, size: parsed.size, sha256: parsed.sha256 }
  } catch {
    return 'unreadable'
  }
}

function sha256Sync(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function inspect(dir: string, name: string, now: number): BackupCopyStatus | null {
  const path = join(dir, name)
  let sizeBytes: number
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return null
    sizeBytes = stat.size
  } catch {
    return null
  }
  const stamped = stampOf(name)
  // A copy renamed away from its stamp still has an mtime; the page shows that
  // age rather than pretending the file has no date.
  const time = stamped?.time ?? statMtime(path)
  const manifest = manifestOf(path, name)
  let state: ManifestState
  let detail: 'size' | 'sha256' | null = null
  if (manifest === 'missing' || manifest === 'unreadable') {
    state = manifest
  } else if (manifest.size !== sizeBytes) {
    state = 'differs'
    detail = 'size'
  } else if (sizeBytes > SHA256_MAX_BYTES) {
    state = 'not-checked'
  } else {
    try {
      state = sha256Sync(path) === manifest.sha256 ? 'matches' : 'differs'
      detail = state === 'differs' ? 'sha256' : null
    } catch {
      state = 'unreadable'
    }
  }
  return {
    name,
    createdAt: stamped?.createdAt ?? (time === null ? null : new Date(time).toISOString()),
    sizeBytes,
    ageHours: time === null ? null : (now - time) / 3_600_000,
    manifest: state,
    manifestDetail: detail,
  }
}

function statMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

export function readBackupStatus(input: {
  dir: string
  /** Injectable so a test can pin the age instead of racing the clock. */
  now?: number
  expectedHours?: number
}): BackupStatus {
  const now = input.now ?? Date.now()
  const expectedHours = input.expectedHours ?? DEFAULT_EXPECTED_HOURS
  let names: string[]
  try {
    names = readdirSync(input.dir).filter((name) => name.endsWith('.db') && name.startsWith('fledge-'))
  } catch {
    return { dir: input.dir, present: false, copies: [], newest: null, stale: false, expectedHours, matching: 0, mismatched: 0 }
  }
  const copies = names
    .map((name) => inspect(input.dir, name, now))
    .filter((copy): copy is BackupCopyStatus => copy !== null)
    // Smallest age first: that is the newest copy. A copy whose date cannot be
    // read sorts last rather than claiming to be the freshest.
    .sort((left, right) => (left.ageHours ?? Number.POSITIVE_INFINITY) - (right.ageHours ?? Number.POSITIVE_INFINITY))
  const newest = copies[0] ?? null
  const matching = copies.filter((copy) => copy.manifest === 'matches').length
  return {
    dir: input.dir,
    present: true,
    copies,
    newest,
    stale: newest?.ageHours !== null && newest?.ageHours !== undefined && newest.ageHours > expectedHours,
    expectedHours,
    matching,
    mismatched: copies.length - matching,
  }
}
