import { GithubError } from '../repos/github.js'
import type { GithubReleaseInfo, GithubReleaseInput, WorkflowJobInfo, WorkflowRunInfo } from '../repos/github.js'

// #546 slice 3: follow the workflow a tag fires. Nothing here publishes a
// Release, reruns a workflow, or moves a tag. A run is observed in bounded
// reads, and only a completed success whose every job is success/neutral/skipped
// can produce a draft Release for a human to edit and publish.

const OK_JOB_CONCLUSIONS = new Set(['success', 'neutral', 'skipped'])

const FAILED_CONCLUSIONS = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'startup_failure',
  'action_required',
  'stale',
])

export interface ReleaseTrackingClient {
  getReleaseByTag(owner: string, name: string, tag: string): Promise<GithubReleaseInfo | null>
  listWorkflowRunsForRef(owner: string, name: string, ref: string): Promise<WorkflowRunInfo[]>
  listWorkflowJobs(owner: string, name: string, runId: number): Promise<WorkflowJobInfo[]>
  createRelease(owner: string, name: string, input: GithubReleaseInput): Promise<GithubReleaseInfo>
}

export interface ReconcileReleaseInput {
  owner: string
  name: string
  tagName: string
  targetSha: string
  prerelease: boolean
  draftReleaseId: number | null
}

export type ReleaseTrackingResult =
  | { status: 'run_missing'; message: string }
  | { status: 'running'; message: string; run: WorkflowRunInfo }
  | { status: 'run_failed'; message: string; run: WorkflowRunInfo; conclusion: string }
  | { status: 'draft_created'; message: string; run: WorkflowRunInfo; release: GithubReleaseInfo }
  | { status: 'draft_exists'; message: string; run: WorkflowRunInfo | null; release: GithubReleaseInfo | null }
  | { status: 'external_release'; message: string; release: GithubReleaseInfo }

// A run list is newest by id. The release workflow's path is the first choice
// because other workflows also fire on a tag; the tag commit breaks a tie, and
// then the newest attempt wins.
export function selectWorkflowRun(runs: WorkflowRunInfo[], targetSha: string): WorkflowRunInfo | null {
  if (runs.length === 0) return null
  const matching = runs.filter((run) => run.headSha === targetSha)
  const pool = matching.length > 0 ? matching : runs
  const releaseRuns = pool.filter((run) => /(^|\/)release\.ya?ml$/.test(run.path ?? ''))
  const candidates = releaseRuns.length > 0 ? releaseRuns : pool
  return candidates.reduce((best, run) => {
    if (run.id !== best.id) return run.id > best.id ? run : best
    return run.runAttempt > best.runAttempt ? run : best
  })
}

export function draftBody(tagName: string): string {
  return `Draft created by Fledge after the ${tagName} release workflow succeeded. Review the changes and write the release notes here; publishing remains a human action.`
}

function failedRun(run: WorkflowRunInfo, conclusion: string): ReleaseTrackingResult {
  return {
    status: 'run_failed',
    message: `workflow run ${run.id} concluded ${conclusion}; Fledge did not create a draft Release and will not rerun it`,
    run,
    conclusion,
  }
}

// The order matters: an existing Release is found before the run is read, so a
// repository that publishes its own Release is marked external and Fledge never
// duplicates it. A draft already recorded for this row is returned as-is, which
// is what makes a second reconcile idempotent.
export async function reconcileRelease(
  client: ReleaseTrackingClient,
  input: ReconcileReleaseInput,
): Promise<ReleaseTrackingResult> {
  const existing = await client.getReleaseByTag(input.owner, input.name, input.tagName)
  if (existing !== null) {
    if (input.draftReleaseId !== null && existing.id === input.draftReleaseId && existing.draft) {
      return {
        status: 'draft_exists',
        message: `draft Release ${existing.htmlUrl} is already recorded for ${input.tagName}`,
        run: null,
        release: existing,
      }
    }
    return {
      status: 'external_release',
      message: `Release ${existing.htmlUrl} already exists for ${input.tagName}; Fledge did not create another`,
      release: existing,
    }
  }

  const runs = await client.listWorkflowRunsForRef(input.owner, input.name, input.tagName)
  const run = selectWorkflowRun(runs, input.targetSha)
  if (run === null) {
    return { status: 'run_missing', message: `no workflow run for ${input.tagName} yet` }
  }
  if (run.conclusion !== null && FAILED_CONCLUSIONS.has(run.conclusion)) {
    return failedRun(run, run.conclusion)
  }
  if (run.status !== 'completed') {
    return { status: 'running', message: `workflow run ${run.id} is ${run.status}`, run }
  }
  if (run.conclusion !== 'success') {
    return failedRun(run, run.conclusion ?? 'unknown')
  }

  // Every job decides: one in-progress job keeps tracking, and a failed or
  // cancelled job is a failed release even if the run-level conclusion is green.
  const jobs = await client.listWorkflowJobs(input.owner, input.name, run.id)
  if (jobs.length === 0) {
    return { status: 'running', message: `workflow run ${run.id} reports no jobs yet`, run }
  }
  const unfinished = jobs.filter((job) => job.status !== 'completed')
  if (unfinished.length > 0) {
    return { status: 'running', message: `workflow run ${run.id} still has ${unfinished.length} unfinished job(s)`, run }
  }
  const blocked = jobs.filter((job) => !OK_JOB_CONCLUSIONS.has(job.conclusion ?? ''))
  if (blocked.length > 0) {
    return failedRun(run, blocked[0]?.conclusion ?? 'unknown')
  }

  if (input.draftReleaseId !== null) {
    return {
      status: 'draft_exists',
      message: `draft Release ${input.draftReleaseId} is already recorded for ${input.tagName}`,
      run,
      release: null,
    }
  }

  try {
    const release = await client.createRelease(input.owner, input.name, {
      tagName: input.tagName,
      targetCommitish: input.targetSha,
      name: input.tagName,
      body: draftBody(input.tagName),
      prerelease: input.prerelease,
    })
    return {
      status: 'draft_created',
      message: `created draft Release ${release.htmlUrl}`,
      run,
      release,
    }
  } catch (error) {
    // A 422 means a Release for this tag appeared between the read and the
    // write. It is the same external-release answer, never a second create.
    if (error instanceof GithubError && error.status === 422) {
      const raced = await client.getReleaseByTag(input.owner, input.name, input.tagName)
      if (raced !== null) {
        if (raced.draft) {
          return {
            status: 'draft_exists',
            message: `draft Release ${raced.htmlUrl} already exists for ${input.tagName}`,
            run,
            release: raced,
          }
        }
        return {
          status: 'external_release',
          message: `Release ${raced.htmlUrl} already exists for ${input.tagName}; Fledge did not create another`,
          release: raced,
        }
      }
    }
    throw error
  }
}

export interface ReleaseTrackingUpdate {
  status: string
  runId: string | null
  runAttempt: number | null
  conclusion: string | null
  workflowName: string | null
  draftReleaseId: string | null
  draftUrl: string | null
  externalReleaseId: string | null
  lastCheckedAt: string
}

// A reconcile is a full observation, so every field it did not see this time is
// cleared. That is what stops a stale run id or a stale draft URL from outliving
// the facts that produced it.
export function trackingUpdate(
  result: ReleaseTrackingResult,
  current: { draftReleaseId: string | null; draftUrl: string | null } | null = null,
  checkedAt = new Date().toISOString(),
): ReleaseTrackingUpdate {
  const run = 'run' in result ? result.run : null
  const release = 'release' in result ? result.release : null
  const keepsDraft = result.status === 'draft_created' || result.status === 'draft_exists'
  return {
    status: result.status,
    runId: run === null ? null : String(run.id),
    runAttempt: run === null ? null : run.runAttempt,
    conclusion: result.status === 'run_failed' ? result.conclusion : run === null ? null : run.conclusion,
    workflowName: run === null ? null : run.name,
    draftReleaseId: keepsDraft
      ? release === null ? current?.draftReleaseId ?? null : String(release.id)
      : null,
    draftUrl: keepsDraft ? release?.htmlUrl ?? current?.draftUrl ?? null : null,
    externalReleaseId: result.status === 'external_release' ? String(result.release.id) : null,
    lastCheckedAt: checkedAt,
  }
}
