import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import type { Runner } from '../src/jobs/runner.js'
import { InstanceManager } from '../src/flybot/instances.js'
import { DEFAULT_DECISION, repairDecision, validateDecision } from '../src/lib/taskDecision.js'
import { makeUser, MemoryMailer, testConfig } from './helpers.js'

// #639: one bounded post-QA decision. These are the cases the issue names: a
// contradiction is repaired once, `supplement` appends without a second run, a
// title match never merges anything, and a related task leaves the running job
// one notice that is consumed exactly once.

function setup() {
  const config = testConfig()
  const store = new Store(':memory:')
  const runner: Runner = { name: 'capture', async run() { return { status: 'running' as const } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer(), new InstanceManager(store, config))
  const user = makeUser(store, { login: 'decision-user', status: 'approved' })
  const repo = store.createRepo({ id: 'repo_decision', userId: user.id, owner: 'o', name: 'd', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
  const job = (id: string, status: 'succeeded' | 'running' = 'succeeded') => {
    const row = store.createJob({ id, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: `h-${id}`, platformTokenHash: '' })
    store.updateJob(id, { status })
    return store.getJob(id)!
  }
  return { store, jobs, user, repo, job }
}

const claim = { reason: 'the follow-up repeats the same flaky retry', evidence: 'https://github.com/o/r/issues/12' }

test('the framework default is a separate task at P2', async () => {
  const { store, jobs, user, repo, job } = setup()
  try {
    assert.deepEqual(DEFAULT_DECISION, { kind: 'new', level: 'P2' })
    const source = job('job_dec_default')
    const out = await jobs.decideNextTask({ repoId: repo.id, sourceJobId: source.id, kind: 'new', ...claim, title: 'prove the retry fix under load', actorUserId: user.id })
    assert.equal(out.ok, true)
    assert.equal(out.kind, 'new')
    const items = store.listWorkItems(repo.id)
    assert.equal(items.length, 1)
    assert.equal(items[0]?.priority, 10, 'P2 is the default level')
    assert.equal(items[0]?.state, 'proposed')
    assert.equal(store.listAudit(50).some((entry) => entry.action === 'task.decision_new'), true)
  } finally {
    store.close()
  }
})

test('new plus an existing task id is repaired once into related', async () => {
  const { store, jobs, user, repo, job } = setup()
  try {
    const target = job('job_dec_target')
    const item = store.createWorkItem({ id: 'work_dec_target', repoId: repo.id, userId: user.id, title: 'flaky retry', state: 'triaged', jobId: target.id })
    const source = job('job_dec_source')

    // The repair is a pure decision: the separate-task claim loses.
    assert.deepEqual(repairDecision('new', item.id), { kind: 'related', existingTaskId: item.id, repaired: true })
    assert.deepEqual(repairDecision('new', ''), { kind: 'new', existingTaskId: '', repaired: false })

    const out = await jobs.decideNextTask({ repoId: repo.id, sourceJobId: source.id, kind: 'new', existingTaskId: item.id, ...claim, title: 'another symptom', actorUserId: user.id })
    assert.equal(out.ok, true)
    assert.equal(out.kind, 'related')
    assert.equal(out.repaired, true)
    const relations = store.listTaskRelations(source.id)
    assert.equal(relations.length, 1)
    assert.equal(relations[0]?.kind, 'related')
    assert.equal(relations[0]?.target_job_id, target.id)
  } finally {
    store.close()
  }
})

test('supplement appends to the existing task and starts nothing', async () => {
  const { store, jobs, user, repo, job } = setup()
  try {
    const item = store.createWorkItem({ id: 'work_dec_supp', repoId: repo.id, userId: user.id, title: 'flaky retry', detail: 'original note', state: 'assigned' })
    const source = job('job_dec_supp')
    const before = store.listWorkItems(repo.id).length
    const out = await jobs.decideNextTask({ repoId: repo.id, sourceJobId: source.id, kind: 'supplement', existingTaskId: item.id, ...claim, actorUserId: user.id })
    assert.equal(out.ok, true)
    assert.equal(out.workItemId, item.id)
    const after = store.getWorkItem(item.id)!
    assert.match(after.detail, /original note/)
    assert.match(after.detail, /the follow-up repeats the same flaky retry/)
    assert.equal(store.listWorkItems(repo.id).length, before, 'no second task was created')
    assert.equal(store.listJobEvents(source.id, 20).length, 0, 'and no second execution was queued')
    assert.equal(after.state, 'assigned', 'supplement does not change the task state by itself')
  } finally {
    store.close()
  }
})

test('a decision that names no existing task is refused', async () => {
  const { jobs, user, repo, job } = setup()
  try {
    const source = job('job_dec_none')
    const out = await jobs.decideNextTask({ repoId: repo.id, sourceJobId: source.id, kind: 'supplement', ...claim, actorUserId: user.id })
    assert.equal(out.ok, false)
    assert.equal(out.code, 'DECISION_TARGET_REQUIRED')
  } finally {
    // setup owns the store; closing it twice is not needed for this case shape.
  }
})

test('a decision without checkable evidence is refused', async () => {
  const { jobs, user, repo, job } = setup()
  try {
    const source = job('job_dec_weak')
    const out = await jobs.decideNextTask({ repoId: repo.id, sourceJobId: source.id, kind: 'new', reason: 'it seems related', evidence: 'obviously', title: 'x', actorUserId: user.id })
    assert.equal(out.ok, false)
    assert.equal(out.code, 'DECISION_EVIDENCE_REQUIRED')
    assert.equal(validateDecision({ kind: 'new', existingTaskId: '', reason: 'short', evidence: 'nope' }).ok, false)
  } finally {
    // see above
  }
})

test('a related task leaves the running job one notice, consumed once', async () => {
  const { store, jobs, user, repo, job } = setup()
  try {
    // One active job per repository: the source finishes first, then the task it
    // relates to is the one still running.
    const source = job('job_dec_related')
    const running = job('job_dec_running', 'running')
    const item = store.createWorkItem({ id: 'work_dec_running', repoId: repo.id, userId: user.id, title: 'retry fix', state: 'assigned', jobId: running.id })
    const out = await jobs.decideNextTask({ repoId: repo.id, sourceJobId: source.id, kind: 'related', existingTaskId: item.id, ...claim, title: 'second symptom', actorUserId: user.id })
    assert.equal(out.ok, true)
    assert.equal(store.getSetting(`coordination:${running.id}`) !== undefined, true)

    assert.equal(jobs.consumeCoordination(running.id), true)
    assert.equal(jobs.consumeCoordination(running.id), false, 'the notice is consumed once')
    assert.equal(store.getSetting(`coordination:${running.id}`), undefined)
    const events = store.listJobEvents(running.id, 20)
    assert.equal(events.filter((event) => event.kind === 'job.coordination_notice').length, 1)
  } finally {
    store.close()
  }
})
