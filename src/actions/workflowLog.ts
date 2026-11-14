import { redact } from '../lib/redact.js'

// The raw job log is untrusted and can be large. This slice keeps only a bounded
// excerpt, and it redacts before the cut so a secret cannot survive as a
// fragment of a truncation. The raw log is never stored, rendered or sent on.
export const MAX_LOG_EXCERPT_CHARS = 4000

// Built from the code point so the linter does not see a control character in a
// regex literal; the pattern itself is the ordinary ANSI SGR escape.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g')

export function stripAnsi(value: string): string {
  return String(value ?? '').replace(ANSI, '')
}

export function boundedLogExcerpt(log: string, maxChars = MAX_LOG_EXCERPT_CHARS): string {
  const clean = redact(stripAnsi(log)).trim()
  if (clean.length <= maxChars) return clean
  const marker = '\n[...]\n'
  const budget = Math.max(0, maxChars - marker.length)
  if (budget === 0) return clean.slice(0, maxChars)
  const head = Math.ceil(budget / 2)
  const tail = budget - head
  return `${clean.slice(0, head)}${marker}${tail === 0 ? '' : clean.slice(-tail)}`
}

export function selectFailedJob<T extends { conclusion: string | null }>(jobs: readonly T[]): T | null {
  for (const job of jobs) {
    if (job.conclusion === 'failure' || job.conclusion === 'timed_out') return job
  }
  return null
}

export interface FailureLogClient {
  listWorkflowJobs(owner: string, name: string, runId: number): Promise<Array<{ id: number; conclusion: string | null }>>
  getJobLog(owner: string, name: string, jobId: number): Promise<string>
}

export interface FailureLogResult {
  excerpt: string | null
  error: string | null
}

export function logFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return redact(message).slice(0, 300) || 'log_fetch_failed'
}

// Fetching a log is best-effort: the intake row is already written, so every
// failure becomes a stored reason instead of an exception that would lose it.
export async function fetchFailureLog(
  client: FailureLogClient,
  owner: string,
  name: string,
  runId: number,
): Promise<FailureLogResult> {
  try {
    const failed = selectFailedJob(await client.listWorkflowJobs(owner, name, runId))
    if (failed === null) return { excerpt: null, error: 'no_failed_job' }
    const excerpt = boundedLogExcerpt(await client.getJobLog(owner, name, failed.id))
    if (excerpt === '') return { excerpt: null, error: 'empty_log' }
    return { excerpt, error: null }
  } catch (error) {
    return { excerpt: null, error: logFailureReason(error) }
  }
}
