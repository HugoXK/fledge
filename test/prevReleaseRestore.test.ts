import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { SCHEMA_VERSION } from '../src/db.js'
import {
  PREV_RELEASE_FIXTURE_DIR,
  PREV_RELEASE_FIXTURE_KEY,
  PREV_RELEASE_PROVENANCE_FILE,
  PrevReleaseError,
  readProvenance,
  restorePreviousRelease,
  verifyPreviousReleaseFixture,
} from '../src/lib/prevRelease.js'

// #652: the existing drill proves a copy this build wrote can be restored;
// these tests prove a database the *previous release* wrote still opens here.
// The fixture is the committed pair under test/fixtures/prev-release, so a schema
// change that renames or drops a column without a migration fails here instead
// of on a real upgrade.

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void }
}

function unpack(): { raw: Buffer; dir: string; provenance: ReturnType<typeof readProvenance> } {
  const provenance = readProvenance(join(PREV_RELEASE_FIXTURE_DIR, PREV_RELEASE_PROVENANCE_FILE))
  const raw = gunzipSync(readFileSync(join(PREV_RELEASE_FIXTURE_DIR, provenance.fixture.file)))
  return { raw, dir: mkdtempSync(join(tmpdir(), 'fledge-prev-release-test-')), provenance }
}

function writeRaw(dir: string, raw: Buffer): string {
  const path = join(dir, 'fledge.db')
  writeFileSync(path, raw)
  return path
}

test('the committed fixture still restores on the current schema', () => {
  const result = restorePreviousRelease()
  assert.equal(result.tag, 'v0.3.6')
  assert.equal(result.fromVersion, 38)
  assert.equal(result.toVersion, SCHEMA_VERSION)
  assert.ok(result.tables > 40, `expected the whole schema, got ${String(result.tables)} tables`)
  assert.ok(result.rows >= 3, `expected the fixture rows to survive, got ${String(result.rows)}`)
})

// A fixture regenerated from this build would restore and prove nothing, so the
// check refuses one that is not older than the schema it is restored into, and
// says so instead of reporting a pass.
test('the fixture must predate the current schema', () => {
  const { raw, dir, provenance } = unpack()
  try {
    const dbPath = writeRaw(dir, raw)
    assert.ok(provenance.schemaVersion < SCHEMA_VERSION)
    assert.throws(
      () => verifyPreviousReleaseFixture({ dbPath, provenance: { ...provenance, schemaVersion: SCHEMA_VERSION } }),
      (error: unknown) => error instanceof PrevReleaseError && error.code === 'corrupt-fixture',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a wrong key fails closed as key-mismatch, never as a pass', () => {
  const { raw, dir, provenance } = unpack()
  try {
    const dbPath = writeRaw(dir, raw)
    assert.throws(
      () => verifyPreviousReleaseFixture({ dbPath, provenance, keyBase64: Buffer.alloc(32, 9).toString('base64') }),
      (error: unknown) => error instanceof PrevReleaseError && error.code === 'key-mismatch',
    )
    // The fixture's own key still works, so the failure above is the key and not
    // the fixture.
    assert.equal(verifyPreviousReleaseFixture({ dbPath, provenance, keyBase64: PREV_RELEASE_FIXTURE_KEY }).toVersion, SCHEMA_VERSION)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The defect class this fixture exists for: a column the current code reads was
// renamed without a migration. The restore has to notice rather than report a
// pass over a table that lost its rows.
test('a renamed column without a migration is caught instead of passing', () => {
  const { raw, dir, provenance } = unpack()
  try {
    const dbPath = writeRaw(dir, raw)
    const db = new DatabaseSync(dbPath)
    db.exec('ALTER TABLE users RENAME COLUMN login TO login_renamed')
    db.close()
    assert.throws(
      () => verifyPreviousReleaseFixture({ dbPath, provenance }),
      (error: unknown) => error instanceof PrevReleaseError && error.code === 'schema-lost',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a fixture whose bytes do not match its provenance is refused before it is opened', () => {
  const { dir, provenance } = unpack()
  const fixtureDir = join(dir, 'fixture')
  try {
    mkdirSync(fixtureDir)
    copyFileSync(join(PREV_RELEASE_FIXTURE_DIR, provenance.fixture.file), join(fixtureDir, provenance.fixture.file))
    writeFileSync(
      join(fixtureDir, PREV_RELEASE_PROVENANCE_FILE),
      `${JSON.stringify({ ...provenance, fixture: { ...provenance.fixture, sha256: '0'.repeat(64) } }, null, 2)}\n`,
    )
    assert.throws(
      () => restorePreviousRelease({ dir: fixtureDir }),
      (error: unknown) => error instanceof PrevReleaseError && error.code === 'corrupt-fixture',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a fixture that is not gzip data is refused rather than half-read', () => {
  const { dir, provenance } = unpack()
  const fixtureDir = join(dir, 'fixture')
  try {
    mkdirSync(fixtureDir)
    writeFileSync(join(fixtureDir, provenance.fixture.file), 'not a database')
    writeFileSync(join(fixtureDir, PREV_RELEASE_PROVENANCE_FILE), `${JSON.stringify(provenance, null, 2)}\n`)
    assert.throws(
      () => restorePreviousRelease({ dir: fixtureDir }),
      (error: unknown) => error instanceof PrevReleaseError && error.code === 'corrupt-fixture',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
