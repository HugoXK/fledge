// The evolvable-artifact contract (#424). ADR 0003 fixes what may evolve and
// what is frozen; this module is the machine-readable form of that table so the
// ledger in `src/db.ts` asks one place instead of keeping a second copy.
//
// Nothing here reads the database: the ledger passes the candidate's facts in
// and records the answer, which keeps every refusal testable without a store.

export type ArtifactKind =
  | 'repo-goal'
  | 'repo-model'
  | 'default-goal'
  | 'task-template'
  | 'playbook'
  | 'review-rubric'
  | 'policy'

export type ArtifactRisk = 'low' | 'medium' | 'high'

export interface ArtifactKindSpec {
  kind: ArtifactKind
  risk: ArtifactRisk
  /**
   * How an accepted version reaches the product. Data artifacts are applied to
   * a row; text artifacts are read by the code that owns them. No artifact is
   * applied by editing a frozen file, which is why the evolvable set and the
   * frozen set cannot overlap.
   */
  apply: 'row' | 'text'
}

// Risk order is deliberate: the first entry is the lowest-risk artifact, and a
// reviewer reads this list top to bottom to know what a candidate may touch.
export const ARTIFACT_KINDS: readonly ArtifactKindSpec[] = [
  { kind: 'repo-goal', risk: 'low', apply: 'row' },
  { kind: 'repo-model', risk: 'low', apply: 'row' },
  { kind: 'task-template', risk: 'medium', apply: 'text' },
  { kind: 'default-goal', risk: 'medium', apply: 'text' },
  { kind: 'playbook', risk: 'medium', apply: 'text' },
  { kind: 'review-rubric', risk: 'high', apply: 'text' },
  { kind: 'policy', risk: 'high', apply: 'text' },
]

// Frozen: the evaluator, authentication, the gateway, the merge gate and the CI
// configuration. A candidate that names any of these is refused before it is
// evaluated — not down-weighted, not deferred. The merge gate lives in
// `src/jobs/service.ts`, so the whole file is frozen rather than a symbol
// inside it: a path is the unit the ledger can check without parsing code.
export const FROZEN_PATHS: readonly string[] = [
  'src/lib/evolution/', // the evaluator and this ledger
  'src/auth/', // authentication and sessions
  'src/gateway/', // the model gateway and quota
  'src/jobs/service.ts', // the merge gate and the job lifecycle
  '.github/workflows/', // CI configuration
  '.github/agent/', // the review, risk and check policy the gates read
]

export type CandidateRefusalCode = 'INELIGIBLE_KIND' | 'FROZEN_PATH' | 'SCOPE_MISMATCH' | 'STALE_BASE' | 'NOT_FOUND'

export interface CandidateRefusal {
  code: CandidateRefusalCode
  detail: string
}

export function artifactSpec(kind: string): ArtifactKindSpec | null {
  return ARTIFACT_KINDS.find((spec) => spec.kind === kind) ?? null
}

function matchesFrozen(path: string, frozen: string): boolean {
  if (frozen.endsWith('/')) return path === frozen || path.startsWith(frozen)
  return path === frozen
}

/** The frozen paths a candidate names, in the order it named them. */
export function frozenPathsNamed(paths: readonly string[]): string[] {
  const named: string[] = []
  for (const path of paths) {
    const frozen = FROZEN_PATHS.find((entry) => matchesFrozen(path, entry))
    if (frozen !== undefined) named.push(path)
  }
  return named
}

/**
 * The ledger key for an artifact. A repository-scoped artifact is namespaced by
 * its repository so two repositories evolve the same kind independently and a
 * version number means one thing inside one lineage.
 */
export function artifactKey(input: { kind: string; scope: 'global' | 'repository'; repoId?: string | null }): string {
  if (input.scope === 'repository') {
    if (input.repoId === undefined || input.repoId === null || input.repoId === '') {
      throw new Error('a repository-scoped artifact needs a repository id')
    }
    return `${input.kind}@${input.repoId}`
  }
  return input.kind
}

/**
 * The refusal a candidate gets before it is stored, or null when it is
 * admissible. Checked in this order because the answer a user reads should be
 * about the candidate itself (kind, then frozen path, then scope) before it is
 * about the lineage (the CAS base).
 */
export function candidateRefusal(input: {
  kind: string
  scope: 'global' | 'repository'
  repoId?: string | null
  paths: readonly string[]
  baseVersion: number
  headVersion: number
}): CandidateRefusal | null {
  const spec = artifactSpec(input.kind)
  if (spec === null) return { code: 'INELIGIBLE_KIND', detail: `artifact kind "${input.kind}" is not in the evolvable set` }
  const frozen = frozenPathsNamed(input.paths)
  if (frozen.length > 0) {
    return { code: 'FROZEN_PATH', detail: `frozen path${frozen.length === 1 ? '' : 's'}: ${frozen.join(', ')}` }
  }
  if (input.scope === 'repository' && (input.repoId === undefined || input.repoId === null || input.repoId === '')) {
    return { code: 'SCOPE_MISMATCH', detail: 'a repository-scoped artifact needs a repository id' }
  }
  if (input.scope === 'global' && input.repoId !== undefined && input.repoId !== null && input.repoId !== '') {
    return { code: 'SCOPE_MISMATCH', detail: `a global artifact must not name repository ${input.repoId}` }
  }
  // Compare-and-swap: the candidate declares the version it was built against.
  // A candidate built on anything but the current head is stale, and a stale
  // candidate is refused rather than re-based, because re-basing would evaluate
  // a diff nobody reviewed.
  if (input.baseVersion !== input.headVersion) {
    return { code: 'STALE_BASE', detail: `declared base ${String(input.baseVersion)} but the head is ${String(input.headVersion)}` }
  }
  return null
}
