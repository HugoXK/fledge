import { createHash } from 'node:crypto'
import type { ProjectMemoryRow } from '../db.js'
import type { Translate } from '../i18n.js'
import type { RepoRole } from './repoRole.js'

// #539: project memory is a durable, versioned record — a decision, convention or
// hard-won experience that a later job can cite instead of re-deriving. This
// module holds the rules that are not SQL: what a valid write looks like, who may
// read which audience, and the bounds on a lookup. The store (`src/db.ts`) owns
// the revision fence; nothing here writes.
//
// The slice has no agent writer and no repository-document promotion. Those need
// the job-prompt surface (`src/jobs/service.ts`) and the merge/blob proof the
// issue describes, and are listed as non-goals in the pull request.

export const MEMORY_KINDS = ['goal', 'decision', 'convention', 'implementation', 'experience', 'hypothesis'] as const
export const MEMORY_STATUSES = ['active', 'needs_review', 'conflict', 'archived', 'revoked'] as const
export const MEMORY_VERIFICATIONS = ['human_asserted', 'observed', 'unverified'] as const

export type MemoryKind = (typeof MEMORY_KINDS)[number]
export type MemoryStatus = (typeof MEMORY_STATUSES)[number]
export type MemoryVerification = (typeof MEMORY_VERIFICATIONS)[number]

// Keys are stable identifiers a person types in a prompt or a citation, so they
// are lowercase, short and free of whitespace. A key is unique inside one repo.
export const MEMORY_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
export const MEMORY_BODY_MAX = 8000
export const MEMORY_SCOPE_MAX = 200
export const MEMORY_REASON_MAX = 200
// The bound the issue asks for is stated here rather than implied by a database
// page size: a query is capped, a result set is capped and a preview is capped.
export const MEMORY_QUERY_MAX = 120
export const MEMORY_SEARCH_LIMIT = 50
export const MEMORY_PREVIEW_CHARS = 200

export type MemoryRefusal =
  | 'key_invalid'
  | 'body_empty'
  | 'body_too_long'
  | 'kind_invalid'
  | 'status_invalid'
  | 'verification_invalid'
  | 'audience_invalid'
  | 'role_not_allowed'
  | 'scope_too_long'
  | 'reason_too_long'
  | 'revision_invalid'
  | 'source_invalid'
  | 'query_too_long'

export interface MemoryInput {
  key: string
  kind: MemoryKind
  status: MemoryStatus
  verification: MemoryVerification
  audience: string
  scope: string
  body: string
  sourcesJson: string
  reason: string
  expectedRevision: number
}

export type MemoryParse =
  | { ok: true; value: MemoryInput }
  | { ok: false; refused: MemoryRefusal }

export function memoryDigest(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

export function memoryAudience(role: RepoRole | null): string {
  return role === null ? 'project' : `role:${role}`
}

export function isMemoryAudience(value: string): boolean {
  return value === 'project' || value === 'role:maintainer' || value === 'role:developer'
}

export function audienceRole(audience: string): RepoRole | null {
  if (audience === 'role:maintainer') return 'maintainer'
  if (audience === 'role:developer') return 'developer'
  return null
}

// The rule the issue is explicit about: a role sees the shared entries and its
// own role entries, and an administrator's permission does not widen that. The
// reader's `role` is the repository's chosen role, so a person acting as a
// developer reads the developer view even when they administer the instance.
export function audienceVisible(audience: string, role: RepoRole | null): boolean {
  if (audience === 'project') return true
  return role !== null && audience === `role:${role}`
}

export function visibleMemories(entries: ProjectMemoryRow[], role: RepoRole | null): ProjectMemoryRow[] {
  return entries.filter((entry) => audienceVisible(entry.audience, role))
}

export function previewOf(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  return flat.length <= MEMORY_PREVIEW_CHARS ? flat : `${flat.slice(0, MEMORY_PREVIEW_CHARS - 1)}…`
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function parseMemoryInput(
  form: Record<string, unknown>,
  options: { role: RepoRole | null; allowedRoles: RepoRole[] },
): MemoryParse {
  const key = text(form.key)
  const body = text(form.body)
  const scope = text(form.scope)
  const reason = text(form.reason)
  const kind = text(form.kind) as MemoryKind
  const status = text(form.status) as MemoryStatus
  const verification = text(form.verification) as MemoryVerification
  const audience = text(form.audience)

  if (!MEMORY_KEY_PATTERN.test(key)) return { ok: false, refused: 'key_invalid' }
  if (body === '') return { ok: false, refused: 'body_empty' }
  if (body.length > MEMORY_BODY_MAX) return { ok: false, refused: 'body_too_long' }
  if (!MEMORY_KINDS.includes(kind)) return { ok: false, refused: 'kind_invalid' }
  if (!MEMORY_STATUSES.includes(status)) return { ok: false, refused: 'status_invalid' }
  if (!MEMORY_VERIFICATIONS.includes(verification)) return { ok: false, refused: 'verification_invalid' }
  if (!isMemoryAudience(audience)) return { ok: false, refused: 'audience_invalid' }
  // A writer may not author an entry for a role it cannot act as. Without this a
  // developer-role reader could plant a maintainer-scoped "decision" that only
  // the maintainer would ever see.
  const authored = audienceRole(audience)
  if (authored !== null && !options.allowedRoles.includes(authored)) return { ok: false, refused: 'role_not_allowed' }
  if (scope.length > MEMORY_SCOPE_MAX) return { ok: false, refused: 'scope_too_long' }
  if (reason.length > MEMORY_REASON_MAX) return { ok: false, refused: 'reason_too_long' }

  const rawRevision = text(form.expected_revision)
  const expectedRevision = rawRevision === '' ? 0 : Number(rawRevision)
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) return { ok: false, refused: 'revision_invalid' }

  // Sources are references, kept as given, but a write that carries them must
  // send a JSON array of short strings — the store keeps them and the reader
  // shows them, so they are never a place for a body of text to hide.
  const rawSources = text(form.sources)
  let sources: string[] = []
  if (rawSources !== '') {
    let parsed: unknown
    try {
      parsed = JSON.parse(rawSources)
    } catch {
      return { ok: false, refused: 'source_invalid' }
    }
    if (!Array.isArray(parsed) || parsed.length > 20) return { ok: false, refused: 'source_invalid' }
    if (!parsed.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 300)) {
      return { ok: false, refused: 'source_invalid' }
    }
    sources = parsed
  }

  return {
    ok: true,
    value: { key, kind, status, verification, audience, scope, body, sourcesJson: JSON.stringify(sources), reason, expectedRevision },
  }
}

export interface MemorySearch {
  matches: ProjectMemoryRow[]
  total: number
  truncated: boolean
  refused: MemoryRefusal | null
}

// A bounded keyword lookup, not retrieval: the same word must appear in the key,
// the body or the scope. It never ranks or embeds, so the same store always
// answers the same way, which is what makes a citation stable.
export function searchMemories(
  entries: ProjectMemoryRow[],
  rawQuery: string,
  role: RepoRole | null,
): MemorySearch {
  const visible = visibleMemories(entries, role)
  const query = rawQuery.trim()
  if (query === '') return { matches: visible.slice(0, MEMORY_SEARCH_LIMIT), total: visible.length, truncated: visible.length > MEMORY_SEARCH_LIMIT, refused: null }
  if (query.length > MEMORY_QUERY_MAX) return { matches: [], total: visible.length, truncated: false, refused: 'query_too_long' }
  const needle = query.toLowerCase()
  const hits = visible.filter((entry) =>
    entry.key.toLowerCase().includes(needle) ||
    entry.body.toLowerCase().includes(needle) ||
    entry.scope.toLowerCase().includes(needle),
  )
  return { matches: hits.slice(0, MEMORY_SEARCH_LIMIT), total: hits.length, truncated: hits.length > MEMORY_SEARCH_LIMIT, refused: null }
}

export function memoryKindLabel(t: Translate, kind: string): string {
  switch (kind) {
    case 'goal': return t('目标', 'Goal')
    case 'decision': return t('决定', 'Decision')
    case 'convention': return t('约定', 'Convention')
    case 'implementation': return t('实现', 'Implementation')
    case 'experience': return t('经验', 'Experience')
    case 'hypothesis': return t('假设', 'Hypothesis')
    default: return kind
  }
}

export function memoryStatusLabel(t: Translate, status: string): string {
  switch (status) {
    case 'active': return t('有效', 'Active')
    case 'needs_review': return t('待复核', 'Needs review')
    case 'conflict': return t('有冲突', 'Conflict')
    case 'archived': return t('已归档', 'Archived')
    case 'revoked': return t('已撤销', 'Revoked')
    default: return status
  }
}

export function memoryVerificationLabel(t: Translate, verification: string): string {
  switch (verification) {
    case 'human_asserted': return t('人已确认', 'Human asserted')
    case 'observed': return t('观察所得', 'Observed')
    case 'unverified': return t('未验证', 'Unverified')
    default: return verification
  }
}

export function memoryAudienceLabel(t: Translate, audience: string): string {
  if (audience === 'role:maintainer') return t('仅维护者', 'Maintainer role only')
  if (audience === 'role:developer') return t('仅开发者', 'Developer role only')
  return t('项目共享', 'Shared with the project')
}
