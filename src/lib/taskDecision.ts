// #639: after a job is verified, the next step is one bounded decision, not an
// open-ended chain: `new` work, `supplement` an existing task, or link the new
// work as `related` / `recurrence`. The decision carries a reason and checkable
// evidence, and a contradictory answer (`new` aimed at an existing task) is
// repaired once into `related` rather than silently creating a duplicate.
import { hasCheckableEvidence } from './priority.js'

export const DECISION_KINDS = ['new', 'supplement', 'related', 'recurrence'] as const

export type DecisionKind = (typeof DECISION_KINDS)[number]

export function isDecisionKind(value: unknown): value is DecisionKind {
  return typeof value === 'string' && (DECISION_KINDS as readonly string[]).includes(value)
}

// When the decision step is unavailable the framework does not guess: every
// follow-up is ordinary work in its own task, which is the P2 default.
export const DEFAULT_DECISION: { kind: 'new'; level: 'P2' } = { kind: 'new', level: 'P2' }

export type DecisionRefusalCode =
  | 'DECISION_KIND_INVALID'
  | 'DECISION_TARGET_REQUIRED'
  | 'DECISION_TARGET_MISSING'
  | 'DECISION_EVIDENCE_REQUIRED'
  | 'DECISION_CONTRADICTORY'

export type DecisionRepair = { kind: DecisionKind; existingTaskId: string; repaired: boolean }

// `new` plus an existing task id is contradictory: the answer says "separate
// task" and "this task" at once. It is repaired once — the separate-task claim
// loses, and the result is `related` to the task the answer named.
export function repairDecision(kind: DecisionKind, existingTaskId: string): DecisionRepair {
  if (kind === 'new' && existingTaskId !== '') return { kind: 'related', existingTaskId, repaired: true }
  return { kind, existingTaskId, repaired: false }
}

export type DecisionAccepted = { ok: true; kind: DecisionKind; existingTaskId: string; reason: string; evidence: string }
export type DecisionRefusal = { ok: false; code: DecisionRefusalCode; message: string }

const MIN_REASON = 8

export function validateDecision(input: {
  kind: unknown
  existingTaskId: unknown
  reason: unknown
  evidence: unknown
}): DecisionAccepted | DecisionRefusal {
  if (!isDecisionKind(input.kind)) {
    return { ok: false, code: 'DECISION_KIND_INVALID', message: `下一步决定无效：${String(input.kind)}` }
  }
  const existingTaskId = typeof input.existingTaskId === 'string' ? input.existingTaskId.trim() : ''
  if (input.kind !== 'new' && existingTaskId === '') {
    return { ok: false, code: 'DECISION_TARGET_REQUIRED', message: `${input.kind} 需要指出已有的任务。` }
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  const evidence = typeof input.evidence === 'string' ? input.evidence.trim() : ''
  if (reason.length < MIN_REASON || !hasCheckableEvidence(evidence)) {
    return {
      ok: false,
      code: 'DECISION_EVIDENCE_REQUIRED',
      message: `下一步决定需要理由（至少 ${MIN_REASON} 字）和可核对的证据：链接、提交/工单 sha，或带单位的测量值。`,
    }
  }
  return { ok: true, kind: input.kind, existingTaskId, reason, evidence }
}
