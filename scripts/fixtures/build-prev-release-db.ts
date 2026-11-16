#!/usr/bin/env tsx
// Builds the previous-release restore fixture (#652).
//
// This file is not run from the working tree: `scripts/prev-release-fixture.mjs`
// copies it into a worktree of the release tag and runs it there, so the
// database is written by that tag's own `Store` — the point of the fixture is
// that an *older* build wrote it, not that the current one can write an old
// schema. Every import is therefore relative to `scripts/fixtures/` so the same
// path resolves in both trees.
//
// It writes nothing but the two paths it is given, and the credential it stores
// is a plain test string under the deterministic fixture key described in
// `src/lib/prevRelease.ts` (Buffer.alloc(32, 7)); no real token is involved.
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Store } from '../../src/db.js'
import { encryptSecret } from '../../src/lib/secrets.js'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

const CREDENTIAL_PLAINTEXT = 'fixture-credential-not-a-real-token'
const FIXTURE_KEY = Buffer.alloc(32, 7).toString('base64')

function arg(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index === -1 ? undefined : process.argv[index + 1]
  if (value === undefined || value === '') throw new Error(`missing ${name} <path>`)
  return value
}

const out = arg('--out')
const facts = arg('--facts')

const store = new Store(out)
const user = store.upsertGithubUser({
  id: 'usr_prev_release',
  githubId: 1,
  login: 'prev-release-fixture',
  name: 'Previous Release Fixture',
  email: 'fixture@example.invalid',
  avatarUrl: null,
  isAdmin: false,
  initialQuotaCny: 0,
})
store.setUserStatus(user.id, 'approved', 'fixture')
store.createRepo({
  id: 'repo_prev_release',
  userId: user.id,
  owner: 'fixture',
  name: 'previous-release',
  defaultBranch: 'main',
  tokenEnc: encryptSecret(CREDENTIAL_PLAINTEXT, FIXTURE_KEY),
  goal: 'previous release fixture',
  autoIterate: false,
  intervalMinutes: 1440,
})
store.createJob({
  id: 'job_prev_release',
  repoId: 'repo_prev_release',
  userId: user.id,
  trigger: 'manual',
  goal: 'previous release fixture',
  callbackHash: 'fixture',
  platformTokenHash: '',
  createdAt: '2026-01-01T00:00:00.000Z',
})
store.updateJob('job_prev_release', { status: 'succeeded', finished_at: '2026-01-01T00:01:00.000Z' })
store.close()

// Facts are read back through a plain connection so they describe the file that
// was written, not the objects this process still holds.
const db = new DatabaseSync(out, { readOnly: true })
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((row: { name: unknown }) => String(row.name))
const shape: Record<string, number> = {}
const columns: Record<string, string[]> = {}
for (const table of tables) {
  const quoted = table.replaceAll('"', '""')
  shape[table] = Number((db.prepare(`SELECT COUNT(*) AS n FROM "${quoted}"`).all()[0] as { n?: number } | undefined)?.n ?? 0)
  // The column list is what a rename or a drop shows up in. A count alone cannot
  // see a column that moved, and a rename without a migration is the defect the
  // fixture exists to catch.
  columns[table] = db
    .prepare(`PRAGMA table_info("${quoted}")`)
    .all()
    .map((row: { name: unknown }) => String(row.name))
}
const schemaVersion = Number((db.prepare('PRAGMA user_version').all()[0] as { user_version?: number } | undefined)?.user_version ?? 0)
db.close()

writeFileSync(facts, `${JSON.stringify({ schemaVersion, shape, columns, credential: { repoId: 'repo_prev_release', plaintext: CREDENTIAL_PLAINTEXT } }, null, 2)}\n`)
process.stdout.write(`fixture: schema ${String(schemaVersion)}, ${String(tables.length)} tables, ${String(shape.jobs ?? 0)} job row(s)\n`)
