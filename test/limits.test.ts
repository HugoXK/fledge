import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { dedupeRepoNames, instanceLimitRefusal, repoLimitRefusal } from '../src/lib/limits.js'
import { formBody, json, makeUser, MemoryMailer, sessionFor, startFakeServer, testConfig } from './helpers.js'

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

test('the repository ceiling counts what an add would create, not the count after it', () => {
  const base = { used: 0, cap: 2, admin: false }
  // #457 review: the bulk path used to pass `used + fresh.length`, so a
  // selection that exactly filled the last slots was refused and reported
  // `used=2/2` to a user who held 1.
  assert.deepEqual(repoLimitRefusal({ ...base, extra: 2 }), null, 'two fresh repositories against an empty cap of two are allowed')
  assert.deepEqual(repoLimitRefusal({ ...base, used: 1, extra: 1 }), null, 'the add that fills the last free slot is allowed')
  assert.deepEqual(repoLimitRefusal({ ...base, used: 1, extra: 2 }), { code: 'REPO_LIMIT', used: 1, cap: 2 }, 'the refusal reports the count the user holds, not the count it would reach')
  assert.deepEqual(repoLimitRefusal({ ...base, used: 2, extra: 0 }), null, 'a selection with nothing fresh to create is never refused')
})

test('a posted selection counts each repository once', () => {
  assert.deepEqual(dedupeRepoNames(['o/a', 'O/A', 'o/b', 'o/a']), ['o/a', 'o/b'])
  assert.deepEqual(dedupeRepoNames(['']), [''])
  // The duplicate must not inflate the ceiling arithmetic: two spellings of one
  // repository are one add, so cap 2 with one row held still fits.
  assert.deepEqual(repoLimitRefusal({ used: 1, cap: 2, admin: false, extra: dedupeRepoNames(['o/a', 'O/A']).length }), null)
})

test('the instance ceiling honours the per-user cap and the optional global cap', () => {
  const base = { usedForUser: 0, capForUser: 2, usedGlobal: 0, capGlobal: 0, admin: false }
  assert.deepEqual(instanceLimitRefusal(base), null)
  assert.deepEqual(instanceLimitRefusal({ ...base, usedForUser: 2 }), { code: 'INSTANCE_LIMIT', used: 2, cap: 2 })
  assert.deepEqual(instanceLimitRefusal({ ...base, usedGlobal: 5, capGlobal: 5 }), { code: 'INSTANCE_LIMIT', used: 5, cap: 5 }, 'a global refusal names the global ceiling, not 0/3')
  assert.deepEqual(instanceLimitRefusal({ ...base, usedForUser: 5, admin: true }), null)
})

test('a bulk add is refused when the instances it would provision do not fit', () => {
  const base = { usedForUser: 0, capForUser: 3, usedGlobal: 0, capGlobal: 0, admin: false }
  assert.deepEqual(instanceLimitRefusal({ ...base, usedForUser: 2, extra: 1 }), null, 'the add that fills the last slot is allowed')
  assert.deepEqual(instanceLimitRefusal({ ...base, usedForUser: 2, extra: 2 }), { code: 'INSTANCE_LIMIT', used: 2, cap: 3 })
  assert.deepEqual(instanceLimitRefusal({ ...base, usedGlobal: 4, capGlobal: 5, extra: 2 }), { code: 'INSTANCE_LIMIT', used: 4, cap: 5 })
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

function instanceRow(userId: string, repoId: string, status: string): Parameters<Store['saveRepoInstance']>[0] {
  return {
    repo_id: repoId, user_id: userId, container: `c-${repoId}`, network: `n-${repoId}`, data_dir: `/tmp/${repoId}`, bridge_script: '',
    dsh_port: 0, bridge_port: 0, model_port: 0, model_bind: '', image: 'img', status, chief_session: null,
    team_json: null, bridge_token_enc: null, bridge_pid: null, log_pid: null, last_error: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_health_at: null,
  } as Parameters<Store['saveRepoInstance']>[0]
}

test('an instance beyond the per-user cap is refused with INSTANCE_LIMIT before provisioning', async () => {
  const config = testConfig({ limits: { reposPerUser: 10, instancesPerUser: 1, instancesGlobal: 0 } })
  config.flybot.instanceImage = 'fledge-flybot:test'
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'instance-cap', status: 'approved' })
    repoRow(store, user.id, 'repo_inst_one', 'one')
    const second = repoRow(store, user.id, 'repo_inst_two', 'two')
    store.saveRepoInstance(instanceRow(user.id, 'repo_inst_one', 'ready'))
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

test('a stopped instance holds no slot, so a user at the cap can restart it', async () => {
  const config = testConfig({ limits: { reposPerUser: 10, instancesPerUser: 1, instancesGlobal: 0 } })
  config.flybot.instanceImage = 'fledge-flybot:test'
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'restart-at-cap', status: 'approved' })
    const repo = repoRow(store, user.id, 'repo_restart', 'restart')
    store.saveRepoInstance(instanceRow(user.id, repo.id, 'stopped'))
    assert.equal(store.countRepoInstancesForUser(user.id), 0, 'a stopped row does not count toward the per-user ceiling')
    assert.equal(store.countRepoInstances(), 0, 'nor toward the global ceiling')
    let provisions = 0
    built.instances.provision = async () => { provisions += 1 }
    built.instances.stop = async () => undefined
    const { cookie, csrf } = sessionFor(built, user)
    const response = await built.app.inject({
      method: 'POST', url: `/repos/${repo.id}/instance`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf }),
    })
    assert.equal(response.statusCode, 302)
    const location = decodeURIComponent(String(response.headers.location))
    assert.equal(location.includes('code=INSTANCE_LIMIT'), false, 'the restart of the repository own stopped instance must be allowed')
    assert.equal(provisions, 1, 'the restart must reach provisioning')
  } finally {
    await built.close()
  }
})

test('adding a repository is refused when the instance it would provision does not fit', async () => {
  const config = testConfig({ limits: { reposPerUser: 10, instancesPerUser: 1, instancesGlobal: 0 } })
  config.flybot.instanceImage = 'fledge-flybot:test'
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'add-at-instance-cap', status: 'approved' })
    const first = repoRow(store, user.id, 'repo_add_cap', 'one')
    store.saveRepoInstance(instanceRow(user.id, first.id, 'ready'))
    const { cookie, csrf } = sessionFor(built, user)
    const refused = await built.app.inject({
      method: 'POST', url: '/repos',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, repo: 'o/two', token: 't' }),
    })
    assert.equal(refused.statusCode, 302)
    assert.match(decodeURIComponent(String(refused.headers.location)), /code=INSTANCE_LIMIT/, 'the add path must not bypass the instance ceiling')
    assert.equal(store.countReposForUser(user.id), 1, 'a refused add must not create a repository that cannot get an instance')
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

// #457 review: the bulk add path (`/repos/app`) needs a GitHub App, so the
// arithmetic it feeds the ceiling had no test at all. A stub API is enough to
// drive the route honestly: the selection, the refusal and the row count are
// the route's own behaviour, and nothing here reaches docker or a real GitHub.
function bulkKeyPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-bulk-key-'))
  const path = join(dir, 'app.pem')
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  writeFileSync(path, privateKey)
  return path
}

test('a bulk add is allowed when the selection exactly fills the cap, and refused when it overflows', async () => {
  const repos = ['a', 'b', 'c'].map((name) => ({
    full_name: `o/${name}`, name, private: false, default_branch: 'main', owner: { login: 'o' },
  }))
  const github = await startFakeServer((request, response) => {
    const url = new URL(String(request.url), 'http://127.0.0.1')
    if (url.pathname === '/rate_limit') return json(response, 200, { resources: {} })
    if (/^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) {
      return json(response, 201, { token: 'ghs_bulk_stub', expires_at: new Date(Date.now() + 3_600_000).toISOString() })
    }
    if (url.pathname === '/installation/repositories') {
      return json(response, 200, { total_count: repos.length, repositories: url.searchParams.get('page') === '1' ? repos : [] })
    }
    const match = /^\/repos\/o\/([^/]+)$/.exec(url.pathname)
    if (match !== null) {
      return json(response, 200, {
        full_name: `o/${match[1]}`, name: match[1], private: false, default_branch: 'main',
        html_url: `https://github.com/o/${match[1]}`, owner: { login: 'o' },
        permissions: { admin: true, maintain: true, push: true, pull: true },
      })
    }
    json(response, 404, { message: 'not found' })
  })
  const base = testConfig()
  const config = testConfig({
    github: { ...base.github, apiBase: github.url },
    githubApp: { id: '77', slug: 'fledge', privateKeyPath: bulkKeyPath(), webhookSecret: 'secret', useUserToken: false },
    limits: { reposPerUser: 2, instancesPerUser: 3, instancesGlobal: 0 },
  })
  config.flybot.instanceImage = ''
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    // Each case gets its own installation row: one installation belongs to one
    // user, and reusing the id would make the route answer INSTALLATION_NOT_FOUND
    // rather than exercise the ceiling.
    let nextInstallation = 770
    const prepare = (login: string): { user: ReturnType<typeof makeUser>; installationId: number } => {
      const user = makeUser(store, { login, status: 'approved' })
      const installationId = nextInstallation
      nextInstallation += 1
      store.saveInstallation({ installationId, userId: user.id, accountLogin: 'o', accountType: 'User' })
      return { user, installationId }
    }
    const post = (who: { user: ReturnType<typeof makeUser>; installationId: number }, names: string[]) => {
      const { cookie, csrf } = sessionFor(built, who.user)
      return built.app.inject({
        method: 'POST',
        url: '/repos/app',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: `csrf=${encodeURIComponent(csrf)}&installation=${who.installationId}${names.map((name) => `&repo=${encodeURIComponent(name)}`).join('')}`,
      })
    }

    // Case 1: empty cap of two, two fresh — allowed, and it ends exactly at the cap.
    const fillsIt = prepare('bulk-fills')
    const filled = await post(fillsIt, ['o/a', 'o/b'])
    assert.equal(filled.statusCode, 302)
    assert.equal(decodeURIComponent(String(filled.headers.location)).includes('code=REPO_LIMIT'), false, 'a selection that ends exactly at the cap is allowed')
    assert.equal(store.countReposForUser(fillsIt.user.id), 2)

    // Case 2: one held, one fresh — allowed and one row created.
    const oneLeft = prepare('bulk-one-left')
    repoRow(store, oneLeft.user.id, 'repo_bulk_held', 'c')
    const added = await post(oneLeft, ['o/a'])
    assert.equal(decodeURIComponent(String(added.headers.location)).includes('code=REPO_LIMIT'), false, 'the add that fills the last free slot is allowed')
    assert.equal(store.countReposForUser(oneLeft.user.id), 2)
    assert.notEqual(store.getRepoByOwnerName(oneLeft.user.id, 'o', 'a'), undefined, 'the allowed bulk add creates its row')

    // Case 3: one held, two fresh — refused, and no row is created.
    const overflows = prepare('bulk-overflows')
    repoRow(store, overflows.user.id, 'repo_bulk_held_two', 'c')
    const refused = await post(overflows, ['o/a', 'o/b'])
    const location = decodeURIComponent(String(refused.headers.location))
    assert.match(location, /code=REPO_LIMIT/, 'a selection that would pass the cap is refused')
    assert.match(location, /1\/2/, 'the message says what the user holds, not what the selection would reach')
    assert.equal(store.countReposForUser(overflows.user.id), 1, 'a refused bulk add creates no row')

    // Case 4: the same repository twice is one add, not two.
    const repeats = prepare('bulk-repeats')
    const deduped = await post(repeats, ['o/a', 'O/A'])
    assert.equal(decodeURIComponent(String(deduped.headers.location)).includes('code=REPO_LIMIT'), false, 'a repeated selection must not be counted twice')
    assert.equal(store.countReposForUser(repeats.user.id), 1)
  } finally {
    await built.close()
    await github.close()
  }
})
