import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { Jobs } from '../src/jobs/service.js'
import type { Runner, RunnerContext } from '../src/jobs/runner.js'
import { parseSchedule } from '../src/schedules/next.js'
import { planTick } from '../src/schedules/tick.js'
import { scheduleConsole } from '../src/schedules/console.js'
import { formBody, MemoryMailer, makeUser, sessionFor, testConfig } from './helpers.js'

// #544 slice 5: the misfire policy. Today `skip` is the only policy and a
// passed-over instant is a count on the next row, never a record of its own.
// These cases are the clause as the card states it: `once` catches up exactly
// one instant and records the rest with a reason; `grace_ms` turns a too-late
// instant into a skipped record instead of a late dispatch; and `skip` with no
// grace keeps answering exactly what it answers today, because every existing
// schedule is on that default.

const HOUR = 3_600_000
const MINUTE = 60_000
const T0 = Date.parse('2026-01-01T00:00:00Z')

function interval(everyMs: number) {
  const parsed = parseSchedule({ everyMs })
  if (!parsed.ok) throw new Error(`test schedule refused: ${parsed.reason}`)
  return parsed.schedule
}

test('misfire: once catches up the oldest passed instant and records the rest', () => {
  // Three instants were passed over. `skip` would run the newest and forget the
  // two before it; `once` runs the oldest — the one that was actually missed, so
  // the run keeps the logical time it was scheduled for — and records the later
  // two as skipped instead of losing them in a count.
  const plan = planTick(interval(HOUR), T0, T0 + 3 * HOUR, { misfire: 'once' })
  assert.equal(plan.dueAt, T0 + HOUR, 'the catch-up runs for the instant that was missed first')
  assert.deepEqual(plan.skipped, [
    { at: T0 + 2 * HOUR, reason: 'misfire-once' },
    { at: T0 + 3 * HOUR, reason: 'misfire-once' },
  ], 'the instants it does not make up are recorded, not counted')
  assert.equal(plan.nextAt, T0 + 4 * HOUR, 'the cursor jumps past now, so the next tick is not the next missed instant')
  assert.equal(plan.cursorAt, T0 + 3 * HOUR, 'the cursor moves to the last instant this decision covered')
})

test('misfire: once on an ordinary tick is the same decision as skip', () => {
  const once = planTick(interval(HOUR), T0, T0 + HOUR, { misfire: 'once' })
  assert.equal(once.dueAt, T0 + HOUR)
  assert.deepEqual(once.skipped, [])
  assert.equal(once.cursorAt, T0 + HOUR)
})

test('a due instant older than grace_ms is recorded as skipped, never dispatched', () => {
  const plan = planTick(interval(HOUR), T0, T0 + 3 * HOUR + 5 * MINUTE, { graceMs: 2 * MINUTE })
  assert.equal(plan.dueAt, null, 'a run that late is not dispatched at all')
  assert.deepEqual(plan.skipped, [{ at: T0 + 3 * HOUR, reason: 'grace-exceeded' }])
  assert.equal(plan.cursorAt, T0 + 3 * HOUR, 'the cursor still moves, or the same late instant is reconsidered forever')
  assert.equal(plan.nextAt, T0 + 4 * HOUR)
  assert.equal(plan.missed, 2, 'the older instants stay counted on the decided row')
})

test('misfire: skip with no grace keeps today s answer exactly', () => {
  const legacy = planTick(interval(HOUR), T0, T0 + 3 * HOUR)
  assert.equal(legacy.dueAt, T0 + 3 * HOUR)
  assert.equal(legacy.missed, 2)
  assert.equal(legacy.nextAt, T0 + 4 * HOUR)
  assert.deepEqual(legacy.skipped, [], 'nothing is recorded per instant under the default policy')
  assert.equal(legacy.cursorAt, T0 + 3 * HOUR)
  // The same answer whether the options are omitted or say `skip` explicitly.
  assert.deepEqual(planTick(interval(HOUR), T0, T0 + 3 * HOUR, { misfire: 'skip' }), legacy)
})

// -- the worker, where a decision becomes rows ------------------------------

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

// The anchor is the row's high water mark, so an aged row is what makes the
// window deterministic: the instants are named by the anchor, not by the moment
// the test happens to run.
function anchorAt(store: Store, repoId: string, at: number): void {
  store.run('UPDATE schedules SET created_at = ?, last_occurrence_at = ? WHERE repo_id = ?', new Date(at).toISOString(), at, repoId)
}

test('a once schedule writes one dispatched row and one row per skipped instant, in one decision', async () => {
  const h = harness('misfire-once')
  try {
    h.store.saveSchedule({ id: 'sch_once', repoId: h.repoId, kind: 'interval', everyMs: HOUR, misfire: 'once' })
    // Three instants are due: anchor+1h, +2h and +3h. `once` makes up the first.
    anchorAt(h.store, h.repoId, Math.floor(Date.now() / HOUR) * HOUR - 3 * HOUR)
    h.store.createWorkItem({ id: 'work_once', repoId: h.repoId, userId: h.userId, title: 'fix it', issueUrl: 'https://github.com/o/mo/issues/1', state: 'triaged' })

    await h.jobs.tick()

    const rows = h.store.listScheduleOccurrences(h.repoId, 10)
    const dispatched = rows.filter((row) => row.state === 'dispatched')
    const skipped = rows.filter((row) => row.state === 'skipped')
    assert.equal(dispatched.length, 1, 'one instant is made up')
    assert.equal(h.store.listJobsForRepo(h.repoId).length, 1)
    assert.equal(skipped.length, 2, 'the instants it did not make up are their own rows')
    assert.deepEqual(skipped.map((row) => row.reason), ['misfire-once', 'misfire-once'])
    assert.ok(dispatched[0]!.logical_time < skipped[0]!.logical_time, 'the catch-up is the oldest instant, the skips are the later ones')

    const cursor = h.store.scheduleForRepo(h.repoId)?.last_occurrence_at ?? 0
    assert.ok(cursor >= (skipped[1]?.logical_time ?? 0), 'the cursor moved past every instant this decision covered')

    // A second tick must not re-decide the same instants: the rows are keyed by
    // (schedule, logical time, timing revision) and the cursor is already past.
    await h.jobs.tick()
    assert.equal(h.store.listScheduleOccurrences(h.repoId, 10).length, 3)
    assert.equal(h.store.listJobsForRepo(h.repoId).length, 1)
  } finally {
    h.store.close()
  }
})

test('a grace_ms schedule records the late instant as skipped and dispatches nothing', async () => {
  const h = harness('misfire-grace')
  try {
    // `start_at` pins the instants off the hour, so the newest due instant is
    // exactly five minutes old whenever the test runs; the bound is two.
    const startAt = Date.now() - 2 * HOUR - 5 * MINUTE
    h.store.saveSchedule({ id: 'sch_grace', repoId: h.repoId, kind: 'interval', everyMs: HOUR, startAt, graceMs: 2 * MINUTE })
    anchorAt(h.store, h.repoId, startAt - HOUR)
    h.store.createWorkItem({ id: 'work_grace', repoId: h.repoId, userId: h.userId, title: 'fix it', issueUrl: 'https://github.com/o/mg/issues/1', state: 'triaged' })

    await h.jobs.tick()

    assert.equal(h.store.listJobsForRepo(h.repoId).length, 0, 'too late to run')
    const rows = h.store.listScheduleOccurrences(h.repoId, 10)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.state, 'skipped')
    assert.equal(rows[0]!.reason, 'grace-exceeded')
    const audit = h.store.all<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'schedule.skipped'")
    assert.equal(audit.length, 1, 'the decision is on the operator record too')
    const detail = JSON.parse(audit[0]!.detail) as { reason: string; occurrence: string | null }
    assert.equal(detail.reason, 'grace-exceeded')
    assert.equal(detail.occurrence, rows[0]!.id, 'the audit line names the row it recorded')
  } finally {
    h.store.close()
  }
})

test('the console shows the reason for the instants a once schedule skipped', async () => {
  const h = harness('misfire-console')
  try {
    h.store.saveSchedule({ id: 'sch_console_misfire', repoId: h.repoId, kind: 'interval', everyMs: HOUR, misfire: 'once' })
    anchorAt(h.store, h.repoId, Math.floor(Date.now() / HOUR) * HOUR - 3 * HOUR)
    h.store.createWorkItem({ id: 'work_console_misfire', repoId: h.repoId, userId: h.userId, title: 'fix it', issueUrl: 'https://github.com/o/mc/issues/1', state: 'triaged' })

    await h.jobs.tick()

    const row = h.store.scheduleForRepo(h.repoId)
    const state = scheduleConsole({
      repoId: h.repoId,
      row,
      occurrences: h.store.listScheduleOccurrences(h.repoId, 10),
      now: Date.now(),
      jobStatus: (jobId) => h.store.getJob(jobId)?.status ?? null,
    })
    assert.equal(state.misfire, 'once', 'the page can say which policy is in force')
    const withReason = state.occurrences.filter((occurrence) => occurrence.state === 'skipped')
    assert.equal(withReason.length, 2)
    assert.deepEqual(withReason.map((occurrence) => occurrence.reason), ['misfire-once', 'misfire-once'], 'a reason nobody can see is the same defect as no reason')
  } finally {
    h.store.close()
  }
})

// -- the console form, where a person sets the policy ----------------------

test('the schedule console saves the misfire policy and its grace bound', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'misfire-form', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_misfire_form', userId: user.id, owner: 'o', name: 'misfire-form',
      defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
      repoRole: 'developer', goal: 'fix bugs', autoIterate: true, intervalMinutes: 1440,
    })
    const session = sessionFor(built, user)
    const page = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/schedule`, headers: { cookie: session.cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /name="misfire"/, 'the form offers the policy')
    assert.match(page.body, /name="grace"/, 'the form offers the grace bound')

    const saved = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/schedule`,
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: session.csrf, every: '15m', misfire: 'once', grace: '10' }),
    })
    assert.equal(saved.statusCode, 302)
    assert.match(String(saved.headers.location), /saved=1/)

    const row = store.scheduleForRepo(repo.id)
    assert.equal(row?.misfire, 'once')
    assert.equal(row?.grace_ms, 10 * 60_000)

    const after = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/schedule`, headers: { cookie: session.cookie } })
    assert.match(after.body, /data-schedule-grace="600000"/, 'the page states the bound it will enforce')

    // A form that predates these fields keeps today's behaviour: skip, no bound.
    const legacy = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/schedule`,
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: session.csrf, every: '15m', misfire: 'skip', grace: '' }),
    })
    assert.equal(legacy.statusCode, 302)
    const reset = store.scheduleForRepo(repo.id)
    assert.equal(reset?.misfire, 'skip')
    assert.equal(reset?.grace_ms, null)
  } finally {
    await built.close()
  }
})
