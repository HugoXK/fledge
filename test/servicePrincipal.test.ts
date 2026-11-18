import test from 'node:test'
import assert from 'node:assert/strict'
import { Store, type JobRow } from '../src/db.js'
import { authorize, legacyTenantId, resolveUserActor } from '../src/identity/authorization.js'
import { resolveServiceActor, resolveServiceActorForJob, ServiceActorRefused } from '../src/identity/serviceActor.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { makeUser, testConfig } from './helpers.js'

// #749 slice 1: the execution identity. Unattended work — a schedule, a release,
// a future evolution job — runs as a `principals` row with `kind='service'`, a
// project binding and an explicit `scoped_grants` row, never as the human who
// created it. This suite pins the resolver only: no creation, rotation or
// disable flow, no schedule or release binding, no console surface.
//
// The refusals are the point of the slice. A service principal that resolves when
// it should not is worse than one that fails to resolve: the first runs a job
// with authority nobody granted, the second stops a run and is visible.

interface Harness {
  store: Store
  owner: ReturnType<typeof makeUser>
  repo: ReturnType<Store['createRepo']>
  otherRepo: ReturnType<Store['createRepo']>
  tenantId: string
}

const SERVICE = 'principal:service:nightly-maintenance'

function harness(): Harness {
  const config = testConfig()
  const store = new Store(':memory:')
  const owner = makeUser(store, { login: 'AcmeOwner', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_service_principal',
    userId: owner.id,
    owner: 'Acme',
    name: 'widgets',
    defaultBranch: 'main',
    tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey),
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  const otherRepo = store.createRepo({
    id: 'repo_service_other',
    userId: owner.id,
    owner: 'Acme',
    name: 'gadgets',
    defaultBranch: 'main',
    tokenEnc: encryptSecret('gh-token-2', config.tokenEncryptionKey),
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  store.migrateIdentity()
  return { store, owner, repo, otherRepo, tenantId: legacyTenantId('Acme') }
}

/**
 * A service principal and one grant, written straight to the rows: the creation
 * flow is the follow-up slice, and this suite must be able to build every shape
 * of grant (revoked, expired, another project) without borrowing that flow.
 */
function seedServicePrincipal(
  h: Harness,
  options: {
    id?: string
    kind?: string
    disabled?: boolean
    capabilities?: string[]
    projectId?: string | null
    revision?: number
    revoked?: boolean
    expiresAt?: string | null
  } = {},
): string {
  const id = options.id ?? SERVICE
  const at = new Date().toISOString()
  h.store.run(
    'INSERT INTO principals (id, kind, user_id, tenant_id, authorization_revision, disabled_at, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)',
    id,
    options.kind ?? 'service',
    h.tenantId,
    options.revision ?? 0,
    options.disabled === true ? at : null,
    at,
  )
  h.store.run(
    `INSERT INTO scoped_grants
       (id, principal_id, tenant_id, project_id, source, capabilities_json, grantor_id, evidence_json, verified_at, expires_at, revoked_at, revision, created_at)
     VALUES (?, ?, ?, ?, 'explicit_delegation', ?, 'principal:user:test-grantor', NULL, ?, ?, ?, 1, ?)`,
    `grant:${id}:${options.projectId ?? 'tenant'}`,
    id,
    h.tenantId,
    options.projectId === undefined ? h.repo.id : options.projectId,
    JSON.stringify(options.capabilities ?? ['tasks.read', 'tasks.write', 'job.create']),
    at,
    options.expiresAt ?? null,
    options.revoked === true ? at : null,
    at,
  )
  return id
}

function refusal(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof ServiceActorRefused, `expected a ServiceActorRefused, got ${String(error)}`)
    return error.code
  }
  assert.fail('the call resolved where it should have been refused')
}

test('a service principal resolves to a project-bounded actor with exactly its grant', () => {
  const h = harness()
  try {
    const id = seedServicePrincipal(h, { capabilities: ['tasks.read', 'job.create'], revision: 7 })
    const actor = resolveServiceActor(h.store, id, { projectId: h.repo.id, capability: 'job.create' })

    assert.equal(actor.principalId, id)
    assert.equal(actor.identityPrincipalId, id)
    assert.equal(actor.projectId, h.repo.id)
    assert.equal(actor.tenantId, h.tenantId)
    assert.equal(actor.channel, 'system')
    assert.equal(actor.authorizationRevision, 7)
    assert.equal(actor.platformRole, undefined, 'a service principal must never carry a platform role')
    assert.deepEqual([...(actor.capabilities ?? [])].sort(), ['job.create', 'tasks.read'])
    assert.equal(actor.capabilities.has('release.manage'), false, 'a capability outside the grant leaked in')
    assert.equal(authorize(actor, 'job.create'), true)
    assert.equal(authorize(actor, 'release.manage'), false)
  } finally {
    h.store.close()
  }
})

test('an unknown principal, a human principal and a disabled principal are refused', () => {
  const h = harness()
  try {
    assert.equal(refusal(() => resolveServiceActor(h.store, 'principal:service:missing', { projectId: h.repo.id })), 'unknown_principal')

    const human = seedServicePrincipal(h, { id: 'principal:service:human-shaped', kind: 'human' })
    assert.equal(refusal(() => resolveServiceActor(h.store, human, { projectId: h.repo.id })), 'not_a_service_principal')

    const disabled = seedServicePrincipal(h, { id: 'principal:service:disabled', disabled: true })
    assert.equal(refusal(() => resolveServiceActor(h.store, disabled, { projectId: h.repo.id })), 'principal_disabled')

    const userActor = resolveUserActor(h.store, h.owner.id, { projectId: h.repo.id, channel: 'web' })
    assert.equal(refusal(() => resolveServiceActor(h.store, userActor.identityPrincipalId ?? '', { projectId: h.repo.id })), 'not_a_service_principal')
  } finally {
    h.store.close()
  }
})

test('a grant that does not cover the project, or the capability, is refused', () => {
  const h = harness()
  try {
    const id = seedServicePrincipal(h, { capabilities: ['tasks.read'], projectId: h.otherRepo.id })
    assert.equal(
      refusal(() => resolveServiceActor(h.store, id, { projectId: h.repo.id })),
      'project_not_granted',
      'a grant for another repository resolved for this one',
    )
    assert.equal(
      refusal(() => resolveServiceActor(h.store, id, { projectId: h.otherRepo.id, capability: 'tasks.write' })),
      'capability_not_granted',
      'a write capability resolved from a read-only grant',
    )
    const actor = resolveServiceActor(h.store, id, { projectId: h.otherRepo.id, capability: 'tasks.read' })
    assert.equal(authorize(actor, 'tasks.read', { projectId: h.repo.id }), false, "another project's task is reachable")
  } finally {
    h.store.close()
  }
})

test('a revoked or expired grant leaves no authority at all', () => {
  const h = harness()
  try {
    const revoked = seedServicePrincipal(h, { id: 'principal:service:revoked', revoked: true })
    assert.equal(refusal(() => resolveServiceActor(h.store, revoked, { projectId: h.repo.id })), 'no_active_grant')

    const expired = seedServicePrincipal(h, { id: 'principal:service:expired', expiresAt: new Date(Date.now() - 60_000).toISOString() })
    assert.equal(refusal(() => resolveServiceActor(h.store, expired, { projectId: h.repo.id })), 'no_active_grant')
  } finally {
    h.store.close()
  }
})

test('a human does not inherit a service principal grant', () => {
  const h = harness()
  try {
    const viewer = makeUser(h.store, { login: 'AcmeViewer', status: 'approved' })
    h.store.run(
      'INSERT INTO repo_members (repo_id, user_id, role, granted_by, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)',
      h.repo.id,
      viewer.id,
      'viewer',
      'system:test',
      new Date().toISOString(),
    )
    // The service principal holds a maintainer-only capability on the same
    // project; the human stays a viewer.
    const id = seedServicePrincipal(h, { capabilities: ['tasks.read', 'release.manage'] })
    resolveServiceActor(h.store, id, { projectId: h.repo.id, capability: 'release.manage' })

    const human = resolveUserActor(h.store, viewer.id, { projectId: h.repo.id, channel: 'web' })
    assert.equal(authorize(human, 'release.manage'), false, 'the human borrowed the service principal authority')
    assert.equal(authorize(human, 'tasks.read'), true)
  } finally {
    h.store.close()
  }
})

test('a job records the service principal and its revision, and a stale revision is refused', () => {
  const h = harness()
  try {
    const id = seedServicePrincipal(h, { capabilities: ['tasks.read', 'job.create'], revision: 4 })
    const job: JobRow = h.store.createJob({
      id: 'job_service_principal',
      repoId: h.repo.id,
      userId: h.owner.id,
      trigger: 'schedule',
      goal: 'nightly maintenance',
      callbackHash: 'cb_service_principal',
      platformTokenHash: '',
      principalId: id,
    })

    assert.equal(job.principal_id, id, 'the job does not name the principal it runs under')
    assert.equal(job.principal_revision, 4, 'the job does not record the revision it resolved at')

    const actor = resolveServiceActorForJob(h.store, job, { capability: 'job.create' })
    assert.equal(actor.principalId, id)
    assert.equal(actor.authorizationRevision, 4)

    h.store.run('UPDATE principals SET authorization_revision = authorization_revision + 1 WHERE id = ?', id)
    assert.equal(
      refusal(() => resolveServiceActorForJob(h.store, job, { capability: 'job.create' })),
      'stale_revision',
      'a job resolved under a revision the principal has moved past',
    )

    const fresh = h.store.getJob(job.id)!
    assert.equal(fresh.principal_id, id, 'the recorded principal changed with the revision')
  } finally {
    h.store.close()
  }
})

test('a job with no principal is a human job, not an unknown principal', () => {
  const h = harness()
  try {
    const job = h.store.createJob({
      id: 'job_human_owner',
      repoId: h.repo.id,
      userId: h.owner.id,
      trigger: 'manual',
      goal: 'g',
      callbackHash: 'cb_human_owner',
      platformTokenHash: '',
    })
    assert.equal(job.principal_id, null)
    assert.equal(job.principal_revision, null)
    assert.equal(refusal(() => resolveServiceActorForJob(h.store, job)), 'not_a_service_principal')
  } finally {
    h.store.close()
  }
})
