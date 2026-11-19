import { createHash } from 'node:crypto'
import { canonicalJson } from '../gates/plan.js'

// #634: a plan approval is a decision about one specific plan, so the record has
// to name the plan the person read. The hash is taken over the same three values
// the page shows — the plan text, the structured evidence and the base sha — with
// the canonical JSON the gate session already hashes, so an edit between the page
// and the POST is a refusal rather than a silent approval of something else.
//
// One function decides and writes for both doors: the web form at
// `src/app.ts:3990-4020` and the `/fledge approve` issue command. The rules are
// ordered, because order is the answer: a decided plan is refused before anything
// else is read, and the hash is compared before the base sha is judged.

export type PlanDecisionKind = 'approve' | 'reject'

export interface PlanPacket {
  summary: string | null
  evidenceJson: string | null
  baseSha: string | null
}

export function planPacketHash(packet: PlanPacket): string {
  const canonical = canonicalJson({
    summary: packet.summary ?? '',
    evidence: packet.evidenceJson ?? '',
    baseSha: packet.baseSha ?? '',
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export interface PlanDecisionJob extends PlanPacket {
  id: string
  approvedAt: string | null
  rejectedAt: string | null
}

export type PlanRefusal =
  | 'PLAN_ALREADY_DECIDED'
  | 'PLAN_HASH_MISMATCH'
  | 'PLAN_BASE_MOVED'
  | 'PLAN_REASON_REQUIRED'
  | 'PLAN_EVIDENCE_MISSING'

export interface PlanRecord {
  plan_hash: string
  plan_approved_at: string | null
  plan_approved_by: string | null
  plan_rejected_at: string | null
  plan_reject_reason: string | null
  plan_allow_paths: string | null
  plan_deny_paths: string | null
}

export type PlanDecisionOutcome =
  | { ok: true; record: PlanRecord; action: 'job.plan_approved' | 'job.plan_rejected'; detail: string }
  | { ok: false; refusal: PlanRefusal; reason: PlanRefusalSentence }

export interface PlanDecisionInput {
  job: PlanDecisionJob
  decision: PlanDecisionKind
  /** The deciding person: a Fledge user id, or a login when they have no account. */
  actor: string
  at: string
  /** The hash the door showed the decider; null when the door read the plan live. */
  shownHash: string | null
  /** The newest base sha the platform has measured for the repository. */
  latestBaseSha: string | null
  /** Which door decided, for the audit line only. */
  door: 'web form' | 'issue command'
  allowPaths?: string
  denyPaths?: string
  reason?: string
}

export interface PlanDecisionStore {
  updateJob(id: string, patch: Partial<PlanRecord>): void
  updateWorkItem(id: string, patch: { state: 'assigned' }): void
  audit(userId: string, action: string, detail: string): void
}

/**
 * The refusal sentence a flash carries. Chinese first, like the routes around it,
 * and the base-moved case names both shas because that difference is the whole
 * point of the refusal.
 */
export interface PlanRefusalSentence {
  zh: string
  en: string
}

/**
 * The refusal sentence a flash carries, in both locales. The base-moved case names
 * both shas because that difference is the whole point of the refusal.
 */
export function planRefusalReason(refusal: PlanRefusal, input: PlanDecisionInput): PlanRefusalSentence {
  const planBase = input.job.baseSha ?? '?'
  const liveBase = input.latestBaseSha ?? '?'
  switch (refusal) {
    case 'PLAN_ALREADY_DECIDED': {
      const approved = input.job.approvedAt !== null
      return {
        zh: `这个计划已经有决定了（${approved ? `${input.job.approvedAt} 被批准` : `${input.job.rejectedAt ?? ''} 被拒绝`}），第一个决定保持不变。`,
        en: `This plan already has a decision (${approved ? `approved at ${input.job.approvedAt}` : `rejected at ${input.job.rejectedAt ?? ''}`}); the first decision stands.`,
      }
    }
    case 'PLAN_HASH_MISMATCH':
      return {
        zh: '计划在你阅读之后被改动了，这个决定没有写入；请重新打开页面确认新的计划。',
        en: 'The plan changed after you read it, so this decision was not written; reopen the page and read the new plan.',
      }
    case 'PLAN_BASE_MOVED':
      return {
        zh: `计划基于 ${planBase}，仓库现在的最新基线是 ${liveBase}；计划已过期，请重新生成计划。`,
        en: `The plan was written against ${planBase} but the repository base is now ${liveBase}; the plan is stale, so generate a new one.`,
      }
    case 'PLAN_REASON_REQUIRED':
      return { zh: '拒绝计划需要写一句理由。', en: 'A rejection needs a reason.' }
    case 'PLAN_EVIDENCE_MISSING':
      return {
        zh: '这个计划没有结构化证据（范围、验收、测试计划、回滚），不能批准；请重新生成计划。',
        en: 'This plan carries no structured evidence (scope, acceptance, test plan, rollback), so it cannot be approved; generate a new plan.',
      }
  }
}

export function planDecisionOutcome(input: PlanDecisionInput): PlanDecisionOutcome {
  const refuse = (refusal: PlanRefusal): PlanDecisionOutcome => ({ ok: false, refusal, reason: planRefusalReason(refusal, input) })
  if (input.job.approvedAt !== null || input.job.rejectedAt !== null) return refuse('PLAN_ALREADY_DECIDED')

  const hash = planPacketHash(input.job)
  if (input.shownHash !== null && input.shownHash !== hash) return refuse('PLAN_HASH_MISMATCH')

  if (input.decision === 'approve') {
    if (input.job.evidenceJson === null || input.job.evidenceJson === '') return refuse('PLAN_EVIDENCE_MISSING')
    // A base that moved makes the plan stale: the page shows the sha the plan was
    // written against, and approving it would ask for code on a different tree.
    if (input.job.baseSha !== null && input.latestBaseSha !== null && input.job.baseSha !== input.latestBaseSha) return refuse('PLAN_BASE_MOVED')
    const allow = input.allowPaths?.trim().slice(0, 2000) ?? null
    const deny = input.denyPaths?.trim().slice(0, 2000) ?? null
    return {
      ok: true,
      record: {
        plan_hash: hash,
        plan_approved_at: input.at,
        plan_approved_by: input.actor,
        plan_rejected_at: null,
        plan_reject_reason: null,
        plan_allow_paths: allow === '' ? null : allow,
        plan_deny_paths: deny === '' ? null : deny,
      },
      action: 'job.plan_approved',
      detail: `${input.job.id} via ${input.door} hash=${hash.slice(0, 12)} allow=${(allow ?? '').slice(0, 200)} deny=${(deny ?? '').slice(0, 200)}`,
    }
  }

  const reason = input.reason?.trim().slice(0, 500) ?? ''
  if (reason === '') return refuse('PLAN_REASON_REQUIRED')
  return {
    ok: true,
    record: {
      plan_hash: hash,
      plan_approved_at: null,
      // The actor of whichever decision stands; the timestamps say which one it is.
      plan_approved_by: input.actor,
      plan_rejected_at: input.at,
      plan_reject_reason: reason,
      plan_allow_paths: null,
      plan_deny_paths: null,
    },
    action: 'job.plan_rejected',
    detail: `${input.job.id} via ${input.door} hash=${hash.slice(0, 12)} reason=${reason.slice(0, 200)}`,
  }
}

/**
 * Decide and record in one place, so the two doors cannot drift into writing
 * different rows or different audit names. The caller maps a refusal to a flash.
 */
export function decidePlan(
  store: PlanDecisionStore,
  input: PlanDecisionInput & { workItemId: string | null },
): PlanDecisionOutcome {
  const outcome = planDecisionOutcome(input)
  if (!outcome.ok) return outcome
  store.updateJob(input.job.id, outcome.record)
  if (input.decision === 'approve' && input.workItemId !== null) store.updateWorkItem(input.workItemId, { state: 'assigned' })
  store.audit(input.actor, outcome.action, outcome.detail)
  return outcome
}
