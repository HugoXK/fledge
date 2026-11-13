import type { RepoRow, Store } from '../db.js'

// #540: the actor is built by the server from the request's session and the
// repository it names. Nothing a caller sends can set one of these fields: a
// browser form, an IM message or a model has no path into `managementActor`.
export type Channel = 'web' | 'api' | 'chat' | 'system'

// The closed capability set of this slice. #541 adds the real grant model; until
// then the repository owner holds the one capability this catalog checks.
export type Capability = 'job.cancel'

export interface ActorContext {
  principalId: string
  tenantId: string | null
  projectId: string | null
  channel: Channel
  capabilities: Set<Capability>
  /** A tenant-wide counter, not a per-repository revision. 0 until #541. */
  authorizationRevision: number
  requestId: string
}

// Argument names that would let a caller claim an identity or reach past the
// catalog. A command rejects them instead of ignoring them, so a future surface
// cannot quietly start trusting a payload field.
export const FORBIDDEN_ARGUMENT_KEYS = new Set([
  'actor',
  'principal',
  'principal_id',
  'principalId',
  'user_id',
  'userId',
  'tenant_id',
  'tenantId',
  'capabilities',
  'capability',
  'permissions',
  'role',
  'roles',
  'channel',
  'authorization_revision',
  'authorizationRevision',
  'sql',
  'shell',
  'url',
  'path',
])

export function capabilitiesForRepo(store: Store, principalId: string, projectId: string | null): Set<Capability> {
  const capabilities = new Set<Capability>()
  if (projectId === null || projectId === '') return capabilities
  const repo = store.getRepo(projectId)
  if (repo !== undefined && repo.user_id === principalId) capabilities.add('job.cancel')
  return capabilities
}

export function managementActor(input: {
  userId: string
  repo: RepoRow
  channel?: Channel
  requestId?: string
}): ActorContext {
  // The acceptance-time capability set. `ManagementService.complete` resolves it
  // again from the database, so this one is only a copy of what held at the time
  // the request arrived.
  const capabilities = new Set<Capability>()
  if (input.repo.user_id === input.userId) capabilities.add('job.cancel')
  return {
    principalId: input.userId,
    tenantId: null,
    projectId: input.repo.id,
    channel: input.channel ?? 'web',
    capabilities,
    authorizationRevision: 0,
    requestId: input.requestId ?? '',
  }
}
