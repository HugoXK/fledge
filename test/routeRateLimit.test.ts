import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #708: a state-changing route answers with the class budget it names, and the
// budget comes from config rather than from a number inside the handler. The
// two budgets below are deliberately smaller than any default so a run cannot
// pass by accident.
const BUDGET = 2

function limitedConfig() {
  const budget = { max: BUDGET, windowMs: 60_000 }
  return testConfig({ rateLimit: { login: budget, destructive: budget, expensive: budget } })
}

function repoRow(store: Store, userId: string, id: string): void {
  store.createRepo({
    id, userId, owner: 'o', name: 'one', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
    repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
  })
}

async function withApp(
  config: ReturnType<typeof testConfig>,
  run: (built: Awaited<ReturnType<typeof buildApp>>, store: Store) => Promise<void>,
): Promise<void> {
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    await run(built, store)
  } finally {
    await built.close()
  }
}

type Built = Awaited<ReturnType<typeof buildApp>>

function post(built: Built, url: string, cookie: string, payload: string, locale = 'zh') {
  return built.app.inject({
    method: 'POST',
    url,
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'accept-language': locale },
    payload,
  })
}

// Every route is walked to BUDGET + 1 requests with a payload that would
// otherwise be answered (a redirect, a 400 or a 403), so only the limiter can
// turn the last one into a 429. The routes keep separate buckets: exhausting one
// destructive route must not refuse another.
test('the paced state-changing POST routes refuse the request after their class budget', async () => {
  await withApp(limitedConfig(), async (built, store) => {
    const superadmin = makeUser(store, { login: 'root-user', admin: true, superadmin: true, status: 'approved' })
    const target = makeUser(store, { login: 'target-user', status: 'approved' })
    const owner = makeUser(store, { login: 'repo-owner', status: 'approved' })
    repoRow(store, owner.id, 'repo_limited')
    const repo = store.listRepos(owner.id)[0]!
    const { cookie: rootCookie, csrf: rootCsrf } = sessionFor(built, superadmin)
    const { cookie: ownerCookie, csrf: ownerCsrf } = sessionFor(built, owner)

    const cases = [
      { name: 'sign-in', url: '/auth/token', cookie: '', payload: formBody({ token: '' }) },
      { name: 'admin role', url: `/admin/users/${target.id}/role`, cookie: rootCookie, payload: formBody({ csrf: rootCsrf, role: 'admin' }) },
      { name: 'repository add', url: '/repos', cookie: ownerCookie, payload: formBody({ csrf: ownerCsrf }) },
      { name: 'rule save', url: `/repos/${repo.id}/rules`, cookie: ownerCookie, payload: formBody({ csrf: ownerCsrf, path: '../escape', content: 'x', expected_revision: '0' }) },
      { name: 'job start', url: `/repos/${repo.id}/run`, cookie: ownerCookie, payload: formBody({ csrf: ownerCsrf }) },
      // #708: the remaining privileged routes the card names. The provider id
      // and the job id do not exist, which is the point: the route is paced
      // before it looks anything up, so a caller cannot probe for existence
      // harder than it can ask.
      { name: 'repository role', url: `/repos/${repo.id}/role`, cookie: ownerCookie, payload: formBody({ csrf: ownerCsrf, role: 'developer' }) },
      { name: 'provider delete', url: '/settings/providers/nope/delete', cookie: ownerCookie, payload: formBody({ csrf: ownerCsrf }) },
      { name: 'team stop', url: `/repos/${repo.id}/team/stop`, cookie: ownerCookie, payload: formBody({ csrf: ownerCsrf, target: 'chief' }) },
      { name: 'job merge', url: `/repos/${repo.id}/jobs/nope/merge`, cookie: ownerCookie, payload: formBody({ csrf: ownerCsrf }) },
      // #893: publishing a release is a tag write, i.e. a ref write, and it
      // scans tags behind one POST. It carries the same class limit as the
      // routes around it, so a caller cannot turn it into a compare amplifier.
      { name: 'release', url: `/repos/${repo.id}/release`, cookie: ownerCookie, payload: formBody({ csrf: ownerCsrf, version: 'v1.0.0', sha: 'a'.repeat(40), confirm: '1' }) },
      // #893: the readiness page's tag button writes the same ref through the
      // same preflight, so it carries the same class limit.
      { name: 'release readiness tag', url: `/repos/${repo.id}/release-readiness/tag`, cookie: ownerCookie, payload: formBody({ csrf: ownerCsrf, version: 'v1.4.0', head: 'a'.repeat(40), confirm: '1' }) },
    ]

    for (const route of cases) {
      for (let attempt = 1; attempt <= BUDGET; attempt += 1) {
        const response = await post(built, route.url, route.cookie, route.payload)
        assert.notEqual(response.statusCode, 429, `${route.name}: attempt ${attempt} of ${BUDGET} was refused`)
      }
      const refused = await post(built, route.url, route.cookie, route.payload)
      assert.equal(refused.statusCode, 429, `${route.name}: attempt ${BUDGET + 1} was not refused, so POST ${route.url} carries no class limit`)
      assert.match(String(refused.headers['content-type']), /text\/html/, `${route.name}: the refusal must be the page, not a bare status`)
    }
  })
})

test('the refusal renders the bilingual page, not a bare status', async () => {
  await withApp(limitedConfig(), async (built, store) => {
    const owner = makeUser(store, { login: 'copy-owner', status: 'approved' })
    const { cookie, csrf } = sessionFor(built, owner)
    for (let attempt = 1; attempt <= BUDGET; attempt += 1) await post(built, '/repos', cookie, formBody({ csrf }))
    const zh = await post(built, '/repos', cookie, formBody({ csrf }), 'zh')
    assert.equal(zh.statusCode, 429)
    assert.match(zh.body, /请求过多/)
    assert.match(zh.body, /请稍后再试。/)

    const other = makeUser(store, { login: 'copy-owner-en', status: 'approved' })
    const en = sessionFor(built, other)
    for (let attempt = 1; attempt <= BUDGET; attempt += 1) await post(built, '/repos', en.cookie, formBody({ csrf: en.csrf }))
    const english = await post(built, '/repos', en.cookie, formBody({ csrf: en.csrf }), 'en')
    assert.equal(english.statusCode, 429)
    assert.match(english.body, /Too many requests/)
    assert.match(english.body, /Please try again later\./)
  })
})

test('a read route is not paced by the mutation budgets', async () => {
  await withApp(limitedConfig(), async (built, store) => {
    const owner = makeUser(store, { login: 'reader', status: 'approved' })
    const { cookie } = sessionFor(built, owner)
    for (let attempt = 1; attempt <= BUDGET * 3; attempt += 1) {
      const response = await built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie } })
      assert.notEqual(response.statusCode, 429, `GET /dashboard was refused on attempt ${attempt}`)
    }
  })
})
