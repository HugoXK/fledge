import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { makeUser } from './helpers.js'

// #544 slice 3A. The schedule table is a schema change, so it is checked as one:
// the version boundary, the columns the planner reads, and the one-row-per-
// repository rule the tick relies on.

test('the schedule table is part of the schema at user_version 37', () => {
  const store = new Store(':memory:')
  try {
    const version = store.get<{ user_version: number }>('PRAGMA user_version')
    assert.equal(Number(version?.user_version), 37, 'a new table moves the refusal boundary: 36 was the schedule, 37 the occurrence')

    const table = store.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schedules'")
    assert.equal(table?.name, 'schedules')

    const columns = store.all<{ name: string }>('PRAGMA table_info(schedules)').map((column) => column.name)
    assert.deepEqual(columns, [
      'id', 'repo_id', 'kind', 'expression', 'every_ms', 'timezone',
      'start_at', 'end_at', 'timing_revision', 'misfire',
      'last_occurrence_at', 'created_at', 'updated_at',
    ])
  } finally {
    store.close()
  }
})

test('one repository holds at most one schedule', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'schedule-owner', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_schedule_unique', userId: user.id, owner: 'o', name: 'sched',
      defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
      repoRole: 'developer', goal: '', autoIterate: true, intervalMinutes: 60,
    })
    const first = store.saveSchedule({ id: 'sch_one', repoId: repo.id, kind: 'interval', everyMs: 60_000 })
    assert.equal(first.timing_revision, 1)
    assert.equal(first.misfire, 'skip')
    assert.equal(first.last_occurrence_at, null)

    const second = store.saveSchedule({ id: 'sch_two', repoId: repo.id, kind: 'interval', everyMs: 120_000 })
    assert.equal(store.listSchedules().length, 1, 'the upsert replaces the row instead of adding a second')
    assert.equal(second.id, 'sch_one', 'the row keeps its identity')
    assert.equal(second.every_ms, 120_000)
    assert.equal(second.timing_revision, 2, 'the interval decides when it fires, so the revision moves')
  } finally {
    store.close()
  }
})

test('the timing revision does not move for a display-only edit', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'schedule-rev', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_schedule_rev', userId: user.id, owner: 'o', name: 'rev',
      defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
      repoRole: 'developer', goal: '', autoIterate: true, intervalMinutes: 60,
    })
    store.saveSchedule({ id: 'sch_rev', repoId: repo.id, kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai' })
    const same = store.saveSchedule({ id: 'sch_rev', repoId: repo.id, kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai' })
    assert.equal(same.timing_revision, 1, 'writing the same timing is not a new plan')
    const moved = store.saveSchedule({ id: 'sch_rev', repoId: repo.id, kind: 'cron', expression: '0 10 * * *', timezone: 'Asia/Shanghai' })
    assert.equal(moved.timing_revision, 2)
    const zone = store.saveSchedule({ id: 'sch_rev', repoId: repo.id, kind: 'cron', expression: '0 10 * * *', timezone: 'UTC' })
    assert.equal(zone.timing_revision, 3, 'the zone decides when it fires too')
  } finally {
    store.close()
  }
})

test('the high water mark never moves backwards', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'schedule-water', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_schedule_water', userId: user.id, owner: 'o', name: 'water',
      defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
      repoRole: 'developer', goal: '', autoIterate: true, intervalMinutes: 60,
    })
    store.saveSchedule({ id: 'sch_water', repoId: repo.id, kind: 'interval', everyMs: 60_000 })
    store.advanceScheduleOccurrence(repo.id, 2_000)
    store.advanceScheduleOccurrence(repo.id, 1_000)
    assert.equal(store.scheduleForRepo(repo.id)?.last_occurrence_at, 2_000, 'a second tick cannot rewind the instant the first one decided')
    store.advanceScheduleOccurrence(repo.id, 3_000)
    assert.equal(store.scheduleForRepo(repo.id)?.last_occurrence_at, 3_000)
  } finally {
    store.close()
  }
})
