// #652: the previous-release restore check. `db:restore-drill:ci` proves that a
// database this build wrote can be backed up and restored; it cannot prove that
// a database the *previous release* wrote still opens here. A column rename or a
// dropped table passes that drill and breaks a real upgrade, so the fixture and
// the checks live here, in one place both the suite and the CLI call.
//
// The fixture is data, never a real backup: it is generated from a release tag's
// own `Store` (see `scripts/fixtures/build-prev-release-db.ts`), holds one user,
// one repository and one finished job, and its credential is a plain test string
// encrypted under a deterministic key that protects nothing:
// `Buffer.alloc(32, 7)`, base64-encoded. It is written down here rather than in a
// file so there is no key-shaped literal in the tree at all.
import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { SCHEMA_VERSION, Store } from '../db.js'
import { decryptSecret } from './secrets.js'

interface SqliteStatement {
  all(): Record<string, unknown>[]
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement
  close(): void
}

// The same access path as `src/db.ts`: the sqlite binding is a require.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase
}

export const PREV_RELEASE_FIXTURE_KEY = Buffer.alloc(32, 7).toString('base64')
export const PREV_RELEASE_FIXTURE_DIR = 'test/fixtures/prev-release'
export const PREV_RELEASE_FIXTURE_FILE = 'fledge.db.gz'
export const PREV_RELEASE_PROVENANCE_FILE = 'provenance.json'

// The provenance is the fixture's own record of what it is: which tag wrote it,
// what schema version it carries, how many rows each table had, and which
// credential it holds. Anything the fixture cannot account for in here is not
// something the check is allowed to call a pass.
export interface PrevReleaseProvenance {
  tag: string
  commit: string
  // The repository-relative directory holding the fixture, so a caller cannot
  // point the check at a different pair of files by accident.
  fixture: { file: string; sha256: string; bytes: number }
  schemaVersion: number
  shape: Record<string, number>
  // Every table's column list, so a rename or a drop is visible even when the
  // row count is unchanged — which is the whole point of the fixture.
  columns: Record<string, string[]>
  credential: { repoId: string; plaintext: string }
  generatedBy: string
}

export type PrevReleaseFailure = 'corrupt-fixture' | 'not-older' | 'unreadable' | 'schema-lost' | 'rows-lost' | 'key-mismatch'

export class PrevReleaseError extends Error {
  readonly code: PrevReleaseFailure

  constructor(code: PrevReleaseFailure, message: string) {
    super(message)
    this.code = code
  }
}

export interface PrevReleaseResult {
  tag: string
  fromVersion: number
  toVersion: number
  tables: number
  rows: number
}

export function readProvenance(path: string): PrevReleaseProvenance {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PrevReleaseProvenance>
  if (typeof parsed.tag !== 'string' || typeof parsed.commit !== 'string' || typeof parsed.schemaVersion !== 'number') {
    throw new PrevReleaseError('unreadable', `provenance at ${path} is missing tag, commit or schemaVersion`)
  }
  if (typeof parsed.fixture?.sha256 !== 'string' || typeof parsed.fixture?.file !== 'string') {
    throw new PrevReleaseError('unreadable', `provenance at ${path} does not name the fixture file and its sha256`)
  }
  if (typeof parsed.columns !== 'object' || parsed.columns === null) {
    throw new PrevReleaseError('unreadable', `provenance at ${path} does not record the fixture's columns`)
  }
  if (typeof parsed.credential?.repoId !== 'string' || typeof parsed.credential?.plaintext !== 'string') {
    throw new PrevReleaseError('unreadable', `provenance at ${path} does not name the credential to decrypt`)
  }
  return parsed as PrevReleaseProvenance
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function schemaVersionOf(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return Number(db.prepare('PRAGMA user_version').all()[0]?.user_version ?? 0)
  } finally {
    db.close()
  }
}

function shapeOf(path: string): Record<string, number> {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => String(row.name))
    const shape: Record<string, number> = {}
    for (const table of tables) {
      const quoted = table.replaceAll('"', '""')
      shape[table] = Number(db.prepare(`SELECT COUNT(*) AS n FROM "${quoted}"`).all()[0]?.n ?? 0)
    }
    return shape
  } finally {
    db.close()
  }
}

function columnsOf(path: string): Record<string, string[]> {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => String(row.name))
    const columns: Record<string, string[]> = {}
    for (const table of tables) {
      const quoted = table.replaceAll('"', '""')
      columns[table] = db
        .prepare(`PRAGMA table_info("${quoted}")`)
        .all()
        .map((row) => String(row.name))
    }
    return columns
  } finally {
    db.close()
  }
}

// Restores the fixture with the code in this build, on a copy, and never on the
// committed file: a drill that mutates its own fixture cannot be run twice.
export function verifyPreviousReleaseFixture(input: {
  dbPath: string
  provenance: PrevReleaseProvenance
  keyBase64?: string
}): PrevReleaseResult {
  const key = input.keyBase64 ?? PREV_RELEASE_FIXTURE_KEY
  const fromVersion = schemaVersionOf(input.dbPath)
  if (fromVersion !== input.provenance.schemaVersion) {
    throw new PrevReleaseError('corrupt-fixture', `fixture is schema ${String(fromVersion)} but its provenance says ${String(input.provenance.schemaVersion)}`)
  }
  // A fixture written by this build proves nothing about an upgrade, so it is a
  // failure rather than a pass: it has to be regenerated from an older tag.
  if (fromVersion >= SCHEMA_VERSION) {
    throw new PrevReleaseError(
      'not-older',
      `fixture is schema ${String(fromVersion)} and this build writes ${String(SCHEMA_VERSION)}; regenerate it from a release tag older than this schema`,
    )
  }
  const work = mkdtempSync(join(tmpdir(), 'fledge-prev-release-'))
  try {
    const restored = join(work, 'fledge.db')
    copyFileSync(input.dbPath, restored)
    let plain: string
    let versionAfter = 0
    const store = new Store(restored)
    try {
      const repo = store.getRepo(input.provenance.credential.repoId)
      if (repo === undefined) {
        throw new PrevReleaseError('rows-lost', `the restored copy has no repository ${input.provenance.credential.repoId}`)
      }
      try {
        plain = decryptSecret(repo.token_enc, key)
      } catch (error) {
        throw new PrevReleaseError('key-mismatch', `the fixture credential does not decrypt with the fixture key: ${String(error)}`)
      }
      if (plain !== input.provenance.credential.plaintext) {
        throw new PrevReleaseError('key-mismatch', 'the fixture credential decrypted to a different value than its provenance records')
      }
    } finally {
      store.close()
    }
    versionAfter = schemaVersionOf(restored)
    const shape = shapeOf(restored)
    const columns = columnsOf(restored)
    const lostColumns: string[] = []
    for (const [table, names] of Object.entries(input.provenance.columns)) {
      const now = columns[table]
      if (now === undefined) {
        lostColumns.push(`${table} (table gone)`)
        continue
      }
      const present = new Set(now)
      for (const name of names) if (!present.has(name)) lostColumns.push(`${table}.${name}`)
    }
    if (lostColumns.length > 0) {
      throw new PrevReleaseError(
        'schema-lost',
        `the restored copy lost columns the fixture wrote: ${lostColumns.slice(0, 5).join(', ')} — a schema change without a migration`,
      )
    }
    const lost: string[] = []
    for (const [table, count] of Object.entries(input.provenance.shape)) {
      const now = shape[table]
      if (now === undefined) lost.push(`${table} (table gone)`)
      else if (now < count) lost.push(`${table} ${String(count)} -> ${String(now)}`)
    }
    if (lost.length > 0) {
      throw new PrevReleaseError('rows-lost', `the restored copy lost rows: ${lost.slice(0, 5).join(', ')}`)
    }
    if (versionAfter !== SCHEMA_VERSION) {
      throw new PrevReleaseError('unreadable', `the restored copy reports schema ${String(versionAfter)} after migration, expected ${String(SCHEMA_VERSION)}`)
    }
    return {
      tag: input.provenance.tag,
      fromVersion,
      toVersion: versionAfter,
      tables: Object.keys(shape).length,
      rows: Object.values(shape).reduce((sum, count) => sum + count, 0),
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// The whole check from the committed pair of files, so the suite and the CLI run
// the same path: decompress, prove the bytes are the fixture the provenance
// names, then restore it.
export function restorePreviousRelease(input: { dir?: string; keyBase64?: string } = {}): PrevReleaseResult {
  const dir = input.dir ?? PREV_RELEASE_FIXTURE_DIR
  const provenance = readProvenance(join(dir, PREV_RELEASE_PROVENANCE_FILE))
  const compressed = readFileSync(join(dir, provenance.fixture.file))
  let raw: Buffer
  try {
    raw = gunzipSync(compressed)
  } catch (error) {
    throw new PrevReleaseError('corrupt-fixture', `the fixture is not gzip data: ${String(error)}`)
  }
  if (sha256(raw) !== provenance.fixture.sha256) {
    throw new PrevReleaseError('corrupt-fixture', `the fixture decompresses to ${sha256(raw)}, not the ${provenance.fixture.sha256} its provenance names`)
  }
  const work = mkdtempSync(join(tmpdir(), 'fledge-prev-release-src-'))
  try {
    const dbPath = join(work, 'fledge.db')
    writeFileSync(dbPath, raw)
    return verifyPreviousReleaseFixture({ dbPath, provenance, keyBase64: input.keyBase64 })
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
