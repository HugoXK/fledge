// Types for the JS tag-provenance decision in tag-provenance.mjs, so the
// TypeScript test suite can import it under `tsc --noEmit` without allowJs.

export interface ReleasePull {
  number?: number
  title?: string
  merged_at?: string | null
  merge_commit_sha?: string | null
}

export interface TagProvenanceInput {
  tag?: string | null
  objectType?: string | null
  tagger?: string | null
  onMain?: boolean | null
  commit?: string | null
  pulls?: ReleasePull[] | null
}

export interface TagProvenanceResult {
  ok: boolean
  identity: 'routine' | 'owner' | null
  reason: string
}

export const ROUTINE_TAGGERS: string[]
export const OWNER_TAGGERS: string[]

export function verifyTagProvenance(input?: TagProvenanceInput): TagProvenanceResult
