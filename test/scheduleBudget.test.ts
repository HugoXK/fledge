import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { Jobs } from '../src/jobs/service.js'
import type { Runner, RunnerContext } from '../src/jobs/runner.js'
import { scheduleConsole } from '../src/schedules/console.js'
import { formBody, MemoryMailer, makeUser, sessionFor, testConfig } from './helpers.js'

// #544 slice 6: the schedule layer of the layered budget. A schedule may carry a
// daily run limit. At the limit a due instant is a `skipped` row with a reason
// instead of a run, and the count is charged by the instant's logical UTC day, so
// a late run stays in the day it was scheduled for. Today no limit exists, so the
// tick dispatches whatever the planner says is due.

const DAY = 86_400_000
const HOUR = 3_600_000

// -- the worker, where the limit stops a dispatch ---------------------------

interface Harness {
  store: Store
  jobs: Jobs
  contexts: RunnerContext[]
  userId: string
  repoId: string
}

function harness(name: string): Harness {
  const config = testConfig()
  const store = new Store(':memory:')
  const contexts: RunnerContext[] = []
  const runner: Runner = {
    name: 'capture',
    async run(context) {
      contexts.push(context)
      return { status: 'running' }
    },
  }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  const user = makeUser(store, { login: `${name}-user`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_${name}`, userId: user.id, owner: 'o', name,
    defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
    repoRole: 'developer', goal: 'fix bugs', autoIterate: true,
    intervalMinutes: 1440,
  })
  return { store, jobs, contexts, userId: user.id, repoId: repo.id }
}

// One due instant, ten days in the past, so the instant's UTC day is stable and
// the day it is charged to can be seeded with the rows an earlier run would have
// left. The interval is far longer than the gap, so exactly one instant is due.
function dueInstant(): { due: number; startAt: number } {
  const due = Date.now() - 10 * DAY
  return { due, startAt: due - 30 * DAY }
}

function utcDayStart(at: number): number {
  return Math.floor(at / DAY) * DAY
}

function anchorAt(store: Store, repoId: string, at: number): void {
  store.run('UPDATE schedules SET created_at = ?, last_occurrence_at = ? WHERE repo_id = ?', new Date(at).toISOString(), at, repoId)
}

test('a schedule at its daily run limit records the due instant as skipped and dispatches nothing', async () => {
  const h = harness('budget-exhausted')
  try {
    const { due, startAt } = dueInstant()
    h.store.saveSchedule({ id: 'sch_budget', repoId: h.repoId, kind: 'interval', everyMs: 30 * DAY, startAt, dailyRuns: 2 })
    anchorAt(h.store, h.repoId, startAt)
    h.store.createWorkItem({ id: 'work_budget', repoId: h.repoId, userId: h.userId, title: 'fix it', issueUrl: 'https://github.com/o/mb/issues/1', state: 'triaged' })

    // Two instants already ran in the day this one belongs to.
    const day = utcDayStart(due)
    for (const at of [day, day + HOUR]) {
      h.store.recordScheduleOccurrence({
        id: `occ_seed_${at}`, scheduleId: 'sch_budget', repoId: h.repoId,
        logicalTime: at, timingRevision: 1, state: 'dispatched', jobId: 'job_seed',
      })
    }

    await h.jobs.tick()

    assert.equal(h.store.listJobsForRepo(h.repoId).length, 0, 'the limit stops the run before a job exists')
    const rows = h.store.listScheduleOccurrences(h.repoId, 20)
    const stopped = rows.find((row) => row.logical_time === due)
    assert.ok(stopped !== undefined, 'the due instant is decided, not silently dropped')
    assert.equal(stopped.state, 'skipped')
    assert.equal(stopped.reason, 'budget-exceeded')
    assert.equal(rows.filter((row) => row.state === 'dispatched').length, 2, 'nothing new ran')

    const cursor = h.store.scheduleForRepo(h.repoId)?.last_occurrence_at ?? 0
    assert.ok(cursor >= due, 'the cursor moves past the instant, or every tick re-decides it')
    await h.jobs.tick()
    assert.equal(h.store.listScheduleOccurrences(h.repoId, 20).length, 3, 'a second tick adds no row for the same instant')
  } finally {
    h.store.close()
  }
})

test('a schedule below its daily limit dispatches the instant and attributes the run', async () => {
  const h = harness('budget-room')
  try {
    const { due, startAt } = dueInstant()
    h.store.saveSchedule({ id: 'sch_room', repoId: h.repoId, kind: 'interval', everyMs: 30 * DAY, startAt, dailyRuns: 2 })
    anchorAt(h.store, h.repoId, startAt)
    h.store.createWorkItem({ id: 'work_room', repoId: h.repoId, userId: h.userId, title: 'fix it', issueUrl: 'https://github.com/o/mr/issues/1', state: 'triaged' })
    const day = utcDayStart(due)
    h.store.recordScheduleOccurrence({
      id: 'occ_room_seed', scheduleId: 'sch_room', repoId: h.repoId,
      logicalTime: day, timingRevision: 1, state: 'dispatched', jobId: 'job_seed',
    })

    await h.jobs.tick()

    const jobs = h.store.listJobsForRepo(h.repoId)
    assert.equal(jobs.length, 1, 'one run is still allowed')
    const row = h.store.listScheduleOccurrences(h.repoId, 20).find((entry) => entry.logical_time === due)
    assert.ok(row !== undefined)
    assert.equal(row.state, 'dispatched', 'the run is attributed to the instant it was scheduled for')
    assert.equal(row.job_id, jobs[0]!.id)
  } finally {
    h.store.close()
  }
})

test('the count is charged to the instant s own day, so crossing midnight grants no fresh budget', async () => {
  const h = harness('budget-midnight')
  try {
    const { due, startAt } = dueInstant()
    h.store.saveSchedule({ id: 'sch_midnight', repoId: h.repoId, kind: 'interval', everyMs: 30 * DAY, startAt, dailyRuns: 1 })
    anchorAt(h.store, h.repoId, startAt)
    h.store.createWorkItem({ id: 'work_midnight', repoId: h.repoId, userId: h.userId, title: 'fix it', issueUrl: 'https://github.com/o/mm/issues/1', state: 'triaged' })
    // The instant before this one ran in the previous logical day; it does not
    // spend this day's allowance.
    const day = utcDayStart(due)
    h.store.recordScheduleOccurrence({
      id: 'occ_prev_day', scheduleId: 'sch_midnight', repoId: h.repoId,
      logicalTime: day - 1, timingRevision: 1, state: 'dispatched', jobId: 'job_yesterday',
    })

    await h.jobs.tick()

    assert.equal(h.store.listJobsForRepo(h.repoId).length, 1, 'a new logical day starts with its own budget')
  } finally {
    h.store.close()
  }
})

test('a project daily limit stops an instant the schedule would allow', async () => {
  const h = harness('budget-project')
  try {
    const { due, startAt } = dueInstant()
    h.store.saveSchedule({ id: 'sch_project', repoId: h.repoId, kind: 'interval', everyMs: 30 * DAY, startAt, dailyRuns: null })
    anchorAt(h.store, h.repoId, startAt)
    const identity = h.store.projectForRepo(h.repoId)
    assert.ok(identity !== undefined, 'the #541 project row exists for the repository')
    h.store.saveScheduleBudget({ scope: 'project', scopeId: identity.id, dailyLimit: 1 })
    h.store.createWorkItem({ id: 'work_project', repoId: h.repoId, userId: h.userId, title: 'fix it', issueUrl: 'https://github.com/o/mp/issues/1', state: 'triaged' })
    const day = utcDayStart(due)
    h.store.recordScheduleOccurrence({
      id: 'occ_project_seed', scheduleId: 'sch_project', repoId: h.repoId,
      logicalTime: day, timingRevision: 1, state: 'dispatched', jobId: 'job_project_seed',
    })

    await h.jobs.tick()

    assert.equal(h.store.listJobsForRepo(h.repoId).length, 0, 'the project limit stops the run before a job exists')
    const row = h.store.listScheduleOccurrences(h.repoId, 20).find((entry) => entry.logical_time === due)
    assert.ok(row !== undefined, 'the due instant is decided, not silently dropped')
    assert.equal(row.state, 'skipped')
    assert.equal(row.reason, 'budget-exceeded')
  } finally {
    h.store.close()
  }
})

test('a tenant daily limit covers every repository the owner runs in the day', async () => {
  const h = harness('budget-tenant')
  try {
    const { due, startAt } = dueInstant()
    const other = h.store.createRepo({
      id: 'repo_budget_tenant_other', userId: h.userId, owner: 'o', name: 'budget-tenant-other',
      defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
      repoRole: 'developer', goal: 'fix bugs', autoIterate: true, intervalMinutes: 1440,
    })
    h.store.saveSchedule({ id: 'sch_tenant_a', repoId: h.repoId, kind: 'interval', everyMs: 30 * DAY, startAt, dailyRuns: null })
    h.store.saveSchedule({ id: 'sch_tenant_b', repoId: other.id, kind: 'interval', everyMs: 30 * DAY, startAt, dailyRuns: null })
    anchorAt(h.store, h.repoId, startAt)
    anchorAt(h.store, other.id, startAt)
    const a = h.store.projectForRepo(h.repoId)
    const b = h.store.projectForRepo(other.id)
    assert.ok(a !== undefined, 'the first repository has a #541 project')
    assert.ok(b !== undefined, 'the second repository has a #541 project')
    assert.equal(a.tenant_id, b.tenant_id, 'both repositories belong to the same owner tenant')
    h.store.saveScheduleBudget({ scope: 'tenant', scopeId: a.tenant_id, dailyLimit: 1 })
    h.store.createWorkItem({ id: 'work_tenant_other', repoId: other.id, userId: h.userId, title: 'fix it', issueUrl: 'https://github.com/o/mt/issues/1', state: 'triaged' })
    const day = utcDayStart(due)
    h.store.recordScheduleOccurrence({
      id: 'occ_tenant_seed', scheduleId: 'sch_tenant_a', repoId: h.repoId,
      logicalTime: day, timingRevision: 1, state: 'dispatched', jobId: 'job_tenant_seed',
    })

    await h.jobs.tick()

    assert.equal(h.store.listJobsForRepo(other.id).length, 0, 'the tenant limit stops the second repository too')
    const row = h.store.listScheduleOccurrences(other.id, 20).find((entry) => entry.logical_time === due)
    assert.ok(row !== undefined, 'the second instant is decided, not silently dropped')
    assert.equal(row.state, 'skipped')
    assert.equal(row.reason, 'budget-exceeded')
  } finally {
    h.store.close()
  }
})

test('a previous logical day does not spend the tenant budget', async () => {
  const h = harness('budget-tenant-day')
  try {
    const { due, startAt } = dueInstant()
    h.store.saveSchedule({ id: 'sch_tenant_day', repoId: h.repoId, kind: 'interval', everyMs: 30 * DAY, startAt, dailyRuns: null })
    anchorAt(h.store, h.repoId, startAt)
    const identity = h.store.projectForRepo(h.repoId)
    assert.ok(identity !== undefined)
    h.store.saveScheduleBudget({ scope: 'tenant', scopeId: identity.tenant_id, dailyLimit: 1 })
    h.store.createWorkItem({ id: 'work_tenant_day', repoId: h.repoId, userId: h.userId, title: 'fix it', issueUrl: 'https://github.com/o/md/issues/1', state: 'triaged' })
    const day = utcDayStart(due)
    h.store.recordScheduleOccurrence({
      id: 'occ_tenant_yesterday', scheduleId: 'sch_tenant_day', repoId: h.repoId,
      logicalTime: day - 1, timingRevision: 1, state: 'dispatched', jobId: 'job_tenant_yesterday',
    })

    await h.jobs.tick()

    assert.equal(h.store.listJobsForRepo(h.repoId).length, 1, 'a new logical day starts with its own tenant budget')
  } finally {
    h.store.close()
  }
})

// -- the console, where a person reads and sets the limit --------------------

test('the console states the limit, the runs used today, and what is left', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'budget-console', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_budget_console', userId: user.id, owner: 'o', name: 'budget-console',
      defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
      repoRole: 'developer', goal: 'fix bugs', autoIterate: true, intervalMinutes: 1440,
    })
    const row = store.saveSchedule({ id: 'sch_console_budget', repoId: repo.id, kind: 'interval', everyMs: HOUR, dailyRuns: 2 })
    const bounded = scheduleConsole({ repoId: repo.id, row, occurrences: [], now: Date.now(), jobStatus: () => null, runsToday: 1 })
    assert.equal(bounded.budget.dailyRuns, 2)
    assert.equal(bounded.budget.runsToday, 1)
    assert.equal(bounded.budget.remaining, 1)

    const exhausted = scheduleConsole({ repoId: repo.id, row, occurrences: [], now: Date.now(), jobStatus: () => null, runsToday: 2 })
    assert.equal(exhausted.budget.remaining, 0, 'a known zero stays zero; only a missing value is unknown')

    const unboundedRow = store.saveSchedule({ id: 'sch_console_budget', repoId: repo.id, kind: 'interval', everyMs: HOUR, dailyRuns: null })
    const unbounded = scheduleConsole({ repoId: repo.id, row: unboundedRow, occurrences: [], now: Date.now(), jobStatus: () => null })
    assert.equal(unbounded.budget.dailyRuns, null, 'no limit is stated as no limit, not as a zero')
    assert.equal(unbounded.budget.remaining, null)
    assert.equal(unbounded.budget.runsToday, null, 'a caller that did not read the count says unknown')

    const none = scheduleConsole({ repoId: repo.id, row: undefined, occurrences: [], now: Date.now(), jobStatus: () => null })
    assert.equal(none.budget.dailyRuns, null)
    assert.equal(none.budget.runsToday, null)
  } finally {
    store.close()
  }
})

test('the schedule console saves the daily limit and refuses a zero', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'budget-form', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_budget_form', userId: user.id, owner: 'o', name: 'budget-form',
      defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
      repoRole: 'developer', goal: 'fix bugs', autoIterate: true, intervalMinutes: 1440,
    })
    const session = sessionFor(built, user)
    const page = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/schedule`, headers: { cookie: session.cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /name="daily_runs"/, 'the form offers the limit')

    const saved = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/schedule`,
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: session.csrf, every: '15m', daily_runs: '3' }),
    })
    assert.equal(saved.statusCode, 302)
    assert.match(String(saved.headers.location), /saved=1/)
    assert.equal(store.scheduleForRepo(repo.id)?.daily_runs, 3)
    const after = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/schedule`, headers: { cookie: session.cookie } })
    assert.match(after.body, /data-schedule-daily-runs="3"/, 'the page states the limit it will enforce')

    for (const refusedValue of ['0', 'two']) {
      const refused = await built.app.inject({
        method: 'POST',
        url: `/repos/${repo.id}/schedule`,
        headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: formBody({ csrf: session.csrf, every: '15m', daily_runs: refusedValue }),
      })
      assert.equal(refused.statusCode, 302)
      assert.match(String(refused.headers.location), /refused=/, `${refusedValue} is not a legal limit`)
      assert.equal(store.scheduleForRepo(repo.id)?.daily_runs, 3, 'a refused save writes nothing')
    }

    const cleared = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/schedule`,
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: session.csrf, every: '15m', daily_runs: '' }),
    })
    assert.equal(cleared.statusCode, 302)
    assert.equal(store.scheduleForRepo(repo.id)?.daily_runs, null, 'an empty field is unbounded, the old behaviour')
  } finally {
    await built.close()
  }
})
