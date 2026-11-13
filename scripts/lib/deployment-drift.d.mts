// Types for the pure deployment drift and canary-gate model, so the
// TypeScript app and suite can import the implementation `verify-release.mjs`
// also runs without turning on allowJs.

export interface DeploymentHealth {
  ok?: boolean | null
  status?: number | null
  version?: string | null
  commit?: string | null
}

export interface DeploymentReadiness {
  ok?: boolean | null
  status?: number | null
}

export interface DeploymentSnapshot {
  environment?: string | null
  version?: string | null
  commit?: string | null
  imageDigest?: string | null
  deployedAt?: string | null
  operator?: string | null
  healthz?: DeploymentHealth | null
  readyz?: DeploymentReadiness | null
  releaseUrl?: string | null
}

export interface ReleaseSnapshot {
  version?: string | null
  commit?: string | null
  tag?: string | null
  url?: string | null
}

export type DriftState = 'ok' | 'behind' | 'mismatch' | 'unknown'

export interface DriftAssessment {
  state: DriftState
  alert: boolean
  summary: string
  deployment: DeploymentSnapshot | null
  release: ReleaseSnapshot | null
}

export interface DriftInput {
  deployment?: DeploymentSnapshot | null
  release?: ReleaseSnapshot | null
  /** A live `/healthz` answer, when a caller has one. */
  healthz?: DeploymentHealth | null
}

export interface SmokeEvidence {
  ok?: boolean | null
  jobId?: string | null
}

export interface ErrorWindowEvidence {
  ok?: boolean | null
  windowMinutes?: number | null
  errors?: number | null
  // A window that claims ok without a finite threshold is missing evidence and
  // blocks the gate; the measured count alone is never a pass.
  threshold?: number | null
}

export interface LatencyWindowEvidence {
  ok?: boolean | null
  windowMinutes?: number | null
  p95Ms?: number | null
  // Required for the window to pass, for the same reason as `threshold`.
  thresholdMs?: number | null
}

export interface CanaryGateEvidence {
  healthz?: DeploymentHealth | null
  readyz?: DeploymentReadiness | null
  smoke?: SmokeEvidence | null
  errorWindow?: ErrorWindowEvidence | null
  latencyWindow?: LatencyWindowEvidence | null
}

export interface CanaryGateExpected {
  commit?: string | null
  version?: string | null
}

export interface GateCheck {
  id: string
  ok: boolean
  detail: string
}

export interface CanaryGateResult {
  ok: boolean
  checks: GateCheck[]
  blocked: string[]
}

export function parseVersion(value: unknown): [number, number, number] | null
export function sameCommit(left: unknown, right: unknown): boolean
export function assessDeploymentDrift(input?: DriftInput): DriftAssessment
export function evaluateCanaryGate(evidence?: CanaryGateEvidence, expected?: CanaryGateExpected): CanaryGateResult
