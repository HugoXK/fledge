// Types for the check-freshness comparison (#1338), so the TypeScript suite can
// read the exported rule without running the sweep.
export interface GateChange {
  commit: string
  at: string
  path: string
}

export interface GateChangeError {
  error: string
}

export const GATE_PATHS: string[]

export function freshnessRefusal(input: {
  checkName?: string
  startedAt?: string | null
  base?: GateChange | GateChangeError | null
}): string | null

export function parseGateChange(log: string): GateChange | null

export function freshnessPayload(input: {
  headSha: string
  policy: { text: string }
  refusal: string
}): {
  name: string
  head_sha: string
  status: string
  conclusion: string
  output: { title: string; summary: string }
}
