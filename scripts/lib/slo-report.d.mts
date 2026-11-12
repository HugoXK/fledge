// Types for slo-report.mjs so the TypeScript suites can import it.

import type { SloInput } from '../../src/lib/slo.js'

export type SloField = keyof SloInput
export type SloQueryPair = readonly [SloField, string]

export declare function sloInputFromValues(
  values: readonly (number | null)[],
  pairs: readonly SloQueryPair[],
): SloInput

export interface ReportSloInput {
  env?: Record<string, string | undefined>
  pairs: readonly SloQueryPair[]
  fetchImpl: (url: string, init?: { headers?: Record<string, string>; signal?: unknown }) => Promise<{
    ok: boolean
    status: number
    json: () => Promise<unknown>
  }>
  target: number
  formatSloReport: (input: SloInput, target?: number) => string
  stdout: { write: (chunk: string) => void }
  stderr: { write: (chunk: string) => void }
  exit: (code: number) => void
}

export declare function reportSlo(input: ReportSloInput): Promise<void>
