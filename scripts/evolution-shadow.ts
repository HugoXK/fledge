#!/usr/bin/env node
// #425: the read-only evolution export. Same CLI as the `.mjs` it replaces
// (`--db`, `--days`, `--limit`, `--repo`, `--out`, `--report`, `--summary`,
// `--verify`) but the payload carries a manifest with its canonical hash, every
// string has passed `redact()`, and only repositories that consented are read.
// The open stays read-only and this script never writes to the database.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { assertExportable, buildDataset, verifyDataset } from '../src/lib/evolution/dataset.js'
import { loadEvolutionRows } from '../src/lib/evolution/export.js'

function arg(name: string, fallback = ''): string {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const dbPath = resolve(arg('--db', process.env.DB_PATH ?? 'data/fledge.db'))
const days = Math.max(1, Math.min(365, Number(arg('--days', '90')) || 90))
const limit = Math.max(1, Math.min(5000, Number(arg('--limit', '500')) || 500))
const repoFilter = arg('--repo', '')
const out = arg('--out', '')
const verifyPath = arg('--verify', '')
const summaryOnly = process.argv.includes('--summary')
const reportOnly = process.argv.includes('--report')

// `--verify` reads a written dataset and recomputes it. It needs no database, so
// it runs before the database is opened; a mismatch is a named refusal and exit 1.
if (verifyPath !== '') {
  let payload: unknown
  try {
    payload = JSON.parse(readFileSync(resolve(verifyPath), 'utf8'))
  } catch (error) {
    console.error(`verify: MALFORMED_DATASET ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
  const verdict = verifyDataset(payload)
  if (!verdict.ok) {
    console.error(`verify: ${verdict.code} ${verdict.detail}`)
    process.exit(1)
  }
  console.log(`verify: ok ${verdict.manifest.id} ${verdict.manifest.contentHash}`)
  process.exit(0)
}

if (!existsSync(dbPath)) {
  console.error(`database not found: ${dbPath}`)
  process.exit(1)
}

const db = new DatabaseSync(dbPath, { readOnly: true })
const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
const jobColumns = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((column) => String(column.name)))
const repoColumns = new Set(db.prepare('PRAGMA table_info(repos)').all().map((column) => String(column.name)))
try {
  assertExportable(jobColumns, version)
  if (!repoColumns.has('evolution_consent')) throw new Error('database has no repos.evolution_consent column; start the current Fledge once before exporting')
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

const since = new Date(Date.now() - days * 86_400_000).toISOString()
const records = loadEvolutionRows(db, { since, limit }).filter((row) => repoFilter === '' || row.repo === repoFilter)

const dataset = buildDataset(records, { days, limit })
try {
  // The split refuses to export a dataset with no training side: a named refusal
  // is better than a file nobody can train on.
  assertExportable(jobColumns, version, dataset.manifest.trainRows)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  db.close()
  process.exit(1)
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

function duration(start: string | null, end: string | null): number | null {
  if (typeof start !== 'string' || typeof end !== 'string') return null
  const a = Date.parse(start)
  const b = Date.parse(end)
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null
}

if (reportOnly) {
  const exported = dataset.records
  const succeeded = exported.filter((row) => row.status === 'succeeded')
  const failed = exported.filter((row) => row.status === 'failed')
  const prs = exported.filter((row) => row.prUrl !== null)
  const merged = exported.filter((row) => row.status === 'succeeded' && row.prUrl !== null)
  const scores = exported.flatMap((row) => (row.kind === 'review' && typeof row.reviewScore === 'number' ? [row.reviewScore] : []))
  const evidenceComplete = exported.filter((row) => {
    const evidence = (row.evidence ?? {}) as Record<string, unknown>
    if (row.kind === 'verify') return Boolean(evidence.testRed && evidence.testGreen)
    if (row.kind === 'iterate') return Boolean(evidence.scope && evidence.acceptance && evidence.testRed && evidence.testGreen)
    if (row.kind === 'review') return Boolean(row.reviewScore !== null)
    return Boolean(evidence.scope || evidence.testPlan || evidence.testGreen)
  })
  const durations = exported.flatMap((row) => {
    const value = duration(row.startedAt ?? row.createdAt, row.finishedAt)
    return value === null ? [] : [value]
  })
  const byKind: Record<string, number> = {}
  for (const row of exported) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1
  const byRepo: Record<string, number> = {}
  for (const row of exported) byRepo[row.repo] = (byRepo[row.repo] ?? 0) + 1
  console.log(JSON.stringify({
    database: dbPath,
    schemaVersion: version,
    windowDays: days,
    dataset: { id: dataset.manifest.id, contentHash: dataset.manifest.contentHash },
    records: exported.length,
    baseline: {
      succeeded: succeeded.length,
      failed: failed.length,
      successRate: exported.length === 0 ? null : Math.round((succeeded.length / exported.length) * 1000) / 10,
      prs: prs.length,
      merged: merged.length,
      mergeRate: prs.length === 0 ? null : Math.round((merged.length / prs.length) * 1000) / 10,
      reviewAverage: scores.length === 0 ? null : Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 10) / 10,
      reviewCount: scores.length,
      evidenceCompleteness: exported.length === 0 ? null : Math.round((evidenceComplete.length / exported.length) * 1000) / 10,
      medianJobMs: median(durations),
    },
    // The manifest's own split, not a second computation: `--report` and the
    // exported file cannot disagree about which rows are held out.
    split: {
      train: dataset.manifest.split.train.length,
      holdout: dataset.manifest.split.holdout.length,
      holdoutProtected: dataset.manifest.holdoutProtected.length,
    },
    byKind,
    byRepo,
  }, null, 2))
  db.close()
  process.exit(0)
}

if (summaryOnly) {
  const byStatus: Record<string, number> = {}
  const byKind: Record<string, number> = {}
  for (const row of dataset.records) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1
    byKind[row.kind] = (byKind[row.kind] ?? 0) + 1
  }
  console.log(JSON.stringify({
    database: dbPath,
    schemaVersion: version,
    days,
    records: dataset.records.length,
    byStatus,
    byKind,
    dataset: {
      id: dataset.manifest.id,
      contentHash: dataset.manifest.contentHash,
      split: { train: dataset.manifest.split.train.length, holdout: dataset.manifest.split.holdout.length },
    },
  }, null, 2))
  db.close()
  process.exit(0)
}

const text = `${JSON.stringify({ manifest: dataset.manifest, records: dataset.records }, null, 2)}\n`
if (out !== '') {
  writeFileSync(resolve(out), text)
  console.error(`wrote ${dataset.records.length} records to ${resolve(out)}`)
} else {
  process.stdout.write(text)
}
db.close()
