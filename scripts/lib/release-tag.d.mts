// Types for the JS tag recogniser in release-tag.mjs, so the TypeScript test
// suite can import it under `tsc --noEmit` without allowJs.

export interface ReleaseTagPrHead {
  ref?: string | null
}

export interface ReleaseTagPr {
  number?: number
  title?: string
  merged_at?: string | null
  merge_commit_sha?: string | null
  head?: ReleaseTagPrHead | null
}

export interface ReleaseTagRelease {
  /** `tag_name` on `GET /releases/tags/{tag}`; `tag` is accepted for fixtures. */
  tag_name?: string | null
  tag?: string | null
}

export interface ReleaseTagInput {
  pulls?: ReleaseTagPr[] | null
  tags?: string[] | null
  /** The GitHub Release for this version, or `{}`/null when there is none. */
  release?: ReleaseTagRelease | null
  packageVersion?: string | null
  sha?: string | null
}

export interface ReleaseTagPlan {
  tag: string | null
  sha: string | null
  action: 'create' | 'publish' | 'skip'
  reason: string
}

export function plan(input?: ReleaseTagInput): ReleaseTagPlan

export interface ReleaseTagPrCandidate {
  number?: number | null
  title?: string | null
  /** `gh pr list --json mergeCommit` shape; `merge_commit_sha` is accepted too. */
  mergeCommit?: { oid?: string | null } | null
  merge_commit_sha?: string | null
}

export interface ReleaseTargetInput {
  /** `push`, `schedule` or the event that woke the job. */
  eventName?: string | null
  /** The event's own commit; `main`'s tip on a scheduled run. */
  sha?: string | null
  version?: string | null
  releasePrs?: ReleaseTagPrCandidate[] | null
}

export interface ReleaseTarget {
  sha: string
  source: 'event' | 'release-merge'
  reason: string
}

export function resolveTarget(input?: ReleaseTargetInput): ReleaseTarget
