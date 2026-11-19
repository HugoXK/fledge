import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #380 review finding: the revoke route and the page both gated on the
// connection's `repo_role` declaration, not on the actor. A repository
// connected today records no role (the state #903 documents), so its owner was
// refused on the only revocation path; and a developer member of a repository
// declared maintainer saw the control and passed the route. The actor's role
// from `ownedRepo` is the one source both sides have to read.

const SOURCE = 'repo:o/r'

interface Harness {
  store: Store
  built: Awaited<ReturnType<typeof buildApp>>
  repoId: string
  close: () => Promise<void>
}

async function harness(repoRole: string | null): Promise<Harness> {
  const store = new Store(':memory:')
  const config = testConfig()
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), startScheduler: false })
  const suffix = Math.random().toString(36).slice(2, 8)
  const owner = makeUser(store, { login: `skill-source-owner-${suffix}`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_skill_source_${suffix}`,
    userId: owner.id,
    owner: 'o',
    name: 'r',
    defaultBranch: 'main',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole,
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  store.ensureSkillBundleSource({ repoId: repo.id, source: SOURCE, updatedBy: 'system:first-load' })
  return {
    store,
    built,
    repoId: repo.id,
    close: async () => {
      store.close()
    },
  }
}

function post(h: Harness, actor: { userId: string; cookie: string; csrf: string }, state: string) {
  return h.built.app.inject({
    method: 'POST',
    url: `/repos/${h.repoId}/skill-source`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: actor.cookie },
    payload: formBody({ csrf: actor.csrf, source: SOURCE, state }),
  })
}

function page(h: Harness, actor: { cookie: string }) {
  return h.built.app.inject({
    method: 'GET',
    url: `/repos/${h.repoId}`,
    headers: { cookie: `${actor.cookie}; fledge_lang=en` },
  })
}

function ownerSession(h: Harness): { userId: string; cookie: string; csrf: string } {
  const repo = h.store.getRepo(h.repoId)!
  const user = h.store.userById(repo.user_id)!
  const session = sessionFor(h.built, user)
  return { userId: user.id, cookie: session.cookie, csrf: session.csrf }
}

test('the owner of a repository connected without a role can revoke a source, and the page offers it', async () => {
  const h = await harness(null)
  try {
    const owner = ownerSession(h)
    const html = await page(h, owner)
    assert.equal(html.statusCode, 200)
    assert.ok(html.body.includes(`/repos/${h.repoId}/skill-source`), 'the owner sees the revocation control')

    const result = await post(h, owner, 'revoked')
    assert.equal(result.statusCode, 302, `the owner may revoke: ${String(result.body).slice(0, 300)}`)
    assert.equal(h.store.skillBundleSource(h.repoId, SOURCE)?.state, 'revoked')
  } finally {
    await h.close()
  }
})

test('a developer member of a maintainer-declared repository neither sees the control nor passes the route', async () => {
  const h = await harness('maintainer')
  try {
    const suffix = Math.random().toString(36).slice(2, 8)
    const developer = makeUser(h.store, { login: `skill-source-dev-${suffix}`, status: 'approved' })
    h.store.addRepoMember({ repoId: h.repoId, userId: developer.id, role: 'developer', grantedBy: null })
    const session = sessionFor(h.built, developer)
    const actor = { userId: developer.id, cookie: session.cookie, csrf: session.csrf }

    const html = await page(h, actor)
    assert.equal(html.statusCode, 200)
    assert.equal(html.body.includes(`/repos/${h.repoId}/skill-source`), false, 'a developer gets no revocation control')

    const result = await post(h, actor, 'revoked')
    assert.equal(result.statusCode, 403, 'a developer is refused by the route as well')
    assert.equal(h.store.skillBundleSource(h.repoId, SOURCE)?.state, 'allowed')
  } finally {
    await h.close()
  }
})

test('a maintainer member of a repository declared developer still has the owner path', async () => {
  const h = await harness('developer')
  try {
    const suffix = Math.random().toString(36).slice(2, 8)
    const maintainer = makeUser(h.store, { login: `skill-source-maint-${suffix}`, status: 'approved' })
    h.store.addRepoMember({ repoId: h.repoId, userId: maintainer.id, role: 'maintainer', grantedBy: null })
    const session = sessionFor(h.built, maintainer)
    const actor = { userId: maintainer.id, cookie: session.cookie, csrf: session.csrf }

    const result = await post(h, actor, 'revoked')
    assert.equal(result.statusCode, 302)
    assert.equal(h.store.skillBundleSource(h.repoId, SOURCE)?.state, 'revoked')
  } finally {
    await h.close()
  }
})
