import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

test('a user cannot read another user\'s repositories, team or workspace', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const alice = makeUser(store, { login: 'alice', status: 'approved', superadmin: true })
    const bob = makeUser(store, { login: 'bob', status: 'approved' })
    const aliceRepo = store.createRepo({ id: 'repo_alice', userId: alice.id, owner: 'alice', name: 'one', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const bobRepo = store.createRepo({ id: 'repo_bob', userId: bob.id, owner: 'bob', name: 'two', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const aliceSession = sessionFor(built, alice)
    const bobSession = sessionFor(built, bob)

    const own = await built.app.inject({ method: 'GET', url: `/repos/${aliceRepo.id}`, headers: { cookie: aliceSession.cookie } })
    assert.equal(own.statusCode, 200)
    const ownTeam = await built.app.inject({ method: 'GET', url: `/repos/${aliceRepo.id}/team`, headers: { cookie: aliceSession.cookie } })
    assert.equal(ownTeam.statusCode, 200)
    const ownWorkspace = await built.app.inject({ method: 'GET', url: `/repos/${aliceRepo.id}/workspace`, headers: { cookie: aliceSession.cookie } })
    assert.equal(ownWorkspace.statusCode, 200)

    for (const url of [`/repos/${bobRepo.id}`, `/repos/${bobRepo.id}/team`, `/api/repos/${bobRepo.id}/team`, `/repos/${bobRepo.id}/workspace`]) {
      const response = await built.app.inject({ method: 'GET', url, headers: { cookie: aliceSession.cookie } })
      assert.equal(response.statusCode, 404, `${url} must be hidden from another user`)
    }
    const bobOwn = await built.app.inject({ method: 'GET', url: `/repos/${bobRepo.id}`, headers: { cookie: bobSession.cookie } })
    assert.equal(bobOwn.statusCode, 200)
  } finally {
    await built.close()
  }
})
