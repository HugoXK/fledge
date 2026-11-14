import type { RepoRow, Store } from '../db.js'
import {
  capabilitiesForRole,
  identityPrincipalId,
  resolveUserActor,
  userIdFromPrincipal,
  type ActorContext,
  type Capability,
  type Channel,
} from '../identity/authorization.js'

// #540/#541: the actor is built by the server from the request's session and
// the repository it names. Nothing a caller sends can set one of these fields: a
// browser form, an IM message or a model has no path into `managementActor`.
export type { ActorContext, Capability, Channel } from '../identity/authorization.js'

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

// #541: the owner's job capabilities are no longer a second list here. They come
// from the identity model (`ROLE_CAPABILITIES.maintainer`), so the acceptance-time
// set and the execution-time re-read read the same table.

export function capabilitiesForRepo(store: Store, principalId: string, projectId: string | null): Set<Capability> {
  const capabilities = new Set<Capability>()
  if (projectId === null || projectId === '') return capabilities
  const userId = userIdFromPrincipal(principalId)
  const repo = store.getRepo(projectId)
  // The execution-time recheck of #540 is still the legacy connection-owner
  // check in this slice: member grants become an enforcement source in a later
  // #541 slice, so a repository that changed hands stops the old owner here.
  if (userId === null || repo === undefined || repo.user_id !== userId) return capabilities
  return resolveUserActor(store, userId, { channel: 'system', projectId }).capabilities
}

export function managementActor(input: {
  userId: string
  repo: RepoRow
  channel?: Channel
  requestId?: string
  store?: Store
}): ActorContext {
  // The acceptance-time capability set. `ManagementService.complete` resolves it
  // again from the database, so this one is only a copy of what held at the time
  // the request arrived.
  if (input.store !== undefined) {
    return resolveUserActor(input.store, input.userId, {
      channel: input.channel ?? 'web',
      projectId: input.repo.id,
      requestId: input.requestId,
    })
  }
  const capabilities = new Set<Capability>()
  if (input.repo.user_id === input.userId) {
    // No store was injected (tests and the bootstrap path): derive the owner's
    // set from the same role table the database resolver reads, so the two
    // cannot drift.
    for (const capability of capabilitiesForRole('maintainer')) capabilities.add(capability)
  }
  return {
    principalId: input.userId,
    identityPrincipalId: identityPrincipalId(input.userId),
    tenantId: null,
    projectId: input.repo.id,
    channel: input.channel ?? 'web',
    capabilities,
    authorizationRevision: 0,
    requestId: input.requestId ?? '',
  }
}
