// Types for the JS planner in release-plan.mjs, so the TypeScript test suite can
// import it under `tsc --noEmit` without allowJs.

export interface ReleasePlanPr {
  number: number
  title: string
  labels: string[]
  mergedAt: string
}

export interface ReleasePlanInput {
  lastTag: string
  packageVersion: string
  prs: ReleasePlanPr[]
  fragments: string[]
  openReleasePr: boolean
  existingTags: string[]
  crossCheck?: { logPrNumbers: number[] }
  /** Commit time of lastTag. When given, older merges are excluded; optional
   * because the issue's input shape leaves the windowing to the caller. */
  lastTagCommittedAt?: string
  /** The nightly run time (ISO). With the last tag's commit time it decides
   * whether this is a patch release in the same ISO week or a new minor. */
  releaseAt?: string
}

export interface ReleasePlanResult {
  total: number
  features: number
  fragments: number
  nextVersion: string
  bump: 'minor' | 'patch' | ''
  reason: string
  shouldRelease: boolean
}

export declare const MIN_PRS = 10
export declare const MIN_FEATURES = 5

export declare function planRelease(input: ReleasePlanInput): ReleasePlanResult
