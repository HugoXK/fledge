import test from 'node:test'
import assert from 'node:assert/strict'
import { Store, type PrincipalRow, type ProjectRow, type RepoMemberRow, type ScopedGrantRow, type TenantRow } from '../src/db.js'
import { authorize, legacyTenantId, resolveUserActor } from '../src/identity/authorization.js'
import { buildApp } from '../src/app.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #541, first slice: additive identity rows, an idempotent backfill, read-only
// capability resolution and the authenticated /api/auth/me summary. No route
// switches its owner check in this PR.

function harness(): { store: Store; owner: ReturnType<typeof makeUser>; repo: ReturnType<Store['createRepo']>; config: ReturnType<typeof testConfig> } {
  const config = testConfig()
  const store = new Store(':memory:')
  const owner = makeUser(store, { login: 'LegacyOwner', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_identity',
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
  return { store, owner, repo, config }
}

function identityCounts(store: Store): Record<string, number> {
  const count = (table: string): number => Number(store.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0)
  return {
    tenants: count('tenants'),
    projects: count('projects'),
    principals: count('principals'),
    repoMembers: count('repo_members'),
    grants: count('scoped_grants'),
    migrations: count('identity_migrations'),
  }
}

test('the backfill is idempotent and seeds the owner tenant, project, member and grant', () => {
  const h = harness()
  try {
    const first = h.store.migrateIdentity()
    const before = identityCounts(h.store)
    const second = h.store.migrateIdentity()
    assert.deepEqual(identityCounts(h.store), before, 'a second migration writes no duplicate row')
    assert.equal(first.version, 1)
    assert.equal(second.version, 1)

    const tenant = h.store.get<TenantRow>('SELECT * FROM tenants WHERE id = ?', legacyTenantId('Acme'))
    assert.equal(tenant?.id, 'github.com:legacy:acme')
    assert.equal(tenant?.provider, 'github')
    assert.equal(tenant?.host, 'github.com')
    assert.equal(tenant?.login, 'Acme')

    const project = h.store.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', h.repo.id)
    assert.equal(project?.repo_id, h.repo.id)
    assert.equal(project?.tenant_id, tenant?.id)

    const principal = h.store.get<PrincipalRow>('SELECT * FROM principals WHERE user_id = ?', h.owner.id)
    assert.ok(principal, 'every user has a principal')
    assert.equal(principal?.id, `principal:user:${h.owner.id}`)
    assert.equal(principal?.kind, 'human')

    const member = h.store.get<RepoMemberRow>('SELECT * FROM repo_members WHERE repo_id = ? AND user_id = ?', h.repo.id, h.owner.id)
    assert.equal(member?.role, 'maintainer')
    assert.equal(member?.revoked_at, null)

    const grant = h.store.get<ScopedGrantRow>('SELECT * FROM scoped_grants WHERE project_id = ? AND principal_id = ?', h.repo.id, principal?.id)
    assert.equal(grant?.source, 'explicit_delegation')
    const capabilities = JSON.parse(grant?.capabilities_json ?? '[]') as string[]
    assert.ok(capabilities.includes('tasks.write'))
    assert.ok(capabilities.includes('config.write'))
    assert.ok(capabilities.includes('release.manage'))

    const migration = h.store.get<{ version: number; report_json: string }>('SELECT * FROM identity_migrations WHERE version = 1')
    assert.equal(migration?.version, 1)
    const report = JSON.parse(migration?.report_json ?? '{}') as Record<string, number>
    assert.equal(report.projects, before.projects)
    assert.equal(report.grants, before.grants)
  } finally {
    h.store.close()
  }
})

test('the migration gives a user with no repository a principal', () => {
  const h = harness()
  try {
    const lonely = makeUser(h.store, { login: 'NoRepo', status: 'approved' })
    h.store.run('DELETE FROM principals WHERE user_id = ?', lonely.id)
    assert.equal(h.store.get<PrincipalRow>('SELECT * FROM principals WHERE user_id = ?', lonely.id), undefined)
    h.store.migrateIdentity()
    const principal = h.store.get<PrincipalRow>('SELECT * FROM principals WHERE user_id = ?', lonely.id)
    assert.equal(principal?.id, `principal:user:${lonely.id}`)
  } finally {
    h.store.close()
  }
})

test('the owner actor has task and config capabilities in its own project', () => {
  const h = harness()
  try {
    const actor = resolveUserActor(h.store, h.owner.id, { channel: 'web', projectId: h.repo.id })
    assert.equal(actor.principalId, h.owner.id, 'the receipt principal stays the user id in this slice')
    assert.equal(actor.identityPrincipalId, `principal:user:${h.owner.id}`)
    assert.equal(actor.tenantId, legacyTenantId('Acme'))
    assert.equal(actor.projectId, h.repo.id)
    assert.equal(actor.authorizationRevision, 0)
    assert.ok(actor.capabilities.has('tasks.write'))
    assert.ok(actor.capabilities.has('config.write'))
    assert.ok(actor.capabilities.has('job.cancel'), 'the #540 execution check keeps its owner capability')
    assert.equal(authorize(actor, 'tasks.write', { projectId: h.repo.id }), true)
    assert.equal(authorize(actor, 'config.write', { projectId: h.repo.id }), true)
  } finally {
    h.store.close()
  }
})

test('a viewer member can read tasks but cannot write or change config', () => {
  const h = harness()
  try {
    const viewer = makeUser(h.store, { login: 'Viewer', status: 'approved' })
    h.store.run(
      'INSERT INTO repo_members (repo_id, user_id, role, granted_by, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)',
      h.repo.id,
      viewer.id,
      'viewer',
      'test',
      new Date().toISOString(),
    )
    const actor = resolveUserActor(h.store, viewer.id, { channel: 'web', projectId: h.repo.id })
    assert.ok(actor.capabilities.has('tasks.read'))
    assert.ok(actor.capabilities.has('knowledge.read'))
    assert.equal(actor.capabilities.has('tasks.write'), false)
    assert.equal(actor.capabilities.has('config.write'), false)
    assert.equal(authorize(actor, 'tasks.read', { projectId: h.repo.id }), true)
    assert.equal(authorize(actor, 'tasks.write', { projectId: h.repo.id }), false)
    assert.equal(authorize(actor, 'config.write', { projectId: h.repo.id }), false)
  } finally {
    h.store.close()
  }
})

test('revoking a member removes the access on the next resolution', () => {
  const h = harness()
  try {
    const viewer = makeUser(h.store, { login: 'RevokedViewer', status: 'approved' })
    h.store.run(
      'INSERT INTO repo_members (repo_id, user_id, role, granted_by, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)',
      h.repo.id,
      viewer.id,
      'viewer',
      'test',
      new Date().toISOString(),
    )
    const before = resolveUserActor(h.store, viewer.id, { channel: 'web', projectId: h.repo.id })
    assert.ok(before.capabilities.has('tasks.read'))

    h.store.run('UPDATE repo_members SET revoked_at = ? WHERE repo_id = ? AND user_id = ?', new Date().toISOString(), h.repo.id, viewer.id)
    const after = resolveUserActor(h.store, viewer.id, { channel: 'web', projectId: h.repo.id })
    assert.equal(after.capabilities.has('tasks.read'), false)
    assert.equal(authorize(after, 'tasks.read', { projectId: h.repo.id }), false)
  } finally {
    h.store.close()
  }
})

test('an actor resolved for one project is denied on another project', () => {
  const h = harness()
  try {
    const viewer = makeUser(h.store, { login: 'CrossProject', status: 'approved' })
    h.store.run(
      'INSERT INTO repo_members (repo_id, user_id, role, granted_by, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)',
      h.repo.id,
      viewer.id,
      'viewer',
      'test',
      new Date().toISOString(),
    )
    const other = makeUser(h.store, { login: 'OtherOwner', status: 'approved' })
    const otherRepo = h.store.createRepo({
      id: 'repo_other',
      userId: other.id,
      owner: 'Other',
      name: 'project',
      defaultBranch: 'main',
      tokenEnc: encryptSecret('gh-token', h.config.tokenEncryptionKey),
      permission: 'admin',
      repoRole: 'maintainer',
      goal: '',
      autoIterate: false,
      intervalMinutes: 1440,
    })
    const actor = resolveUserActor(h.store, viewer.id, { channel: 'web', projectId: h.repo.id })
    assert.equal(authorize(actor, 'tasks.read', { projectId: h.repo.id }), true)
    assert.equal(authorize(actor, 'tasks.read', { projectId: otherRepo.id }), false)
    assert.equal(authorize(actor, 'tasks.write', { projectId: otherRepo.id }), false)

    const unscoped = resolveUserActor(h.store, viewer.id, { channel: 'api' })
    assert.equal(authorize(unscoped, 'tasks.read', { projectId: h.repo.id }), true)
    assert.equal(authorize(unscoped, 'tasks.read', { projectId: otherRepo.id }), false, 'a union of scopes is not a grant on every project')
  } finally {
    h.store.close()
  }
})

test('/api/auth/me requires an approved session and never returns a secret column', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: { name: 'capture', async run() { return { status: 'running' as const } } }, startScheduler: false })
  try {
    const owner = makeUser(store, { login: 'MeOwner', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_me',
      userId: owner.id,
      owner: 'Me',
      name: 'project',
      defaultBranch: 'main',
      tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey),
      permission: 'admin',
      repoRole: 'maintainer',
      goal: '',
      autoIterate: false,
      intervalMinutes: 1440,
    })

    const anonymous = await built.app.inject({ method: 'GET', url: '/api/auth/me' })
    assert.equal(anonymous.statusCode, 401)

    const session = sessionFor(built, owner)
    const response = await built.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: session.cookie } })
    assert.equal(response.statusCode, 200)
    const body = response.json() as {
      user: { id: string; login: string; role: string }
      platformCapabilities: string[]
      capabilities: string[]
      projects: Array<{ id: string; tenantId: string | null; role: string | null; capabilities: string[] }>
    }
    assert.equal(body.user.id, owner.id)
    assert.equal(body.user.login, 'MeOwner')
    assert.deepEqual(body.platformCapabilities, [])
    assert.ok(body.capabilities.includes('tasks.write'))
    assert.ok(body.capabilities.includes('config.write'))
    const project = body.projects.find((entry) => entry.id === repo.id)
    assert.ok(project)
    assert.equal(project?.tenantId, legacyTenantId('Me'))
    assert.equal(project?.role, 'maintainer')
    assert.ok(project?.capabilities.includes('tasks.write'))
    assert.doesNotMatch(response.body, /token_enc|github_token|key_enc|password/i)
  } finally {
    await built.close()
  }
})
