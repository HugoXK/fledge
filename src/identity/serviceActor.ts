import { nowIso } from '../lib/time.js'
import type { JobRow, PrincipalRow, ProjectRow, ScopedGrantRow, Store } from '../db.js'
import { type ActorContext, type Capability, isCapability, legacyTenantId } from './authorization.js'

// #749 slice 1: the execution identity. Unattended work runs as a `principals`
// row with `kind='service'`, its project binding and an explicit `scoped_grants`
// row, so a nightly run no longer borrows the authority of the person who created
// it and survives that person being disabled.
//
// This module answers one question: given a principal id and a project, what may
// this run do? It builds the same `ActorContext` a human actor gets, from the
// grant only — no role derivation, no platform role, no wildcard. The refusals
// are deliberately total: an unknown, disabled, mis-granted or stale principal
// resolves nothing, because a service actor that resolves too widely runs work
// nobody authorised, while a refusal stops one run and is visible.
//
// Not in this slice: creating, rotating and disabling a principal, binding a
// schedule or release to one, revoking a running job's token on revocation, and
// the console surface. Those each write rows or audit entries, and none of them
// should ship behind the resolver they depend on.

export type ServiceActorRefusalCode =
  | 'unknown_principal'
  | 'not_a_service_principal'
  | 'principal_disabled'
  | 'no_active_grant'
  | 'project_not_granted'
  | 'capability_not_granted'
  | 'stale_revision'

const REFUSAL_MESSAGES: Readonly<Record<ServiceActorRefusalCode, string>> = {
  unknown_principal: 'no principal with that id',
  not_a_service_principal: 'the principal is not a service principal',
  principal_disabled: 'the principal is disabled',
  no_active_grant: 'the principal has no active grant',
  project_not_granted: 'no active grant covers this project',
  capability_not_granted: 'the grant does not carry this capability',
  stale_revision: 'the run resolved under a revision the principal has moved past',
}

/** A refused service actor. `code` is the machine-readable reason; the message names it. */
export class ServiceActorRefused extends Error {
  readonly code: ServiceActorRefusalCode

  constructor(code: ServiceActorRefusalCode, detail?: string) {
    super(detail === undefined ? REFUSAL_MESSAGES[code] : `${REFUSAL_MESSAGES[code]}: ${detail}`)
    this.name = 'ServiceActorRefused'
    this.code = code
  }
}

export interface ServiceActorOptions {
  projectId: string
  /** When given, the grant must carry it; the resolved actor still holds only the grant. */
  capability?: Capability
  requestId?: string
  /** The revision the caller believes the principal is at; a mismatch is a refusal. */
  expectedRevision?: number
}

function grantIsActive(row: ScopedGrantRow, at: string): boolean {
  return row.revoked_at === null && (row.expires_at === null || row.expires_at > at)
}

function grantCoversProject(row: ScopedGrantRow, projectId: string, tenantId: string | null): boolean {
  if (row.project_id !== null) return row.project_id === projectId
  // A tenant-wide grant covers a project only inside that tenant, never across
  // one: the grant row and the project must name the same tenant.
  return tenantId !== null && row.tenant_id === tenantId
}

function capabilitiesOf(row: ScopedGrantRow): Capability[] {
  try {
    const parsed: unknown = JSON.parse(row.capabilities_json)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is Capability => typeof entry === 'string' && isCapability(entry))
  } catch {
    // Grant rows are written by the server, never by a caller. Corrupt JSON is
    // no capability rather than a widened one.
    return []
  }
}

function tenantIdForProject(store: Store, projectId: string): string | null {
  const project = store.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', projectId)
  if (project !== undefined) return project.tenant_id
  const repo = store.getRepo(projectId)
  return repo === undefined ? null : legacyTenantId(repo.owner)
}

/**
 * Resolve a service principal into an `ActorContext`, bounded by one project.
 *
 * The actor holds the union of the active grants that cover `projectId` and
 * nothing else: `projectCapabilities` carries that project only, so
 * `authorize(actor, capability, { projectId: anotherProject })` answers false even
 * when the principal holds a tenant-wide grant for it.
 */
export function resolveServiceActor(store: Store, principalId: string, options: ServiceActorOptions): ActorContext {
  const principal = store.get<PrincipalRow>('SELECT * FROM principals WHERE id = ?', principalId)
  if (principal === undefined) throw new ServiceActorRefused('unknown_principal', principalId)
  if (principal.kind !== 'service') throw new ServiceActorRefused('not_a_service_principal', `${principalId} is kind=${principal.kind}`)
  if (principal.disabled_at !== null) throw new ServiceActorRefused('principal_disabled', principalId)
  if (options.expectedRevision !== undefined && options.expectedRevision !== principal.authorization_revision) {
    throw new ServiceActorRefused('stale_revision', `${principalId} expected ${options.expectedRevision}, at ${principal.authorization_revision}`)
  }

  const at = nowIso()
  const projectId = options.projectId
  const tenantId = tenantIdForProject(store, projectId)
  const grants = store.all<ScopedGrantRow>('SELECT * FROM scoped_grants WHERE principal_id = ?', principalId)
  const active = grants.filter((grant) => grantIsActive(grant, at))
  if (active.length === 0) throw new ServiceActorRefused('no_active_grant', principalId)

  const covering = active.filter((grant) => grantCoversProject(grant, projectId, tenantId))
  if (covering.length === 0) throw new ServiceActorRefused('project_not_granted', `${principalId} has no grant for ${projectId}`)

  const capabilities = new Set<Capability>()
  for (const grant of covering) for (const capability of capabilitiesOf(grant)) capabilities.add(capability)

  if (options.capability !== undefined && !capabilities.has(options.capability)) {
    throw new ServiceActorRefused('capability_not_granted', `${principalId} has no ${options.capability} on ${projectId}`)
  }

  return {
    principalId: principal.id,
    identityPrincipalId: principal.id,
    // A tenant-wide grant covers several projects, but the actor is resolved for
    // the one asked for, and the tenant comes from that project.
    tenantId,
    projectId,
    channel: 'system',
    capabilities,
    authorizationRevision: principal.authorization_revision,
    requestId: options.requestId ?? '',
    projectCapabilities: new Map([[projectId, capabilities]]),
  }
}

/**
 * Resolve the actor for a job that records a service principal.
 *
 * The job carries the revision it was created at, so a principal that has moved
 * on since (a rotation, a revocation, a new grant) refuses the run instead of
 * executing under authority nobody re-approved. A job with no `principal_id` is a
 * human-owned run and is refused here, so a caller cannot read "no principal" as
 * "some principal".
 */
export function resolveServiceActorForJob(
  store: Store,
  job: Pick<JobRow, 'id' | 'repo_id' | 'principal_id' | 'principal_revision'>,
  options: { capability?: Capability; requestId?: string } = {},
): ActorContext {
  if (job.principal_id === null) throw new ServiceActorRefused('not_a_service_principal', `job ${job.id} has no principal`)
  return resolveServiceActor(store, job.principal_id, {
    projectId: job.repo_id,
    capability: options.capability,
    requestId: options.requestId,
    expectedRevision: job.principal_revision ?? undefined,
  })
}
