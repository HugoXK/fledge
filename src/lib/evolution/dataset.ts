// #425: the dataset registry. Everything here is pure — the exporter hands in
// the rows it read and gets back a manifest and the records it must write — so
// the hash, the split and the redaction rule are testable without a database, a
// clock or a network.
//
// Two properties this module owns and the tests pin:
// - one recogniser: every exported string passes through redact(), the same
//   function the rest of the platform uses; there is no second pattern list.
// - one hash: contentHash covers the selection, the split and the canonical rows,
//   never the wall-clock window, so the same rows and parameters hash the same
//   twice and `verifyDataset` can recompute it from the written file.

import { createHash } from 'node:crypto'
import { redact } from '../redact.js'
import type { AttributionGround } from '../attribution.js'

// #1194: the record carries the observed ground beside the claim, so the shape a
// consumer reads changed and the version that travels inside the hash moves. A
// dataset exported as version 1 still verifies against its own manifest.
export const DATASET_SCHEMA_VERSION = 2
export const REDACTION_VERSION = 1

// The job columns the export reads. A database missing one cannot produce an
// honest record, so the exporter refuses instead of exporting a partial row —
// that is what replaces the frozen `user_version > 28` check. Without
// `attribution_ground_json` a pre-#1186 database cannot say what was observed.
export const REQUIRED_JOB_COLUMNS = ['kind', 'evidence_json', 'team_stats_json', 'attribution_ground_json'] as const

export interface EvolutionRow {
  jobId: string
  repo: string
  repoGoal: string
  kind: string
  status: string
  trigger: string
  goal: string
  baseSha: string | null
  branch: string | null
  prUrl: string | null
  issueUrl: string | null
  reviewScore: number | null
  evidence: unknown
  attribution: unknown
  attributionGround: AttributionGround | null
  teamStats: unknown
  checkpoint: string | null
  costUsd: number
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  stageMode: string | null
  repoRole: string
  autoMerge: boolean
}

// What the caller asked for. The applied limit is part of the dataset's identity:
// two files with the same rows but a different truncation are not the same
// selection, and the hash has to say so.
export interface DatasetSelection {
  days: number
  limit: number | null
}

// Provenance, deliberately outside the hash: when the export ran, which window it
// was asked for, and the real coverage of the rows it actually wrote.
export interface DatasetWindow {
  from: string
  to: string
  oldestRowAt: string | null
  newestRowAt: string | null
}

export interface DatasetManifest {
  id: string
  schemaVersion: number
  redactionVersion: number
  selection: DatasetSelection
  window: DatasetWindow
  repositories: string[]
  rowCount: number
  trainRows: number
  holdoutRows: number
  contentHash: string
  split: { train: string[]; holdout: string[] }
  holdoutProtected: string[]
}

export interface Dataset {
  manifest: DatasetManifest
  records: EvolutionRow[]
}

export interface BuildOptions {
  days: number
  limit?: number
  now?: Date
}

export interface HoldoutLeakRefusal {
  ok: false
  code: 'HOLDOUT_LEAK'
  protected: string
}

export interface HoldoutLeakOk {
  ok: true
}

export type HoldoutLeakVerdict = HoldoutLeakOk | HoldoutLeakRefusal

export type ExportRefusalCode = 'MISSING_JOB_COLUMNS' | 'NO_TRAINING_ROWS'

// A named refusal, so a caller can say which rule stopped it rather than match
// on prose. The exporter prints the code and the sentence.
export class ExportRefusal extends Error {
  constructor(readonly code: ExportRefusalCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'ExportRefusal'
  }
}

export type VerifyCode =
  | 'MALFORMED_DATASET'
  | 'SPLIT_MISMATCH'
  | 'MANIFEST_MISMATCH'
  | 'CONTENT_HASH_MISMATCH'
  | 'DATASET_ID_MISMATCH'

export type VerifyVerdict =
  | { ok: true; manifest: DatasetManifest }
  | { ok: false; code: VerifyCode; detail: string }

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map(redactValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactValue(item)]))
  }
  return value
}

function redactRow(row: EvolutionRow): EvolutionRow {
  return {
    ...row,
    repo: redact(row.repo),
    repoGoal: redact(row.repoGoal),
    kind: redact(row.kind),
    status: redact(row.status),
    trigger: redact(row.trigger),
    goal: redact(row.goal),
    baseSha: row.baseSha === null ? null : redact(row.baseSha),
    branch: row.branch === null ? null : redact(row.branch),
    prUrl: row.prUrl === null ? null : redact(row.prUrl),
    issueUrl: row.issueUrl === null ? null : redact(row.issueUrl),
    evidence: redactValue(row.evidence),
    attribution: redactValue(row.attribution),
    // The ground is role names and states; redactValue touches only the strings,
    // and the cast restores the shape the record was built with.
    attributionGround: row.attributionGround === null ? null : redactValue(row.attributionGround) as AttributionGround,
    teamStats: redactValue(row.teamStats),
    checkpoint: row.checkpoint === null ? null : redact(row.checkpoint),
    createdAt: redact(row.createdAt),
    startedAt: row.startedAt === null ? null : redact(row.startedAt),
    finishedAt: row.finishedAt === null ? null : redact(row.finishedAt),
    stageMode: row.stageMode === null ? null : redact(row.stageMode),
    repoRole: redact(row.repoRole),
  }
}

// One canonical order for the records and one for the split. `finishedAt` is the
// newest answer a row has; a row still running falls back to its start and then to
// creation, so ordering never depends on the input array.
function finishedKey(row: EvolutionRow): string {
  return row.finishedAt ?? row.startedAt ?? row.createdAt
}

function compareRows(a: EvolutionRow, b: EvolutionRow): number {
  if (a.repo !== b.repo) return a.repo < b.repo ? -1 : 1
  const aKey = finishedKey(a)
  const bKey = finishedKey(b)
  if (aKey !== bKey) return aKey < bKey ? -1 : 1
  return a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0
}

// The real coverage of the rows in the file, independent of the requested window.
function rowExtent(rows: readonly EvolutionRow[]): { oldest: string | null; newest: string | null } {
  let oldest = Number.POSITIVE_INFINITY
  let newest = Number.NEGATIVE_INFINITY
  for (const row of rows) {
    const value = Date.parse(finishedKey(row))
    if (!Number.isFinite(value)) continue
    if (value < oldest) oldest = value
    if (value > newest) newest = value
  }
  if (oldest === Number.POSITIVE_INFINITY) return { oldest: null, newest: null }
  return { oldest: new Date(oldest).toISOString(), newest: new Date(newest).toISOString() }
}

// The holdout entry a prompt must not contain: the pull request when the row has
// one, otherwise the job id. Both are stable and both name the row.
export function holdoutEntry(row: EvolutionRow): string {
  const number = row.prUrl === null ? null : /\/pull\/(\d+)\b/.exec(row.prUrl)?.[1] ?? null
  return number === null ? `${row.repo}#${row.jobId}` : `${row.repo}#${number}`
}

// A repository that appears in the newest tail puts all of its rows on the
// holdout side, so no repository is ever on both sides. The tail is 20% of rows
// by the canonical newest-first order; ties break on jobId, so the same input
// always yields the same split. Repository-disjointness wins over the exact time
// cut: the tail only chooses which repositories are held out, so the holdout can
// exceed 20% and a holdout row can be older than a train row.
function splitRows(rows: EvolutionRow[]): { train: EvolutionRow[]; holdout: EvolutionRow[] } {
  if (rows.length === 0) return { train: [], holdout: [] }
  const newestFirst = [...rows].sort((a, b) => {
    const aKey = finishedKey(a)
    const bKey = finishedKey(b)
    if (aKey !== bKey) return aKey < bKey ? 1 : -1
    return a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0
  })
  const holdoutCount = Math.max(1, Math.floor(rows.length * 0.2))
  const tailRepos = new Set(newestFirst.slice(0, holdoutCount).map((row) => row.repo))
  const holdout = rows.filter((row) => tailRepos.has(row.repo))
  const train = rows.filter((row) => !tailRepos.has(row.repo))
  return { train, holdout }
}

type HashedManifest = Pick<
  DatasetManifest,
  'schemaVersion' | 'redactionVersion' | 'selection' | 'repositories' | 'rowCount' | 'trainRows' | 'holdoutRows' | 'split' | 'holdoutProtected'
>

// The exact object the hash covers. `window`, `id` and `contentHash` are not in
// it: the first is provenance, the other two are derived from this hash.
function hashedProjection(manifest: HashedManifest): HashedManifest {
  return {
    schemaVersion: manifest.schemaVersion,
    redactionVersion: manifest.redactionVersion,
    selection: { days: manifest.selection.days, limit: manifest.selection.limit },
    repositories: [...manifest.repositories],
    rowCount: manifest.rowCount,
    trainRows: manifest.trainRows,
    holdoutRows: manifest.holdoutRows,
    split: { train: [...manifest.split.train], holdout: [...manifest.split.holdout] },
    holdoutProtected: [...manifest.holdoutProtected],
  }
}

function contentHashOf(projection: HashedManifest, rows: readonly EvolutionRow[]): string {
  return createHash('sha256')
    .update(canonicalJson(hashedProjection(projection)))
    .update(canonicalJson(rows))
    .digest('hex')
}

export function buildDataset(inputRows: readonly EvolutionRow[], options: BuildOptions): Dataset {
  const rows = inputRows.map(redactRow).sort(compareRows)
  const selection: DatasetSelection = { days: Math.max(1, options.days), limit: options.limit ?? null }
  const { train, holdout } = splitRows(rows)
  const extent = rowExtent(rows)
  // Without an explicit `now`, the window ends at the newest row instead of the
  // wall clock, so the provenance line describes the export rather than the
  // moment it was run.
  const now = options.now ?? (extent.newest === null ? new Date(0) : new Date(extent.newest))
  const from = new Date(now.getTime() - selection.days * 86_400_000).toISOString()
  const projection: HashedManifest = {
    schemaVersion: DATASET_SCHEMA_VERSION,
    redactionVersion: REDACTION_VERSION,
    selection,
    repositories: [...new Set(rows.map((row) => row.repo))].sort(),
    rowCount: rows.length,
    trainRows: train.length,
    holdoutRows: holdout.length,
    split: { train: train.map((row) => row.jobId), holdout: holdout.map((row) => row.jobId) },
    holdoutProtected: [...new Set(holdout.map(holdoutEntry))].sort(),
  }
  const contentHash = contentHashOf(projection, rows)
  const manifest: DatasetManifest = {
    id: `ds_${contentHash.slice(0, 16)}`,
    ...projection,
    window: { from, to: now.toISOString(), oldestRowAt: extent.oldest, newestRowAt: extent.newest },
    contentHash,
  }
  return { manifest, records: rows }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

function malformed(detail: string): VerifyVerdict {
  return { ok: false, code: 'MALFORMED_DATASET', detail }
}

function parseRecords(value: unknown): EvolutionRow[] | null {
  if (!Array.isArray(value)) return null
  const records: EvolutionRow[] = []
  for (const item of value) {
    if (!isRecord(item)) return null
    const nullable = (field: string): boolean => item[field] === null || typeof item[field] === 'string'
    if (typeof item.jobId !== 'string' || typeof item.repo !== 'string' || typeof item.createdAt !== 'string') return null
    if (!nullable('startedAt') || !nullable('finishedAt')) return null
    records.push(item as unknown as EvolutionRow)
  }
  return records
}

// Recompute the artifact from its own bytes. The split is recomputed from the
// records, so moving a job id between sides is refused even if the attacker also
// recomputes the hash; the id and hash are then compared to the declared ones.
export function verifyDataset(payload: unknown): VerifyVerdict {
  if (!isRecord(payload) || !isRecord(payload.manifest) || !Array.isArray(payload.records)) {
    return malformed('payload must be { manifest, records }')
  }
  const manifest = payload.manifest
  const selection = manifest.selection
  const window = manifest.window
  const split = manifest.split
  if (
    typeof manifest.id !== 'string' ||
    typeof manifest.schemaVersion !== 'number' ||
    typeof manifest.redactionVersion !== 'number' ||
    typeof manifest.contentHash !== 'string' ||
    typeof manifest.rowCount !== 'number' ||
    typeof manifest.trainRows !== 'number' ||
    typeof manifest.holdoutRows !== 'number' ||
    !isRecord(selection) ||
    typeof selection.days !== 'number' ||
    !(selection.limit === null || typeof selection.limit === 'number') ||
    !isRecord(window) ||
    !['from', 'to'].every((field) => typeof window[field] === 'string') ||
    !['oldestRowAt', 'newestRowAt'].every((field) => window[field] === null || typeof window[field] === 'string') ||
    !isStringArray(manifest.repositories) ||
    !isRecord(split) ||
    !isStringArray(split.train) ||
    !isStringArray(split.holdout) ||
    !isStringArray(manifest.holdoutProtected)
  ) {
    return malformed('manifest fields are missing or have the wrong type')
  }
  const records = parseRecords(payload.records)
  if (records === null) return malformed('every record needs jobId, repo, createdAt and nullable startedAt/finishedAt')

  const rows = [...records].sort(compareRows)
  const expected = splitRows(rows)
  if (
    !sameStringArray(expected.train.map((row) => row.jobId), split.train) ||
    !sameStringArray(expected.holdout.map((row) => row.jobId), split.holdout) ||
    !sameStringArray([...new Set(expected.holdout.map(holdoutEntry))].sort(), manifest.holdoutProtected)
  ) {
    return { ok: false, code: 'SPLIT_MISMATCH', detail: 'the split does not match the repository-disjoint rule for these records' }
  }

  const projection: HashedManifest = {
    schemaVersion: manifest.schemaVersion,
    redactionVersion: manifest.redactionVersion,
    selection: { days: selection.days, limit: selection.limit as number | null },
    repositories: manifest.repositories,
    rowCount: manifest.rowCount,
    trainRows: manifest.trainRows,
    holdoutRows: manifest.holdoutRows,
    split: { train: split.train, holdout: split.holdout },
    holdoutProtected: manifest.holdoutProtected,
  }
  const repositories = [...new Set(rows.map((row) => row.repo))].sort()
  if (
    !sameStringArray(repositories, manifest.repositories) ||
    manifest.rowCount !== rows.length ||
    manifest.trainRows !== expected.train.length ||
    manifest.holdoutRows !== expected.holdout.length
  ) {
    return { ok: false, code: 'MANIFEST_MISMATCH', detail: 'rowCount, trainRows, holdoutRows or repositories disagree with the records' }
  }

  const contentHash = contentHashOf(projection, rows)
  if (contentHash !== manifest.contentHash) {
    return { ok: false, code: 'CONTENT_HASH_MISMATCH', detail: `recomputed ${contentHash}` }
  }
  const id = `ds_${contentHash.slice(0, 16)}`
  if (id !== manifest.id) return { ok: false, code: 'DATASET_ID_MISMATCH', detail: `recomputed ${id}` }

  return {
    ok: true,
    manifest: {
      id,
      ...projection,
      window: {
        from: window.from as string,
        to: window.to as string,
        oldestRowAt: window.oldestRowAt as string | null,
        newestRowAt: window.newestRowAt as string | null,
      },
      contentHash,
    },
  }
}

// A prompt that repeats a holdout entry is a leak. Case and any whitespace run
// are ignored, including the space some writers put before `#`, so `a/r #12` is
// the same entry as `A/R#12`; the refusal names the entry so the operator can
// find the row.
function normalize(value: string): string {
  return value.toLowerCase().replace(/\s*#\s*/g, '#').replace(/\s+/g, ' ').trim()
}

// #427 calls this before a promotion; the function ships here so the call site
// has nothing to invent.
export function checkHoldoutLeak(prompt: string, manifest: DatasetManifest): HoldoutLeakVerdict {
  const text = normalize(prompt)
  for (const entry of manifest.holdoutProtected) {
    if (text.includes(normalize(entry))) return { ok: false, code: 'HOLDOUT_LEAK', protected: entry }
  }
  return { ok: true }
}

// Replaces the frozen `user_version > 28` refusal and refuses a dataset nobody
// can train on. The version is accepted so the call site reads as "these columns
// at this schema"; the rule is the columns, because a newer schema that still has
// them exports a complete record.
export function assertExportable(columns: Iterable<string>, version: number, trainRows?: number): void {
  void version
  const present = new Set(columns)
  const missing = REQUIRED_JOB_COLUMNS.filter((column) => !present.has(column))
  if (missing.length > 0) {
    throw new ExportRefusal('MISSING_JOB_COLUMNS', `database is missing the job columns this export reads: ${missing.join(', ')}; start the current Fledge once before exporting`)
  }
  if (trainRows === 0) {
    throw new ExportRefusal('NO_TRAINING_ROWS', 'the split holds out every exported row, so there is no training side; consent a second repository or export more history')
  }
}
