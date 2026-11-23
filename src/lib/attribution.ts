export const ATTRIBUTION_FIELDS = [
  { key: 'writtenBy', verb: 'wrote', zh: '编写', en: 'Written' },
  { key: 'claimedBy', verb: 'claimed', zh: '领取', en: 'Claimed' },
  { key: 'implementedBy', verb: 'implemented', zh: '实现', en: 'Implemented' },
  { key: 'testedBy', verb: 'tested', zh: '测试', en: 'Tested' },
  { key: 'reviewedBy', verb: 'reviewed', zh: '审核', en: 'Reviewed' },
] as const

export type AttributionKey = (typeof ATTRIBUTION_FIELDS)[number]['key']
export type Attribution = Partial<Record<AttributionKey, string>>

const EMPTY = new Set(['not run', 'not recorded', 'none', 'n/a', 'na', 'pending', 'unknown', '-', '—', ''])

function cleanRole(value: string): string {
  let text = value.trim()
  for (const suffix of ['(team)', '(automation)', '(自动化)']) {
    if (text.toLowerCase().endsWith(suffix)) {
      text = text.slice(0, -suffix.length).trim()
      break
    }
  }
  return text.slice(0, 80)
}

export function parseAttribution(value: unknown): Attribution | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const out: Attribution = {}
  for (const field of ATTRIBUTION_FIELDS) {
    const raw = (value as Record<string, unknown>)[field.key]
    if (typeof raw !== 'string') continue
    const text = cleanRole(raw)
    if (EMPTY.has(text.toLowerCase())) continue
    out[field.key] = text
  }
  return Object.keys(out).length === 0 ? null : out
}

export function parseAttributionJson(value: string | null): Attribution | null {
  if (value === null || value === '') return null
  try {
    return parseAttribution(JSON.parse(value))
  } catch {
    return null
  }
}

export interface AttributionStep {
  role: string
  keys: AttributionKey[]
}

export function attributionJourney(attribution: Attribution | null): AttributionStep[] {
  if (attribution === null) return []
  const byRole = new Map<string, AttributionKey[]>()
  for (const field of ATTRIBUTION_FIELDS) {
    const role = attribution[field.key]
    if (role === undefined) continue
    // "wrote" and "implemented" are the same contribution when one role did both.
    if (field.key === 'writtenBy' && attribution.implementedBy === role) continue
    const keys = byRole.get(role) ?? []
    keys.push(field.key)
    byRole.set(role, keys)
  }
  return [...byRole.entries()].map(([role, keys]) => ({ role, keys }))
}

export function attributionSentence(attribution: Attribution | null): string {
  return attributionJourney(attribution)
    .map(({ role, keys }) => `${role} ${keys.map((key) => ATTRIBUTION_FIELDS.find((field) => field.key === key)?.verb ?? key).join(' + ')}`)
    .join(' · ')
}

// #368: the job says who did what and the server can see which seats actually
// worked, and those are two different facts. `attribution_json` holds the first,
// this record holds both per attribution key, so a claim is never overwritten by
// an observation and a page can mark the difference:
//
// - `grounded` — the observation names the claimed seat, or the observation names
//   a seat nobody claimed (presence is all the call counts prove).
// - `unobserved` — an observation ran and did not see the claimed seat work.
// - `no-observation` — no instance observed this job at all, so the claim is
//   unverified rather than false.
export type AttributionGroundState = 'grounded' | 'unobserved' | 'no-observation'

export interface AttributionGroundStep {
  key: AttributionKey
  claimed: string | null
  observed: string | null
  state: AttributionGroundState
}

export interface AttributionGround {
  steps: AttributionGroundStep[]
}

const GROUND_STATES: readonly AttributionGroundState[] = ['grounded', 'unobserved', 'no-observation']

export function parseAttributionGround(value: unknown): AttributionGround | null {
  if (value === null || typeof value !== 'object') return null
  const raw = (value as { steps?: unknown }).steps
  if (!Array.isArray(raw)) return null
  const steps: AttributionGroundStep[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const key = ATTRIBUTION_FIELDS.find((field) => field.key === record.key)?.key
    if (key === undefined) continue
    const claimed = typeof record.claimed === 'string' && record.claimed.trim() !== '' ? cleanRole(record.claimed) : null
    const observed = typeof record.observed === 'string' && record.observed.trim() !== '' ? cleanRole(record.observed) : null
    const state = GROUND_STATES.find((candidate) => candidate === record.state)
    if (state === undefined || (claimed === null && observed === null)) continue
    steps.push({ key, claimed, observed, state })
  }
  return steps.length === 0 ? null : { steps }
}

export function parseAttributionGroundJson(value: string | null): AttributionGround | null {
  if (value === null || value === '') return null
  try {
    return parseAttributionGround(JSON.parse(value))
  } catch {
    return null
  }
}

// #368/#1190: one reconstruction of the ground record, shared by every reader of
// the claim. A row written before `attribution_ground_json` exists carries the
// observation in `attribution_json` itself when team stats were recorded (the
// old writer overwrote the claim), and a claim nothing checked otherwise. The
// reconstruction is a rule, not a guess: a stored record always wins.
export function attributionGroundFor(input: {
  groundJson: string | null
  attributionJson: string | null
  teamStatsJson: string | null
}): AttributionGround | null {
  const stored = parseAttributionGroundJson(input.groundJson)
  if (stored !== null) return stored
  const recorded = parseAttributionJson(input.attributionJson)
  if (recorded === null) return null
  const observedOnly = input.teamStatsJson !== null
  return {
    steps: ATTRIBUTION_FIELDS
      .filter((field) => recorded[field.key] !== undefined)
      .map((field) => ({
        key: field.key,
        claimed: observedOnly ? null : (recorded[field.key] as string),
        observed: recorded[field.key] as string,
        state: observedOnly ? 'grounded' as const : 'no-observation' as const,
      })),
  }
}

const CLAIM_STATE_ORDER: Record<AttributionGroundState, number> = { grounded: 0, unobserved: 1, 'no-observation': 2 }

/**
 * How the record judges the seat's claim on `role`, or null when the role is not
 * claimed at all (an observation-only seat). The worst state among the claiming
 * steps speaks for the role, the same rule `jobAttribution` applies to one seat
 * on several kinds of work: a seat seen on one kind of work and not on another
 * is not a grounded seat.
 */
export function claimedRoleState(
  ground: AttributionGround | null,
  role: string | null,
  keys: readonly AttributionKey[] = ['writtenBy', 'implementedBy'],
): AttributionGroundState | null {
  if (ground === null || role === null || role === '') return null
  let worst: AttributionGroundState | null = null
  for (const step of ground.steps) {
    if (step.claimed !== role || !keys.includes(step.key)) continue
    if (worst === null || CLAIM_STATE_ORDER[step.state] > CLAIM_STATE_ORDER[worst]) worst = step.state
  }
  return worst
}
