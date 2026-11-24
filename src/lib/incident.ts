import type { Config } from '../config.js'
import type { AlertView, AuditRow, DeploymentRow, JobEventRow, RepoInstanceRow, Store } from '../db.js'
import { releaseSurface } from './releaseSurface.js'
import { maskEmail, maskIp, redact } from './secrets.js'

// #1234: one read-only artifact for a support conversation. The route and the
// CLI share this builder, so the page an operator reads and the file they attach
// cannot disagree. Every string is redacted and bounded; the config contributes
// names only, never a value.
export const MAX_INCIDENT_HOURS = 24
export const INCIDENT_JOB_EVENTS = 200
export const INCIDENT_AUDIT_ROWS = 500
const META_MAX = 1_000
const DETAIL_MAX = 600
const MESSAGE_MAX = 500

export interface IncidentWindow {
  label: string
  hours: number
  since: string
}

export function parseIncidentWindow(value: string | undefined, now = new Date()): { ok: true; window: IncidentWindow } | { ok: false; error: string } {
  const raw = (value ?? '1h').trim().toLowerCase()
  const match = /^([1-9]|1[0-9]|2[0-4])h$/.exec(raw)
  if (match === null) return { ok: false, error: `window must be 1h through ${String(MAX_INCIDENT_HOURS)}h` }
  const hours = Number(match[1])
  return {
    ok: true,
    window: {
      label: `${String(hours)}h`,
      hours,
      since: new Date(now.getTime() - hours * 3_600_000).toISOString(),
    },
  }
}

/** The top-level and one-level keys of the config, names only. */
export function configFingerprint(config: Config): { sections: string[]; keys: string[] } {
  const sections = Object.keys(config).sort()
  const keys: string[] = []
  for (const section of sections) {
    const value = (config as unknown as Record<string, unknown>)[section]
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of Object.keys(value).sort()) keys.push(`${section}.${key}`)
    } else {
      keys.push(section)
    }
  }
  return { sections, keys: keys.sort() }
}

export interface IncidentAlert {
  kind: string
  level: string
  repoLabel: string | null
  jobId: string | null
  minutes: number | null
  message: string
}

export interface IncidentJobEvent {
  at: string
  jobId: string
  repoId: string | null
  kind: string
  role: string | null
  step: string | null
  meta: string | null
}

export interface IncidentAudit {
  at: string
  action: string
  detail: string | null
}

export interface IncidentDeployment {
  environment: string
  version: string
  commit: string
  imageDigest: string
  deployedAt: string
  operator: string
  healthzOk: boolean
  readyzOk: boolean
  releaseUrl: string | null
}

export interface IncidentBundle {
  generatedAt: string
  window: IncidentWindow
  release: ReturnType<typeof releaseSurface>
  build: { commit: string; builtAt: string }
  schemaVersion: number
  counts: { users: number; repos: number; jobs: number }
  readiness: {
    database: boolean
    instances: { ready: number; failed: number; total: number }
    clock: unknown | null
    router: unknown | null
  }
  /** Sources this export could not read; an absent one is named, not omitted. */
  unavailable: string[]
  instances: Array<{ repoId: string; status: string; lastHealthAt: string | null }>
  alerts: IncidentAlert[]
  jobEvents: IncidentJobEvent[]
  audit: IncidentAudit[]
  latestDeployment: IncidentDeployment | null
  configFingerprint: { sections: string[]; keys: string[] }
}

const HOST_PATH = /(?:\/Users\/|\/home\/|\/var\/|\/etc\/|\/root\/)[^\s"'<>]*/g
const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const IPV4_SHAPE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g

function sanitize(value: string): string {
  return redact(
    String(value)
      .replace(EMAIL_SHAPE, (email) => maskEmail(email))
      .replace(IPV4_SHAPE, (ip) => maskIp(ip)),
  ).replace(HOST_PATH, '[path]')
}

function clean(value: string, max: number): string {
  return sanitize(value).slice(0, max)
}

function bounded(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null
  return clean(value, max)
}

function alertOf(alert: AlertView): IncidentAlert {
  return {
    kind: clean(alert.kind, 80),
    level: alert.level,
    repoLabel: alert.repoLabel === undefined ? null : clean(alert.repoLabel, 200),
    jobId: alert.jobId === undefined ? null : clean(alert.jobId, 120),
    minutes: alert.minutes ?? null,
    message: clean(alert.message, MESSAGE_MAX),
  }
}

function jobEventOf(row: JobEventRow): IncidentJobEvent {
  return {
    at: row.at,
    jobId: clean(row.job_id, 120),
    repoId: row.repo_id === null ? null : clean(row.repo_id, 120),
    kind: clean(row.kind, 80),
    role: bounded(row.role, 80),
    step: bounded(row.step, 120),
    meta: bounded(row.meta, META_MAX),
  }
}

function auditOf(row: AuditRow): IncidentAudit {
  return {
    at: row.at,
    action: clean(row.action, 120),
    detail: bounded(row.detail, DETAIL_MAX),
  }
}

function deploymentOf(row: DeploymentRow): IncidentDeployment {
  return {
    environment: row.environment,
    version: row.version,
    commit: row.commit_sha,
    imageDigest: row.image_digest,
    deployedAt: row.deployed_at,
    operator: clean(row.operator, 80),
    healthzOk: row.healthz_ok === 1,
    readyzOk: row.readyz_ok === 1,
    releaseUrl: bounded(row.release_url, 500),
  }
}

function instanceOf(row: RepoInstanceRow): { repoId: string; status: string; lastHealthAt: string | null } {
  return {
    repoId: clean(row.repo_id, 120),
    status: clean(row.status, 40),
    lastHealthAt: row.last_health_at,
  }
}

export function buildIncidentBundle(input: {
  store: Store
  config: Config
  window: IncidentWindow
  now?: string
  /** The `/readyz` clock/router readings; `undefined` is named as unavailable. */
  clock?: unknown
  router?: unknown
}): IncidentBundle {
  const { store, config, window } = input
  const generatedAt = input.now ?? new Date().toISOString()
  const instances = store.listRepoInstances()
  let database = true
  try {
    store.db.prepare('SELECT 1').get()
  } catch {
    database = false
  }
  const latest = store.listDeployments(null, 1)[0]
  const unavailable: string[] = []
  if (input.clock === undefined) unavailable.push('clock: not read by this export')
  if (input.router === undefined) unavailable.push('router: not read by this export')
  if (latest === undefined) unavailable.push('deployments: no deployment record')
  const alerts = store.alerts({
    now: generatedAt,
    usdCny: config.quota.usdCny,
    automationIdleMinutes: config.ops.automationIdleAlertMinutes,
    instancesManaged: config.flybot.instanceImage !== '',
  })
  return {
    generatedAt,
    window,
    release: releaseSurface(),
    build: { commit: config.build.commit, builtAt: config.build.builtAt },
    schemaVersion: store.schemaVersion(),
    counts: store.incidentCounts(),
    readiness: {
      database,
      instances: {
        ready: instances.filter((entry) => entry.status === 'ready').length,
        failed: instances.filter((entry) => entry.status === 'failed').length,
        total: instances.length,
      },
      clock: input.clock ?? null,
      router: input.router ?? null,
    },
    unavailable,
    instances: instances.map(instanceOf),
    alerts: alerts.map(alertOf),
    jobEvents: store.recentJobEventsSince(window.since, INCIDENT_JOB_EVENTS).map(jobEventOf),
    audit: store.listAuditSince(window.since, INCIDENT_AUDIT_ROWS).map(auditOf),
    latestDeployment: latest === undefined ? null : deploymentOf(latest),
    configFingerprint: configFingerprint(config),
  }
}

export function incidentMarkdown(bundle: IncidentBundle): string {
  const lines: string[] = [
    `# Fledge incident bundle — ${bundle.window.label} — ${bundle.generatedAt}`,
    '',
    `- window: ${bundle.window.label} since ${bundle.window.since}`,
    `- release: ${bundle.release.version ?? 'unknown'} (changelog ${bundle.release.changelogVersion ?? 'unknown'})`,
    `- build: ${bundle.build.commit || 'unknown'} at ${bundle.build.builtAt || 'unknown'}`,
    `- schema: ${String(bundle.schemaVersion)}`,
    `- counts: ${String(bundle.counts.users)} users, ${String(bundle.counts.repos)} repos, ${String(bundle.counts.jobs)} jobs`,
    `- database: ${bundle.readiness.database ? 'ok' : 'unavailable'}`,
    `- instances: ${String(bundle.readiness.instances.ready)} ready, ${String(bundle.readiness.instances.failed)} failed, ${String(bundle.readiness.instances.total)} total`,
    '',
    '## Unavailable',
    ...(bundle.unavailable.length === 0 ? ['- none'] : bundle.unavailable.map((entry) => `- ${entry}`)),
    '',
    '## Alerts',
    ...(bundle.alerts.length === 0
      ? ['- none']
      : bundle.alerts.map((alert) => `- ${alert.level} ${alert.kind}${alert.repoLabel === null ? '' : ` (${alert.repoLabel})`}: ${alert.message}`)),
    '',
    '## Job events',
    ...(bundle.jobEvents.length === 0
      ? ['- none']
      : bundle.jobEvents.map((event) => `- ${event.at} ${event.jobId} ${event.kind}${event.role === null ? '' : `/${event.role}`}${event.step === null ? '' : `/${event.step}`}${event.meta === null ? '' : `: ${event.meta}`}`)),
    '',
    '## Audit',
    ...(bundle.audit.length === 0
      ? ['- none']
      : bundle.audit.map((row) => `- ${row.at} ${row.action}${row.detail === null ? '' : `: ${row.detail}`}`)),
    '',
    '## Latest deployment',
    ...(bundle.latestDeployment === null
      ? ['- none']
      : [
          `- ${bundle.latestDeployment.environment} ${bundle.latestDeployment.version} @ ${bundle.latestDeployment.commit}`,
          `- deployed at ${bundle.latestDeployment.deployedAt} by ${bundle.latestDeployment.operator}`,
          `- healthz ${bundle.latestDeployment.healthzOk ? 'ok' : 'failed'}, readyz ${bundle.latestDeployment.readyzOk ? 'ok' : 'failed'}`,
        ]),
    '',
    '## Config fingerprint (names only)',
    ...bundle.configFingerprint.sections.map((section) => `- ${section}`),
    '',
  ]
  return `${lines.join('\n')}\n`
}
