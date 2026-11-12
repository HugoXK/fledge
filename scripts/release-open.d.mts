// Types for the release-opener in scripts/release-open.mjs, so the TypeScript
// test suite can import it under `tsc --noEmit` without allowJs.

export interface ReleasePlanArtifact {
  mainSha: string
  plan: {
    shouldRelease: boolean
    nextVersion: string
    reason?: string
    total?: number
    features?: number
    fragments?: number
    lastTag?: string
  }
}

export interface ReleaseOpenAdapter {
  readFile(path: string): string
  listDir(path: string): string[]
  exec(file: string, args: string[], options: { cwd: string; env: Record<string, string | undefined> }): { code: number; stdout: string; stderr: string }
}

export interface ReleaseOpenOptions {
  artifact: ReleasePlanArtifact
  version: string
  sha: string
  repo?: string
  token?: string
  fetch?: typeof fetch
  adapter?: ReleaseOpenAdapter
}

export interface ReleaseOpenResult {
  status: 'opened' | 'reused' | 'refused'
  reason: string
  pr?: number
  url?: string
  branch?: string
  sha?: string
  mainSha?: string
  files?: string[]
  fetched?: string[]
  checks?: Array<{ script: string; code: number; output: string }>
  permissions?: Record<string, boolean>
  scopes?: string
}

export declare const SURFACE_PATHS: string[]

export declare function releaseBranch(version: string): string
export declare function exitCodeFor(result: { status?: string }): number
export declare function runReleaseOpen(options: ReleaseOpenOptions): Promise<ReleaseOpenResult>
