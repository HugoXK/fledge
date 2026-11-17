// Types for release-alias.mjs, the pairing the other release helpers use, so the
// suite can import the pure rule instead of reading YAML prose.

export const ALIAS_SAME: 'same'
export const ALIAS_CREATE: 'create'
export const ALIAS_REFUSE: 'refuse'

export interface AliasDecision {
  action: 'same' | 'create' | 'refuse'
  reason: string
}

export function classifyAlias(input?: { status?: number; existing?: string; digest?: string }): AliasDecision
