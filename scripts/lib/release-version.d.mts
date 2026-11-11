export interface ParsedVersion {
  major: number
  minor: number
  patch: number
}

export interface ReleaseVersionInput {
  packageVersion: string
  lastTagCommittedAt?: string
  releaseAt?: string
}

export interface ReleaseVersionResult {
  version: string
  bump: 'minor' | 'patch' | ''
  known: boolean
}

export declare function parseVersion(value: string): ParsedVersion | null
export declare function compareVersions(left: string, right: string): number
export declare function weekKey(value: string): string
export declare function nextReleaseVersion(input: ReleaseVersionInput): ReleaseVersionResult
