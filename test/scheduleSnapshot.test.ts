import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import type { Runner, RunnerContext } from '../src/jobs/runner.js'
import {
  OCCURRENCE_SNAPSHOT_VERSION,
  encodeOccurrenceSnapshot,
  occurrenceSnapshot,
  parseOccurrenceSnapshot,
} from '../src/schedules/snapshot.js'
import { MemoryMailer, makeUser, testConfig } from './helpers.js'

// #544: an occurrence row stores the schedule configuration and the repository
// authorization it was decided under, frozen when it was written. These tests
// pin the two ways that can go wrong:
//
//   - the row answers the *live* schedule after an edit, which would let a later
//     change rewrite what a past instant ran as;
//   - an absent snapshot is guessed instead of reported as unknown.
//
// A recovered lease is the third: the second worker must not be able to replace
// the first worker's snapshot with whatever the schedule says by then.

const MINUTE = 60_000

function harness(name: string): {
  store: Store
  jobs: Jobs
  runnerContexts: RunnerContext[]
  userId: string
  repoId: string
  scheduleId: string
} {
  const store = new Store(':memory:')
  const runnerContexts: RunnerContext[] = []
  const runner: Runner = {
    name: 'capture',
    async run(context) {
      runnerContexts.push(context)
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
  const schedule = store.saveSchedule({
    id: `sch_${name}`, repoId: repo.id, kind: 'interval', everyMs: 15 * MINUTE,
    dailyRuns: 5,
  })
  return { store, jobs, runnerContexts, userId: user.id, repoId: repo.id, scheduleId: schedule.id }
}

function makeDue(store: Store, repoId: string): void {
  store.run('UPDATE schedules SET created_at = ? WHERE repo_id = ?', new Date(Date.now() - 60 * MINUTE).toISOString(), repoId)
}

function editSchedule(store: Store, repoId: string): void {
  const row = store.scheduleForRepo(repoId)
  if (row === undefined) throw new Error('schedule disappeared')
  store.run(
    'UPDATE schedules SET every_ms = ?, misfire = ?, grace_ms = ?, daily_runs = ? WHERE id = ?',
    30 * MINUTE, 'skip', null, null, row.id,
  )
  store.run("UPDATE repos SET permission = 'read', repo_role = 'maintainer' WHERE id = ?", repoId)
}

test('a dispatched instant keeps the configuration and authorization it was claimed under', async () => {
  const h = harness('snap-dispatch')
  try {
    makeDue(h.store, h.repoId)
    h.store.createWorkItem({
      id: 'work_snap', repoId: h.repoId, userId: h.userId,
      title: 'fix it', issueUrl: 'https://github.com/o/snap/issues/1', state: 'triaged',
    })

    await h.jobs.tick()

    const occurrence = h.store.listScheduleOccurrences(h.repoId).find((row) => row.state === 'dispatched')
    if (occurrence === undefined) throw new Error('the due instant did not dispatch')
    const snapshot = parseOccurrenceSnapshot(occurrence.snapshot_json)
    assert.notEqual(snapshot, null, 'a dispatched occurrence carries a snapshot')
    assert.equal(snapshot?.version, OCCURRENCE_SNAPSHOT_VERSION)
    assert.equal(snapshot?.config.kind, 'interval')
    assert.equal(snapshot?.config.everyMs, 15 * MINUTE)
    assert.equal(snapshot?.config.misfire, 'skip')
    assert.equal(snapshot?.config.graceMs, null)
    assert.equal(snapshot?.config.dailyRuns, 5)
    assert.equal(snapshot?.config.status, 'active')
    assert.equal(snapshot?.authorization.userId, h.userId)
    assert.equal(snapshot?.authorization.permission, 'admin')
    assert.equal(snapshot?.authorization.repoRole, 'developer')

    // Editing the schedule and re-checking the repository afterwards must not
    // rewrite what the instant was decided under.
    editSchedule(h.store, h.repoId)
    const after = h.store.listScheduleOccurrences(h.repoId).find((row) => row.state === 'dispatched')
    if (after === undefined) throw new Error('the dispatched occurrence disappeared')
    assert.equal(after.id, occurrence.id)
    assert.equal(after?.snapshot_json, occurrence?.snapshot_json)
    const reread = parseOccurrenceSnapshot(after.snapshot_json)
    assert.equal(reread?.config.everyMs, 15 * MINUTE, 'the snapshot still names the cadence the run used')
    assert.equal(reread?.config.dailyRuns, 5, 'the budget the run was decided under is frozen too')
    assert.equal(reread?.config.misfire, 'skip')
    assert.equal(reread?.config.graceMs, null)
    assert.equal(reread?.authorization.permission, 'admin', 'the permission the run acted with is not today\'s permission')
    assert.equal(reread?.authorization.repoRole, 'developer')
  } finally {
    h.store.close()
  }
})

test('a skipped instant carries the same snapshot as a dispatched one', async () => {
  const h = harness('snap-skip')
  try {
    makeDue(h.store, h.repoId)
    h.store.createJob({
      id: 'job_busy', repoId: h.repoId, userId: h.userId,
      trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '',
    })
    h.store.updateJob('job_busy', { status: 'running' })

    await h.jobs.tick()

    const occurrence = h.store.listScheduleOccurrences(h.repoId).find((row) => row.state === 'skipped')
    assert.equal(occurrence?.state, 'skipped')
    assert.equal(occurrence?.reason, 'active-job')
    const snapshot = parseOccurrenceSnapshot(occurrence.snapshot_json)
    assert.equal(snapshot?.config.everyMs, 15 * MINUTE)
    assert.equal(snapshot?.config.dailyRuns, 5)
  } finally {
    h.store.close()
  }
})

test('a recovered lease keeps the first claim\'s snapshot, not the second worker\'s', () => {
  const h = harness('snap-recover')
  try {
    const schedule = h.store.scheduleForRepo(h.repoId)
    const repo = h.store.getRepo(h.repoId)
    assert.ok(schedule !== undefined && repo !== undefined)
    const firstSnapshot = encodeOccurrenceSnapshot(occurrenceSnapshot(schedule, repo))

    const leaseMs = 30_000
    const now = Date.parse('2026-01-01T00:00:00Z')
    const first = h.store.claimScheduleOccurrence({
      id: 'occ_a', scheduleId: h.scheduleId, repoId: h.repoId,
      logicalTime: now, timingRevision: 1,
      leaseToken: 'tok_a', leaseMs, now,
      snapshotJson: firstSnapshot,
    })
    assert.equal(first.claimed, true)
    assert.equal(first.row.snapshot_json, firstSnapshot)

    editSchedule(h.store, h.repoId)
    const edited = h.store.scheduleForRepo(h.repoId)
    const editedSnapshot = encodeOccurrenceSnapshot(occurrenceSnapshot(edited!, h.store.getRepo(h.repoId)!))
    assert.notEqual(editedSnapshot, firstSnapshot)

    const second = h.store.claimScheduleOccurrence({
      id: 'occ_b', scheduleId: h.scheduleId, repoId: h.repoId,
      logicalTime: now, timingRevision: 1,
      leaseToken: 'tok_b', leaseMs, now: now + leaseMs + 1,
      snapshotJson: editedSnapshot,
    })
    assert.equal(second.claimed, true)
    assert.equal(second.row.attempts, 2)
    assert.equal(second.row.snapshot_json, firstSnapshot, 'the recovered row keeps the snapshot of the decision it already recorded')
  } finally {
    h.store.close()
  }
})

test('a row written before the column existed reads as unknown, never as the live config', () => {
  const h = harness('snap-unknown')
  try {
    const written = h.store.recordScheduleOccurrence({
      id: 'occ_old', scheduleId: h.scheduleId, repoId: h.repoId,
      logicalTime: Date.parse('2026-01-01T00:00:00Z'), timingRevision: 1,
      state: 'skipped', reason: 'misfire-skip',
    })
    assert.equal(written.row.snapshot_json, null)
    assert.equal(parseOccurrenceSnapshot(written.row.snapshot_json), null)

    // Even after the live schedule changes, an absent snapshot stays absent.
    editSchedule(h.store, h.repoId)
    const reread = h.store.findScheduleOccurrence(h.scheduleId, Date.parse('2026-01-01T00:00:00Z'), 1)
    assert.equal(parseOccurrenceSnapshot(reread?.snapshot_json), null)
  } finally {
    h.store.close()
  }
})

test('a run-now press records the snapshot it was accepted under and keeps it on replay', async () => {
  const h = harness('snap-runnow')
  try {
    const repo = h.store.getRepo(h.repoId)
    assert.ok(repo !== undefined)
    const first = await h.jobs.runScheduleNow(repo, 'cmd:snap')
    assert.equal(first.occurrence !== undefined, true)
    const snapshot = parseOccurrenceSnapshot(first.occurrence?.snapshot_json)
    assert.equal(snapshot?.config.everyMs, 15 * MINUTE)

    editSchedule(h.store, h.repoId)
    const replay = await h.jobs.runScheduleNow(repo, 'cmd:snap')
    assert.equal(replay.replayed, true)
    assert.equal(replay.occurrence?.id, first.occurrence?.id)
    assert.equal(replay.occurrence?.snapshot_json, first.occurrence?.snapshot_json)
  } finally {
    h.store.close()
  }
})

test('an unreadable snapshot is unknown, not a guess', () => {
  assert.equal(parseOccurrenceSnapshot(null), null)
  assert.equal(parseOccurrenceSnapshot(''), null)
  assert.equal(parseOccurrenceSnapshot('not json'), null)
  assert.equal(parseOccurrenceSnapshot('{"version":2}'), null, 'a newer shape is not read by this build')
  assert.equal(parseOccurrenceSnapshot('{"version":1,"config":{},"authorization":{}}'), null)
})
