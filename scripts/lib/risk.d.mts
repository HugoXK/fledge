// Types for the pure risk rules and the base choice, so the TypeScript suite can
// call them directly instead of only through the CLI.
export type Tier = 'T0' | 'T1' | 'T2' | 'T3'

export interface RiskRules {
  tiers?: Partial<Record<Tier, { paths?: string[]; diffPatterns?: string[] }>>
  limits?: Partial<Record<Tier, { files: number; lines: number }>>
  unknownPathTier?: Tier
  [key: string]: unknown
}

export interface TierResult {
  tier: Tier
  basis: string
  files: string[]
}

export interface BaseChoice {
  ref: string
  fetch: string
}

export declare const RULES_FILE: string
export declare function loadRules(path?: string): RiskRules
export declare function matchesPath(path: string, pattern: string): boolean
export declare function tierForFiles(files: string[], rules?: RiskRules): TierResult
export declare function classify(files: string[], diffText?: string, rules?: RiskRules): TierResult
export declare function limitsFor(tier: Tier | string, rules?: RiskRules): { files: number; lines: number } | null
export declare function chooseBase(eventName: string, event?: Record<string, unknown>): BaseChoice
