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

export interface ReleaseTagInput {
  pulls?: ReleaseTagPr[] | null
  tags?: string[] | null
  packageVersion?: string | null
  sha?: string | null
}

export interface ReleaseTagPlan {
  tag: string | null
  sha: string | null
  action: 'create' | 'skip'
  reason: string
}

export function plan(input?: ReleaseTagInput): ReleaseTagPlan
