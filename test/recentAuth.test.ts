import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store, type RepoRow } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { sha256Hex } from '../src/lib/secrets.js'
import { formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #460: a session cookie lasts 30 days, so a stolen one could delete a
// repository, change a quota or mint a token. Destructive actions therefore
// need a GitHub confirmation inside the configured window; the refusal is
// audited and the re-authentication must not cost the form its CSRF token.

const OLD = new Date(Date.now() - 60 * 60_000).toISOString()

// A session that has never re-authenticated has no recent_auth_at: that is also
// the state of every session created before this change was deployed.
function clearRecentAuth(store: Store, raw: string): void {
  store.db.exec(`UPDATE sessions SET recent_auth_at = NULL WHERE id_hash = '${sha256Hex(raw)}'`)
}

async function build() {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  return { built, store, config }
}

function repoFor(store: Store, userId: string, name = 'dt'): { id: string } {
  return store.createRepo({
    id: 'repo_recent_auth', userId, owner: 'o', name, defaultBranch: 'main', tokenEnc: 'x',
    permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
  })
}

test('a stale session is refused with a re-auth redirect and an audit row', async () => {
  const { built, store } = await build()
  try {
    const user = makeUser(store, { login: 'stale-session', status: 'approved' })
    const repo = repoFor(store, user.id)
    const { raw, cookie, csrf } = sessionFor(built, user)
    clearRecentAuth(store, raw)
    const refused = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/delete`,
      headers: { cookie, referer: `http://127.0.0.1:9999/repos/${repo.id}`, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, confirmName: 'dt' }),
    })
    assert.equal(refused.statusCode, 302)
    const location = String(refused.headers.location)
    assert.match(location, /^\/auth\/github\/reauthorize\?next=/, 'the refusal must ask GitHub to confirm')
    assert.match(decodeURIComponent(location), new RegExp(`/repos/${repo.id}`), 'the redirect must return to the form it came from')
    assert.match(decodeURIComponent(location), /notice=/, 'the form must explain why it came back')
    assert.notEqual(store.getRepo(repo.id), undefined, 'a refused delete must not remove the repository')
    const audit = store.listAudit(20).find((row) => row.action === 'recent_auth_required')
    assert.ok(audit !== undefined, 'the refusal must be audited')
    assert.match(String(audit.detail), /repo\.delete/)
  } finally {
    await built.close()
  }
})

test('a fresh session may still delete its repository', async () => {
  const { built, store } = await build()
  try {
    const user = makeUser(store, { login: 'fresh-session', status: 'approved' })
    const repo = repoFor(store, user.id)
    const { cookie, csrf } = sessionFor(built, user)
    const deleted = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/delete`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, confirmName: 'dt' }),
    })
    assert.equal(deleted.statusCode, 302)
    assert.equal(store.getRepo(repo.id), undefined)
    assert.equal(store.listAudit(20).some((row) => row.action === 'recent_auth_required'), false)
  } finally {
    await built.close()
  }
})

// #555: a settings save leaves `notice=` in the address bar and a fragment
// never travels in a Referer, so the bounce can start from a page that already
// carries a message. Appending a second `notice=` makes the query parser hand
// back an array, `queryText()` refuses a non-string, and the console then shows
// nothing at all.
test('a bounce from a page that already carries a notice returns exactly one notice', async () => {
  const { built, store } = await build()
  try {
    const user = makeUser(store, { login: 'stale-with-notice', status: 'approved' })
    const repo = repoFor(store, user.id)
    const { raw, cookie, csrf } = sessionFor(built, user)
    clearRecentAuth(store, raw)
    const refused = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/delete`,
      headers: {
        cookie,
        referer: `http://127.0.0.1:9999/repos/${repo.id}?notice=old`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formBody({ csrf, confirmName: 'dt' }),
    })
    assert.equal(refused.statusCode, 302)
    const next = new URL(String(refused.headers.location), 'http://127.0.0.1:9999').searchParams.get('next') ?? ''
    const target = new URL(next, 'http://127.0.0.1:9999')
    const notices = target.searchParams.getAll('notice')
    assert.equal(notices.length, 1, 'the return target must carry one notice, not an array')
    assert.match(notices[0] ?? '', /重新用 GitHub 确认|re-authenticat/, 'the notice must be the re-auth reason, not the stale one')
    const page = await built.app.inject({ method: 'GET', url: `${target.pathname}${target.search}`, headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(
      page.body,
      /<div class="banner ok" role="status">[^<]*(重新用 GitHub 确认|re-authenticat)[^<]*<\/div>/,
      'the returned page must show the re-auth notice inside the banner',
    )
    assert.equal(store.getRepo(repo.id) !== undefined, true, 'a refused delete must not remove the repository')
  } finally {
    await built.close()
  }
})

test('a real re-authentication refreshes the same session and keeps its CSRF token', async () => {
  const { built, store } = await build()
  try {
    const user = makeUser(store, { login: 'reauth-session', status: 'approved' })
    const repo = repoFor(store, user.id)
    const { raw, cookie, csrf } = sessionFor(built, user)
    const hash = sha256Hex(raw)
    store.markRecentAuth(hash, OLD)
    // What /auth/github/callback does for a logged-in browser: the session that
    // is being refreshed is updated in place instead of being replaced.
    built.sessions.markRecentAuth({ cookies: { fledge_session: raw }, headers: {} } as never)
    assert.equal(store.getSession(hash)?.recent_auth_at !== OLD, true, 'the refresh must move recent_auth_at')
    const deleted = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/delete`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, confirmName: 'dt' }),
    })
    assert.equal(deleted.statusCode, 302, 'the refreshed session must still pass CSRF and the recency check')
    assert.equal(store.getRepo(repo.id), undefined)
  } finally {
    await built.close()
  }
})

test('an admin action is still refused for a non-admin after re-authentication', async () => {
  const { built, store } = await build()
  try {
    const user = makeUser(store, { login: 'not-admin', status: 'approved' })
    const target = makeUser(store, { login: 'target-user', status: 'pending' })
    const { cookie, csrf } = sessionFor(built, user)
    const refused = await built.app.inject({
      method: 'POST',
      url: `/admin/users/${target.id}/approve`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf }),
    })
    assert.equal(refused.statusCode, 403, 'role checks must come before the recency check')
    assert.equal(store.userById(target.id)?.status, 'pending')
  } finally {
    await built.close()
  }
})

// #524: the settings POST writes the pre-merge policy as well, and the
// auto-merge gate left that half reaching the database from a stale session.
// `require_protection` and `stage_mode` each disable a check the merge path
// depends on (src/jobs/service.ts:1415 for branch protection, required checks and
// required approvals; :1642 with src/lib/stages.ts:32 for the stage gate),
// `allow_paths`, `deny_paths` and `target_branch` decide what the next merge may
// touch, and `repo_role` decides who may act at all.

function policyRepo(store: Store, userId: string, id: string): RepoRow {
  return store.createRepo({
    id, userId, owner: 'o', name: id.replace(/^repo_policy_/, ''), defaultBranch: 'main', tokenEnc: 'x',
    permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
    requireProtection: true, stageMode: 'enforced',
  })
}

// The same body the settings form posts, so a case that overrides one field
// changes exactly that field and nothing else.
function policyForm(csrf: string, overrides: Record<string, string> = {}): string {
  return formBody({
    csrf,
    repoRole: 'maintainer',
    targetBranch: 'main',
    requireProtection: '1',
    stageMode: 'enforced',
    allowPaths: '',
    denyPaths: '',
    enabled: '1',
    ...overrides,
  })
}

const POLICY_CASES: Array<{ field: string; body: Record<string, string>; read: (repo: RepoRow) => unknown }> = [
  { field: 'require_protection', body: { requireProtection: '0' }, read: (repo) => repo.require_protection },
  { field: 'allow_paths', body: { allowPaths: 'src/**' }, read: (repo) => repo.allow_paths },
  { field: 'deny_paths', body: { denyPaths: 'deploy/**' }, read: (repo) => repo.deny_paths },
  { field: 'target_branch', body: { targetBranch: 'release' }, read: (repo) => repo.target_branch },
  { field: 'repo_role', body: { repoRole: 'developer' }, read: (repo) => repo.repo_role },
  { field: 'stage_mode', body: { stageMode: 'off' }, read: (repo) => repo.stage_mode },
]

test('a stale session cannot move any pre-merge policy field the settings form writes', async () => {
  const { built, store } = await build()
  try {
    const user = makeUser(store, { login: 'policy-stale-fields', status: 'approved' })
    const { raw, cookie, csrf } = sessionFor(built, user)
    clearRecentAuth(store, raw)
    for (const [index, item] of POLICY_CASES.entries()) {
      const repo = policyRepo(store, user.id, `repo_policy_case_${index}`)
      const before = item.read(repo)
      const refused = await built.app.inject({
        method: 'POST',
        url: `/repos/${repo.id}/settings`,
        headers: { cookie, referer: `http://127.0.0.1:9999/repos/${repo.id}#repo-settings`, 'content-type': 'application/x-www-form-urlencoded' },
        payload: policyForm(csrf, item.body),
      })
      assert.equal(refused.statusCode, 302)
      const location = String(refused.headers.location)
      assert.match(location, /^\/auth\/github\/reauthorize\?next=/, `${item.field} must ask GitHub to confirm`)
      assert.deepEqual(item.read(store.getRepo(repo.id)!), before, `a refused save must not change ${item.field}`)
      const audit = store.listAudit(50).find((row) => row.action === 'recent_auth_required' && String(row.detail).includes(`/repos/${repo.id}/settings`))
      assert.ok(audit !== undefined, `the ${item.field} refusal must be audited`)
      assert.match(String(audit.detail), /repo\.policy/, 'the audit row must name the action, not the request body')
    }
  } finally {
    await built.close()
  }
})

// The gate has to be narrow: a save that leaves the policy alone is the normal
// path through this form, and turning it into a login wall would be worse than
// the hole. This one is green before the fix as well, which is the point.
test('a settings save that leaves the policy alone is not refused for a stale session', async () => {
  const { built, store } = await build()
  try {
    const user = makeUser(store, { login: 'policy-stale-unchanged', status: 'approved' })
    const repo = policyRepo(store, user.id, 'repo_policy_unchanged')
    const { raw, cookie, csrf } = sessionFor(built, user)
    clearRecentAuth(store, raw)
    const saved = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/settings`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: policyForm(csrf),
    })
    assert.equal(saved.statusCode, 302)
    assert.doesNotMatch(String(saved.headers.location), /reauthorize/, 'an unrelated save must not ask for a fresh confirmation')
    assert.equal(store.listAudit(50).some((row) => row.action === 'recent_auth_required'), false)
    assert.equal(store.getRepo(repo.id)?.require_protection, 1)
  } finally {
    await built.close()
  }
})

test('a fresh session may change the policy and one submit writes one repo.policy row', async () => {
  const { built, store } = await build()
  try {
    const user = makeUser(store, { login: 'policy-fresh', status: 'approved' })
    const repo = policyRepo(store, user.id, 'repo_policy_fresh')
    const { cookie, csrf } = sessionFor(built, user)
    const saved = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/settings`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: policyForm(csrf, { requireProtection: '0', stageMode: 'off', allowPaths: 'src/**' }),
    })
    assert.equal(saved.statusCode, 302)
    assert.doesNotMatch(String(saved.headers.location), /reauthorize/)
    const updated = store.getRepo(repo.id)!
    assert.equal(updated.require_protection, 0)
    assert.equal(updated.stage_mode, 'off')
    assert.equal(updated.allow_paths, 'src/**')
    const rows = store.listAudit(50).filter((row) => row.action === 'repo.policy')
    assert.equal(rows.length, 1, 'one submit writes one policy row, not one per field')
    assert.equal(rows[0]?.user_id, user.id, 'the row must name the actor')
    assert.match(String(rows[0]?.detail), /require_protection/)
    assert.match(String(rows[0]?.detail), /stage_mode/)
    assert.match(String(rows[0]?.detail), /allow_paths/)
  } finally {
    await built.close()
  }
})

// #460 review: the eight destructive handlers this change touches also have to
// be rate-limited. A stolen cookie (or a page that resubmits itself) must not be
// able to hammer one of them, and the bucket has to be keyed on the client
// address rather than on anything the caller can mint per request.
const DESTRUCTIVE_ATTEMPTS = 61

async function hammerDelete(remoteAddress: string, forwardedFor?: string): Promise<number[]> {
  const { built, store } = await build()
  try {
    const user = makeUser(store, { login: `hammer-${remoteAddress}`, status: 'approved' })
    const repo = repoFor(store, user.id)
    const { raw, cookie, csrf } = sessionFor(built, user)
    // A stale session keeps every attempt side-effect free: each one is refused
    // with the re-auth redirect, so what the loop measures is the limiter.
    clearRecentAuth(store, raw)
    const statuses: number[] = []
    for (let i = 0; i < DESTRUCTIVE_ATTEMPTS; i += 1) {
      const headers: Record<string, string> = { cookie, 'content-type': 'application/x-www-form-urlencoded' }
      if (forwardedFor !== undefined) headers['x-forwarded-for'] = forwardedFor.replace('{n}', String(i + 1))
      const response = await built.app.inject({
        method: 'POST',
        url: `/repos/${repo.id}/delete`,
        headers,
        payload: formBody({ csrf, confirmName: 'dt' }),
        remoteAddress,
      })
      statuses.push(response.statusCode)
    }
    assert.equal(store.getRepo(repo.id) !== undefined, true, 'a refused attempt must not delete the repository')
    return statuses
  } finally {
    await built.close()
  }
}

test('a destructive action is refused with 429 once one client retries it too often', async () => {
  const statuses = await hammerDelete('203.0.113.9')
  assert.equal(statuses[DESTRUCTIVE_ATTEMPTS - 1], 429, `the ${DESTRUCTIVE_ATTEMPTS}th attempt answered ${statuses[DESTRUCTIVE_ATTEMPTS - 1]} instead of 429; statuses ${statuses.join(',')}`)
})

test('a rotating forged X-Forwarded-For does not buy unlimited destructive attempts', async () => {
  const statuses = await hammerDelete('203.0.113.9', '198.51.100.{n}')
  assert.equal(statuses[DESTRUCTIVE_ATTEMPTS - 1], 429, `a forged left end must not mint buckets; statuses ${statuses.join(',')}`)
})
