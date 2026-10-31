export const ATTRIBUTION_FIELDS = [
  { key: 'writtenBy', verb: 'wrote', zh: '编写', en: 'Written' },
  { key: 'claimedBy', verb: 'claimed', zh: '领取', en: 'Claimed' },
  { key: 'implementedBy', verb: 'implemented', zh: '实现', en: 'Implemented' },
  { key: 'testedBy', verb: 'tested', zh: '测试', en: 'Tested' },
  { key: 'reviewedBy', verb: 'reviewed', zh: '审核', en: 'Reviewed' },
] as const

export type AttributionKey = (typeof ATTRIBUTION_FIELDS)[number]['key']
export type Attribution = Partial<Record<AttributionKey, string>>

export function parseAttribution(value: unknown): Attribution | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const out: Attribution = {}
  for (const field of ATTRIBUTION_FIELDS) {
    const raw = (value as Record<string, unknown>)[field.key]
    if (typeof raw !== 'string') continue
    const text = raw.trim().slice(0, 80)
    if (text !== '') out[field.key] = text
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
