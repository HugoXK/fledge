import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #1052: the schedule console rendered Save, Delete, Pause and Resume to roles the
// routes already refuse. `ownedRepo` refuses every mutating schedule route for a
// viewer, and pause/resume additionally require a maintainer — so a control the
// reader cannot use is a button whose only answer is a 403. Every case drives the
// real console route and then the control it renders, because the defect is the
// gap between the page and the route rather than either one alone.

interface Harness {
  store: Store
  built: Awaited<ReturnType<typeof buildApp>>
  owner: ReturnType<typeof makeUser>
  developer: ReturnType<typeof makeUser>
  viewer: ReturnType<typeof makeUser>
  repo: ReturnType<Store['createRepo']>
  close: () => Promise<void>
}

async function harness(): Promise<Harness> {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), startScheduler: false })
  const owner = makeUser(store, { login: `owner-${Math.random().toString(36).slice(2, 8)}`, status: 'approved' })
  const developer = makeUser(store, { login: `dev-${Math.random().toString(36).slice(2, 8)}`, status: 'approved' })
  const viewer = makeUser(store, { login: `viewer-${Math.random().toString(36).slice(2, 8)}`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_${Math.random().toString(36).slice(2, 8)}`,
    userId: owner.id,
    owner: 'o',
    name: 'r',
    defaultBranch: 'main',
    tokenEnc: '',
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  store.addRepoMember({ repoId: repo.id, userId: developer.id, role: 'developer', grantedBy: owner.id })
  store.addRepoMember({ repoId: repo.id, userId: viewer.id, role: 'viewer', grantedBy: owner.id })
  // A schedule must exist for Pause/Resume to be offered at all.
  store.saveSchedule({
    id: `sch_${Math.random().toString(36).slice(2, 8)}`,
    repoId: repo.id,
    kind: 'cron',
    expression: '0 9 * * 1-5',
    timezone: 'Asia/Shanghai',
  })
  return { store, built, owner, developer, viewer, repo, close: () => built.close() }
}

function consolePage(h: Harness, user: ReturnType<typeof makeUser>, session: { cookie: string }): Promise<{ statusCode: number; body: string }> {
  return h.built.app.inject({ method: 'GET', url: `/repos/${h.repo.id}/schedule`, headers: { cookie: `${session.cookie}; fledge_lang=en` } })
}

function sessionOf(h: Harness, user: ReturnType<typeof makeUser>): { cookie: string; csrf: string } {
  return sessionFor(h.built, user)
}

test('the console offers a viewer no control the routes refuse', async () => {
  const h = await harness()
  try {
    const session = sessionOf(h, h.viewer)
    const page = await consolePage(h, h.viewer, session)
    assert.equal(page.statusCode, 200)
    // The page is still readable: this is a read-only console, not a refusal page.
    assert.match(page.body, /data-schedule-kind="cron"/)
    assert.doesNotMatch(page.body, /action="\/repos\/[^"]*\/schedule"/, 'no save form for a viewer')
    assert.doesNotMatch(page.body, /\/schedule\/remove/, 'no delete form for a viewer')
    assert.doesNotMatch(page.body, /\/schedule\/pause/, 'no pause form for a viewer')
    assert.doesNotMatch(page.body, /\/schedule\/resume/, 'no resume form for a viewer')
    assert.doesNotMatch(page.body, /\/schedule\/run-now/, 'no run-now form for a viewer')
    assert.match(page.body, /data-schedule-write-role="viewer"/, 'the page says which role may write')

    // And the route agrees with the page it no longer renders.
    const refused = await h.built.app.inject({
      method: 'POST',
      url: `/repos/${h.repo.id}/schedule`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: session.cookie },
      payload: formBody({ csrf: session.csrf, cron: '0 9 * * *', timezone: 'Asia/Shanghai' }),
    })
    assert.equal(refused.statusCode, 403, 'the save the viewer cannot see is also refused')
  } finally {
    await h.close()
  }
})

test('a developer saves and deletes, and is not offered pause or resume', async () => {
  const h = await harness()
  try {
    const session = sessionOf(h, h.developer)
    const page = await consolePage(h, h.developer, session)
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /action="\/repos\/[^"]*\/schedule"/, 'the developer sees the save form')
    assert.match(page.body, /data-confirm=/, 'the developer sees the delete control')
    assert.doesNotMatch(page.body, /\/schedule\/pause/, 'pause is a maintainer control')
    assert.doesNotMatch(page.body, /\/schedule\/resume/, 'resume is a maintainer control')
    assert.match(page.body, /data-pause-role="developer"/, 'the page says which role may pause')

    // The rendered Save is a working control for this role.
    const saved = await h.built.app.inject({
      method: 'POST',
      url: `/repos/${h.repo.id}/schedule`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: session.cookie },
      payload: formBody({ csrf: session.csrf, every: '2h' }),
    })
    assert.equal(saved.statusCode, 302)
    assert.equal(h.store.scheduleForRepo(h.repo.id)?.every_ms, 2 * 60 * 60 * 1000)
    // The pause the developer cannot see is also refused.
    const pause = await h.built.app.inject({
      method: 'POST',
      url: `/repos/${h.repo.id}/schedule/pause`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: session.cookie },
      payload: formBody({ csrf: session.csrf }),
    })
    assert.equal(pause.statusCode, 403)
  } finally {
    await h.close()
  }
})

test('a maintainer sees every control, and they all answer', async () => {
  const h = await harness()
  try {
    const session = sessionOf(h, h.owner)
    const page = await consolePage(h, h.owner, session)
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /action="\/repos\/[^"]*\/schedule"/)
    assert.match(page.body, /\/schedule\/remove/)
    assert.match(page.body, /\/schedule\/pause/)
    assert.match(page.body, /\/schedule\/run-now/)
    assert.doesNotMatch(page.body, /data-pause-role=/)
    assert.doesNotMatch(page.body, /data-schedule-write-role=/)

    const pause = await h.built.app.inject({
      method: 'POST',
      url: `/repos/${h.repo.id}/schedule/pause`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: session.cookie },
      payload: formBody({ csrf: session.csrf }),
    })
    assert.equal(pause.statusCode, 302)
    assert.equal(h.store.scheduleForRepo(h.repo.id)?.status, 'paused')
    // Paused now renders Resume, still to a maintainer.
    const after = await consolePage(h, h.owner, session)
    assert.match(after.body, /\/schedule\/resume/)
    assert.doesNotMatch(after.body, /\/schedule\/pause/)
  } finally {
    await h.close()
  }
})
