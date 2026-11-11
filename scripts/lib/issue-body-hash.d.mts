// Types for issue-body-hash.mjs so the TypeScript suites can import it.

export type BodyHashForm = 'raw' | 'trimmed'

export interface BodyHashes {
  raw: string
  trimmed: string
  differ: boolean
}

export interface BodyHashMatch {
  form: BodyHashForm
  hash: string
}

export declare function hashBody(body: string): string
export declare function rstripBody(body: string): string
export declare function bodyHashes(body: string): BodyHashes
export declare function matchBodyHash(body: string, hash: string): BodyHashMatch | null
export declare function trimmedSuffix(form: BodyHashForm): string
