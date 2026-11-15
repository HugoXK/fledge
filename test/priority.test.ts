import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import type { JobStatus } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import type { Runner } from '../src/jobs/runner.js'
import { InstanceManager } from '../src/flybot/instances.js'
import { levelFromRank, priorityRank, PRIORITY_LEVELS } from '../src/lib/priority.js'
import { makeUser, MemoryMailer, testConfig } from './helpers.js'

// #639: the priority ladder is the closed P0..P3 set; the integer column keeps
// the ordering the queue ticket already reads. These tests are the red half of
// the first slice: the level table, the evidence standard and the ticket rule.
function setup() {
  const config = testConfig()
  const store = new Store(':memory:')
  const runner: Runner = { name: 'capture', async run() { return { status: 'running' as const } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer(), new InstanceManager(store, config))
  const user = makeUser(store, { login: 'priority-user', status: 'approved' })
  // jobs_one_active_per_repo allows one queued/running job per repository, so a
  // multi-job scenario gets one repository per job, like three real repos.
  let repos = 0
  const repo = () => store.createRepo({ id: `repo_priority_${++repos}`, userId: user.id, owner: 'o', name: `r${repos}`, defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440, canReview: false, reviewerEnabled: false })
  let n = 0
  const job = (priority: number, status: JobStatus = 'queued', target = repo()) => {
    const row = store.createJob({ id: `job_priority_${++n}`, repoId: target.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'h', platformTokenHash: 't', priority })
    if (status !== 'queued') store.updateJob(row.id, { status })
    return store.getJob(row.id)!
  }
  return { store, jobs, user, repo, job }
}

test('the legacy 0/10/20/30 integers map onto the closed P0-P3 ladder', () => {
  assert.deepEqual([...PRIORITY_LEVELS], ['P0', 'P1', 'P2', 'P3'])
  assert.equal(levelFromRank(30), 'P0')
  assert.equal(levelFromRank(20), 'P1')
  assert.equal(levelFromRank(10), 'P2')
  assert.equal(levelFromRank(0), 'P3')
  // Work-item priorities are 0..100; the ladder clamps them rather than inventing levels.
  assert.equal(levelFromRank(100), 'P0')
  assert.equal(levelFromRank(7), 'P3')
  assert.equal(priorityRank('P0'), 30)
  assert.equal(priorityRank('P3'), 0)
})

test('a P1 claim without evidence is refused and the ticket does not move', async () => {
  const { store, jobs, user, job } = setup()
  try {
    const row = job(10)
    const before = store.getJob(row.id)!
    const out = await jobs.setPriority(row.id, { level: 'P1', reason: 'this is urgent', evidence: '', actorUserId: user.id })
    assert.equal(out.ok, false)
    assert.equal(out.code, 'PRIORITY_EVIDENCE_REQUIRED')
    const after = store.getJob(row.id)!
    assert.equal(after.priority, before.priority)
    assert.equal(after.queue_seq, before.queue_seq)
    assert.equal(store.listAudit(50).some((a) => a.action === 'job.priority_changed'), false)
  } finally {
    store.close()
  }
})

test('adjectives alone are not evidence', async () => {
  const { store, jobs, user, job } = setup()
  try {
    const row = job(10)
    const out = await jobs.setPriority(row.id, { level: 'P0', reason: 'very very urgent!!!', evidence: 'critical, blocking everything', actorUserId: user.id })
    assert.equal(out.ok, false)
    assert.equal(out.code, 'PRIORITY_EVIDENCE_REQUIRED')
    assert.equal(store.getJob(row.id)!.priority, 10)
  } finally {
    store.close()
  }
})

test('a no-op priority save keeps the ticket', async () => {
  const { store, jobs, user, job } = setup()
  try {
    const row = job(10)
    const before = store.getJob(row.id)!
    const out = await jobs.setPriority(row.id, { level: 'P2', actorUserId: user.id })
    assert.equal(out.ok, true)
    assert.equal(out.changed, false)
    const after = store.getJob(row.id)!
    assert.equal(after.queue_seq, before.queue_seq)
    assert.equal(after.priority, before.priority)
  } finally {
    store.close()
  }
})

test('a real change lands at the tail of the new level', async () => {
  const { store, jobs, user, job } = setup()
  try {
    const first = job(10)
    const second = job(10)
    const third = job(10)
    const tail = Math.max(first.queue_seq, second.queue_seq, third.queue_seq)
    const out = await jobs.setPriority(second.id, {
      level: 'P1',
      reason: 'the release job is blocked on this defect',
      evidence: 'https://github.com/o/r/issues/639',
      actorUserId: user.id,
    })
    assert.equal(out.ok, true)
    assert.equal(out.changed, true)
    const after = store.getJob(second.id)!
    assert.equal(after.priority, priorityRank('P1'))
    assert.ok(after.queue_seq > tail, `expected a ticket past ${tail}, got ${after.queue_seq}`)
    const queued = store.listQueuedJobs()
    assert.equal(queued[0]?.id, second.id)
  } finally {
    store.close()
  }
})

test('a running job is never preempted by a later P0', async () => {
  const { store, jobs, user, job } = setup()
  try {
    const running = job(10, 'running')
    const out = await jobs.setPriority(running.id, {
      level: 'P0',
      reason: 'credential exposure: the token is live in a public log',
      evidence: 'sha 0123456789abcdef and 14 error responses in 60s',
      actorUserId: user.id,
    })
    assert.equal(out.ok, true)
    const after = store.getJob(running.id)!
    // The level moves, the run does not: no pause, no cancel, no status write.
    assert.equal(after.status, 'running')
    assert.equal(after.priority, priorityRank('P0'))
    assert.equal(after.started_at, running.started_at)
  } finally {
    store.close()
  }
})

test('a priority change is audited with its reason and evidence', async () => {
  const { store, jobs, user, job } = setup()
  try {
    const row = job(10)
    const out = await jobs.setPriority(row.id, {
      level: 'P1',
      reason: 'the core goal cannot move until this is fixed',
      evidence: 'https://github.com/o/r/issues/639#issuecomment-1',
      actorUserId: user.id,
    })
    assert.equal(out.ok, true)
    const entry = store.listAudit(20).find((a) => a.action === 'job.priority_changed')
    assert.ok(entry, 'expected a job.priority_changed audit row')
    assert.match(entry!.detail ?? '', /P2->P1/)
    assert.match(entry!.detail ?? '', /issues\/639/)
  } finally {
    store.close()
  }
})

test('an unknown level is refused', async () => {
  const { store, jobs, user, job } = setup()
  try {
    const row = job(10)
    const out = await jobs.setPriority(row.id, { level: 'P9' as never, actorUserId: user.id })
    assert.equal(out.ok, false)
    assert.equal(out.code, 'PRIORITY_LEVEL_INVALID')
  } finally {
    store.close()
  }
})
