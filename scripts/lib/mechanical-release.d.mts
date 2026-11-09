// Types for mechanical-release.mjs so the TypeScript suites can import it.

export declare const MECHANICAL_PATHS: string[]

export interface ReleaseIdentity {
  version: string
}

export interface MechanicalReleaseResult {
  mechanical: boolean
  version: string
  reason: string
}

export declare function releaseIdentity(input?: { branch?: string; title?: string }): ReleaseIdentity | null
export declare function isMechanicalPath(path: string): boolean
export declare function mechanicalRelease(input?: { branch?: string; title?: string; files?: string[] }): MechanicalReleaseResult
