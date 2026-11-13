import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #539: Fledge keeps job history and a prose carry-over block, but no durable,
// queryable project memory. This slice is the smallest thing a person can use end
// to end on the repository page: write an entry under a revision fence, have it
// scoped to `project` or one role, read an exact revision, and find entries with a
// bounded keyword lookup.
//
// Every case below drives the HTTP routes, because the defect class this card
// exists for — a write that silently overwrites, or a role that reads past its
// audience — is invisible to a helper-level test.

interface Harness {
  store: Store
  built: Awaited<ReturnType<typeof buildApp>>
  user: ReturnType<typeof makeUser>
  repo: ReturnType<Store['createRepo']>
  cookie: string
  csrf: string
  close: () => Promise<void>
}

async function harness(options: { repoRole?: 'maintainer' | 'developer'; permission?: string } = {}): Promise<Harness> {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), startScheduler: false })
  const user = makeUser(store, { login: `memory-${Math.random().toString(36).slice(2, 8)}`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_${Math.random().toString(36).slice(2, 8)}`,
    userId: user.id,
    owner: 'owner',
    name: 'repo',
    defaultBranch: 'main',
    upstreamHtmlUrl: 'https://github.com/owner/repo',
    tokenEnc: 'x',
    permission: (options.permission ?? 'admin') as 'admin',
    repoRole: options.repoRole ?? 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  const session = sessionFor(built, user)
  return { store, built, user, repo, cookie: session.cookie, csrf: session.csrf, close: () => built.close() }
}

function page(h: Harness, query = ''): Promise<{ statusCode: number; body: string }> {
  return h.built.app.inject({
    method: 'GET',
    url: `/repos/${h.repo.id}/memory${query}`,
    headers: { cookie: `${h.cookie}; fledge_lang=en` },
  })
}

function write(
  h: Harness,
  values: Record<string, string>,
): Promise<{ statusCode: number; headers: Record<string, unknown> }> {
  return h.built.app.inject({
    method: 'POST',
    url: `/repos/${h.repo.id}/memory`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `${h.cookie}; fledge_lang=en` },
    payload: formBody({ csrf: h.csrf, ...values }),
  })
}

function entry(values: Record<string, string> = {}): Record<string, string> {
  return {
    key: 'migrations',
    kind: 'decision',
    status: 'active',
    verification: 'human_asserted',
    audience: 'project',
    scope: 'src/db.ts',
    body: 'Migrations are additive and idempotent; never rewrite a released migration.',
    reason: 'recorded while closing #539',
    expected_revision: '0',
    ...values,
  }
}

function location(response: { headers: Record<string, unknown> }): string {
  return String(response.headers.location ?? '')
}

function digest(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

test('a person can write a memory entry and see it on the repository page', async () => {
  const h = await harness()
  try {
    const empty = await page(h)
    assert.equal(empty.statusCode, 200, 'the page exists before the first entry')
    assert.match(empty.body, /data-memory-empty="true"/, 'an empty store is an explicit empty state')

    const created = await write(h, entry())
    assert.equal(created.statusCode, 302)
    assert.match(location(created), /saved=1/)

    const after = await page(h, '?key=migrations')
    assert.equal(after.statusCode, 200)
    assert.match(after.body, /data-memory-key="migrations"/)
    assert.match(after.body, /data-memory-revision="1"/)
    assert.match(after.body, /data-memory-kind="decision"/)
    assert.match(after.body, /data-memory-audience="project"/)
    assert.match(after.body, new RegExp(`data-memory-digest="${digest(entry().body ?? '')}"`))
  } finally {
    await h.close()
  }
})

test('a stale expected_revision is rejected and leaves the current entry untouched', async () => {
  const h = await harness()
  try {
    await write(h, entry())
    const second = await write(h, entry({ expected_revision: '1', body: 'Second body the reviewer wrote.' }))
    assert.equal(second.statusCode, 302)
    assert.match(location(second), /saved=1/)

    // A writer that still believes revision 1 is current must not win.
    const stale = await write(h, entry({ expected_revision: '1', body: 'Overwritten by a stale writer.' }))
    assert.equal(stale.statusCode, 302)
    assert.match(location(stale), /conflict=2/, 'the redirect names the revision that actually won')

    const shown = await page(h, '?key=migrations')
    assert.match(shown.body, /Second body the reviewer wrote\./)
    assert.doesNotMatch(shown.body, /Overwritten by a stale writer\./)
    assert.match(shown.body, /data-memory-revision="2"/)
    assert.match(shown.body, /data-memory-version-count="2"/, 'the rejected write appended no version')
  } finally {
    await h.close()
  }
})

test('an identical write is a no-op rather than a new revision', async () => {
  const h = await harness()
  try {
    await write(h, entry())
    const again = await write(h, entry({ expected_revision: '1' }))
    assert.equal(again.statusCode, 302)
    assert.match(location(again), /unchanged=1/)
    const shown = await page(h, '?key=migrations')
    assert.match(shown.body, /data-memory-revision="1"/)
    assert.match(shown.body, /data-memory-version-count="1"/)
  } finally {
    await h.close()
  }
})

test('a role entry is invisible to the other role, even to an administrator acting as that role', async () => {
  const h = await harness({ repoRole: 'maintainer', permission: 'admin' })
  try {
    assert.equal((await write(h, entry({ key: 'shared-rule', audience: 'project' }))).statusCode, 302)
    const scoped = await write(h, entry({ key: 'maintainer-only', audience: 'role:maintainer' }))
    assert.equal(scoped.statusCode, 302)
    assert.match(location(scoped), /saved=1/)

    const maintainerView = await page(h)
    assert.match(maintainerView.body, /data-memory-key="shared-rule"/)
    assert.match(maintainerView.body, /data-memory-key="maintainer-only"/)

    // The same repository, read while acting as the developer role: the shared
    // entry stays, the maintainer entry disappears — including from a direct
    // exact-version read, so the audience is not a list-page filter.
    h.store.updateRepo(h.repo.id, { repo_role: 'developer' })
    const developerView = await page(h)
    assert.match(developerView.body, /data-memory-key="shared-rule"/)
    assert.doesNotMatch(developerView.body, /data-memory-key="maintainer-only"/)
    const direct = await page(h, '?key=maintainer-only')
    assert.equal(direct.statusCode, 404, 'an entry outside the audience is reported as absent')

    // A writer who may only act as a developer cannot plant a maintainer entry.
    h.store.updateRepo(h.repo.id, { permission: 'write' })
    const forge = await write(h, entry({ key: 'forged', audience: 'role:maintainer' }))
    assert.equal(forge.statusCode, 302)
    assert.match(location(forge), /refused=role_not_allowed/)
  } finally {
    await h.close()
  }
})

test('reading an old revision returns the old body and marks it historical', async () => {
  const h = await harness()
  try {
    await write(h, entry({ body: 'First body.' }))
    await write(h, entry({ expected_revision: '1', body: 'Second body.' }))

    const current = await page(h, '?key=migrations')
    assert.match(current.body, /data-memory-historical="false"/)
    assert.match(current.body, /Second body\./)

    const old = await page(h, '?key=migrations&rev=1')
    assert.equal(old.statusCode, 200)
    assert.match(old.body, /data-memory-historical="true"/)
    assert.match(old.body, /First body\./)
    assert.match(old.body, new RegExp(`data-memory-digest="${digest('First body.')}"`), 'the digest is of that exact version')
  } finally {
    await h.close()
  }
})

test('search is a bounded keyword lookup over the visible entries only', async () => {
  const h = await harness()
  try {
    await write(h, entry({ key: 'migrations', body: 'Additive migrations only.' }))
    await write(h, entry({ key: 'deploy', body: 'The deploy gate is fail-closed.', scope: 'src/lib/deploy.ts' }))

    const hit = await page(h, '?q=deploy')
    assert.match(hit.body, /data-memory-key="deploy"/)
    assert.doesNotMatch(hit.body, /data-memory-key="migrations"/)

    const byScope = await page(h, '?q=src%2Flib%2Fdeploy.ts')
    assert.match(byScope.body, /data-memory-key="deploy"/)

    // The bound is stated, not implied: an over-long query is refused by name and
    // does not silently become a prefix search.
    const long = await page(h, `?q=${'x'.repeat(200)}`)
    assert.equal(long.statusCode, 200)
    assert.match(long.body, /data-memory-refused="query_too_long"/)
  } finally {
    await h.close()
  }
})
