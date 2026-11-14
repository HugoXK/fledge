import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import type { ScheduleRow } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import type { Runner, RunnerContext } from '../src/jobs/runner.js'
import { parseSchedule } from '../src/schedules/next.js'
import { planTick, scheduleFromRow } from '../src/schedules/tick.js'
import { MemoryMailer, makeUser, testConfig } from './helpers.js'

// #544 slice 3A. Two halves: the pure decision (`planTick`) and the worker tick
// that consumes it. The boundaries are the contract: `start_at` inclusive, the
// caller's `from` exclusive, `end_at` exclusive.

const HOUR = 3_600_000
const T0 = Date.parse('2026-01-01T00:00:00Z')

function cron(expression: string, extra: { startAt?: number | null; endAt?: number | null } = {}) {
  const parsed = parseSchedule({ cron: expression, timezone: 'Asia/Shanghai', startAt: extra.startAt ?? null, endAt: extra.endAt ?? null })
  if (!parsed.ok) throw new Error(`test schedule refused: ${parsed.reason}`)
  return parsed.schedule
}

function interval(everyMs: number, extra: { startAt?: number | null; endAt?: number | null } = {}) {
  const parsed = parseSchedule({ everyMs, startAt: extra.startAt ?? null, endAt: extra.endAt ?? null })
  if (!parsed.ok) throw new Error(`test schedule refused: ${parsed.reason}`)
  return parsed.schedule
}

test('planTick names the due instant of a weekday cron in its own zone', () => {
  const schedule = cron('0 9 * * 1-5')
  // Friday 2026-03-06 00:00Z is before that day's 09:00 Asia/Shanghai run.
  const plan = planTick(schedule, Date.parse('2026-03-06T00:00:00Z'), Date.parse('2026-03-06T01:00:00Z'))
  assert.equal(plan.dueAt, Date.parse('2026-03-06T01:00:00Z'))
  assert.equal(plan.missed, 0)
  // The next run is Monday, not Saturday: the day field is a weekday list.
  assert.equal(plan.nextAt, Date.parse('2026-03-09T01:00:00Z'))
})

test('planTick treats the caller instant as exclusive, so one run is never handed out twice', () => {
  const schedule = cron('0 9 * * 1-5')
  const at = Date.parse('2026-03-06T01:00:00Z')
  const justBefore = planTick(schedule, at - 1, at)
  assert.equal(justBefore.dueAt, at, 'an instant one millisecond later is due')
  const exactly = planTick(schedule, at, at)
  assert.equal(exactly.dueAt, null, 'passing the dispatched instant again must not make it due again')
  assert.equal(exactly.nextAt, Date.parse('2026-03-09T01:00:00Z'))
})

test('planTick counts the instants it passed over under misfire: skip', () => {
  const schedule = interval(HOUR)
  const plan = planTick(schedule, T0, T0 + 3 * HOUR)
  assert.equal(plan.dueAt, T0 + 3 * HOUR)
  assert.equal(plan.missed, 2, 'the two hours between are skipped, not run')
  assert.equal(plan.nextAt, T0 + 4 * HOUR)
})

test('planTick includes start_at and excludes end_at', () => {
  const startAt = T0 + 30 * 60_000
  const schedule = interval(HOUR, { startAt })
  const first = planTick(schedule, T0, startAt)
  assert.equal(first.dueAt, startAt, 'start_at is inclusive')
  assert.equal(first.missed, 0)
  const after = planTick(schedule, startAt, startAt + HOUR)
  assert.equal(after.dueAt, startAt + HOUR)
  assert.equal(after.nextAt, startAt + 2 * HOUR)

  const windowed = interval(HOUR, { startAt, endAt: T0 + 2 * HOUR })
  const closed = planTick(windowed, T0 + 2 * HOUR, T0 + 3 * HOUR)
  assert.equal(closed.dueAt, null, 'end_at is exclusive, so nothing is due after it')
  assert.equal(closed.nextAt, null)
})

test('planTick reports a schedule that has not started yet without inventing a run', () => {
  const startAt = T0 + 10 * HOUR
  const plan = planTick(interval(HOUR, { startAt }), T0, T0 + HOUR)
  assert.equal(plan.dueAt, null)
  assert.equal(plan.nextAt, startAt)
})

test('scheduleFromRow refuses a row it cannot schedule instead of guessing a cadence', () => {
  const base: ScheduleRow = {
    id: 'sch_1', repo_id: 'repo_1', kind: 'cron', expression: '0 9 * * *', every_ms: null,
    timezone: 'UTC', start_at: null, end_at: null, timing_revision: 1, misfire: 'skip',
    last_occurrence_at: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  }
  const parsed = scheduleFromRow(base)
  assert.equal(parsed?.kind, 'cron')
  assert.equal(scheduleFromRow({ ...base, expression: null }), null, 'a cron row without an expression is not a schedule')
  assert.equal(scheduleFromRow({ ...base, timezone: null }), null, 'a cron row without a zone is not a schedule')
  assert.equal(scheduleFromRow({ ...base, kind: 'interval', every_ms: null }), null)
  assert.equal(scheduleFromRow({ ...base, kind: 'unknown' }), null)
})

// -- the worker tick -------------------------------------------------------

interface Harness {
  store: Store
  jobs: Jobs
  contexts: RunnerContext[]
  userId: string
  repoId: string
}

function harness(options: { name: string; intervalMinutes?: number }): Harness {
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
  const user = makeUser(store, { login: `${options.name}-user`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_${options.name}`, userId: user.id, owner: 'o', name: options.name,
    defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
    repoRole: 'developer', goal: 'fix bugs', autoIterate: true,
    intervalMinutes: options.intervalMinutes ?? 1440,
  })
  return { store, jobs, contexts, userId: user.id, repoId: repo.id }
}

function ageSchedule(store: Store, repoId: string, createdAt: number, lastOccurrenceAt: number | null = null): void {
  store.run('UPDATE schedules SET created_at = ?, last_occurrence_at = ? WHERE repo_id = ?', new Date(createdAt).toISOString(), lastOccurrenceAt, repoId)
}

function audits(store: Store, action: string): string[] {
  return store.all<{ detail: string }>('SELECT detail FROM audit_log WHERE action = ? ORDER BY id ASC', action).map((row) => row.detail)
}

test('a due schedule dispatches through nextTime and advances the high water mark', async () => {
  const h = harness({ name: 'sched-due' })
  try {
    h.store.saveSchedule({ id: 'sch_due', repoId: h.repoId, kind: 'interval', everyMs: 15 * 60_000 })
    ageSchedule(h.store, h.repoId, Date.now() - 60 * 60_000)
    h.store.createWorkItem({ id: 'work_due', repoId: h.repoId, userId: h.userId, title: 'fix it', issueUrl: 'https://github.com/o/due/issues/1', state: 'triaged' })

    await h.jobs.tick()

    assert.equal(h.store.listJobsForRepo(h.repoId).length, 1, 'one due instant makes one job')
    const row = h.store.scheduleForRepo(h.repoId)
    assert.notEqual(row?.last_occurrence_at, null, 'the high water mark moves past the instant it dispatched')
    assert.ok((row?.last_occurrence_at ?? 0) <= Date.now())
    const recorded = audits(h.store, 'schedule.dispatched')
    assert.equal(recorded.length, 1)
    const detail = JSON.parse(recorded[0]!) as { occurrence_at: number; job: string; missed: number }
    assert.equal(detail.occurrence_at, row?.last_occurrence_at)
    assert.notEqual(detail.job, null)
    assert.ok(detail.missed >= 3, `an hour of 15-minute instants is skipped, got ${detail.missed}`)

    // A second tick must not dispatch the same instant again: the job is finished
    // (so it is not the active-job skip) and the high water mark is past it.
    const dispatched = h.store.listJobsForRepo(h.repoId)[0]!
    h.store.updateJob(dispatched.id, { status: 'succeeded', finished_at: new Date().toISOString() })
    await h.jobs.tick()
    assert.equal(h.store.listJobsForRepo(h.repoId).length, 1, 'one instant makes exactly one job')
    assert.equal(audits(h.store, 'schedule.dispatched').length, 1)
  } finally {
    h.store.close()
  }
})

test('a schedule that is not due keeps the repository idle even when the legacy interval is long past', async () => {
  const h = harness({ name: 'sched-not-due', intervalMinutes: 60 })
  try {
    h.store.saveSchedule({ id: 'sch_not_due', repoId: h.repoId, kind: 'interval', everyMs: 24 * HOUR })
    // The row was written now, so its first instant is a day away; the repository
    // last ran an hour ago, which makes the legacy rule say "due".
    h.store.updateRepo(h.repoId, { last_run_at: new Date(Date.now() - HOUR).toISOString() })
    h.store.createWorkItem({ id: 'work_not_due', repoId: h.repoId, userId: h.userId, title: 'fix it', issueUrl: 'https://github.com/o/nd/issues/1', state: 'triaged' })

    await h.jobs.tick()

    assert.equal(h.store.listJobsForRepo(h.repoId).length, 0, 'the schedule row owns the cadence: nothing is due yet')
    assert.equal(h.store.scheduleForRepo(h.repoId)?.last_occurrence_at, null)
  } finally {
    h.store.close()
  }
})

test('a due schedule dispatches even when repos.interval_minutes alone would refuse it', async () => {
  const h = harness({ name: 'sched-overrides', intervalMinutes: 1440 })
  try {
    h.store.saveSchedule({ id: 'sch_overrides', repoId: h.repoId, kind: 'interval', everyMs: 15 * 60_000 })
    ageSchedule(h.store, h.repoId, Date.now() - 60 * 60_000)
    // A run one minute ago blocks the legacy interval (1440 minutes) but not the
    // schedule, which is what "the tick consumes nextTime" has to mean.
    h.store.updateRepo(h.repoId, { last_run_at: new Date(Date.now() - 60_000).toISOString() })
    h.store.createWorkItem({ id: 'work_overrides', repoId: h.repoId, userId: h.userId, title: 'fix it', issueUrl: 'https://github.com/o/ov/issues/1', state: 'triaged' })

    await h.jobs.tick()

    assert.equal(h.store.listJobsForRepo(h.repoId).length, 1)
    assert.equal(audits(h.store, 'schedule.dispatched').length, 1)
  } finally {
    h.store.close()
  }
})

test('a due instant behind an active job is skipped with a reason, not queued twice', async () => {
  const h = harness({ name: 'sched-busy' })
  try {
    h.store.saveSchedule({ id: 'sch_busy', repoId: h.repoId, kind: 'interval', everyMs: 15 * 60_000 })
    ageSchedule(h.store, h.repoId, Date.now() - 60 * 60_000)
    h.store.createJob({ id: 'job_busy', repoId: h.repoId, userId: h.userId, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    h.store.updateJob('job_busy', { status: 'running' })

    await h.jobs.tick()

    assert.equal(h.store.listJobsForRepo(h.repoId).length, 1, 'no second job behind the active one')
    const skipped = audits(h.store, 'schedule.skipped')
    assert.equal(skipped.length, 1)
    const detail = JSON.parse(skipped[0]!) as { reason: string; occurrence_at: number }
    assert.equal(detail.reason, 'active-job')
    assert.equal(h.store.scheduleForRepo(h.repoId)?.last_occurrence_at, detail.occurrence_at)
  } finally {
    h.store.close()
  }
})

test('a due instant with nothing to run is recorded as skipped rather than dropped', async () => {
  const h = harness({ name: 'sched-idle' })
  try {
    h.store.saveSchedule({ id: 'sch_idle', repoId: h.repoId, kind: 'interval', everyMs: 15 * 60_000 })
    ageSchedule(h.store, h.repoId, Date.now() - 60 * 60_000)
    h.store.setSetting(`discover:${h.repoId}`, new Date().toISOString())

    await h.jobs.tick()

    assert.equal(h.store.listJobsForRepo(h.repoId).length, 0)
    const skipped = audits(h.store, 'schedule.skipped')
    assert.equal(skipped.length, 1)
    const detail = JSON.parse(skipped[0]!) as { reason: string; occurrence_at: number }
    assert.equal(detail.reason, 'idle')
    assert.equal(h.store.scheduleForRepo(h.repoId)?.last_occurrence_at, detail.occurrence_at)
  } finally {
    h.store.close()
  }
})
