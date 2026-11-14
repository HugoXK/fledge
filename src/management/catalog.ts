import type { Store } from '../db.js'
import type { Jobs } from '../jobs/service.js'
import type { Capability } from './actor.js'

// #540: the catalog is a closed map, not a registry a caller can extend. An
// operation declares its capabilities, the target it needs and the arguments it
// accepts; everything else about a write (who, which tenant, which channel) is
// already decided before the catalog is consulted.

export interface CommandTarget {
  projectId?: string
  jobId?: string
}

export interface OperationContext {
  store: Store
  jobs: Jobs
}

export interface OperationResult {
  status: 'succeeded' | 'failed'
  result?: Record<string, unknown>
  errorCode?: string
  errorMessage?: string
  /**
   * Local writes that belong to the business change. The service runs this inside
   * the receipt's transaction, so a crash cannot leave the effect committed with
   * the receipt still saying `accepted`. Anything that must await stays in the
   * operation body, before it returns.
   */
  commit?: () => void
  /**
   * A write that must not run inside the receipt transaction because it opens a
   * transaction of its own (#616: the cancel postmortem). The service runs it
   * only after the transaction committed, so a rolled-back command leaves no
   * trace of it.
   */
  afterCommit?: () => void
}

export interface Operation {
  readonly kind: 'command'
  readonly capabilities: readonly Capability[]
  /** Target fields the operation cannot run without. */
  readonly requiredTarget: readonly (keyof CommandTarget)[]
  /** Target fields that identify the resource whose revision fences the write. */
  readonly revisionTarget: keyof CommandTarget
  readonly revisionType: string
  execute(context: OperationContext, target: CommandTarget, args: Record<string, unknown>): Promise<OperationResult>
}

function stringArgument(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

// The first command of the catalog and the only write that migrates in this
// slice. It stays a call into `Jobs.cancelJob`, so the rules (a finished job is
// not cancellable, the live sessions stop, the platform token is revoked, the
// work item closes) exist once.
const taskCancel: Operation = {
  kind: 'command',
  capabilities: ['job.cancel'],
  requiredTarget: ['projectId', 'jobId'],
  revisionTarget: 'jobId',
  revisionType: 'job',
  async execute(context, target, args) {
    const projectId = target.projectId ?? ''
    const jobId = target.jobId ?? ''
    const repo = context.store.getRepo(projectId)
    if (repo === undefined) return { status: 'failed', errorCode: 'project_not_found', errorMessage: 'the project does not exist' }
    const job = context.store.getJob(jobId)
    if (job === undefined || job.repo_id !== repo.id) return { status: 'failed', errorCode: 'job_not_found', errorMessage: 'the job does not exist in this project' }
    // The awaited part (the bridge stop) is repeatable; the local write it hands
    // back commits inside the receipt transaction, so the effect and its receipt
    // are never split by a crash.
    const prepared = await context.jobs.prepareCancel(job.id, stringArgument(args, 'reason') ?? '用户取消任务')
    if (!prepared.ok) return { status: 'failed', errorCode: 'job_not_cancellable', errorMessage: prepared.error }
    return { status: 'succeeded', result: { jobId: job.id, stopped: prepared.stop.stopped ?? 0 }, commit: prepared.apply, afterCommit: prepared.afterCommit }
  },
}

// #540 slice 2: pausing is the same shape as cancelling — one job, one local
// status write, one repeatable bridge stop — and its only refusal is "already
// finished", so the code stays stable. `task.resume`, `task.retry` and
// `task.create` are not here yet: their refusals come back from `Jobs.enqueue`
// as free-text Chinese with an enqueue code, and turning those into bilingual
// management codes is its own change, not something to bolt onto this one.
const taskPause: Operation = {
  kind: 'command',
  capabilities: ['job.pause'],
  requiredTarget: ['projectId', 'jobId'],
  revisionTarget: 'jobId',
  revisionType: 'job',
  async execute(context, target) {
    const repo = context.store.getRepo(target.projectId ?? '')
    if (repo === undefined) return { status: 'failed', errorCode: 'project_not_found', errorMessage: 'the project does not exist' }
    const job = context.store.getJob(target.jobId ?? '')
    if (job === undefined || job.repo_id !== repo.id) return { status: 'failed', errorCode: 'job_not_found', errorMessage: 'the job does not exist in this project' }
    const prepared = await context.jobs.preparePause(job.id)
    if (!prepared.ok) return { status: 'failed', errorCode: 'job_not_pausable', errorMessage: prepared.error }
    return { status: 'succeeded', result: { jobId: job.id, stopped: prepared.stop.stopped ?? 0 }, commit: prepared.apply }
  },
}

export const OPERATIONS: Readonly<Record<string, Operation>> = Object.freeze({
  'task.cancel': taskCancel,
  'task.pause': taskPause,
})

export function operationFor(name: string): Operation | undefined {
  return Object.prototype.hasOwnProperty.call(OPERATIONS, name) ? OPERATIONS[name] : undefined
}

export function operationNames(): string[] {
  return Object.keys(OPERATIONS)
}
