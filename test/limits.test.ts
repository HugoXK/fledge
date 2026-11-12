import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { instanceLimitRefusal, repoLimitRefusal } from '../src/lib/limits.js'
import { formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #457: one user must not be able to connect repositories or provision FlyBot
// instances without a ceiling — each one costs host CPU, memory, disk and a
// port. A refusal has to be a stable code, has to happen before anything is
// created, and has to release the slot when the repository is removed.

test('the repository ceiling is a pure rule with an admin exemption', () => {
  assert.deepEqual(repoLimitRefusal({ used: 1, cap: 2, admin: false }), null)
  assert.deepEqual(repoLimitRefusal({ used: 2, cap: 2, admin: false }), { code: 'REPO_LIMIT', used: 2, cap: 2 })
  assert.deepEqual(repoLimitRefusal({ used: 9, cap: 2, admin: true }), null, 'an admin is not capped')
  assert.deepEqual(repoLimitRefusal({ used: 9, cap: 0, admin: false }), null, 'cap 0 means no ceiling')
})

test('the instance ceiling honours the per-user cap and the optional global cap', () => {
  const base = { usedForUser: 0, capForUser: 2, usedGlobal: 0, capGlobal: 0, admin: false }
  assert.deepEqual(instanceLimitRefusal(base), null)
  assert.deepEqual(instanceLimitRefusal({ ...base, usedForUser: 2 }), { code: 'INSTANCE_LIMIT', used: 2, cap: 2 })
  assert.deepEqual(instanceLimitRefusal({ ...base, usedGlobal: 5, capGlobal: 5 }), { code: 'INSTANCE_LIMIT', used: 0, cap: 2 })
  assert.deepEqual(instanceLimitRefusal({ ...base, usedForUser: 5, admin: true }), null)
})

function repoRow(store: Store, userId: string, id: string, name: string): { id: string } {
  return store.createRepo({
    id, userId, owner: 'o', name, defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
    repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
  })
}

test('a third repository is refused with REPO_LIMIT and creates no row', async () => {
  const config = testConfig({ limits: { reposPerUser: 1, instancesPerUser: 1, instancesGlobal: 0 } })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'capped-user', status: 'approved' })
    repoRow(store, user.id, 'repo_cap_one', 'one')
    const { cookie, csrf } = sessionFor(built, user)
    const refused = await built.app.inject({
      method: 'POST',
      url: '/repos',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, repo: 'o/two', token: 't', cap: '99', limit: '999' }),
    })
    assert.equal(refused.statusCode, 302)
    const location = decodeURIComponent(String(refused.headers.location))
    assert.match(location, /code=REPO_LIMIT/, 'the refusal must carry a stable code')
    assert.match(location, /1\/1/, 'the message must say used / cap')
    assert.equal(store.countReposForUser(user.id), 1, 'a refused add must not create a row')
    assert.equal(store.listAudit(20).some((row) => row.action === 'limit.refused' && String(row.detail).includes('REPO_LIMIT')), true)
  } finally {
    await built.close()
  }
})

test('removing a repository releases its slot', async () => {
  const config = testConfig({ limits: { reposPerUser: 1, instancesPerUser: 1, instancesGlobal: 0 } })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'slot-user', status: 'approved' })
    const repo = repoRow(store, user.id, 'repo_slot', 'slot')
    const { cookie, csrf } = sessionFor(built, user)
    const before = await built.app.inject({
      method: 'POST', url: '/repos',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, repo: 'o/two', token: 't' }),
    })
    assert.match(decodeURIComponent(String(before.headers.location)), /code=REPO_LIMIT/)
    store.deleteRepo(repo.id)
    const after = await built.app.inject({
      method: 'POST', url: '/repos',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, repo: 'o/two', token: 't' }),
    })
    assert.equal(decodeURIComponent(String(after.headers.location)).includes('code=REPO_LIMIT'), false, 'the slot must be free again')
  } finally {
    await built.close()
  }
})

test('an instance beyond the per-user cap is refused with INSTANCE_LIMIT before provisioning', async () => {
  const config = testConfig({ limits: { reposPerUser: 10, instancesPerUser: 1, instancesGlobal: 0 } })
  config.flybot.instanceImage = 'fledge-flybot:test'
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'instance-cap', status: 'approved' })
    repoRow(store, user.id, 'repo_inst_one', 'one')
    const second = repoRow(store, user.id, 'repo_inst_two', 'two')
    store.saveRepoInstance({
      repo_id: 'repo_inst_one', user_id: user.id, container: 'c1', network: 'n1', data_dir: '/tmp/d1', bridge_script: '',
      dsh_port: 0, bridge_port: 0, model_port: 0, model_bind: '', image: 'img', status: 'ready', chief_session: null,
      team_json: null, bridge_token_enc: null, bridge_pid: null, log_pid: null, last_error: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_health_at: null,
    } as Parameters<Store['saveRepoInstance']>[0])
    const { cookie, csrf } = sessionFor(built, user)
    const refused = await built.app.inject({
      method: 'POST', url: `/repos/${second.id}/instance`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf }),
    })
    assert.equal(refused.statusCode, 302)
    assert.match(decodeURIComponent(String(refused.headers.location)), /code=INSTANCE_LIMIT/)
    assert.equal(store.getRepoInstance(second.id), undefined, 'a refused provision must leave no instance row')
  } finally {
    await built.close()
  }
})

test('a non-admin cannot talk the cap away with a posted value', async () => {
  const config = testConfig({ limits: { reposPerUser: 1, instancesPerUser: 1, instancesGlobal: 0 } })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'crafty-user', status: 'approved' })
    repoRow(store, user.id, 'repo_crafty', 'crafty')
    const { cookie, csrf } = sessionFor(built, user)
    const refused = await built.app.inject({
      method: 'POST', url: '/repos',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, repo: 'o/two', token: 't', reposPerUser: '50', LIMIT_REPOS_PER_USER: '50' }),
    })
    assert.match(decodeURIComponent(String(refused.headers.location)), /code=REPO_LIMIT/, 'the ceiling comes from config, never from the form')
  } finally {
    await built.close()
  }
})

test('the repository page shows used / cap for both ceilings', async () => {
  const { repoPage } = await import('../src/views/pages.js')
  const config = testConfig({ limits: { reposPerUser: 2, instancesPerUser: 3, instancesGlobal: 0 } })
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'usage-line', status: 'approved' })
    const repo = repoRow(store, user.id, 'repo_usage', 'usage')
    const html = repoPage({
      config,
      locale: 'en',
      viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' },
      repo: store.getRepo(repo.id)!,
      jobs: [],
      usage: { repos: 1, reposCap: 2, instances: 1, instancesCap: 3 },
    } as Parameters<typeof repoPage>[0])
    assert.match(html, /data-usage-line/)
    assert.match(html, /Repositories used 1\/2/)
    assert.match(html, /FlyBot instances 1\/3/)
  } finally {
    store.close()
  }
})
