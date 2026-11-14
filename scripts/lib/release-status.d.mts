// Types for the pure release-status model in release-status.mjs, so the
// TypeScript suite can import it under `tsc --noEmit` without allowJs.

export type ReleaseLinkState = 'ok' | 'missing' | 'mismatch' | 'skipped'

export interface ReleaseLink {
  id: string
  state: ReleaseLinkState
  detail: string
}

export interface ReleasePlanFixture {
  version?: string | null
  mainSha?: string | null
  plannedAt?: string | null
}

export interface ReleaseBranchFixture {
  name?: string | null
  tip?: string | null
  deleted?: boolean
}

export interface ReleasePullFixture {
  number?: number | null
  state?: string | null
  headSha?: string | null
  mergeCommitSha?: string | null
  mergedAt?: string | null
  base?: string | null
}

export interface ReleaseTagFixture {
  name?: string | null
  objectSha?: string | null
  objectType?: string | null
  targetSha?: string | null
}

export interface ReleaseImageFixture {
  tag?: string | null
  digest?: string | null
}

export interface ReleaseSbomFixture {
  present?: boolean
  name?: string | null
}

export interface ReleaseAttestationFixture {
  present?: boolean
  subjectDigest?: string | null
}

export interface ReleaseFixture {
  url?: string | null
  tagName?: string | null
  publishedAt?: string | null
  draft?: boolean
}

export interface ReleaseHealthFixture {
  version?: string | null
  commit?: string | null
}

export interface ReleaseStatusInput {
  version?: string | null
  packageVersion?: string | null
  checkedAt?: string | null
  baseUrl?: string | null
  plan?: ReleasePlanFixture | null
  branch?: ReleaseBranchFixture | null
  pull?: ReleasePullFixture | null
  tag?: ReleaseTagFixture | null
  image?: ReleaseImageFixture | null
  sbom?: ReleaseSbomFixture | null
  attestation?: ReleaseAttestationFixture | null
  release?: ReleaseFixture | null
  healthz?: ReleaseHealthFixture | null
  /** `sha256:…` of the image this host would run, read locally by the caller. */
  localImageDigest?: string | null
}

export interface ReleaseStatus {
  schema: number
  version: string
  checkedAt: string
  baseUrl: string
  ok: boolean
  links: ReleaseLink[]
  problems: string[]
  /** The commit the release tag points at, empty when no tag target is readable. */
  targetSha: string
  /** The GitHub Release url, empty when the chain has no readable Release. */
  releaseUrl: string
  /** The local image digest that was compared, empty when none was given. */
  localImageDigest: string
}

export function evaluateReleaseStatus(input?: ReleaseStatusInput): ReleaseStatus
