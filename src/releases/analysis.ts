import { redact } from '../lib/redact.js'
import { stripAnsi } from '../actions/workflowLog.js'

// #546 slice 4: the optional run analysis. A maintainer asks Fledge to read the
// failed jobs of the release run this row recorded. The read is bounded, the
// excerpt is redacted before it is cut, and the credential is a read-only
// installation token that is revoked when the read ends. Nothing here reruns a
// workflow, changes a release state or creates a Release: an analysis is an
// observation, and a failed analysis is a sentence on the page.

// The token can only read the run and the logs it belongs to. `actions: read`
// covers both endpoints this analysis touches — /actions/runs/{id}/jobs and
// /actions/jobs/{id}/logs — and nothing else is asked for: `contents: read`
// would also let the credential read the source of every repository in the
// installation, which is a wider blast radius than a log read can justify. The
// mint is scoped to this repository as well, so the token cannot reach another
// one even if a later permission were to widen.
export const ANALYSIS_TOKEN_PERMISSIONS: Record<string, 'read'> = { actions: 'read' }

export const ANALYSIS_JOB_PAGES = 3
/** Two failed jobs are enough to explain a release; the rest are named, not read. */
export const MAX_ANALYSIS_JOBS = 2
export const MAX_ANALYSIS_LINES = 40
export const MAX_ANALYSIS_CHARS = 4000

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale'])

export class AnalysisTokenUnavailable extends Error {
  readonly code = 'ANALYSIS_READ_ONLY_TOKEN'

  constructor(message: string) {
    super(message)
    this.name = 'AnalysisTokenUnavailable'
  }
}

export interface AnalysisTokenApp {
  configured: boolean
  ephemeralToken(installationId: number, permissions: Record<string, 'read'>, repositories?: string[]): Promise<string>
  revokeToken(token: string): Promise<boolean>
}

export interface MintedAnalysisToken {
  token: string
  /** Revokes the token; false means the revocation call failed and is recorded. */
  revoke: () => Promise<boolean>
}

// The same refusal shape the triage token uses: a user OAuth token cannot be
// narrowed to read-only, so a repository without an App installation gets a
// named refusal instead of a wider credential on a log read. The mint names the
// repository it reads, because an installation token is a repository-set
// credential: without the scope it reaches everything the installation sees.
export async function mintAnalysisToken(
  repo: { installation_id: number | null; name: string },
  app: AnalysisTokenApp,
): Promise<MintedAnalysisToken> {
  if (repo.installation_id === null || !app.configured) {
    throw new AnalysisTokenUnavailable('ANALYSIS_READ_ONLY_TOKEN: run analysis needs a GitHub App installation; a user token cannot be narrowed to read-only, so the analysis is refused.')
  }
  const token = await app.ephemeralToken(repo.installation_id, ANALYSIS_TOKEN_PERMISSIONS, [repo.name])
  return { token, revoke: () => app.revokeToken(token) }
}

export interface AnalysisRunFacts {
  id: number
  attempt: number
  status: string
  conclusion: string | null
}

export interface AnalysisJobFacts {
  id: number
  name: string
  status: string
  conclusion: string | null
  htmlUrl: string
}

export interface AnalysisLogClient {
  listWorkflowJobs(owner: string, name: string, runId: number, maxPages?: number): Promise<AnalysisJobFacts[]>
  getJobLog(owner: string, name: string, jobId: number): Promise<string>
}

export interface ReleaseAnalysisJob {
  jobId: number
  name: string
  conclusion: string | null
  url: string
  /** 1-based, inclusive: the lines of the job's own log this excerpt keeps. */
  lineStart: number
  lineEnd: number
  totalLines: number
  excerpt: string
}

export interface ReleaseAnalysisCounters {
  /** Whether a token was minted for this attempt. */
  tokenSpent: boolean
  /** Whether no token of this attempt is left unrevoked; true when none was minted. */
  tokenRevoked: boolean
}

export type ReleaseAnalysisResult =
  | ({ ok: true; runId: number; attempt: number; jobs: ReleaseAnalysisJob[] } & ReleaseAnalysisCounters)
  | ({ ok: false; code: 'run_not_failed' | 'no_failed_job' | 'log_unreadable'; message: string } & ReleaseAnalysisCounters)

// The tail is where a failure is: logs end with the failing step. Lines are
// counted from the whole redacted text, so the recorded range describes the log
// the job actually produced rather than the slice that survived the budget.
function tailRange(redactedText: string): { lineStart: number; lineEnd: number; totalLines: number; excerpt: string } {
  const lines = redactedText.split('\n')
  while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') lines.pop()
  const totalLines = lines.length
  if (totalLines === 0) return { lineStart: 0, lineEnd: 0, totalLines: 0, excerpt: '' }
  let start = totalLines
  let chars = 0
  while (start > 0) {
    const line = lines[start - 1] ?? ''
    const next = chars + line.length + 1
    if (totalLines - start + 1 > MAX_ANALYSIS_LINES) break
    if (totalLines - start > 0 && next > MAX_ANALYSIS_CHARS) break
    chars = next
    start -= 1
  }
  return {
    lineStart: start + 1,
    lineEnd: totalLines,
    totalLines,
    excerpt: lines.slice(start).join('\n'),
  }
}

function runNotFailed(run: AnalysisRunFacts): ReleaseAnalysisResult | null {
  if (run.status !== 'completed') {
    return { ok: false, code: 'run_not_failed', message: `workflow run ${String(run.id)} is ${run.status}; there is no failed log to analyse yet`, tokenSpent: false, tokenRevoked: true }
  }
  if (run.conclusion === null || !FAILED_CONCLUSIONS.has(run.conclusion)) {
    return { ok: false, code: 'run_not_failed', message: `workflow run ${String(run.id)} concluded ${run.conclusion ?? 'unknown'}; there is no failed log to analyse`, tokenSpent: false, tokenRevoked: true }
  }
  return null
}

export interface AnalyzeReleaseInput {
  owner: string
  name: string
  run: AnalysisRunFacts
  /** Mints the read-only token and returns its revocation. */
  mint: () => Promise<MintedAnalysisToken>
  /** Builds the log client around the token the analysis just minted. */
  client: (token: string) => AnalysisLogClient
}

type AnalysisRead =
  | { ok: true; jobs: ReleaseAnalysisJob[] }
  | { ok: false; code: 'no_failed_job' | 'log_unreadable'; message: string }

async function readAnalysis(input: AnalyzeReleaseInput, token: string): Promise<AnalysisRead> {
  const client = input.client(token)
  let jobs: AnalysisJobFacts[]
  try {
    jobs = await client.listWorkflowJobs(input.owner, input.name, input.run.id, ANALYSIS_JOB_PAGES)
  } catch (error) {
    return { ok: false, code: 'log_unreadable', message: `the workflow jobs could not be read: ${redact(error instanceof Error ? error.message : String(error)).slice(0, 300)}` }
  }
  const failed = jobs
    .filter((job) => job.conclusion !== null && FAILED_CONCLUSIONS.has(job.conclusion))
    .sort((left, right) => left.id - right.id)
    .slice(0, MAX_ANALYSIS_JOBS)
  if (failed.length === 0) {
    return { ok: false, code: 'no_failed_job', message: `workflow run ${String(input.run.id)} records no failed job to analyse` }
  }
  const analysed: ReleaseAnalysisJob[] = []
  for (const job of failed) {
    let raw: string
    try {
      raw = await client.getJobLog(input.owner, input.name, job.id)
    } catch (error) {
      return { ok: false, code: 'log_unreadable', message: `the log of job ${job.name} could not be read: ${redact(error instanceof Error ? error.message : String(error)).slice(0, 300)}` }
    }
    // Redaction runs over the whole log, before any slice: a secret split by
    // the cut would be a fragment no pattern can recognise afterwards.
    const range = tailRange(redact(stripAnsi(raw)))
    if (range.excerpt === '') {
      return { ok: false, code: 'log_unreadable', message: `the log of job ${job.name} is empty` }
    }
    analysed.push({
      jobId: job.id,
      name: job.name,
      conclusion: job.conclusion,
      url: job.htmlUrl,
      lineStart: range.lineStart,
      lineEnd: range.lineEnd,
      totalLines: range.totalLines,
      excerpt: range.excerpt,
    })
  }
  return { ok: true, jobs: analysed }
}

// The refusal path and the success path both end with the same revocation, and
// a revocation that fails is reported rather than swallowed: the token is short
// lived, but an operator has to be able to see that one outlived its read.
export async function analyzeReleaseRun(input: AnalyzeReleaseInput): Promise<ReleaseAnalysisResult> {
  const refusal = runNotFailed(input.run)
  if (refusal !== null) return refusal
  const minted = await input.mint()
  let read: AnalysisRead
  let tokenRevoked = false
  try {
    read = await readAnalysis(input, minted.token)
  } catch (error) {
    read = { ok: false, code: 'log_unreadable', message: `the workflow log could not be analysed: ${redact(error instanceof Error ? error.message : String(error)).slice(0, 300)}` }
  } finally {
    try {
      tokenRevoked = await minted.revoke()
    } catch {
      tokenRevoked = false
    }
  }
  if (!read.ok) return { ...read, tokenSpent: true, tokenRevoked }
  return { ok: true, runId: input.run.id, attempt: input.run.attempt, jobs: read.jobs, tokenSpent: true, tokenRevoked }
}

export interface StoredReleaseAnalysis {
  runId: number
  attempt: number
  tokenRevoked: boolean
  at: string | null
  jobs: ReleaseAnalysisJob[]
}

// What the page reads back. A stored value that is missing, unparsable or
// structurally wrong renders as no analysis rather than as a page error: the run
// itself is the record, and this column is only its explanation.
export function readReleaseAnalysis(json: string | null): StoredReleaseAnalysis | null {
  if (json === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (!Array.isArray(record.jobs)) return null
  const jobs: ReleaseAnalysisJob[] = []
  for (const entry of record.jobs) {
    if (typeof entry !== 'object' || entry === null) continue
    const job = entry as Record<string, unknown>
    const jobId = job.jobId
    const lineStart = job.lineStart
    const lineEnd = job.lineEnd
    const totalLines = job.totalLines
    if (typeof jobId !== 'number' || typeof lineStart !== 'number' || typeof lineEnd !== 'number' || typeof totalLines !== 'number') continue
    if (typeof job.name !== 'string' || typeof job.url !== 'string' || typeof job.excerpt !== 'string') continue
    jobs.push({
      jobId,
      name: job.name,
      conclusion: typeof job.conclusion === 'string' ? job.conclusion : null,
      url: job.url,
      lineStart,
      lineEnd,
      totalLines,
      excerpt: job.excerpt,
    })
  }
  if (jobs.length === 0) return null
  return {
    runId: typeof record.runId === 'number' ? record.runId : 0,
    attempt: typeof record.attempt === 'number' ? record.attempt : 1,
    tokenRevoked: record.tokenRevoked === true,
    at: typeof record.at === 'string' ? record.at : null,
    jobs,
  }
}

// The stored shape is the analysis the route just produced plus when it ran, so
// the page can say how old the observation is without a second column.
export function releaseAnalysisJson(result: Extract<ReleaseAnalysisResult, { ok: true }>, at: string): string {
  return JSON.stringify({ runId: result.runId, attempt: result.attempt, tokenRevoked: result.tokenRevoked, at, jobs: result.jobs })
}
