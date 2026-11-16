import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #105 slice 1: a repository row belongs to its connection owner, but the
// product shares its read path with the members of that repository. The role
// vocabulary is the one the capability model already resolves, so a viewer
// reads and does nothing else, a developer works and cannot change the merge
// policy, and a revoked member falls back to the same 404 as a stranger.

async function harness() {
  const config = testConfig({ githubApp: { id: '1', slug: 'fledge-platform', privateKeyPath: '/tmp/fake.pem', webhookSecret: 'secret', useUserToken: false } })
  const store = new Store(':memory:')
  const runner = { name: 'capture', async run() { return { status: 'running' as const } } }
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner, startScheduler: false })
  const owner = makeUser(store, { login: 'owner105', status: 'approved' })
  const member = makeUser(store, { login: 'member105', status: 'approved' })
  const viewer = makeUser(store, { login: 'viewer105', status: 'approved' })
  const stranger = makeUser(store, { login: 'stranger105', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo105',
    userId: owner.id,
    owner: 'HugoXK',
    name: 'shared105',
    defaultBranch: 'main',
    tokenEnc: '',
    permission: 'admin',
    repoRole: 'maintainer',
    goal: 'keep this goal',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  return { config, store, built, owner, member, viewer, stranger, repo }
}

test('member rows accept only the capability roles and revoking removes access', async () => {
  const store = new Store(':memory:')
  const owner = makeUser(store, { login: 'owner-rows' })
  const other = makeUser(store, { login: 'member-rows' })
  const repo = store.createRepo({
    id: 'repo-rows',
    userId: owner.id,
    owner: 'HugoXK',
    name: 'rows',
    defaultBranch: 'main',
    tokenEnc: '',
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })

  assert.equal(store.addRepoMember({ repoId: repo.id, userId: other.id, role: 'admin', grantedBy: owner.id }), undefined)
  const created = store.addRepoMember({ repoId: repo.id, userId: other.id, role: 'viewer', grantedBy: owner.id })
  assert.equal(created?.role, 'viewer')
  assert.equal(store.memberRoleFor(repo.id, other.id), 'viewer')

  // The same pair added again is a role change, not a duplicate row or a crash.
  assert.equal(store.addRepoMember({ repoId: repo.id, userId: other.id, role: 'developer', grantedBy: owner.id })?.role, 'developer')
  assert.equal(store.listRepoMembers(repo.id).filter((row) => row.user_id === other.id).length, 1)
  assert.equal(store.setRepoMemberRole(repo.id, other.id, 'viewer'), true)
  assert.equal(store.memberRoleFor(repo.id, other.id), 'viewer')
  assert.equal(store.setRepoMemberRole(repo.id, other.id, 'admin'), false)
  assert.equal(store.memberRoleFor(repo.id, other.id), 'viewer')

  // The connection owner is the maintainer of last resort and cannot be removed.
  assert.equal(store.removeRepoMember(repo.id, owner.id), false)
  assert.equal(store.removeRepoMember(repo.id, other.id), true)
  assert.equal(store.memberRoleFor(repo.id, other.id), null)
  // The repository was created with its owner's backfilled maintainer row
  // (`system:identity`), and that is the only member left after the revoke.
  assert.deepEqual(store.listRepoMembers(repo.id).map((row) => [row.user_id, row.role]), [[owner.id, 'maintainer']])
  await Promise.resolve()
})

test('an active member reads the shared repository and a stranger does not', async () => {
  const h = await harness()
  try {
    h.store.addRepoMember({ repoId: h.repo.id, userId: h.member.id, role: 'developer', grantedBy: h.owner.id })
    const memberSession = sessionFor(h.built, h.member)
    const strangerSession = sessionFor(h.built, h.stranger)

    const memberDashboard = await h.built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie: memberSession.cookie } })
    assert.equal(memberDashboard.statusCode, 200)
    assert.match(memberDashboard.body, /shared105/)

    const memberRepo = await h.built.app.inject({ method: 'GET', url: `/repos/${h.repo.id}`, headers: { cookie: memberSession.cookie } })
    assert.equal(memberRepo.statusCode, 200)

    const strangerDashboard = await h.built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie: strangerSession.cookie } })
    assert.equal(strangerDashboard.statusCode, 200)
    assert.doesNotMatch(strangerDashboard.body, /shared105/)

    const strangerRepo = await h.built.app.inject({ method: 'GET', url: `/repos/${h.repo.id}`, headers: { cookie: strangerSession.cookie } })
    assert.equal(strangerRepo.statusCode, 404)
  } finally {
    await h.built.close()
  }
})

test('a viewer member reads but cannot write', async () => {
  const h = await harness()
  try {
    h.store.addRepoMember({ repoId: h.repo.id, userId: h.viewer.id, role: 'viewer', grantedBy: h.owner.id })
    const session = sessionFor(h.built, h.viewer)
    const read = await h.built.app.inject({ method: 'GET', url: `/repos/${h.repo.id}`, headers: { cookie: session.cookie } })
    assert.equal(read.statusCode, 200)

    const write = await h.built.app.inject({
      method: 'POST',
      url: `/repos/${h.repo.id}/work`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: session.cookie, 'x-csrf-token': session.csrf },
      payload: formBody({ title: 'viewer should not create this', csrf: session.csrf }),
    })
    assert.equal(write.statusCode, 403)
    assert.equal(h.store.listWorkItems(h.repo.id).length, 0)
  } finally {
    await h.built.close()
  }
})

test('a developer member writes work but cannot change repository settings', async () => {
  const h = await harness()
  try {
    h.store.addRepoMember({ repoId: h.repo.id, userId: h.member.id, role: 'developer', grantedBy: h.owner.id })
    const session = sessionFor(h.built, h.member)

    const created = await h.built.app.inject({
      method: 'POST',
      url: `/repos/${h.repo.id}/work`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: session.cookie, 'x-csrf-token': session.csrf },
      payload: formBody({ title: 'member work item', csrf: session.csrf }),
    })
    assert.equal(created.statusCode, 302)
    assert.deepEqual(h.store.listWorkItems(h.repo.id).map((item) => item.title), ['member work item'])

    const settings = await h.built.app.inject({
      method: 'POST',
      url: `/repos/${h.repo.id}/settings`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: session.cookie, 'x-csrf-token': session.csrf },
      payload: formBody({ goal: 'a developer must not rewrite this', csrf: session.csrf }),
    })
    assert.equal(settings.statusCode, 403)
    assert.equal(h.store.getRepo(h.repo.id)?.goal, 'keep this goal')
  } finally {
    await h.built.close()
  }
})

test('a revoked member loses the repository again', async () => {
  const h = await harness()
  try {
    h.store.addRepoMember({ repoId: h.repo.id, userId: h.member.id, role: 'developer', grantedBy: h.owner.id })
    assert.equal(h.store.removeRepoMember(h.repo.id, h.member.id), true)
    const session = sessionFor(h.built, h.member)
    const page = await h.built.app.inject({ method: 'GET', url: `/repos/${h.repo.id}`, headers: { cookie: session.cookie } })
    assert.equal(page.statusCode, 404)
    const dashboard = await h.built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie: session.cookie } })
    assert.equal(dashboard.statusCode, 200)
    assert.doesNotMatch(dashboard.body, /shared105/)
  } finally {
    await h.built.close()
  }
})

// #105 review (5914605525): slice 1 handed a developer member every route that
// `ownedRepo` let through with `mutating` only. Those routes write the same
// columns as the settings form and can clear `auto_merge`/`reviewer_enabled` or
// destroy the connection, so they carry the settings rule now: maintainer.
// The refusal is the guard's, which answers before the body is read — a
// malformed release body still gets 403 rather than a body-validation redirect.
async function postForm(built: Awaited<ReturnType<typeof harness>>['built'], session: { cookie: string; csrf: string }, url: string, payload: Record<string, string>) {
  return built.app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: session.cookie, 'x-csrf-token': session.csrf },
    payload: formBody({ ...payload, csrf: session.csrf }),
  })
}

test('a developer member cannot change the repository role', async () => {
  const h = await harness()
  try {
    h.store.addRepoMember({ repoId: h.repo.id, userId: h.member.id, role: 'developer', grantedBy: h.owner.id })
    assert.equal(h.store.getRepo(h.repo.id)?.repo_role, 'maintainer')
    const session = sessionFor(h.built, h.member)
    // `role` writes the same column as settings, and demoting clears
    // `auto_merge`; a developer holding it could turn auto-merge off.
    const demote = await postForm(h.built, session, `/repos/${h.repo.id}/role`, { role: 'developer' })
    assert.equal(demote.statusCode, 403)
    assert.equal(h.store.getRepo(h.repo.id)?.repo_role, 'maintainer')

    // The maintainer keeps the route; the guard is not a blanket refusal.
    const ownerSession = sessionFor(h.built, h.owner)
    const ownerDemote = await postForm(h.built, ownerSession, `/repos/${h.repo.id}/role`, { role: 'developer' })
    assert.equal(ownerDemote.statusCode, 302)
    assert.equal(h.store.getRepo(h.repo.id)?.repo_role, 'developer')
  } finally {
    await h.built.close()
  }
})

test('a developer member cannot delete the repository', async () => {
  const h = await harness()
  try {
    h.store.addRepoMember({ repoId: h.repo.id, userId: h.member.id, role: 'developer', grantedBy: h.owner.id })
    const session = sessionFor(h.built, h.member)
    const refused = await postForm(h.built, session, `/repos/${h.repo.id}/delete`, { confirmName: 'shared105' })
    assert.equal(refused.statusCode, 403)
    assert.notEqual(h.store.getRepo(h.repo.id), undefined)
    assert.equal(h.store.memberRoleFor(h.repo.id, h.member.id), 'developer')
  } finally {
    await h.built.close()
  }
})

test('a developer member cannot publish a release', async () => {
  const h = await harness()
  try {
    h.store.addRepoMember({ repoId: h.repo.id, userId: h.member.id, role: 'developer', grantedBy: h.owner.id })
    const session = sessionFor(h.built, h.member)
    // Malformed first: the guard answers before the SHA and confirmation are
    // parsed, so the refusal is a permission answer and not a body complaint.
    const malformed = await postForm(h.built, session, `/repos/${h.repo.id}/release`, { version: '9.9.9', sha: 'abc123', confirm: '1' })
    assert.equal(malformed.statusCode, 403)
    // A well-formed body is refused for the same reason.
    const wellFormed = await postForm(h.built, session, `/repos/${h.repo.id}/release`, { version: '9.9.9', sha: 'a'.repeat(40), confirm: '1' })
    assert.equal(wellFormed.statusCode, 403)
    assert.equal(h.store.releaseByTag(h.repo.id, 'v9.9.9'), undefined)
  } finally {
    await h.built.close()
  }
})

test('a developer member cannot stop, disable or restart the repository workspace', async () => {
  const h = await harness()
  try {
    h.store.addRepoMember({ repoId: h.repo.id, userId: h.member.id, role: 'developer', grantedBy: h.owner.id })
    const session = sessionFor(h.built, h.member)
    for (const [url, payload] of [
      [`/repos/${h.repo.id}/instance`, {}],
      [`/repos/${h.repo.id}/instance/stop`, {}],
      [`/repos/${h.repo.id}/models/apply`, {}],
      [`/repos/${h.repo.id}/disable`, {}],
      [`/repos/${h.repo.id}/enable`, {}],
    ] as const) {
      const refused = await postForm(h.built, session, url, payload)
      assert.equal(refused.statusCode, 403, `${url} must refuse a developer member`)
    }
    assert.equal(h.store.getRepo(h.repo.id)?.enabled, h.repo.enabled)
  } finally {
    await h.built.close()
  }
})

test('a developer member starts work through the same rule as plan and triage', async () => {
  const h = await harness()
  try {
    h.store.addRepoMember({ repoId: h.repo.id, userId: h.member.id, role: 'developer', grantedBy: h.owner.id })
    const session = sessionFor(h.built, h.member)
    // `/run` was the only member-facing start still reading `repo.user_id`; the
    // four converted routes accept a member, so `/run` answers on the repository
    // page instead of the 404 a stranger gets.
    const started = await postForm(h.built, session, `/repos/${h.repo.id}/run`, {})
    assert.equal(started.statusCode, 302)
    // The banner rides a one-shot flash cookie (#472), so a queued start lands
    // on the bare repository page with the message in the cookie, not the query.
    assert.equal(String(started.headers.location), `/repos/${h.repo.id}`)
    assert.match(String(started.headers['set-cookie']), /fledge_flash=/)
  } finally {
    await h.built.close()
  }
})
