import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import type { Runner, RunnerContext } from '../src/jobs/runner.js'
import { MemoryMailer, makeUser, testConfig } from './helpers.js'

// #544 slice 3B. Slice A recorded a decided instant as an audit line only: no
// row, so no skip row, no attempt count and no console field. This slice gives
// the instant a row and pins the one property the rest of 3B rests on —
// `(schedule_id, logical_time, timing_revision)` is the identity of a decision,
// so the same instant cannot be recorded twice and an edited cadence cannot
// rewrite the decision taken under the old one.
//
// The lease and the stale-result rejection are the next slice: they answer
// against these rows.

const HOUR = 3_600_000
const T0 = Date.parse('2026-01-01T00:00:00Z')

function harness(name: string): {
  store: Store
  jobs: Jobs
  contexts: RunnerContext[]
  userId: string
  repoId: string
  scheduleId: string
} {
  const store = new Store(':memory:')
  const contexts: RunnerContext[] = []
  const runner: Runner = {
    name: 'capture',
    async run(context) {
      contexts.push(context)
      return { status: 'running' }
    },
  }
  const jobs = new Jobs(store, testConfig(), runner, new MemoryMailer())
  const user = makeUser(store, { login: `${name}-user`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_${name}`, userId: user.id, owner: 'o', name,
    defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
    repoRole: 'developer', goal: 'fix bugs', autoIterate: true, intervalMinutes: 1440,
  })
  const schedule = store.saveSchedule({ id: `sch_${name}`, repoId: repo.id, kind: 'interval', everyMs: 15 * 60_000 })
  return { store, jobs, contexts, userId: user.id, repoId: repo.id, scheduleId: schedule.id }
}

function ageSchedule(store: Store, repoId: string, createdAt: number): void {
  store.run('UPDATE schedules SET created_at = ? WHERE repo_id = ?', new Date(createdAt).toISOString(), repoId)
}

function audits(store: Store, action: string): string[] {
  return store.all<{ detail: string }>('SELECT detail FROM audit_log WHERE action = ? ORDER BY id ASC', action).map((row) => row.detail)
}

// -- the table -------------------------------------------------------------

test('the occurrence table is part of the schema at user_version 38', () => {
  const store = new Store(':memory:')
  try {
    const version = store.get<{ user_version: number }>('PRAGMA user_version')
    assert.equal(Number(version?.user_version), 38, 'the lease columns of slice B2 move the refusal boundary from 37 to 38')

    const table = store.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schedule_occurrences'")
    assert.equal(table?.name, 'schedule_occurrences')

    const columns = store.all<{ name: string }>('PRAGMA table_info(schedule_occurrences)').map((column) => column.name)
    assert.deepEqual(columns, [
      'id', 'schedule_id', 'repo_id', 'logical_time', 'timing_revision',
      'state', 'reason', 'missed', 'job_id', 'decided_at', 'dispatched_at', 'lag_ms',
      'attempts', 'lease_token', 'lease_expires_at',
    ])

    // The identity of a decision is the row's own uniqueness constraint, not a
    // convention the caller is trusted to keep.
    const uniques = store.all<{ name: string; unique: number }>('PRAGMA index_list(schedule_occurrences)')
    const uniqueIndexes = uniques.filter((index) => index.unique === 1)
    assert.equal(uniqueIndexes.length >= 1, true, 'the table must carry a UNIQUE constraint')
    const columnsOf = (index: string): string[] =>
      store.all<{ name: string }>(`PRAGMA index_info(${JSON.stringify(index)})`).map((info) => info.name)
    assert.equal(
      uniqueIndexes.some((index) => columnsOf(index.name).join(',') === 'schedule_id,logical_time,timing_revision'),
      true,
      'the unique key is (schedule_id, logical_time, timing_revision)',
    )

    const fk = store.all<{ table: string; on_delete: string }>('PRAGMA foreign_key_list(schedule_occurrences)')
    assert.equal(fk.some((row) => row.table === 'schedules' && row.on_delete === 'CASCADE'), true,
      'deleting the schedule must delete the decisions taken under it')
  } finally {
    store.close()
  }
})

test('one instant is one decision, however many ticks report it', () => {
  const h = harness('occ-dedupe')
  try {
    const first = h.store.recordScheduleOccurrence({
      id: 'occ_one', scheduleId: h.scheduleId, repoId: h.repoId,
      logicalTime: T0, timingRevision: 1, state: 'skipped', reason: 'active-job',
    })
    assert.equal(first.created, true)
    assert.equal(first.row.logical_time, T0)

    // A second tick that reaches the same instant (a retry, a restarted worker,
    // two processes) reports it again. The row is the same row, and the first
    // decision stands: a later `dispatched` cannot turn a recorded skip into a run.
    const second = h.store.recordScheduleOccurrence({
      id: 'occ_two', scheduleId: h.scheduleId, repoId: h.repoId,
      logicalTime: T0, timingRevision: 1, state: 'dispatched', jobId: 'job_late',
    })
    assert.equal(second.created, false, 'the second report is not a second decision')
    assert.equal(second.row.id, 'occ_one', 'the instant keeps the row it was first recorded with')
    assert.equal(second.row.state, 'skipped')
    assert.equal(second.row.reason, 'active-job')
    assert.equal(second.row.job_id, null)

    const rows = h.store.listScheduleOccurrences(h.repoId)
    assert.equal(rows.length, 1)
  } finally {
    h.store.close()
  }
})

test('an edited cadence re-keys the same wall-clock instant instead of rewriting the old decision', () => {
  const h = harness('occ-revision')
  try {
    const before = h.store.recordScheduleOccurrence({
      id: 'occ_rev1', scheduleId: h.scheduleId, repoId: h.repoId,
      logicalTime: T0, timingRevision: 1, state: 'dispatched', jobId: 'job_old',
    })
    assert.equal(before.created, true)

    // The row was saved again with a new cadence, so `timing_revision` moved.
    const after = h.store.recordScheduleOccurrence({
      id: 'occ_rev2', scheduleId: h.scheduleId, repoId: h.repoId,
      logicalTime: T0, timingRevision: 2, state: 'skipped', reason: 'not-due',
    })
    assert.equal(after.created, true, 'a different plan is a different decision')
    assert.notEqual(after.row.id, before.row.id)

    const rows = h.store.listScheduleOccurrences(h.repoId)
    assert.equal(rows.length, 2, 'the old decision is kept, not overwritten')
    assert.deepEqual(rows.map((row) => row.timing_revision).sort(), [1, 2])
    assert.equal(rows.find((row) => row.timing_revision === 1)?.job_id, 'job_old')
  } finally {
    h.store.close()
  }
})

test('occurrences are listed newest logical instant first and are scoped to their repository', () => {
  const h = harness('occ-list')
  try {
    for (const [index, at] of [T0, T0 + HOUR, T0 + 2 * HOUR].entries()) {
      h.store.recordScheduleOccurrence({
        id: `occ_list_${index}`, scheduleId: h.scheduleId, repoId: h.repoId,
        logicalTime: at, timingRevision: 1, state: 'skipped', reason: 'idle',
      })
    }
    const rows = h.store.listScheduleOccurrences(h.repoId)
    assert.deepEqual(rows.map((row) => row.logical_time), [T0 + 2 * HOUR, T0 + HOUR, T0])
    assert.equal(h.store.listScheduleOccurrences('repo_other').length, 0)
  } finally {
    h.store.close()
  }
})

test('deleting the schedule removes the decisions recorded under it', () => {
  const h = harness('occ-cascade')
  try {
    h.store.recordScheduleOccurrence({
      id: 'occ_cascade', scheduleId: h.scheduleId, repoId: h.repoId,
      logicalTime: T0, timingRevision: 1, state: 'skipped', reason: 'idle',
    })
    h.store.deleteSchedule(h.repoId)
    assert.equal(h.store.listScheduleOccurrences(h.repoId).length, 0,
      'a deleted schedule leaves no orphan occurrence behind')
  } finally {
    h.store.close()
  }
})

// -- the tick writes one row per decided instant ---------------------------

test('a dispatched instant is one row carrying the job, the revision and the lag', async () => {
  const h = harness('occ-dispatch')
  try {
    ageSchedule(h.store, h.repoId, Date.now() - 60 * 60_000)
    h.store.createWorkItem({
      id: 'work_occ_dispatch', repoId: h.repoId, userId: h.userId,
      title: 'fix it', issueUrl: 'https://github.com/o/occ-dispatch/issues/1', state: 'triaged',
    })

    await h.jobs.tick()

    const jobs = h.store.listJobsForRepo(h.repoId)
    assert.equal(jobs.length, 1)
    const rows = h.store.listScheduleOccurrences(h.repoId)
    assert.equal(rows.length, 1, 'the decided instant has exactly one row')
    const row = rows[0]!
    const schedule = h.store.scheduleForRepo(h.repoId)!
    assert.equal(row.state, 'dispatched')
    assert.equal(row.reason, null)
    assert.equal(row.job_id, jobs[0]!.id)
    assert.equal(row.timing_revision, schedule.timing_revision)
    assert.equal(row.logical_time, schedule.last_occurrence_at, 'the row records the instant the high water mark moved to')
    assert.ok((row.lag_ms ?? -1) >= 0, 'a dispatched row says how late it ran')
    assert.ok((row.dispatched_at ?? 0) >= row.logical_time, 'the dispatch cannot precede the instant it was due')

    // The audit line is not replaced by the row: operators read the audit log,
    // and the two records must agree about which instant was dispatched.
    const detail = JSON.parse(audits(h.store, 'schedule.dispatched')[0]!) as { occurrence_at: number }
    assert.equal(detail.occurrence_at, row.logical_time)
  } finally {
    h.store.close()
  }
})

test('a skipped instant is a row with its reason, not only an audit line', async () => {
  const h = harness('occ-skip')
  try {
    ageSchedule(h.store, h.repoId, Date.now() - 60 * 60_000)
    h.store.createJob({
      id: 'job_occ_busy', repoId: h.repoId, userId: h.userId,
      trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '',
    })
    h.store.updateJob('job_occ_busy', { status: 'running' })

    await h.jobs.tick()

    const rows = h.store.listScheduleOccurrences(h.repoId)
    assert.equal(rows.length, 1, 'a skip is recorded, not dropped')
    const row = rows[0]!
    assert.equal(row.state, 'skipped')
    assert.equal(row.reason, 'active-job')
    assert.equal(row.job_id, null)
    assert.equal(row.logical_time, h.store.scheduleForRepo(h.repoId)?.last_occurrence_at)
    assert.equal(audits(h.store, 'schedule.skipped').length, 1)
  } finally {
    h.store.close()
  }
})

test('a passed-over instant is one row and the count it reports is kept', async () => {
  const h = harness('occ-missed')
  try {
    ageSchedule(h.store, h.repoId, Date.now() - 60 * 60_000)
    h.store.setSetting(`discover:${h.repoId}`, new Date().toISOString())

    await h.jobs.tick()

    const rows = h.store.listScheduleOccurrences(h.repoId)
    assert.equal(rows.length, 1, 'the missed instants are counted on the decided row, not written as thousands of rows')
    const row = rows[0]!
    assert.equal(row.state, 'skipped')
    assert.equal(row.reason, 'idle')
    assert.ok(row.missed >= 3, `an hour of 15-minute instants is reported as missed, got ${row.missed}`)
  } finally {
    h.store.close()
  }
})
