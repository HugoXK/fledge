// Types for the pure pull request body rules, so the TypeScript suite can call
// them directly instead of only through the CLI.
export interface ReviewPolicyNames {
  writers?: string[]
  authors?: string[]
  [key: string]: unknown
}

export interface AttributionList {
  name: 'authors' | 'writers'
  names: string[]
}

export declare function firstLine(body: unknown): string
export declare function hasRanSection(body: unknown): boolean
export declare function hasNotRunSection(body: unknown): boolean
export declare function ranHeading(body: unknown): string | null
export declare function notRunHeading(body: unknown): string | null
export declare function attributionList(policy: ReviewPolicyNames | undefined): AttributionList
export declare function checkAttribution(body: unknown, policy: ReviewPolicyNames | undefined): string | null
export declare function checkBody(body: unknown, policy: ReviewPolicyNames | undefined): string[]
