// #639: the priority ladder is a closed set. The integer column the queue
// ticket already orders by stays the storage form, so the ladder translates
// instead of adding a fourth scale: P0 is the most urgent and maps to the
// highest integer the old label mapping used (30), P3 to the old default (0).
//
// The evidence standard only binds a *claim* that work is P0/P1. A platform
// policy default (an enqueue that inherits a work item's priority) is not a
// claim and is not asked for a reason.
export const PRIORITY_LEVELS = ['P0', 'P1', 'P2', 'P3'] as const

export type PriorityLevel = (typeof PRIORITY_LEVELS)[number]

const RANK_BY_LEVEL: Record<PriorityLevel, number> = { P0: 30, P1: 20, P2: 10, P3: 0 }

export function isPriorityLevel(value: unknown): value is PriorityLevel {
  return typeof value === 'string' && (PRIORITY_LEVELS as readonly string[]).includes(value)
}

export function priorityRank(level: PriorityLevel): number {
  return RANK_BY_LEVEL[level]
}

// Rows written before the ladder (and work-item priorities on a 0..100 scale)
// read as the nearest level rather than as an invalid value.
export function levelFromRank(rank: number): PriorityLevel {
  if (rank >= 30) return 'P0'
  if (rank >= 20) return 'P1'
  if (rank >= 10) return 'P2'
  return 'P3'
}

export type PriorityRefusalCode = 'PRIORITY_LEVEL_INVALID' | 'PRIORITY_EVIDENCE_REQUIRED'

export type PriorityRefusal = { ok: false; code: PriorityRefusalCode; message: string }
export type PriorityAccepted = { ok: true; level: PriorityLevel; changed: boolean }

// A reason says why the level is claimed; evidence is something a second person
// can check — a link, a commit/ticket SHA, or a measurement with a unit. An
// adjective ("urgent", "critical") is a restatement of the claim, not evidence.
const EVIDENCE_SHAPE = /(https?:\/\/\S+|\b[0-9a-f]{7,40}\b|\d+(?:\.\d+)?\s*(?:ms|s|%|x|requests?|errors?|failures?|tokens?|users?|jobs?|CNY|USD))/i

const MIN_REASON = 12

export interface PriorityClaim {
  level: PriorityLevel
  currentLevel: PriorityLevel
  reason?: string
  evidence?: string
}

export function validatePriorityClaim(claim: PriorityClaim): PriorityAccepted | PriorityRefusal {
  if (!isPriorityLevel(claim.level)) {
    return { ok: false, code: 'PRIORITY_LEVEL_INVALID', message: `优先级别无效：${String(claim.level)}` }
  }
  // Saving the level a row already holds is a no-op: it keeps its ticket and
  // needs no evidence, because nothing is being claimed (#639).
  if (claim.level === claim.currentLevel) return { ok: true, level: claim.level, changed: false }
  if (claim.level !== 'P0' && claim.level !== 'P1') return { ok: true, level: claim.level, changed: true }
  const reason = (claim.reason ?? '').trim()
  const evidence = (claim.evidence ?? '').trim()
  if (reason.length < MIN_REASON || !EVIDENCE_SHAPE.test(evidence)) {
    return {
      ok: false,
      code: 'PRIORITY_EVIDENCE_REQUIRED',
      message: `${claim.level} 需要理由（至少 ${MIN_REASON} 字）和可核对的证据：链接、提交/工单 sha，或带单位的测量值。形容词不算证据。`,
    }
  }
  return { ok: true, level: claim.level, changed: true }
}
