#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const dbPath = resolve(arg('--db', process.env.DB_PATH ?? 'data/fledge.db'))
const days = Math.max(1, Math.min(365, Number(arg('--days', '90')) || 90))
const limit = Math.max(1, Math.min(5000, Number(arg('--limit', '500')) || 500))
const repoFilter = arg('--repo', '')
const out = arg('--out', '')
const summaryOnly = process.argv.includes('--summary')
const reportOnly = process.argv.includes('--report')

if (!existsSync(dbPath)) {
  console.error(`database not found: ${dbPath}`)
  process.exit(1)
}

const db = new DatabaseSync(dbPath, { readOnly: true })
const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
if (version > 28) {
  console.error(`database schema ${version} is newer than this exporter supports (28)`)
  process.exit(1)
}
const jobColumns = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((column) => column.name))
if (!jobColumns.has('kind') || !jobColumns.has('evidence_json') || !jobColumns.has('team_stats_json')) {
  console.error('database schema is older than the current job evidence columns; start the current Fledge once before exporting')
  process.exit(1)
}

const since = new Date(Date.now() - days * 86_400_000).toISOString()
const rows = db.prepare(`
  SELECT j.id, j.kind, j.status, j.trigger, j.goal, j.branch, j.pr_url, j.issue_url,
         j.review_score, j.evidence_json, j.attribution_json, j.team_stats_json,
         j.checkpoint, j.base_sha, j.cost_usd, j.created_at, j.started_at, j.finished_at,
         r.owner, r.name, r.upstream_owner, r.upstream_name, r.goal AS repo_goal,
         r.stage_mode, r.repo_role, r.auto_merge
    FROM jobs j
    JOIN repos r ON r.id = j.repo_id
   WHERE j.created_at >= ?
   ORDER BY j.created_at DESC
   LIMIT ?
`).all(since, limit)

function parse(value) {
  if (typeof value !== 'string' || value === '') return null
  try { return JSON.parse(value) } catch { return null }
}

const records = rows
  .map((row) => ({
    jobId: row.id,
    repo: `${row.upstream_owner || row.owner}/${row.upstream_name || row.name}`,
    repoGoal: row.repo_goal ?? '',
    kind: row.kind,
    status: row.status,
    trigger: row.trigger,
    goal: row.goal,
    baseSha: row.base_sha,
    branch: row.branch,
    prUrl: row.pr_url,
    issueUrl: row.issue_url,
    reviewScore: row.review_score,
    evidence: parse(row.evidence_json),
    attribution: parse(row.attribution_json),
    teamStats: parse(row.team_stats_json),
    checkpoint: row.checkpoint,
    costUsd: Number(row.cost_usd ?? 0),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    stageMode: row.stage_mode,
    repoRole: row.repo_role,
    autoMerge: row.auto_merge === 1,
  }))
  .filter((row) => repoFilter === '' || row.repo === repoFilter)

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function duration(start, end) {
  if (typeof start !== 'string' || typeof end !== 'string') return null
  const a = Date.parse(start)
  const b = Date.parse(end)
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null
}

if (reportOnly) {
  const succeeded = records.filter((row) => row.status === 'succeeded')
  const failed = records.filter((row) => row.status === 'failed')
  const prs = records.filter((row) => row.prUrl !== null)
  const merged = records.filter((row) => row.status === 'succeeded' && row.prUrl !== null)
  const scores = records.flatMap((row) => (row.kind === 'review' && typeof row.reviewScore === 'number' ? [row.reviewScore] : []))
  const evidenceComplete = records.filter((row) => {
    const evidence = row.evidence ?? {}
    if (row.kind === 'verify') return Boolean(evidence.testRed && evidence.testGreen)
    if (row.kind === 'iterate') return Boolean(evidence.scope && evidence.acceptance && evidence.testRed && evidence.testGreen)
    if (row.kind === 'review') return Boolean(row.reviewScore !== null)
    return Boolean(evidence.scope || evidence.testPlan || evidence.testGreen)
  })
  const durations = records.flatMap((row) => {
    const value = duration(row.startedAt ?? row.createdAt, row.finishedAt)
    return value === null ? [] : [value]
  })
  const sorted = [...records].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  const holdoutCount = Math.max(1, Math.floor(sorted.length * 0.2))
  const train = sorted.slice(0, Math.max(0, sorted.length - holdoutCount))
  const holdout = sorted.slice(Math.max(0, sorted.length - holdoutCount))
  const byKind = {}
  for (const row of records) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1
  const byRepo = {}
  for (const row of records) byRepo[row.repo] = (byRepo[row.repo] ?? 0) + 1
  console.log(JSON.stringify({
    database: dbPath,
    schemaVersion: version,
    windowDays: days,
    records: records.length,
    baseline: {
      succeeded: succeeded.length,
      failed: failed.length,
      successRate: records.length === 0 ? null : Math.round((succeeded.length / records.length) * 1000) / 10,
      prs: prs.length,
      merged: merged.length,
      mergeRate: prs.length === 0 ? null : Math.round((merged.length / prs.length) * 1000) / 10,
      reviewAverage: scores.length === 0 ? null : Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 10) / 10,
      reviewCount: scores.length,
      evidenceCompleteness: records.length === 0 ? null : Math.round((evidenceComplete.length / records.length) * 1000) / 10,
      medianJobMs: median(durations),
    },
    split: { train: train.length, holdout: holdout.length, holdoutFrom: holdout[0]?.createdAt ?? null },
    byKind,
    byRepo,
  }, null, 2))
  db.close()
  process.exit(0)
}

if (summaryOnly) {
  const byStatus = new Map()
  const byKind = new Map()
  for (const row of records) {
    byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1)
    byKind.set(row.kind, (byKind.get(row.kind) ?? 0) + 1)
  }
  console.log(JSON.stringify({
    database: dbPath,
    schemaVersion: version,
    days,
    records: records.length,
    byStatus: Object.fromEntries(byStatus),
    byKind: Object.fromEntries(byKind),
  }, null, 2))
  db.close()
  process.exit(0)
}

const payload = {
  schemaVersion: version,
  exportedAt: new Date().toISOString(),
  days,
  count: records.length,
  records,
}
const text = `${JSON.stringify(payload, null, 2)}\n`
if (out !== '') {
  writeFileSync(resolve(out), text)
  console.error(`wrote ${records.length} records to ${resolve(out)}`)
} else {
  process.stdout.write(text)
}
db.close()
