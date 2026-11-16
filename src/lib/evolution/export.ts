// #425: the one row loader the exporter and its tests share. It is a query, not
// a rule — the consent filter lives in the SQL so a repository that did not opt
// in cannot reach `buildDataset` even by accident.
import type { DatabaseSync } from 'node:sqlite'
import type { EvolutionRow } from './dataset.js'

export interface LoadOptions {
  since: string
  limit: number
}

type Row = Record<string, unknown>

function parse(value: unknown): unknown {
  if (typeof value !== 'string' || value === '') return null
  try { return JSON.parse(value) } catch { return null }
}

export function loadEvolutionRows(db: DatabaseSync, options: LoadOptions): EvolutionRow[] {
  const rows = db.prepare(`
    SELECT j.id, j.kind, j.status, j.trigger, j.goal, j.branch, j.pr_url, j.issue_url,
           j.review_score, j.evidence_json, j.attribution_json, j.team_stats_json,
           j.checkpoint, j.base_sha, j.cost_usd, j.created_at, j.started_at, j.finished_at,
           r.owner, r.name, r.upstream_owner, r.upstream_name, r.goal AS repo_goal,
           r.stage_mode, r.repo_role, r.auto_merge
      FROM jobs j
      JOIN repos r ON r.id = j.repo_id
     WHERE j.created_at >= ? AND r.evolution_consent = 1
     ORDER BY j.created_at DESC
     LIMIT ?
  `).all(options.since, options.limit) as Row[]

  return rows.map((row) => ({
    jobId: String(row.id),
    repo: `${String(row.upstream_owner || row.owner)}/${String(row.upstream_name || row.name)}`,
    repoGoal: String(row.repo_goal ?? ''),
    kind: String(row.kind),
    status: String(row.status),
    trigger: String(row.trigger ?? ''),
    goal: String(row.goal ?? ''),
    baseSha: row.base_sha === null ? null : String(row.base_sha),
    branch: row.branch === null ? null : String(row.branch),
    prUrl: row.pr_url === null ? null : String(row.pr_url),
    issueUrl: row.issue_url === null ? null : String(row.issue_url),
    reviewScore: typeof row.review_score === 'number' ? row.review_score : null,
    evidence: parse(row.evidence_json),
    attribution: parse(row.attribution_json),
    teamStats: parse(row.team_stats_json),
    checkpoint: row.checkpoint === null ? null : String(row.checkpoint),
    costUsd: Number(row.cost_usd ?? 0),
    createdAt: String(row.created_at),
    startedAt: row.started_at === null ? null : String(row.started_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
    stageMode: row.stage_mode === null ? null : String(row.stage_mode),
    repoRole: String(row.repo_role ?? ''),
    autoMerge: row.auto_merge === 1,
  }))
}
