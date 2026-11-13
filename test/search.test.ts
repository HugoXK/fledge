import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { makeTerminalJob, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// One approved owner with one repository and a session; the job helper keeps the
// two required hashes out of every call site.
async function fixture(login: string) {
  const store = new Store(':memory:')
  const built = await buildApp({ config: testConfig(), store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  const user = makeUser(store, { login, status: 'approved' })
  const repo = store.createRepo({ id: `repo_${login}`, userId: user.id, owner: 'octo', name: login, defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
  const { cookie } = sessionFor(built, user)
  const job = (id: string, goal: string, createdAt?: string) => makeTerminalJob(store, { id, repoId: repo.id, userId: user.id, trigger: 'manual', goal, callbackHash: id, platformTokenHash: '', ...(createdAt === undefined ? {} : { createdAt }) })
  const search = (query: string) => built.app.inject({ method: 'GET', url: `/search?q=${encodeURIComponent(query)}`, headers: { cookie } })
  return { store, built, user, repo, cookie, job, search }
}

// #362: two users share every matching string, so a query that forgets `user_id`
// returns the other one's row and the first assertion fails.
test('owner search returns only the signed-in user rows', async () => {
  const store = new Store(':memory:')
  const built = await buildApp({ config: testConfig(), store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const mine = makeUser(store, { login: 'search-mine', status: 'approved' })
    const other = makeUser(store, { login: 'search-other', status: 'approved' })
    for (const [user, name, tag] of [[mine, 'needle-project', 'mine'], [other, 'needle-secret', 'other']] as const) {
      const repo = store.createRepo({ id: `repo_${tag}`, userId: user.id, owner: 'octo', name, defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
      makeTerminalJob(store, { id: `job_${tag}_needle`, repoId: repo.id, userId: user.id, trigger: 'manual', goal: `needle summary of ${tag}`, callbackHash: `cb-${tag}`, platformTokenHash: '' })
      store.createWorkItem({ id: `wi_${tag}_needle`, repoId: repo.id, userId: user.id, title: `needle work item of ${tag}` })
      store.audit(user.id, 'repo.needle', `${tag} audit detail`)
    }
    const { cookie } = sessionFor(built, mine)
    const page = await built.app.inject({ method: 'GET', url: '/search?q=needle', headers: { cookie } })
    assert.equal(page.statusCode, 200)
    for (const own of ['job_mine_needle', 'needle-project', 'wi_mine_needle', 'mine audit detail']) assert.match(page.body, new RegExp(own))
    for (const leaked of ['job_other_needle', 'needle-secret', 'repo_other', 'wi_other_needle', 'other audit detail']) assert.doesNotMatch(page.body, new RegExp(leaked))
    // A row's email and token columns are never selected, so they cannot render.
    assert.doesNotMatch(page.body, /search-mine@example\.com|search-other@example\.com/)
  } finally {
    await built.close()
  }
})

test('owner search matches % _ quotes and tags as literal text', async () => {
  const { built, job, search } = await fixture('search-literal')
  try {
    job('job_percent', 'discount 100% off')
    job('job_under', 'snake_case name')
    job('job_tag', 'see <script>boom</script> tail')
    // `%` and `_` are LIKE wildcards; as text they match the rows that literally
    // contain them, and `snake%case` finds nothing because `%` may not stand in
    // for the underscore.
    const percent = await search('%')
    assert.equal(percent.statusCode, 200)
    assert.match(percent.body, /job_percent/)
    assert.doesNotMatch(percent.body, /job_under|job_tag/)
    assert.match((await search('100%')).body, /job_percent/)
    assert.doesNotMatch((await search('snake%case')).body, /job_under/)
    assert.doesNotMatch((await search('snake_case')).body, /job_percent|job_tag/)
    // A tag in the data is escaped text on the page, never markup, and a query
    // that matches nothing keeps its own text out of the markup too.
    const tag = await search('<script>boom</script>')
    assert.match(tag.body, /job_tag/)
    assert.doesNotMatch(tag.body, /<script>boom/)
    assert.match(tag.body, /&lt;script&gt;boom/)
    assert.doesNotMatch((await search(`' OR 1=1 --`)).body, /job_percent|job_under|job_tag/)
  } finally {
    await built.close()
  }
})

test('owner search states the cap and offers a next step when nothing matches', async () => {
  const { built, job, search, cookie } = await fixture('search-cap')
  try {
    for (let i = 0; i < 25; i += 1) job(`job_cap_${String(i).padStart(2, '0')}`, 'capping goal', `2026-11-01T00:${String(i).padStart(2, '0')}:00.000Z`)
    const capped = await search('capping')
    assert.equal(capped.statusCode, 200)
    assert.equal((capped.body.match(/<code>job_cap_\d\d<\/code>/g) ?? []).length, 20)
    assert.doesNotMatch(capped.body, /job_cap_00/)
    assert.match(capped.body, /(前 20|first 20)/i)
    const empty = await search('no-such-needle')
    assert.equal(empty.statusCode, 200)
    assert.match(empty.body, /(没有匹配|No matches)/)
    assert.match(empty.body, /(缩小|narrow)/i)
    // No query yet is the same empty state, not a listing of everything.
    const bare = await built.app.inject({ method: 'GET', url: '/search', headers: { cookie } })
    assert.deepEqual([bare.statusCode, /job_cap_00/.test(bare.body)], [200, false])
  } finally {
    await built.close()
  }
})
