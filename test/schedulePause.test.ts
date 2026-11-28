import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { Jobs } from '../src/jobs/service.js'
import type { Runner, RunnerContext } from '../src/jobs/runner.js'
import { scheduleConsole } from '../src/schedules/console.js'
import { formBody, MemoryMailer, makeUser, sessionFor, testConfig } from './helpers.js'

// #544 slice 9: a schedule has a state a person can change. Pausing stops the
// tick from dispatching, and the pause window is recorded as skipped instants
// with a reason rather than dropped, so resuming does not make up a backlog. The
// console states the state and the instant it was paused, and the two routes are
// the only new control.

const HOUR = 3_600_000
const EVERY = 6 * HOUR

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

// A schedule whose last instants are already behind `now`, anchored so the tick
// has something due to decide about: start twenty-nine hours ago, every six
// hours. The newest instant is five hours old and the next one is an hour away,
// so the test never depends on the instant it happens to run in.
function seedDueSchedule(h: Harness, id: string): { startAt: number; due: number } {
  const now = Date.now()
  const startAt = now - 29 * HOUR
  const due = startAt + 4 * EVERY
  h.store.saveSchedule({ id, repoId: h.repoId, kind: 'interval', everyMs: EVERY, startAt })
  h.store.run(
    'UPDATE schedules SET created_at = ?, last_occurrence_at = ? WHERE repo_id = ?',
    new Date(startAt).toISOString(), startAt, h.repoId,
  )
  h.store.createWorkItem({
    id: `work_${id}`, repoId: h.repoId, userId: h.userId, title: 'fix it',
    issueUrl: 'https://github.com/o/p/issues/1', state: 'triaged',
  })
  return { startAt, due }
}

test('a paused schedule records its due instant as skipped and dispatches nothing', async () => {
  const h = harness('pause-tick')
  try {
    const { due } = seedDueSchedule(h, 'sch_pause')
    const active = h.store.scheduleForRepo(h.repoId)
    assert.equal(active?.status, 'active', 'a saved schedule is active until somebody pauses it')

    const pausedAt = Date.now()
    const paused = h.store.setScheduleStatus(h.repoId, 'paused', pausedAt)
    assert.equal(paused?.status, 'paused')
    assert.equal(paused?.paused_at, pausedAt)

    await h.jobs.tick()

    assert.equal(h.store.listJobsForRepo(h.repoId).length, 0, 'a paused schedule starts no job')
    const rows = h.store.listScheduleOccurrences(h.repoId, 20)
    const decided = rows.find((row) => row.logical_time === due)
    assert.ok(decided !== undefined, 'the paused instant is decided, not silently dropped')
    assert.equal(decided.state, 'skipped')
    assert.equal(decided.reason, 'paused')

    const cursor = h.store.scheduleForRepo(h.repoId)?.last_occurrence_at ?? 0
    assert.ok(cursor >= due, 'the cursor moves past the instant, or every tick re-decides it')
    await h.jobs.tick()
    assert.equal(h.store.listScheduleOccurrences(h.repoId, 20).length, rows.length, 'a second tick adds no row')
    assert.equal(h.contexts.length, 0, 'the runner was never called')
  } finally {
    h.store.close()
  }
})

test('resuming makes the schedule runnable again without making up the pause window', async () => {
  const h = harness('pause-resume')
  try {
    seedDueSchedule(h, 'sch_resume')
    h.store.setScheduleStatus(h.repoId, 'paused', Date.now())
    await h.jobs.tick()
    assert.equal(h.store.listScheduleOccurrences(h.repoId, 20).length, 1, 'one decided instant while paused')

    const resumed = h.store.setScheduleStatus(h.repoId, 'active', Date.now())
    assert.equal(resumed?.status, 'active')
    assert.equal(resumed?.paused_at, null, 'resuming clears the instant it was paused')

    // Nothing is due yet, and the window stays recorded rather than becoming a
    // backlog: the next tick starts nothing and writes no new row.
    await h.jobs.tick()
    assert.equal(h.store.listJobsForRepo(h.repoId).length, 0)
    assert.equal(h.store.listScheduleOccurrences(h.repoId, 20).length, 1)
  } finally {
    h.store.close()
  }

  // A repository paused and resumed before its instant was ever decided is
  // dispatched again on the next tick, so the state is what stopped the run.
  const resumed = harness('pause-resume-again')
  try {
    const { due } = seedDueSchedule(resumed, 'sch_resume_again')
    resumed.store.setScheduleStatus(resumed.repoId, 'paused', Date.now())
    resumed.store.setScheduleStatus(resumed.repoId, 'active', Date.now())
    await resumed.jobs.tick()

    const jobs = resumed.store.listJobsForRepo(resumed.repoId)
    assert.equal(jobs.length, 1, 'a resumed schedule dispatches its due instant')
    const dispatched = resumed.store.listScheduleOccurrences(resumed.repoId, 20)
      .find((row) => row.logical_time === due)
    assert.ok(dispatched !== undefined)
    assert.equal(dispatched.state, 'dispatched')
    assert.equal(dispatched.job_id, jobs[0]!.id)
    assert.equal(resumed.store.listScheduleOccurrences(resumed.repoId, 20).filter((row) => row.reason === 'paused').length, 0, 'a resume leaves no paused row behind')
  } finally {
    resumed.store.close()
  }
})

test('the console states the schedule state and the instant it was paused', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'pause-console', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_pause_console', userId: user.id, owner: 'o', name: 'pause-console',
      defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
      repoRole: 'developer', goal: 'fix bugs', autoIterate: true, intervalMinutes: 1440,
    })
    const saved = store.saveSchedule({ id: 'sch_console_pause', repoId: repo.id, kind: 'interval', everyMs: HOUR })
    const active = scheduleConsole({ repoId: repo.id, row: saved, occurrences: [], now: Date.now(), jobStatus: () => null })
    assert.equal(active.status, 'active')
    assert.equal(active.pausedAt, null)

    const pausedAt = Date.now()
    const pausedRow = store.setScheduleStatus(repo.id, 'paused', pausedAt)
    assert.ok(pausedRow !== undefined)
    const paused = scheduleConsole({ repoId: repo.id, row: pausedRow, occurrences: [], now: pausedAt, jobStatus: () => null })
    assert.equal(paused.status, 'paused')
    assert.equal(paused.pausedAt, pausedAt)

    const none = scheduleConsole({ repoId: repo.id, row: undefined, occurrences: [], now: pausedAt, jobStatus: () => null })
    assert.equal(none.status, 'none')
    assert.equal(none.pausedAt, null)
  } finally {
    store.close()
  }
})

test('a maintainer pauses and resumes from the console, and the page says which state it is in', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'pause-form', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_pause_form', userId: user.id, owner: 'o', name: 'pause-form',
      defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
      repoRole: 'developer', goal: 'fix bugs', autoIterate: true, intervalMinutes: 1440,
    })
    store.saveSchedule({ id: 'sch_pause_form', repoId: repo.id, kind: 'interval', everyMs: HOUR })
    const session = sessionFor(built, user)

    const page = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/schedule`, headers: { cookie: session.cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /data-schedule-status="active"/)
    assert.match(page.body, /action="\/repos\/repo_pause_form\/schedule\/pause"/, 'the page offers Pause')
    assert.doesNotMatch(page.body, /action="\/repos\/repo_pause_form\/schedule\/resume"/)

    const pausedAt = Date.now()
    const paused = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/schedule/pause`,
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: session.csrf }),
    })
    assert.equal(paused.statusCode, 302)
    const row = store.scheduleForRepo(repo.id)
    assert.equal(row?.status, 'paused')
    assert.ok((row?.paused_at ?? 0) >= pausedAt, 'the instant it was paused is recorded')
    assert.ok(store.listAudit(20).some((entry) => entry.action === 'schedule.pause'), 'the pause is audited')

    const pausedPage = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/schedule`, headers: { cookie: session.cookie } })
    assert.match(pausedPage.body, /data-schedule-status="paused"/)
    assert.match(pausedPage.body, /action="\/repos\/repo_pause_form\/schedule\/resume"/, 'the page offers Resume while paused')

    // Saving the schedule form while paused changes the timing, not the state: an
    // ordinary save must not silently switch a paused schedule back on.
    const saved = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/schedule`,
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: session.csrf, every: '2h' }),
    })
    assert.equal(saved.statusCode, 302)
    assert.equal(store.scheduleForRepo(repo.id)?.status, 'paused', 'a form save keeps the state it found')
    assert.equal(store.scheduleForRepo(repo.id)?.every_ms, 2 * HOUR)

    const resumed = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/schedule/resume`,
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: session.csrf }),
    })
    assert.equal(resumed.statusCode, 302)
    assert.equal(store.scheduleForRepo(repo.id)?.status, 'active')
    assert.equal(store.scheduleForRepo(repo.id)?.paused_at, null)
    assert.ok(store.listAudit(20).some((entry) => entry.action === 'schedule.resume'), 'the resume is audited')
  } finally {
    await built.close()
  }
})

test('a schedule row written before the pause columns existed is active, not paused or unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-pause-migrate-'))
  const path = join(dir, 'fledge.db')
  try {
    const store = new Store(path)
    const user = makeUser(store, { login: 'pause-migrate', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_pause_migrate', userId: user.id, owner: 'o', name: 'pause-migrate',
      defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
      repoRole: 'developer', goal: 'fix bugs', autoIterate: true, intervalMinutes: 1440,
    })
    store.saveSchedule({ id: 'sch_pause_migrate', repoId: repo.id, kind: 'interval', everyMs: HOUR })
    // The shape of a file written by an earlier slice: the two columns are gone,
    // which is what the in-place migration has to notice and add back.
    store.run('ALTER TABLE schedules DROP COLUMN status')
    store.run('ALTER TABLE schedules DROP COLUMN paused_at')
    store.close()

    const reopened = new Store(path)
    try {
      const columns = reopened.all<{ name: string }>('PRAGMA table_info(schedules)').map((column) => column.name)
      assert.ok(columns.includes('status') && columns.includes('paused_at'), 'the migration adds both columns')
      const row = reopened.scheduleForRepo(repo.id)
      assert.equal(row?.status, 'active', 'a schedule written before the columns is active, the behaviour it had')
      assert.equal(row?.paused_at, null)
      const paused = reopened.setScheduleStatus(repo.id, 'paused', Date.now())
      assert.equal(paused?.status, 'paused', 'the migrated row is writable')
    } finally {
      reopened.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
