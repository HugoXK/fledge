import { nowIso } from '../lib/time.js'
import type { PrincipalRow, ProjectRow, RepoMemberRow, RepoRow, ScopedGrantRow, Store } from '../db.js'

// #541: capability resolution is the read-only half of the identity model. The
// rows are backfilled from the repository owner; enforcement stays outside this
// slice, so the existing owner checks keep running until later PRs switch them.
export type Channel = 'web' | 'api' | 'chat' | 'system'

export type Capability =
  | 'tasks.read'
  | 'tasks.write'
  | 'config.write'
  | 'release.manage'
  | 'knowledge.read'
  | 'knowledge.write'
  | 'schedules.manage'
  | 'grants.manage'
  | 'job.cancel'
  | 'job.pause'
  | 'job.create'
  | 'job.resume'
  | 'job.retry'

export const ALL_CAPABILITIES: readonly Capability[] = [
  'tasks.read',
  'tasks.write',
  'config.write',
  'release.manage',
  'knowledge.read',
  'knowledge.write',
  'schedules.manage',
  'grants.manage',
  'job.cancel',
  'job.pause',
  'job.create',
  'job.resume',
  'job.retry',
]

export const REPO_ROLES = ['maintainer', 'developer', 'viewer'] as const
export type RepoRole = (typeof REPO_ROLES)[number]

const ROLE_CAPABILITIES: Readonly<Record<RepoRole, readonly Capability[]>> = {
  maintainer: ['tasks.read', 'tasks.write', 'config.write', 'release.manage', 'knowledge.read', 'knowledge.write', 'schedules.manage', 'job.cancel', 'job.pause', 'job.create', 'job.resume', 'job.retry'],
  // #624 added `job.create`, `job.resume` and `job.retry` as commands the
  // connection owner holds. `deriveRepoRole` maps a write-permission connection to
  // `developer`, so that role must carry them or an owner with a write token loses
  // commands it had before #541 (only the connection owner could act then).
  developer: ['tasks.read', 'tasks.write', 'knowledge.read', 'knowledge.write', 'job.cancel', 'job.pause', 'job.create', 'job.resume', 'job.retry'],
  viewer: ['tasks.read', 'knowledge.read'],
}

export interface ActorContext {
  principalId: string
  /** The `principals` row. `principalId` stays the user id for receipt compatibility in this slice. */
  identityPrincipalId?: string
  tenantId: string | null
  projectId: string | null
  channel: Channel
  capabilities: Set<Capability>
  authorizationRevision: number
  requestId: string
  /** The platform role the actor resolved from; `superadmin` is the only wildcard. */
  platformRole?: string
  /** Capabilities per project when the actor was resolved without one project. */
  projectCapabilities?: Map<string, Set<Capability>>
}

export type EffectiveScopeSource = 'repo_member' | 'explicit_delegation' | 'github_derived' | 'legacy_owner' | 'platform'

export interface EffectiveScope {
  principalId: string
  tenantId: string | null
  projectId: string | null
  role: RepoRole | null
  source: EffectiveScopeSource
  capabilities: Capability[]
}

export function isCapability(value: string): value is Capability {
  return (ALL_CAPABILITIES as readonly string[]).includes(value)
}

export function isRepoRole(value: string | null | undefined): value is RepoRole {
  return value === 'maintainer' || value === 'developer' || value === 'viewer'
}

export function capabilitiesForRole(role: RepoRole): readonly Capability[] {
  return ROLE_CAPABILITIES[role]
}

export function platformCapabilitiesForRole(role: string | null | undefined): readonly Capability[] {
  if (role === 'superadmin') return ALL_CAPABILITIES
  if (role === 'admin') return ['grants.manage']
  return []
}

// Names are display-only. Numeric GitHub owner ids are not stored yet: the
// legacy tenant id uses the login and therefore needs a later rekey if the owner
// renames. The id is still stable for every repository that exists today.
export function legacyTenantId(owner: string): string {
  return `github.com:legacy:${owner.toLowerCase()}`
}

export function identityPrincipalId(userId: string): string {
  return `principal:user:${userId}`
}

export function userIdFromPrincipal(principalIdOrUserId: string): string | null {
  if (principalIdOrUserId.startsWith('principal:user:')) return principalIdOrUserId.slice('principal:user:'.length)
  if (principalIdOrUserId.startsWith('principal:')) return null
  return principalIdOrUserId
}

export function deriveRepoRole(repo: Pick<RepoRow, 'repo_role' | 'permission'>): RepoRole {
  if (isRepoRole(repo.repo_role)) return repo.repo_role
  if (repo.permission === 'admin' || repo.permission === 'maintain') return 'maintainer'
  if (repo.permission === 'none') return 'viewer'
  return 'developer'
}

function capabilitiesFromGrant(row: ScopedGrantRow): Capability[] {
  try {
    const parsed: unknown = JSON.parse(row.capabilities_json)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is Capability => typeof entry === 'string' && isCapability(entry))
  } catch {
    // A grant row is written by the server, never a caller. Corrupt JSON is
    // treated as no capability rather than widening access.
    return []
  }
}

function grantIsActive(row: ScopedGrantRow, at: string): boolean {
  return row.revoked_at === null && (row.expires_at === null || row.expires_at > at)
}

function projectIdsForUser(store: Store, userId: string, principalId: string, at: string): string[] {
  const ids = new Set<string>()
  for (const row of store.all<RepoMemberRow>('SELECT * FROM repo_members WHERE user_id = ? AND revoked_at IS NULL', userId)) ids.add(row.repo_id)
  for (const row of store.all<ScopedGrantRow>('SELECT * FROM scoped_grants WHERE principal_id = ?', principalId)) {
    if (row.project_id !== null && grantIsActive(row, at)) ids.add(row.project_id)
  }
  for (const row of store.all<RepoRow>('SELECT * FROM repos WHERE user_id = ?', userId)) ids.add(row.id)
  return [...ids].sort()
}

function capabilitiesForProject(
  store: Store,
  userId: string,
  principalId: string,
  projectId: string,
  platformRole: string,
  at: string,
): { tenantId: string | null; role: RepoRole | null; capabilities: Set<Capability> } {
  const repo = store.getRepo(projectId)
  const project = store.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', projectId)
  const tenantId = project?.tenant_id ?? (repo === undefined ? null : legacyTenantId(repo.owner))
  const capabilities = new Set<Capability>()

  const member = store.get<RepoMemberRow>('SELECT * FROM repo_members WHERE repo_id = ? AND user_id = ? AND revoked_at IS NULL', projectId, userId)
  let role = member !== undefined && isRepoRole(member.role) ? member.role : null
  if (role !== null) for (const capability of capabilitiesForRole(role)) capabilities.add(capability)

  const grants = store.all<ScopedGrantRow>(
    `SELECT * FROM scoped_grants
     WHERE principal_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
       AND (project_id = ? OR (project_id IS NULL AND tenant_id = ?))`,
    principalId,
    at,
    projectId,
    tenantId,
  )
  for (const grant of grants) for (const capability of capabilitiesFromGrant(grant)) capabilities.add(capability)

  // The connection owner keeps access even before the backfill reaches a row,
  // and a change of hands is still visible here rather than only in repos.
  if (repo !== undefined && repo.user_id === userId) {
    const legacyRole = deriveRepoRole(repo)
    if (role === null) role = legacyRole
    for (const capability of capabilitiesForRole(legacyRole)) capabilities.add(capability)
  }

  if (platformRole === 'superadmin') for (const capability of ALL_CAPABILITIES) capabilities.add(capability)

  return { tenantId, role, capabilities }
}

export function resolveUserActor(
  store: Store,
  userId: string,
  options: { channel?: Channel; projectId?: string; requestId?: string } = {},
): ActorContext {
  const user = store.userById(userId)
  const principal = store.get<PrincipalRow>('SELECT * FROM principals WHERE user_id = ?', userId)
  const principalId = identityPrincipalId(userId)
  const platformRole = user?.role ?? 'user'
  const at = nowIso()
  const projectIds = options.projectId === undefined ? projectIdsForUser(store, userId, principalId, at) : [options.projectId]
  const projectCapabilities = new Map<string, Set<Capability>>()
  let tenantId: string | null = null

  for (const projectId of projectIds) {
    const resolved = capabilitiesForProject(store, userId, principalId, projectId, platformRole, at)
    projectCapabilities.set(projectId, resolved.capabilities)
    if (options.projectId === projectId) tenantId = resolved.tenantId
  }

  const capabilities = new Set<Capability>(platformCapabilitiesForRole(platformRole))
  if (options.projectId === undefined) {
    for (const scoped of projectCapabilities.values()) for (const capability of scoped) capabilities.add(capability)
  } else {
    for (const capability of projectCapabilities.get(options.projectId) ?? []) capabilities.add(capability)
  }

  return {
    principalId: userId,
    identityPrincipalId: principalId,
    tenantId,
    projectId: options.projectId ?? null,
    channel: options.channel ?? 'system',
    capabilities,
    authorizationRevision: principal?.authorization_revision ?? 0,
    requestId: options.requestId ?? '',
    platformRole,
    projectCapabilities,
  }
}

export function authorize(actor: ActorContext, capability: Capability, options: { projectId?: string } = {}): boolean {
  if (actor.platformRole === 'superadmin') return true
  const projectId = options.projectId ?? actor.projectId
  if (projectId === null) return actor.capabilities.has(capability)
  if (actor.projectCapabilities !== undefined) return actor.projectCapabilities.get(projectId)?.has(capability) ?? false
  if (actor.projectId !== null && actor.projectId !== projectId) return false
  return actor.capabilities.has(capability)
}

export function listEffectiveScopes(store: Store, principalIdOrUserId: string): EffectiveScope[] {
  const principalId = principalIdOrUserId.startsWith('principal:') ? principalIdOrUserId : identityPrincipalId(principalIdOrUserId)
  const userId = userIdFromPrincipal(principalId)
  const principal = store.get<PrincipalRow>('SELECT * FROM principals WHERE id = ?', principalId)
  const at = nowIso()
  const scopes: EffectiveScope[] = []
  const tenantForProject = (projectId: string | null): string | null => {
    if (projectId === null) return principal?.tenant_id ?? null
    const project = store.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', projectId)
    if (project !== undefined) return project.tenant_id
    const repo = store.getRepo(projectId)
    return repo === undefined ? null : legacyTenantId(repo.owner)
  }

  if (userId !== null) {
    for (const member of store.all<RepoMemberRow>('SELECT * FROM repo_members WHERE user_id = ? AND revoked_at IS NULL', userId)) {
      const role = isRepoRole(member.role) ? member.role : null
      scopes.push({
        principalId,
        tenantId: tenantForProject(member.repo_id),
        projectId: member.repo_id,
        role,
        source: 'repo_member',
        capabilities: role === null ? [] : [...capabilitiesForRole(role)],
      })
    }
    for (const repo of store.all<RepoRow>('SELECT * FROM repos WHERE user_id = ?', userId)) {
      const role = deriveRepoRole(repo)
      scopes.push({
        principalId,
        tenantId: tenantForProject(repo.id),
        projectId: repo.id,
        role,
        source: 'legacy_owner',
        capabilities: [...capabilitiesForRole(role)],
      })
    }
  }

  for (const grant of store.all<ScopedGrantRow>('SELECT * FROM scoped_grants WHERE principal_id = ?', principalId)) {
    if (!grantIsActive(grant, at)) continue
    scopes.push({
      principalId,
      tenantId: grant.tenant_id,
      projectId: grant.project_id,
      role: null,
      source: grant.source === 'github_derived' ? 'github_derived' : 'explicit_delegation',
      capabilities: capabilitiesFromGrant(grant),
    })
  }

  const platformCapabilities = platformCapabilitiesForRole(userId === null ? null : store.userById(userId)?.role)
  if (platformCapabilities.length > 0) {
    scopes.push({
      principalId,
      tenantId: principal?.tenant_id ?? null,
      projectId: null,
      role: null,
      source: 'platform',
      capabilities: [...platformCapabilities],
    })
  }

  return scopes
}
