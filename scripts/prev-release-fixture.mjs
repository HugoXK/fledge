#!/usr/bin/env node
// #652: regenerate the previous-release restore fixture.
//
//   npm run db:prev-release:fixture -- --tag v0.3.6
//
// The point of the fixture is that an *older* build wrote it, so this script
// never uses the current tree to write the database: it creates a git worktree
// at the tag, copies `scripts/fixtures/build-prev-release-db.ts` into it, links
// this clone's `node_modules` (the old tree's dependencies are not installed
// anywhere) and runs that tree's own `Store`. It then compacts the copy to a
// single journal-delete file, gzips it, and writes the provenance the check
// reads.
//
// Run it when a release is cut: the newest tag becomes the fixture's tag and the
// check starts exercising the migration from that schema. It writes only the two
// files under `test/fixtures/prev-release/` and removes its worktree afterwards.
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

const FIXTURE_DIR = 'test/fixtures/prev-release'
const PROVENANCE_FILE = 'provenance.json'
const GENERATOR = 'scripts/fixtures/build-prev-release-db.ts'

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  if (value === undefined || value === '') throw new Error(`missing ${name} <value>`)
  return value
}

function git(args, cwd = process.cwd()) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

const tag = arg('--tag')
if (tag === undefined) {
  process.stderr.write('usage: node scripts/prev-release-fixture.mjs --tag <release-tag> [--out <dir>]\n')
  process.exit(2)
}
const outDir = arg('--out', FIXTURE_DIR)
const commit = git(['rev-parse', '--short', tag])
const worktree = mkdtempSync(join(tmpdir(), 'fledge-prev-release-gen-'))
const scratch = mkdtempSync(join(tmpdir(), 'fledge-prev-release-out-'))
try {
  git(['worktree', 'add', '--detach', worktree, tag])
  mkdirSync(join(worktree, dirname(GENERATOR)), { recursive: true })
  copyFileSync(GENERATOR, join(worktree, GENERATOR))
  // The old tree has no node_modules of its own; this clone's are the same major
  // line, and the generator only uses `Store`, `encryptSecret` and node:sqlite.
  const modules = join(process.cwd(), 'node_modules')
  if (!existsSync(modules)) throw new Error('node_modules is missing; run npm ci first')
  symlinkSync(modules, join(worktree, 'node_modules'), 'dir')
  const dbPath = join(scratch, 'fledge.db')
  const factsPath = join(scratch, 'facts.json')
  const run = spawnSync(process.execPath, ['--import', 'tsx', join(worktree, GENERATOR), '--out', dbPath, '--facts', factsPath], {
    cwd: worktree,
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: process.env.TMPDIR ?? tmpdir() },
  })
  if (run.status !== 0) throw new Error(`generator failed: ${run.stderr.trim() || run.stdout.trim()}`)
  process.stdout.write(run.stdout)

  // A fixture is a file, not a running database: journal-delete plus a VACUUM
  // keeps it one file, and gzip keeps the commit small (700 KB -> ~14 KB).
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = DELETE;')
  db.exec('VACUUM;')
  db.close()
  for (const suffix of ['-shm', '-wal']) rmSync(`${dbPath}${suffix}`, { force: true })
  const raw = readFileSync(dbPath)
  const facts = JSON.parse(readFileSync(factsPath, 'utf8'))
  const gzip = gzipSync(raw, { level: 9 })

  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'fledge.db.gz'), gzip)
  chmodSync(join(outDir, 'fledge.db.gz'), 0o644)
  writeFileSync(
    join(outDir, PROVENANCE_FILE),
    `${JSON.stringify(
      {
        tag,
        commit,
        fixture: { file: 'fledge.db.gz', sha256: createHash('sha256').update(raw).digest('hex'), bytes: raw.length, gzipBytes: gzip.length },
        schemaVersion: facts.schemaVersion,
        shape: facts.shape,
        columns: facts.columns,
        credential: facts.credential,
        generatedBy: `node scripts/prev-release-fixture.mjs --tag ${tag}`,
      },
      null,
      2,
    )}\n`,
  )
  process.stdout.write(
    `previous-release fixture: ${tag} (${commit}), schema ${String(facts.schemaVersion)}, ${String(Object.keys(facts.columns).length)} tables, ${String(raw.length)} bytes -> ${String(gzip.length)} gzipped, written to ${relative(process.cwd(), outDir)}\n`,
  )
} finally {
  rmSync(scratch, { recursive: true, force: true })
  try {
    git(['worktree', 'remove', '--force', worktree])
  } catch {
    rmSync(worktree, { recursive: true, force: true })
  }
}
