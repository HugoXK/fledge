import type { DeploymentRollbackRow, DeploymentRow } from '../db.js'
import type { ReleaseStatusSnapshot } from './releaseStatus.js'
import {
  assessDeploymentDrift,
  evaluateCanaryGate,
  sameCommit,
  type CanaryGateEvidence,
  type CanaryGateResult,
  type DeploymentHealth,
  type DeploymentReadiness,
  type DriftAssessment,
  type ReleaseSnapshot,
} from '../../scripts/lib/deployment-drift.mjs'

export { assessDeploymentDrift, evaluateCanaryGate, sameCommit }
export type { CanaryGateEvidence, CanaryGateResult, DeploymentHealth, DeploymentReadiness, DriftAssessment, ReleaseSnapshot }

const ENVIRONMENT = /^[a-z0-9][a-z0-9-]{0,31}$/
const VERSION = /^\d+\.\d+\.\d+$/
const COMMIT = /^[0-9a-f]{7,40}$/
const DIGEST = /^sha256:[0-9a-f]{64}$/
const OPERATOR = /^[A-Za-z0-9_.@-]{1,80}$/
const DECISION = /^[a-z][a-z-]{0,31}$/
const RELEASE_URL = /^https?:\/\/[^\s<>"']{1,480}$/
const HOST_PATH = /(?:^|\s)(?:\/Users\/|\/home\/|\/var\/|\/etc\/|\/root\/)/
const SECRET_ASSIGNMENT = /\b(token|secret|password|passwd|api[_-]?key|authorization)(\s*[=:]\s*)([^\s]+)/gi

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

export interface PromotionInput {
  environment: string
  version: string
  commit: string
  imageDigest: string
  deployedAt: string
  operator: string
  releaseUrl: string
  healthz: DeploymentHealth & { ok: boolean; status: number; version: string; commit: string }
  readyz: DeploymentReadiness & { ok: boolean; status: number }
  gate: CanaryGateEvidence
  gateResult: CanaryGateResult
}

export interface RollbackInput {
  environment: string
  fromDeploymentId: string | null
  previousDeploymentId: string
  previousDigest: string
  previousCommit: string
  owner: string
  command: string
  decision: string
  healthz: DeploymentHealth & { ok: boolean; status: number; commit: string }
  verified: boolean
}

export function latestReleaseFromStatus(snapshot: ReleaseStatusSnapshot | null): ReleaseSnapshot | null {
  // A snapshot for an open release pull request names a version but has no tag
  // target yet. That version is not a release, so it must not make production
  // look behind.
  if (snapshot === null || !VERSION.test(snapshot.version) || !COMMIT.test(snapshot.targetSha)) return null
  return {
    version: snapshot.version,
    commit: snapshot.targetSha,
    tag: `v${snapshot.version}`,
    url: snapshot.releaseUrl,
  }
}

export function deploymentFromRow(row: DeploymentRow): ReleaseSnapshot & { environment: string; operator: string; imageDigest: string; deployedAt: string } {
  return {
    environment: row.environment,
    version: row.version,
    commit: row.commit_sha,
    tag: `v${row.version}`,
    url: row.release_url ?? '',
    operator: row.operator,
    imageDigest: row.image_digest,
    deployedAt: row.deployed_at,
  }
}

export function deploymentHealth(row: DeploymentRow): DeploymentHealth {
  return {
    ok: row.healthz_ok === 1,
    status: row.healthz_status,
    version: row.healthz_version ?? '',
    commit: row.healthz_commit ?? '',
  }
}

export function deploymentReadiness(row: DeploymentRow): DeploymentReadiness {
  return { ok: row.readyz_ok === 1, status: row.readyz_status }
}

export function redactCommand(value: string): string {
  return value.replace(SECRET_ASSIGNMENT, (_match, name: string, separator: string) => `${name}${separator}***`)
}

function text(body: Record<string, string>, key: string): string {
  return String(body[key] ?? '').trim()
}

function flag(body: Record<string, string>, key: string): boolean {
  const value = text(body, key).toLowerCase()
  return value === '1' || value === 'true' || value === 'on' || value === 'yes'
}

function integer(body: Record<string, string>, key: string, fallback: number): number {
  const value = text(body, key)
  if (value === '') return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : Number.NaN
}

// #395 review round 2: a present status field is evidence or it is nothing.
// Coercing an unparseable value to 200 recorded a probe nobody measured and let
// the canary gate pass on it; only an absent field may default to 200.
function httpStatus(body: Record<string, string>, key: string, label: string): ParseResult<number> {
  const value = text(body, key)
  if (value === '') return { ok: true, value: 200 }
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 100 || parsed > 599) {
    return { ok: false, error: `${label} status must be an HTTP status code` }
  }
  return { ok: true, value: parsed }
}

function validUrl(value: string): boolean {
  if (value === '') return true
  if (!RELEASE_URL.test(value) || value.includes('\n')) return false
  if (/\/\/[^/]*@/.test(value)) return false
  return !/[?&](token|secret|password|passwd|api[_-]?key|authorization)=/i.test(value)
}

function commandOf(value: string): ParseResult<string> {
  const trimmed = value.trim()
  if (trimmed === '') return { ok: false, error: 'rollback command is required' }
  if (trimmed.length > 500) return { ok: false, error: 'rollback command is longer than 500 characters' }
  if (Array.from(trimmed).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return { ok: false, error: 'rollback command contains a control character' }
  if (HOST_PATH.test(trimmed)) return { ok: false, error: 'rollback command must not contain a host path' }
  const redacted = redactCommand(trimmed)
  if (redacted === '') return { ok: false, error: 'rollback command is empty after redaction' }
  return { ok: true, value: redacted }
}

export function parsePromotionForm(body: Record<string, string>, fallbackOperator = ''): ParseResult<PromotionInput> {
  const environment = text(body, 'environment')
  if (!ENVIRONMENT.test(environment)) return { ok: false, error: 'environment must be a short lowercase slug' }
  const version = text(body, 'version')
  if (!VERSION.test(version)) return { ok: false, error: 'version must be X.Y.Z' }
  const commit = text(body, 'commit').toLowerCase()
  if (!COMMIT.test(commit)) return { ok: false, error: 'commit must be a 7-40 character sha' }
  const imageDigest = text(body, 'image_digest')
  if (!DIGEST.test(imageDigest)) return { ok: false, error: 'image digest must be sha256:<64 hex>' }
  const deployedAtText = text(body, 'deployed_at')
  const deployedAtMs = Date.parse(deployedAtText)
  if (deployedAtText === '' || !Number.isFinite(deployedAtMs)) return { ok: false, error: 'deployed_at must be an ISO timestamp' }
  const operator = text(body, 'operator') || fallbackOperator
  if (!OPERATOR.test(operator)) return { ok: false, error: 'operator must be a login-like name' }
  const releaseUrl = text(body, 'release_url')
  if (!validUrl(releaseUrl)) return { ok: false, error: 'release_url must be an http(s) URL' }

  const healthzStatus = httpStatus(body, 'healthz_status', 'healthz')
  if (!healthzStatus.ok) return healthzStatus
  const healthzVersion = text(body, 'healthz_version')
  if (healthzVersion !== '' && !VERSION.test(healthzVersion)) return { ok: false, error: 'healthz version must be X.Y.Z' }
  const healthzCommit = text(body, 'healthz_commit').toLowerCase()
  if (healthzCommit !== '' && !COMMIT.test(healthzCommit)) return { ok: false, error: 'healthz commit must be a sha' }
  const readyzStatus = httpStatus(body, 'readyz_status', 'readyz')
  if (!readyzStatus.ok) return readyzStatus

  const healthz = {
    ok: flag(body, 'healthz_ok'),
    status: healthzStatus.value,
    version: healthzVersion,
    commit: healthzCommit,
  }
  const readyz = { ok: flag(body, 'readyz_ok'), status: readyzStatus.value }
  const gate: CanaryGateEvidence = {
    healthz,
    readyz,
    smoke: { ok: flag(body, 'smoke_ok'), jobId: text(body, 'smoke_job') },
    errorWindow: {
      ok: flag(body, 'error_ok'),
      windowMinutes: integer(body, 'error_window_minutes', Number.NaN),
      errors: integer(body, 'error_count', Number.NaN),
      threshold: integer(body, 'error_threshold', Number.NaN),
    },
    latencyWindow: {
      ok: flag(body, 'latency_ok'),
      windowMinutes: integer(body, 'latency_window_minutes', Number.NaN),
      p95Ms: integer(body, 'latency_p95_ms', Number.NaN),
      thresholdMs: integer(body, 'latency_threshold_ms', Number.NaN),
    },
  }
  return {
    ok: true,
    value: {
      environment,
      version,
      commit,
      imageDigest,
      deployedAt: new Date(deployedAtMs).toISOString(),
      operator,
      releaseUrl,
      healthz,
      readyz,
      gate,
      gateResult: evaluateCanaryGate(gate, { commit, version }),
    },
  }
}

export function parseRollbackForm(body: Record<string, string>, deployments: DeploymentRow[], fallbackOwner = ''): ParseResult<RollbackInput> {
  const environment = text(body, 'environment')
  if (!ENVIRONMENT.test(environment)) return { ok: false, error: 'environment must be a short lowercase slug' }
  const previousDigest = text(body, 'previous_digest')
  if (!DIGEST.test(previousDigest)) return { ok: false, error: 'previous digest must be sha256:<64 hex>' }
  const previousCommit = text(body, 'previous_commit').toLowerCase()
  if (!COMMIT.test(previousCommit)) return { ok: false, error: 'previous commit must be a sha' }
  const previous = deployments.find((row) => row.environment === environment && row.image_digest === previousDigest && sameCommit(row.commit_sha, previousCommit))
  if (previous === undefined) return { ok: false, error: 'the previous digest and commit are not a recorded deployment in this environment' }

  const owner = text(body, 'owner') || fallbackOwner
  if (!OPERATOR.test(owner)) return { ok: false, error: 'owner must be a login-like name' }
  const command = commandOf(text(body, 'command'))
  if (!command.ok) return command
  const decision = text(body, 'decision') || 'rollback'
  if (!DECISION.test(decision)) return { ok: false, error: 'decision must be a short lowercase word' }

  const healthzStatus = httpStatus(body, 'healthz_status', 'healthz')
  if (!healthzStatus.ok) return healthzStatus
  const healthzCommit = text(body, 'healthz_commit').toLowerCase()
  if (healthzCommit !== '' && !COMMIT.test(healthzCommit)) return { ok: false, error: 'healthz commit must be a sha' }
  const healthzOk = flag(body, 'healthz_ok')
  const healthz = { ok: healthzOk, status: healthzStatus.value, commit: healthzCommit }
  const fromId = text(body, 'from_deployment_id')
  const from = deployments.find((row) => row.environment === environment && row.id === fromId)
  return {
    ok: true,
    value: {
      environment,
      fromDeploymentId: from?.id ?? null,
      previousDeploymentId: previous.id,
      previousDigest,
      previousCommit,
      owner,
      command: command.value,
      decision,
      healthz,
      verified: healthzOk && sameCommit(healthzCommit, previous.commit_sha),
    },
  }
}

export function deploymentDrift(row: DeploymentRow | null, release: ReleaseSnapshot | null, healthz?: DeploymentHealth): DriftAssessment {
  if (row === null) return assessDeploymentDrift({ deployment: null, release })
  return assessDeploymentDrift({
    deployment: {
      ...deploymentFromRow(row),
      healthz: deploymentHealth(row),
      readyz: deploymentReadiness(row),
    },
    release,
    healthz,
  })
}

export type { DeploymentRow }

// #395 review round 2: an environment is not only its newest deployment. A
// rollback recorded after that deployment says production runs the previous
// commit, and judging the deployment alone kept the drift view green at exactly
// the moment it exists for. The rollback wins only when it actually moves the
// environment: a rollback that names the same commit and digest as the newest
// deployment changed nothing, so the deployment stays the environment's state.
export interface EnvironmentCurrent {
  source: 'deployment' | 'rollback' | 'none'
  version: string | null
  commit: string
  digest: string
  recordedAt: string
  operator: string
  healthz: boolean | null
  readyz: boolean | null
}

export interface EnvironmentState {
  current: EnvironmentCurrent
  drift: DriftAssessment
}

const NO_ENVIRONMENT: EnvironmentCurrent = {
  source: 'none',
  version: null,
  commit: '',
  digest: '',
  recordedAt: '',
  operator: '',
  healthz: null,
  readyz: null,
}

function sameInstallation(commit: string, digest: string, row: DeploymentRow): boolean {
  return sameCommit(commit, row.commit_sha) && digest === row.image_digest
}

export function environmentState(latest: DeploymentRow | null, rollback: DeploymentRollbackRow | null, release: ReleaseSnapshot | null): EnvironmentState {
  // Equal timestamps count as a rollback: when the two records cannot be
  // ordered, the safe direction is to alert rather than to report ok.
  const rolledBack = rollback !== null && (latest === null || (rollback.created_at >= latest.created_at && !sameInstallation(rollback.previous_commit, rollback.previous_digest, latest)))
  if (!rolledBack) {
    const current: EnvironmentCurrent = latest === null
      ? NO_ENVIRONMENT
      : {
          source: 'deployment',
          version: latest.version,
          commit: latest.commit_sha,
          digest: latest.image_digest,
          recordedAt: latest.deployed_at,
          operator: latest.operator,
          healthz: latest.healthz_ok === 1,
          readyz: latest.readyz_ok === 1,
        }
    return { current, drift: deploymentDrift(latest, release) }
  }
  const record = rollback as DeploymentRollbackRow
  const current: EnvironmentCurrent = {
    source: 'rollback',
    version: null,
    commit: record.previous_commit,
    digest: record.previous_digest,
    recordedAt: record.created_at,
    operator: record.owner,
    healthz: record.healthz_ok === 1,
    readyz: null,
  }
  const snapshot = {
    environment: record.environment,
    version: null,
    commit: current.commit,
    imageDigest: current.digest,
    deployedAt: current.recordedAt,
    operator: current.operator,
    healthz: { ok: current.healthz === true, status: record.healthz_status, commit: record.healthz_commit },
    readyz: null,
  }
  if (!COMMIT.test(current.commit) || !DIGEST.test(current.digest)) {
    return {
      current,
      drift: {
        state: 'unknown',
        alert: true,
        summary: `a rollback recorded at ${current.recordedAt} names no readable commit or digest, so the current state cannot be judged`,
        deployment: snapshot,
        release,
      },
    }
  }
  if (release === null) {
    return {
      current,
      drift: {
        state: 'unknown',
        alert: true,
        summary: `production was rolled back to ${current.commit} and no release snapshot is recorded, so drift cannot be judged`,
        deployment: snapshot,
        release,
      },
    }
  }
  const superseded = latest === null ? 'no deployment is recorded' : `the newest deployment is v${latest.version} at ${latest.commit_sha}`
  return {
    current,
    drift: {
      state: 'mismatch',
      alert: true,
      summary: `production was rolled back to ${current.commit}, not v${String(release.version ?? '')} at ${String(release.commit ?? '')}; ${superseded}, and the rollback names no version`,
      deployment: snapshot,
      release,
    },
  }
}
