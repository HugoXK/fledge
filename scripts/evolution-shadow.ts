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
import {
  loadFixtureSet,
  renderShadowRecord,
  renderShadowReport,
  runShadow,
  shadowSummaryLines,
  type ShadowAttempt,
  type ShadowFixtureSet,
  type ShadowHost,
  type ShadowRecordedAttempt,
  type ShadowVersion,
} from '../src/lib/evaluation.js'
import { createMockShadowHost } from '../src/jobs/shadow.js'

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

// #372: the held-out shadow mode. It runs no repository and holds no token: a
// signed operator host records what the loop did per fixture and version, and
// this mode scores those attempts into a report artifact. Recording and scoring
// stay apart so the numbers can be checked without trusting the machine that
// produced them, and this mode stays offline like the rest of the exporter.
// `--record` is the bundled reference recorder: it runs the mock runner over the
// fixtures and writes both the attempts record and the report in one command.
const shadowFixtures = arg('--shadow', '')
if (shadowFixtures !== '') {
  const attemptsPath = arg('--attempts', '')
  const recordPath = arg('--record', '')
  const reportPath = arg('--out', '')
  if (reportPath === '') {
    console.error('shadow: --shadow needs --out <report.json>')
    process.exit(2)
  }
  if (attemptsPath === '' && recordPath === '') {
    console.error('shadow: --shadow needs --attempts <file> or --record <file>')
    process.exit(2)
  }
  if (attemptsPath !== '' && recordPath !== '') {
    console.error('shadow: --attempts scores a record and --record writes one; pass one of them')
    process.exit(2)
  }
  let fixtureSet: ShadowFixtureSet
  try {
    fixtureSet = loadFixtureSet(readFileSync(resolve(shadowFixtures), 'utf8'))
  } catch (error) {
    console.error(`shadow: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
  if (recordPath !== '') {
    const versionIds = arg('--versions', 'mock')
      .split(',')
      .map((id) => id.trim())
    if (versionIds.some((id) => id === '')) {
      console.error('shadow: MALFORMED_VERSIONS every --versions entry must be a non-empty id')
      process.exit(2)
    }
    const versions: ShadowVersion[] = versionIds.map((id) => ({ id }))
    const host = createMockShadowHost()
    const recordedAttempts: ShadowRecordedAttempt[] = []
    const result = await runShadow(fixtureSet, versions, host, {
      onAttempt: ({ fixture, version, attempt }) => {
        recordedAttempts.push({ fixtureId: fixture.id, version: version.id, ...attempt })
      },
    })
    if (!result.ok) {
      console.error(`shadow: ${result.code} ${result.detail}`)
      process.exit(1)
    }
    writeFileSync(resolve(recordPath), renderShadowRecord({ host: { name: host.name, signature: host.signature }, attempts: recordedAttempts }))
    writeFileSync(resolve(reportPath), renderShadowReport(result.report))
    for (const line of shadowSummaryLines(result.report)) console.log(line)
    console.error(`shadow: attempts ${resolve(recordPath)}; report ${resolve(reportPath)}`)
    process.exit(0)
  }
  let recorded: { host?: { name?: unknown; signature?: unknown }; attempts?: unknown }
  try {
    recorded = JSON.parse(readFileSync(resolve(attemptsPath), 'utf8')) as typeof recorded
  } catch (error) {
    console.error(`shadow: MALFORMED_ATTEMPTS ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
  const hostName = typeof recorded.host?.name === 'string' ? recorded.host.name : ''
  const hostSignature = typeof recorded.host?.signature === 'string' ? recorded.host.signature : ''
  if (!Array.isArray(recorded.attempts)) {
    console.error('shadow: MALFORMED_ATTEMPTS attempts must be an array')
    process.exit(1)
  }
  const byKey = new Map<string, ShadowAttempt>()
  const versions: ShadowVersion[] = []
  for (const entry of recorded.attempts) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const fixtureId = typeof record.fixtureId === 'string' ? record.fixtureId : ''
    const versionId = typeof record.version === 'string' ? record.version : ''
    if (fixtureId === '' || versionId === '') {
      console.error('shadow: MALFORMED_ATTEMPTS every attempt needs fixtureId and version')
      process.exit(1)
    }
    if (!versions.some((version) => version.id === versionId)) versions.push({ id: versionId })
    byKey.set(`${versionId}/${fixtureId}`, {
      pullRequest: typeof record.pullRequest === 'string' ? record.pullRequest : null,
      merged: record.merged === true,
      reviewScore: typeof record.reviewScore === 'number' ? record.reviewScore : null,
      verificationJson: typeof record.verificationJson === 'string' ? record.verificationJson : null,
      costUsd: typeof record.costUsd === 'number' ? record.costUsd : 0,
      durationMs: typeof record.durationMs === 'number' ? record.durationMs : 0,
      ...(typeof record.error === 'string' ? { error: record.error } : {}),
    })
  }
  const missing = fixtureSet.fixtures.flatMap((fixture) =>
    versions.filter((version) => !byKey.has(`${version.id}/${fixture.id}`)).map((version) => `${version.id}/${fixture.id}`),
  )
  if (missing.length > 0) {
    console.error(`shadow: MISSING_ATTEMPTS no recorded attempt for ${missing.join(', ')}; a missing run is not a failure`)
    process.exit(1)
  }
  const recordedHost: ShadowHost = {
    name: hostName,
    signature: hostSignature,
    capabilities: { push: false, merge: false, liveAccess: false, tokens: false },
    run: ({ fixture, version }) => byKey.get(`${version.id}/${fixture.id}`) as ShadowAttempt,
  }
  const result = await runShadow(fixtureSet, versions, recordedHost)
  if (!result.ok) {
    console.error(`shadow: ${result.code} ${result.detail}`)
    process.exit(1)
  }
  writeFileSync(resolve(reportPath), renderShadowReport(result.report))
  for (const line of shadowSummaryLines(result.report)) console.log(line)
  console.error(`shadow: report ${resolve(reportPath)}`)
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
