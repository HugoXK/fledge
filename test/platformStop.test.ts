import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { Jobs, PLATFORM_DRAIN_LIMIT, PLATFORM_STOP_DRAIN_LIMIT } from '../src/jobs/service.js'
import { MockRunner } from '../src/jobs/mock.js'
import { failureBannerSentence } from '../src/lib/failure.js'
import { formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #283: the platform emergency stop. The card asks for one operator action that
// pauses scheduling, refuses every new enqueue with PLATFORM_PAUSED, drains the
// active jobs and survives a restart, and for a resume that clears the stop
// without replaying the set it froze.
//
// Every case here is red on `main` before the feature: `/admin/platform/stop` is
// not a route, `jobs.stopPlatform` is not a method, and `enqueue()` answers
// `ok: true` while the platform is stopped. That is the point of the file.

const posting = (session: { cookie: string; csrf: string }): Record<string, string> => ({
  cookie: session.cookie,
  'content-type': 'application/x-www-form-urlencoded',
})

interface PlatformFixture {
  built: Awaited<ReturnType<typeof buildApp>>
  store: Store
  admin: ReturnType<typeof makeUser>
  owner: ReturnType<typeof makeUser>
  // A repository with a job already running: the drain target.
  busy: ReturnType<Store['createRepo']>
  // A repository that is due on the next tick and has no active job, so the
  // scheduler would enqueue for it if nothing stopped it.
  due: ReturnType<Store['createRepo']>
}

async function platformFixture(): Promise<PlatformFixture> {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  const admin = makeUser(store, { login: 'platform-admin', admin: true, status: 'approved' })
  const owner = makeUser(store, { login: 'platform-owner', status: 'approved' })
  const base = { userId: owner.id, owner: 'acme', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', intervalMinutes: 1440 }
  const busy = store.createRepo({ ...base, id: 'repo_platform_busy', name: 'busy', autoIterate: false })
  const due = store.createRepo({ ...base, id: 'repo_platform_due', name: 'due', autoIterate: true })
  store.createApiToken({ id: 'tok_platform_busy', userId: owner.id, kind: 'job', name: 'job:job_platform_busy', tokenHash: 'platform-busy-hash', prefix: 'flg_plat', expiresAt: null })
  store.createJob({ id: 'job_platform_busy', repoId: busy.id, userId: owner.id, trigger: 'manual', goal: 'g', callbackHash: 'cb-platform-busy', platformTokenHash: 'platform-busy-hash' })
  store.updateJob('job_platform_busy', { status: 'running' })
  return { built, store, admin, owner, busy, due }
}

function stopAudits(store: Store): number {
  return store.listAuditPageForUsers(null, 100, 0).filter((row) => row.action === 'platform.stopped').length
}

test('a platform stop refuses new enqueues, drains the running job and records one audit row', async () => {
  const f = await platformFixture()
  try {
    const session = sessionFor(f.built, f.admin)
    const stopped = await f.built.app.inject({
      method: 'POST',
      url: '/admin/platform/stop',
      headers: posting(session),
      payload: formBody({ csrf: session.csrf, reason: 'provider outage' }),
    })
    assert.equal(stopped.statusCode, 302)

    const stop = f.built.jobs.platformStop()
    assert.ok(stop !== null, 'the stop was not persisted, so a restart would silently resume')
    assert.equal(stop.by, 'platform-admin')
    assert.equal(stop.reason, 'provider outage')
    assert.equal(f.store.getJob('job_platform_busy')?.status, 'paused', 'the running job was not paused')
    assert.equal(f.store.findApiToken('platform-busy-hash'), undefined, 'the running job kept its platform token')

    // A manual enqueue is refused with the stable code, not with a generic refusal.
    // It is posted as the repository owner, which is who can enqueue at all: the
    // admin session is not the owner of this repository and would 404 first.
    const enqueueSession = sessionFor(f.built, f.owner)
    const refused = await f.built.app.inject({
      method: 'POST',
      url: `/repos/${f.due.id}/run`,
      headers: posting(enqueueSession),
      payload: formBody({ csrf: enqueueSession.csrf }),
    })
    assert.equal(refused.statusCode, 302)
    assert.match(String(refused.headers.location), /[?&]error=PLATFORM_PAUSED(?:%3A|:)/)

    // What the user reads is the banner template, not the shorter inline message
    // the service returns: `failureSentence` resolves the code against
    // `REFUSAL_SENTENCES` first and only falls through to the writer's text when
    // the code has no entry. Pin the exact sentence in both languages, so the two
    // strings cannot drift apart again without this failing.
    assert.equal(
      failureBannerSentence('en', 'PLATFORM_PAUSED'),
      'The platform is stopped for an emergency, so no new job is accepted; retry once an admin resumes it.',
    )
    assert.equal(failureBannerSentence('zh', 'PLATFORM_PAUSED'), '平台已紧急停止，暂不接受新任务；等管理员恢复后再试。')

    // The scheduler does not enqueue for a due repository either: the guard has
    // to be in the admission path, not only on the route.
    await f.built.jobs.tick()
    assert.equal(f.store.listJobsForRepo(f.due.id).length, 0, 'the scheduler enqueued while the platform was stopped')

    assert.equal(stopAudits(f.store), 1, 'the stop did not leave exactly one audit row')
  } finally {
    await f.built.close()
  }
})

test('resume clears the stop, replays nothing, and names the repositories due on the next tick', async () => {
  const f = await platformFixture()
  try {
    const session = sessionFor(f.built, f.admin)
    await f.built.app.inject({
      method: 'POST',
      url: '/admin/platform/stop',
      headers: posting(session),
      payload: formBody({ csrf: session.csrf, reason: 'credential leak' }),
    })
    const jobsWhileStopped = f.store.listJobsForRepo(f.due.id).length

    const resumed = await f.built.app.inject({
      method: 'POST',
      url: '/admin/platform/resume',
      headers: posting(session),
      payload: formBody({ csrf: session.csrf }),
    })
    assert.equal(resumed.statusCode, 302)
    assert.equal(f.built.jobs.platformStop(), null, 'resume left the stop in place')
    // Resume itself must not re-enqueue the frozen set; only the next tick decides.
    assert.equal(f.store.listJobsForRepo(f.due.id).length, jobsWhileStopped, 'resume replayed the frozen set')
    // The operator is told which repositories are due next, before they happen.
    assert.match(decodeURIComponent(String(resumed.headers.location)), /acme\/due/)

    await f.built.jobs.tick()
    assert.equal(f.store.listJobsForRepo(f.due.id).length, 1, 'the scheduler did not enqueue after resume')
    assert.equal(stopAudits(f.store), 1, 'the stop audit was written more than once')
  } finally {
    await f.built.close()
  }
})

test('a second stop while stopped keeps the original record and writes no second audit row', async () => {
  const f = await platformFixture()
  try {
    const session = sessionFor(f.built, f.admin)
    for (const reason of ['first reason', 'second reason']) {
      const response = await f.built.app.inject({
        method: 'POST',
        url: '/admin/platform/stop',
        headers: posting(session),
        payload: formBody({ csrf: session.csrf, reason }),
      })
      assert.equal(response.statusCode, 302)
    }
    assert.equal(f.built.jobs.platformStop()?.reason, 'first reason', 'a second stop overwrote who stopped the platform and why')
    assert.equal(stopAudits(f.store), 1)
  } finally {
    await f.built.close()
  }
})

test('a non-admin cannot stop or resume the platform', async () => {
  const f = await platformFixture()
  try {
    const stranger = sessionFor(f.built, f.owner)
    const refused = await f.built.app.inject({
      method: 'POST',
      url: '/admin/platform/stop',
      headers: posting(stranger),
      payload: formBody({ csrf: stranger.csrf, reason: 'not mine to stop' }),
    })
    assert.equal(refused.statusCode, 403)
    assert.equal(f.built.jobs.platformStop(), null)
    assert.equal(f.store.getJob('job_platform_busy')?.status, 'running', 'a refused stop still drained the job')

    const admin = sessionFor(f.built, f.admin)
    await f.built.app.inject({
      method: 'POST',
      url: '/admin/platform/stop',
      headers: posting(admin),
      payload: formBody({ csrf: admin.csrf, reason: 'abuse report' }),
    })
    assert.notEqual(f.built.jobs.platformStop(), null)

    const refusedResume = await f.built.app.inject({
      method: 'POST',
      url: '/admin/platform/resume',
      headers: posting(stranger),
      payload: formBody({ csrf: stranger.csrf }),
    })
    assert.equal(refusedResume.statusCode, 403)
    assert.notEqual(f.built.jobs.platformStop(), null, 'a refused resume cleared the stop')
  } finally {
    await f.built.close()
  }
})

test('a stop disables no repository and deletes no row', async () => {
  const f = await platformFixture()
  try {
    const before = {
      repos: f.store.listUsers().length,
      jobs: f.store.countJobs(),
      enabled: [f.store.getRepo(f.busy.id)?.enabled, f.store.getRepo(f.due.id)?.enabled],
    }
    const session = sessionFor(f.built, f.admin)
    const stopped = await f.built.app.inject({
      method: 'POST',
      url: '/admin/platform/stop',
      headers: posting(session),
      payload: formBody({ csrf: session.csrf, reason: 'spend runaway' }),
    })
    // Without this line the case would pass on a tree that has no stop at all:
    // "nothing was deleted" is only evidence once something happened.
    assert.equal(stopped.statusCode, 302)
    assert.notEqual(f.built.jobs.platformStop(), null)
    assert.equal(f.store.countJobs(), before.jobs, 'the stop deleted a job row')
    assert.equal(f.store.listUsers().length, before.repos)
    assert.deepEqual([f.store.getRepo(f.busy.id)?.enabled, f.store.getRepo(f.due.id)?.enabled], before.enabled)
    assert.equal(f.store.getRepo(f.busy.id)?.enabled, 1)
    assert.equal(f.store.getRepo(f.due.id)?.enabled, 1)
    // A paused job is still a row with its history: the drain stops work, not data.
    assert.ok(f.store.getJob('job_platform_busy') !== undefined)
  } finally {
    await f.built.close()
  }
})

test('a super admin can still stop while the admin panel is degraded to read-only', async () => {
  const f = await platformFixture()
  try {
    const owner = makeUser(f.store, { login: 'platform-root', superadmin: true, status: 'approved' })
    const session = sessionFor(f.built, owner)
    const preview = { ...posting(session), cookie: `${session.cookie}; fledge_preview=user` }

    // The degraded panel proves itself: the admin page itself refuses to render.
    const panel = await f.built.app.inject({ method: 'GET', url: '/admin', headers: { cookie: preview.cookie } })
    assert.equal(panel.statusCode, 302)
    assert.equal(panel.headers.location, '/console')

    const stopped = await f.built.app.inject({
      method: 'POST',
      url: '/admin/platform/stop',
      headers: preview,
      payload: formBody({ csrf: session.csrf, reason: 'panel degraded' }),
    })
    assert.equal(stopped.statusCode, 302)
    assert.notEqual(f.built.jobs.platformStop(), null, 'the read-only panel also blocked the emergency stop')
  } finally {
    await f.built.close()
  }
})

test('without a bridge a running job is cancelled with a terminal reason instead of paused', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, new MockRunner(), new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'no-bridge-owner', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_no_bridge',
      userId: user.id,
      owner: 'acme',
      name: 'nobridge',
      defaultBranch: 'main',
      tokenEnc: 'x',
      permission: 'admin',
      repoRole: 'maintainer',
      goal: '',
      autoIterate: false,
      intervalMinutes: 1440,
    })
    store.createApiToken({ id: 'tok_no_bridge', userId: user.id, kind: 'job', name: 'job:job_no_bridge', tokenHash: 'no-bridge-hash', prefix: 'flg_nobr', expiresAt: null })
    store.createJob({ id: 'job_no_bridge', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb-no-bridge', platformTokenHash: 'no-bridge-hash' })
    store.updateJob('job_no_bridge', { status: 'running' })

    const outcome = await jobs.stopPlatform({ id: user.id, login: 'no-bridge-root' }, 'bridge down')
    assert.equal(outcome.cancelled, 1, 'a job with no bridge to pause was not cancelled')
    assert.equal(store.getJob('job_no_bridge')?.status, 'cancelled')
    assert.match(String(store.getJob('job_no_bridge')?.error), /停止|emergency/i)
    assert.equal(store.findApiToken('no-bridge-hash'), undefined)
  } finally {
    store.close()
  }
})

test('a burst against the stop and resume routes is refused at the same threshold as the other mutating forms', async () => {
  const f = await platformFixture()
  try {
    const session = sessionFor(f.built, f.admin)
    // 30 requests per minute is the window the other mutating form in this file
    // (`POST /approve/:token`) uses, so the 31st request in the window is the
    // first refusal, and it is refused before it can act.
    const allowed: number[] = []
    for (let i = 0; i < 30; i += 1) {
      const response = await f.built.app.inject({
        method: 'POST',
        url: '/admin/platform/stop',
        headers: posting(session),
        payload: formBody({ csrf: session.csrf, reason: `burst ${i}` }),
      })
      allowed.push(response.statusCode)
    }
    assert.deepEqual([...new Set(allowed)], [302], 'the stop route closed the window early')

    const refused = await f.built.app.inject({
      method: 'POST',
      url: '/admin/platform/stop',
      headers: posting(session),
      payload: formBody({ csrf: session.csrf, reason: 'burst refused' }),
    })
    assert.equal(refused.statusCode, 429, 'a burst past the form threshold was accepted')
    assert.match(String(refused.headers['content-type']), /text\/html/, 'a form route answered a browser with a machine body')
    // The limiter has to run before the action: the refused call wrote no second
    // audit row and did not re-drain the platform.
    assert.equal(stopAudits(f.store), 1)
    assert.equal(f.built.jobs.platformStop()?.reason, 'burst 0', 'the refused stop overwrote the record')

    const resumeAllowed: number[] = []
    for (let i = 0; i < 30; i += 1) {
      const response = await f.built.app.inject({
        method: 'POST',
        url: '/admin/platform/resume',
        headers: posting(session),
        payload: formBody({ csrf: session.csrf }),
      })
      resumeAllowed.push(response.statusCode)
    }
    assert.deepEqual([...new Set(resumeAllowed)], [302], 'the resume route closed the window early')

    const resumeRefused = await f.built.app.inject({
      method: 'POST',
      url: '/admin/platform/resume',
      headers: posting(session),
      payload: formBody({ csrf: session.csrf }),
    })
    assert.equal(resumeRefused.statusCode, 429, 'a burst past the form threshold was accepted on resume')
    const resumedAudits = f.store.listAuditPageForUsers(null, 100, 0).filter((row) => row.action === 'platform.resumed').length
    assert.equal(resumedAudits, 1, 'the refused resume wrote another audit row')
  } finally {
    await f.built.close()
  }
})

test('a stop drains past the inline bound on the following ticks and records the completion', async () => {
  const f = await platformFixture()
  try {
    // The fixture already carries one running job. Add enough that neither the
    // inline pass nor one tick can finish them, which is the case the old suite
    // never built: the thirty-iteration loop above is the HTTP limiter, not the
    // job bound.
    const extra = PLATFORM_STOP_DRAIN_LIMIT + PLATFORM_DRAIN_LIMIT
    for (let i = 0; i < extra; i += 1) {
      const repo = f.store.createRepo({
        userId: f.owner.id,
        id: `repo_drain_${i}`,
        name: `drain-${i}`,
        owner: 'acme',
        defaultBranch: 'main',
        tokenEnc: 'x',
        permission: 'admin',
        repoRole: 'maintainer',
        goal: '',
        intervalMinutes: 1440,
        autoIterate: false,
      })
      const tokenHash = `drain-hash-${i}`
      f.store.createApiToken({ id: `tok_drain_${i}`, userId: f.owner.id, kind: 'job', name: `job:job_drain_${i}`, tokenHash, prefix: 'flg_drn', expiresAt: null })
      f.store.createJob({ id: `job_drain_${i}`, repoId: repo.id, userId: f.owner.id, trigger: 'manual', goal: 'g', callbackHash: `cb-drain-${i}`, platformTokenHash: tokenHash })
      f.store.updateJob(`job_drain_${i}`, { status: 'running' })
    }
    const total = extra + 1

    const stopped = await f.built.jobs.stopPlatform({ id: f.admin.id, login: f.admin.login }, 'mass outage')
    assert.equal(stopped.left, total - PLATFORM_STOP_DRAIN_LIMIT, 'the stop drained past its inline bound')
    assert.equal(f.store.listActiveJobs().length, total - PLATFORM_STOP_DRAIN_LIMIT)

    // One tick, one bounded pass; the pass that reaches the end records the
    // completion. Without the tick step the remainder stayed active with valid
    // platform tokens while the platform said it was stopped.
    await f.built.jobs.tick()
    assert.equal(
      f.store.listActiveJobs().length,
      total - PLATFORM_STOP_DRAIN_LIMIT - PLATFORM_DRAIN_LIMIT,
      'the tick did not drain up to its own bound',
    )
    await f.built.jobs.tick()
    assert.equal(f.store.listActiveJobs().length, 0, 'jobs past the inline bound were still active while the platform was stopped')

    const actions = f.store.listAuditPageForUsers(null, 200, 0).map((row) => row.action)
    assert.ok(actions.includes('platform.drain_incomplete'), 'the first bounded pass left work with no audit row saying so')
    assert.ok(actions.includes('platform.drain_complete'), 'the drain finished without recording its completion')
    for (let i = 0; i < extra; i += 1) {
      assert.equal(f.store.findApiToken(`drain-hash-${i}`), undefined, `job_drain_${i} kept its platform token past the drain`)
    }
    assert.equal(f.store.findApiToken('platform-busy-hash'), undefined)
  } finally {
    await f.built.close()
  }
})
