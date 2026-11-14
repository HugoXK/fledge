// #639: a task relation is an explicit claim that two tasks are about the same
// problem, are related, or that one recurs. It is never inferred from a title or
// an embedding: only a person or the bounded post-QA decision writes one, and it
// carries the reason and the evidence the claim rests on.
import { hasCheckableEvidence } from './priority.js'

export const RELATION_KINDS = ['same_problem', 'related', 'recurrence'] as const

export type RelationKind = (typeof RELATION_KINDS)[number]

export function isRelationKind(value: unknown): value is RelationKind {
  return typeof value === 'string' && (RELATION_KINDS as readonly string[]).includes(value)
}

export function relationKindLabel(kind: RelationKind, t: (zh: string, en: string) => string): string {
  if (kind === 'same_problem') return t('同一问题', 'Same problem')
  if (kind === 'recurrence') return t('复发', 'Recurrence')
  return t('相关', 'Related')
}

export type RelationRefusalCode = 'RELATION_KIND_INVALID' | 'RELATION_EVIDENCE_REQUIRED'

export type RelationRefusal = { ok: false; code: RelationRefusalCode; message: string }
export type RelationAccepted = { ok: true; kind: RelationKind; reason: string; evidence: string }

// A reason says why the two tasks belong together; evidence is something a
// second person can check. The bar is lower than a P0/P1 claim because a
// relation does not reorder work, but it is the same kind of checkable fact.
const MIN_REASON = 8

export function validateRelationClaim(input: { kind: unknown; reason: unknown; evidence: unknown }): RelationAccepted | RelationRefusal {
  if (!isRelationKind(input.kind)) {
    return { ok: false, code: 'RELATION_KIND_INVALID', message: `关联类型无效：${String(input.kind)}` }
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  const evidence = typeof input.evidence === 'string' ? input.evidence.trim() : ''
  if (reason.length < MIN_REASON || !hasCheckableEvidence(evidence)) {
    return {
      ok: false,
      code: 'RELATION_EVIDENCE_REQUIRED',
      message: `关联需要理由（至少 ${MIN_REASON} 字）和可核对的证据：链接、提交/工单 sha，或带单位的测量值。`,
    }
  }
  return { ok: true, kind: input.kind, reason, evidence }
}
