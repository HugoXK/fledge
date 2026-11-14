import type { Store } from '../db.js'
import type { Jobs } from '../jobs/service.js'
import { JOB_KINDS, type JobKind } from '../jobs/runner.js'
import type { Capability } from './actor.js'
import { refusalSentenceUsesDetail } from '../lib/failure.js'

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
  /** The principal on the accepted receipt, read from the row — never the payload. */
  principalId: string
}

export interface OperationResult {
  status: 'succeeded' | 'failed'
  result?: Record<string, unknown>
  /** A management code, or the admission code the operation's service returned. */
  errorCode?: string
  errorMessage?: string
  /**
   * The parameter the refusal names (`main`, `2`, a pull request URL). Recorded
   * only when a banner sentence interpolates it: without a sentence the banner
   * keeps `errorMessage`, and a bare parameter would displace that sentence.
   */
  errorDetail?: string
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

// #611: what an operator needs to read after a refusal. A parameterised sentence
// already owns `detail`; a fixed sentence does not print anything, so the text the
// service wrote (the exception's class and address) is the copy instead.
function operatorCopy(detail: string | undefined, code: string, message: string | undefined): string | undefined {
  if (detail !== undefined && detail !== '') return detail
  if (refusalSentenceUsesDetail(code)) return undefined
  return message === undefined || message.trim() === '' ? undefined : message
}

// A caller-supplied integer is either absent, valid, or refused. Clamping a
// posted 500 to 100 would queue a job the caller did not ask for and answer
// success, so an out-of-range or non-integer value fails the command instead.
function integerArgument(args: Record<string, unknown>, name: string, min: number, max: number): number | undefined | null {
  const value = args[name]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) return null
  return value
}

// The refusal shape `Jobs.enqueue` answers with: a code the banner table already
// knows, an optional parameter, and the sentence the service wrote. Passing all
// three through keeps the console's refusal exactly as good as it was before the
// route moved behind the contract.
function refused(code: string | undefined, message: string | undefined, detail: string | undefined, fallback: string): OperationResult {
  const refusalCode = code ?? fallback
  return {
    status: 'failed',
    errorCode: refusalCode,
    errorMessage: message ?? 'the job did not start',
    // #611: the operator copy is the value the service named, or — for a code
    // whose sentence is fixed — the text the service wrote in `error`, which is
    // where an upstream exception's class and address arrive. The banner shows
    // only the sentence (`refusalSentenceUsesDetail` guards the interpolation);
    // this value stays in the receipt and the audit row, the two places support
    // reads.
    ...(operatorCopy(detail, refusalCode, message) === undefined ? {} : { errorDetail: operatorCopy(detail, refusalCode, message) }),
  }
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

// #540 slice 2 (rest): creating a job is a command like any other. The revision
// fence is the project's, bumped on every create, so a page rendered before
// someone else's create is refused instead of queueing beside it; the active-job
// admission gate inside `Jobs.enqueue` remains the authority on a duplicate run.
// The awaited part of `enqueue` — the duplicate/credential/preflight reads — runs
// here, before the receipt is finalized. The job row is the only durable effect,
// and a crash between it and the receipt leaves the receipt `accepted` (the same
// key replays `command_in_progress`; a fresh key is refused as an active job), so
// this command needs no `unknown` path.
const taskCreate: Operation = {
  kind: 'command',
  capabilities: ['job.create'],
  requiredTarget: ['projectId'],
  revisionTarget: 'projectId',
  revisionType: 'project',
  async execute(context, target, args) {
    const repo = context.store.getRepo(target.projectId ?? '')
    if (repo === undefined) return { status: 'failed', errorCode: 'project_not_found', errorMessage: 'the project does not exist' }
    const kind = stringArgument(args, 'kind')
    if (kind === undefined || !(JOB_KINDS as readonly string[]).includes(kind)) {
      return { status: 'failed', errorCode: 'invalid_arguments', errorMessage: 'a create command needs a job kind' }
    }
    const workItemId = stringArgument(args, 'workItemId')
    if (workItemId !== undefined) {
      // The adapter already checked this; the command checks it again at
      // execution time, because the work item can close between acceptance and
      // the write and a create must not resume work nobody owns.
      const item = context.store.getWorkItem(workItemId)
      if (item === undefined || item.repo_id !== repo.id) {
        return { status: 'failed', errorCode: 'work_item_not_found', errorMessage: 'the work item does not exist in this project' }
      }
    }
    const goal = stringArgument(args, 'goal')
    const prUrl = stringArgument(args, 'prUrl')
    const priority = integerArgument(args, 'priority', 0, 100)
    if (priority === null) return { status: 'failed', errorCode: 'invalid_arguments', errorMessage: 'the priority must be an integer between 0 and 100' }
    const result = await context.jobs.enqueue(repo, 'manual', goal, kind as JobKind, {
      ...(workItemId === undefined ? {} : { workItemId }),
      ...(prUrl === undefined ? {} : { prUrl }),
      ...(priority === undefined ? {} : { priority }),
    })
    if (!result.ok || result.job === undefined) return refused(result.code, result.error, result.detail, 'task_not_queued')
    return { status: 'succeeded', result: { jobId: result.job.id } }
  },
}

// Resuming and retrying both hand their rules to the service method that already
// owns them, and both are fenced on the source job's revision: a page rendered
// before the job moved on is refused instead of queueing a second continuation.
// Their external step is the same read-only admission preflight as a create.
const taskResume: Operation = {
  kind: 'command',
  capabilities: ['job.resume'],
  requiredTarget: ['projectId', 'jobId'],
  revisionTarget: 'jobId',
  revisionType: 'job',
  async execute(context, target) {
    const repo = context.store.getRepo(target.projectId ?? '')
    if (repo === undefined) return { status: 'failed', errorCode: 'project_not_found', errorMessage: 'the project does not exist' }
    const job = context.store.getJob(target.jobId ?? '')
    if (job === undefined || job.repo_id !== repo.id) return { status: 'failed', errorCode: 'job_not_found', errorMessage: 'the job does not exist in this project' }
    const result = await context.jobs.resumeJob(job.id)
    if (!result.ok || result.job === undefined) {
      return { status: 'failed', errorCode: 'job_not_resumable', errorMessage: result.error ?? 'the job could not be resumed' }
    }
    return { status: 'succeeded', result: { jobId: result.job.id } }
  },
}

const taskRetry: Operation = {
  kind: 'command',
  capabilities: ['job.retry'],
  requiredTarget: ['projectId', 'jobId'],
  revisionTarget: 'jobId',
  revisionType: 'job',
  async execute(context, target) {
    const repo = context.store.getRepo(target.projectId ?? '')
    if (repo === undefined) return { status: 'failed', errorCode: 'project_not_found', errorMessage: 'the project does not exist' }
    const job = context.store.getJob(target.jobId ?? '')
    if (job === undefined || job.repo_id !== repo.id) return { status: 'failed', errorCode: 'job_not_found', errorMessage: 'the job does not exist in this project' }
    // The principal comes from the receipt, so the `job.retried` audit row names
    // the same actor the server resolved, never a form field.
    const result = await context.jobs.retryJob(job.id, context.principalId)
    if (!result.ok || result.job === undefined) return refused(result.code, result.error, result.detail, 'job_not_retryable')
    return { status: 'succeeded', result: { jobId: result.job.id } }
  },
}

export const OPERATIONS: Readonly<Record<string, Operation>> = Object.freeze({
  'task.cancel': taskCancel,
  'task.pause': taskPause,
  'task.create': taskCreate,
  'task.resume': taskResume,
  'task.retry': taskRetry,
})

export function operationFor(name: string): Operation | undefined {
  return Object.prototype.hasOwnProperty.call(OPERATIONS, name) ? OPERATIONS[name] : undefined
}

export function operationNames(): string[] {
  return Object.keys(OPERATIONS)
}
