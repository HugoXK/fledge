import type { ManagementCommandRow, Store } from '../db.js'
import type { Jobs } from '../jobs/service.js'
import { randomId, sha256Hex } from '../lib/secrets.js'
import { capabilitiesForRepo, FORBIDDEN_ARGUMENT_KEYS, type ActorContext } from './actor.js'
import { operationFor, type CommandTarget } from './catalog.js'

// #540: one contract for every console write. A command is an operation from the
// closed catalog, a target, validated arguments, the revision the caller saw, and
// an idempotency key. The service stores a receipt before the business write,
// re-checks authorization at execution time, fences the write with the revision,
// and returns the same receipt when the same key arrives again.

export interface CommandEnvelope {
  operation: string
  target: CommandTarget
  arguments: Record<string, unknown>
  expectedRevision: number
  idempotencyKey: string
  sourceConversation?: string
  sourceMessage?: string
}

export type ManagementCode =
  | 'unknown_operation'
  | 'invalid_envelope'
  | 'invalid_target'
  | 'actor_not_allowed'
  | 'idempotency_conflict'
  | 'management_revision_conflict'
  | 'command_in_progress'
  | 'authorization_revoked'
  | 'not_accepted'
  | 'corrupt_receipt'
  | 'project_not_found'
  | 'job_not_found'
  | 'job_not_cancellable'
  | 'job_not_pausable'
  | 'job_not_resumable'
  | 'job_not_retryable'
  | 'task_not_queued'
  | 'invalid_arguments'
  | 'work_item_not_found'

// A failed command's `code` is not always a management code: an operation hands
// back the admission refusal its service returned (`REPO_DISABLED`, `JOB_ACTIVE`,
// `BRANCH_MISSING`), which the console banner already knows how to translate. The
// receipt keeps that code verbatim so a replay answers with the same refusal.
export type CommandOutcome =
  | { ok: true; receipt: ManagementCommandRow; replayed: boolean; result: Record<string, unknown> }
  | { ok: false; code: string; message: string; detail?: string; receipt?: ManagementCommandRow }

// A request hash must not depend on key order, or two payloads that say the same
// thing would read as a conflict. Undefined values are dropped for the same
// reason: an absent optional field is not a different argument.
function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value) as string
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
}

// A receipt stores its result as canonical JSON. A replay answers from that row,
// so the caller reads the same shape it would have read from the first attempt.
function resultOf(value: string | null): Record<string, unknown> {
  if (value === null || value === '') return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function isForbiddenArguments(args: Record<string, unknown>): string | null {
  for (const key of Object.keys(args)) if (FORBIDDEN_ARGUMENT_KEYS.has(key)) return key
  return null
}

export class ManagementService {
  constructor(
    private readonly store: Store,
    private readonly jobs: Jobs,
  ) {}

  revisionOf(type: string, id: string): number {
    return this.store.revisionOf(type, id)
  }

  receipt(id: string): ManagementCommandRow | undefined {
    return this.store.commandReceipt(id)
  }

  // Reserve the command. A caller that wants to prove authorization is re-checked
  // can stop here and call `complete` later; the form adapter uses `run`.
  begin(actor: ActorContext, envelope: CommandEnvelope): CommandOutcome {
    if (envelope.operation.trim() === '' || envelope.idempotencyKey.trim() === '') {
      return { ok: false, code: 'invalid_envelope', message: 'an operation and an idempotency key are required' }
    }
    if (!Number.isInteger(envelope.expectedRevision) || envelope.expectedRevision < 1) {
      return { ok: false, code: 'invalid_envelope', message: 'expected_revision must be a positive integer' }
    }
    const operation = operationFor(envelope.operation)
    if (operation === undefined) return { ok: false, code: 'unknown_operation', message: `unknown operation: ${envelope.operation}` }
    const forbidden = isForbiddenArguments(envelope.arguments)
    // A payload that carries an identity is refused, not ignored: silently
    // dropping it would let a future caller believe it was honoured.
    if (forbidden !== null) return { ok: false, code: 'actor_not_allowed', message: `the argument ${forbidden} is set by the server, never by a caller` }
    for (const field of operation.requiredTarget) {
      if (envelope.target[field] === undefined || envelope.target[field] === '') {
        return { ok: false, code: 'invalid_target', message: `the target needs ${field}` }
      }
    }

    const scope = this.scope(actor, envelope.target)
    const requestHash = this.requestHash(envelope)
    const existing = this.store.commandReceiptByKey(scope, envelope.idempotencyKey)
    if (existing !== undefined) {
      if (existing.request_hash === requestHash) return this.replay(existing)
      return { ok: false, code: 'idempotency_conflict', message: 'this idempotency key was already used for a different request', receipt: existing }
    }

    const resourceId = String(envelope.target[operation.revisionTarget] ?? '')
    const current = this.store.revisionOf(operation.revisionType, resourceId)
    // Checked before the receipt exists, so a stale page leaves no trace and no
    // business write behind.
    if (current !== envelope.expectedRevision) {
      return { ok: false, code: 'management_revision_conflict', message: `the resource is at revision ${current}, the request expects ${envelope.expectedRevision}` }
    }

    const id = randomId('cmd')
    try {
      this.store.insertCommandReceipt({
        id,
        principalId: actor.principalId,
        channel: actor.channel,
        idempotencyScope: scope,
        idempotencyKey: envelope.idempotencyKey,
        requestHash,
        operation: envelope.operation,
        targetJson: canonical(envelope.target),
        argumentsJson: canonical(envelope.arguments),
        expectedRevision: envelope.expectedRevision,
        beforeRevision: current,
        sourceConversation: envelope.sourceConversation ?? null,
        sourceMessage: envelope.sourceMessage ?? null,
      })
    } catch (error) {
      // Two callers with the same key: the unique index decides. The loser reads
      // the winner's receipt rather than inventing a second command.
      const winner = this.store.commandReceiptByKey(scope, envelope.idempotencyKey)
      if (winner !== undefined && winner.request_hash === requestHash) return this.replay(winner)
      if (winner !== undefined) return { ok: false, code: 'idempotency_conflict', message: 'this idempotency key was already used for a different request', receipt: winner }
      return { ok: false, code: 'invalid_envelope', message: `the receipt could not be written: ${String(error)}` }
    }
    const receipt = this.store.commandReceipt(id)
    if (receipt === undefined) return { ok: false, code: 'corrupt_receipt', message: 'the receipt disappeared after it was written' }
    return { ok: true, receipt, replayed: false, result: resultOf(receipt.result_json) }
  }

  async run(actor: ActorContext, envelope: CommandEnvelope): Promise<CommandOutcome> {
    const begun = this.begin(actor, envelope)
    if (!begun.ok) return begun
    if (begun.replayed) return begun
    return this.complete(begun.receipt.id)
  }

  // Execute an accepted receipt. Everything that could have changed since the
  // request arrived is re-read here — the caller's capabilities, the revision —
  // and a lost capability fails the receipt before the business write.
  async complete(receiptId: string): Promise<CommandOutcome> {
    const receipt = this.store.commandReceipt(receiptId)
    if (receipt === undefined) return { ok: false, code: 'not_accepted', message: 'the command does not exist' }
    if (receipt.status === 'succeeded') return { ok: true, receipt, replayed: true, result: resultOf(receipt.result_json) }
    if (receipt.status === 'failed') {
      return {
        ok: false,
        code: receipt.error_code ?? 'not_accepted',
        message: receipt.error_message ?? 'the command already failed',
        ...(receipt.error_detail === null ? {} : { detail: receipt.error_detail }),
        receipt,
      }
    }
    const operation = operationFor(receipt.operation)
    if (operation === undefined) return this.failReceipt(receipt, 'unknown_operation', `unknown operation: ${receipt.operation}`)

    let target: CommandTarget
    let args: Record<string, unknown>
    try {
      target = JSON.parse(receipt.target_json) as CommandTarget
      args = JSON.parse(receipt.arguments_json) as Record<string, unknown>
    } catch {
      return this.failReceipt(receipt, 'corrupt_receipt', 'the stored target or arguments are unreadable')
    }

    const capabilities = capabilitiesForRepo(this.store, receipt.principal_id, target.projectId ?? null)
    const missing = operation.capabilities.filter((capability) => !capabilities.has(capability))
    if (missing.length > 0) return this.failReceipt(receipt, 'authorization_revoked', `no longer holds: ${missing.join(', ')}`)

    const resourceId = String(target[operation.revisionTarget] ?? '')
    const current = this.store.revisionOf(operation.revisionType, resourceId)
    if (current !== receipt.expected_revision) {
      return this.failReceipt(receipt, 'management_revision_conflict', `the resource moved from ${receipt.expected_revision} to ${current} after acceptance`)
    }

    const outcome = await operation.execute({ store: this.store, jobs: this.jobs, principalId: receipt.principal_id }, target, args)
    if (outcome.status === 'failed') {
      return this.failReceipt(receipt, outcome.errorCode ?? 'job_not_cancellable', outcome.errorMessage ?? 'the operation failed', outcome.errorDetail)
    }
    // The receipt, the revision bump and the audit row commit together. The
    // business write itself already happened inside the operation, which is why
    // `docs/architecture.md` names the operations that cannot be one transaction.
    return this.commitSucceeded(receipt, operation.revisionType, resourceId, outcome.result ?? {}, outcome.commit)
  }

  // #540 slice 2: shadow mode runs today's path and then records what happened,
  // so a receipt exists for a command the service did not execute. It commits the
  // same way a real completion does — revision bump, receipt, audit row together —
  // because the business write did happen, just not here.
  settle(receiptId: string, outcome: { ok: true; result?: Record<string, unknown> } | { ok: false; code: ManagementCode; message: string }): CommandOutcome {
    const receipt = this.store.commandReceipt(receiptId)
    if (receipt === undefined) return { ok: false, code: 'not_accepted', message: 'the command does not exist' }
    // A receipt that already answered is the record of what happened, and one
    // command moves the revision once. A later settle — the shape a resubmitted
    // form produces — replays it instead of overwriting a success with a failure
    // and bumping the revision a second time.
    if (receipt.status !== 'accepted') return this.replay(receipt)
    if (!outcome.ok) return this.failReceipt(receipt, outcome.code, outcome.message)
    const operation = operationFor(receipt.operation)
    if (operation === undefined) return this.failReceipt(receipt, 'unknown_operation', `unknown operation: ${receipt.operation}`)
    let target: CommandTarget
    try {
      target = JSON.parse(receipt.target_json) as CommandTarget
    } catch {
      return this.failReceipt(receipt, 'corrupt_receipt', 'the stored target is unreadable')
    }
    return this.commitSucceeded(receipt, operation.revisionType, String(target[operation.revisionTarget] ?? ''), outcome.result ?? {})
  }

  private commitSucceeded(receipt: ManagementCommandRow, revisionType: string, resourceId: string, result: Record<string, unknown>, commit?: () => void): CommandOutcome {
    const current = receipt.before_revision ?? this.store.revisionOf(revisionType, resourceId)
    this.store.transaction(() => {
      // The effect and the receipt that records it are one commit: a crash either
      // leaves both absent (the receipt still `accepted`, which is honest) or both
      // present. The awaited parts of an operation happened before this point.
      commit?.()
      const revision = this.store.bumpRevision(revisionType, resourceId)
      this.store.updateCommandReceipt(receipt.id, {
        status: 'succeeded',
        result_json: canonical(result),
        after_revision: revision,
        error_code: null,
        error_message: null,
      })
      this.store.audit(receipt.principal_id, 'management.command', `${receipt.id} ${receipt.operation} revision ${current}->${revision} status=succeeded`)
      return revision
    })
    const updated = this.store.commandReceipt(receipt.id)
    if (updated === undefined) return { ok: false, code: 'corrupt_receipt', message: 'the receipt disappeared after completion' }
    return { ok: true, receipt: updated, replayed: false, result }
  }

  // A replay answers with what the first attempt stored. Only a succeeded
  // receipt is a success: a stored failure repeats its code, and a receipt that
  // is still accepted/running/unknown is in progress — never a success notice,
  // which would tell a person the job was cancelled when it was not.
  private replay(receipt: ManagementCommandRow): CommandOutcome {
    if (receipt.status === 'succeeded') return { ok: true, receipt, replayed: true, result: resultOf(receipt.result_json) }
    if (receipt.status === 'failed') {
      return {
        ok: false,
        code: receipt.error_code ?? 'not_accepted',
        message: receipt.error_message ?? 'the command already failed',
        ...(receipt.error_detail === null ? {} : { detail: receipt.error_detail }),
        receipt,
      }
    }
    return { ok: false, code: 'command_in_progress', message: `the command is ${receipt.status} and has not finished`, receipt }
  }

  private failReceipt(receipt: ManagementCommandRow, code: string, message: string, detail?: string): CommandOutcome {
    this.store.transaction(() => {
      this.store.updateCommandReceipt(receipt.id, {
        status: 'failed',
        error_code: code,
        error_message: message,
        error_detail: detail ?? null,
      })
      this.store.audit(receipt.principal_id, 'management.command', `${receipt.id} ${receipt.operation} status=failed code=${code}`)
    })
    const updated = this.store.commandReceipt(receipt.id)
    return {
      ok: false,
      code,
      message,
      ...(detail === undefined ? {} : { detail }),
      ...(updated === undefined ? {} : { receipt: updated }),
    }
  }

  private scope(actor: ActorContext, target: CommandTarget): string {
    return `${actor.principalId}|${actor.tenantId ?? ''}|${target.projectId ?? actor.projectId ?? ''}`
  }

  private requestHash(envelope: CommandEnvelope): string {
    return sha256Hex([envelope.operation, canonical(envelope.target), canonical(envelope.arguments), String(envelope.expectedRevision)].join('\n'))
  }
}
