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
    const outcome = await context.jobs.cancelJob(job.id, stringArgument(args, 'reason') ?? '用户取消任务')
    if (!outcome.ok) return { status: 'failed', errorCode: 'job_not_cancellable', errorMessage: outcome.error ?? 'cancel refused' }
    return { status: 'succeeded', result: { jobId: job.id, stopped: outcome.stopped ?? 0 } }
  },
}

export const OPERATIONS: Readonly<Record<string, Operation>> = Object.freeze({
  'task.cancel': taskCancel,
})

export function operationFor(name: string): Operation | undefined {
  return Object.prototype.hasOwnProperty.call(OPERATIONS, name) ? OPERATIONS[name] : undefined
}

export function operationNames(): string[] {
  return Object.keys(OPERATIONS)
}
