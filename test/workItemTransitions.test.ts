import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import type { Runner, RunnerContext } from '../src/jobs/runner.js'
import { WORK_ITEM_TRANSITIONS } from '../src/lib/workItems.js'
import { makeUser, MemoryMailer, testConfig } from './helpers.js'

// Both cases drive the public enqueue -> callback (or quotaBlocked) path and then
// ask the recorded table whether it offers the state the service just wrote, so
// the table cannot drift away from the service again without a red run.
function harness(): { store: Store; jobs: Jobs; contexts: RunnerContext[] } {
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
  return { store, jobs, contexts }
}

test('a failed job moves its work item to a state the recorded table offers', async () => {
  const { store, jobs, contexts } = harness()
  try {
    const user = makeUser(store, { login: 'transition-fail-user', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_transition_fail', userId: user.id, owner: 'o', name: 'tf', defaultBranch: 'main',
      tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
    })
    const item = store.createWorkItem({ id: 'work_transition_fail', repoId: repo.id, userId: user.id, title: 'Fix parser', state: 'triaged' })
    const result = await jobs.enqueue(repo, 'manual', 'work goal', 'iterate', { workItemId: item.id })
    assert.equal(result.ok, true)
    assert.equal(store.getWorkItem(item.id)?.state, 'in_progress', 'the job starts with the item in progress')

    await jobs.handleCallback(result.job!.id, contexts[0]!.callback.secret, { status: 'failed', error: 'bridge 502' })

    const after = store.getWorkItem(item.id)!
    assert.equal(after.state, 'triaged', 'a failed job returns its work item to triaged')
    assert.ok(
      WORK_ITEM_TRANSITIONS.in_progress.includes(after.state),
      `the service moved in_progress -> ${after.state}, but WORK_ITEM_TRANSITIONS.in_progress offers ${JSON.stringify(WORK_ITEM_TRANSITIONS.in_progress)}`,
    )
  } finally {
    store.close()
  }
})

test('a quota-refused job moves its work item to a state the recorded table offers', async () => {
  const { store, jobs } = harness()
  try {
    const user = makeUser(store, { login: 'transition-quota-user', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_transition_quota', userId: user.id, owner: 'o', name: 'tq', defaultBranch: 'main',
      tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
    })
    const item = store.createWorkItem({ id: 'work_transition_quota', repoId: repo.id, userId: user.id, title: 'Fix parser', state: 'triaged' })
    const result = await jobs.enqueue(repo, 'manual', 'work goal', 'iterate', { workItemId: item.id })
    assert.equal(result.ok, true)
    assert.equal(store.getWorkItem(item.id)?.state, 'in_progress', 'the job starts with the item in progress')

    await jobs.quotaBlocked(user)

    assert.equal(store.getJob(result.job!.id)?.status, 'quota_exhausted', 'the job ends quota_exhausted')
    const after = store.getWorkItem(item.id)!
    assert.equal(after.state, 'triaged', 'a quota-refused job leaves no active work item behind')
    assert.ok(
      WORK_ITEM_TRANSITIONS.in_progress.includes(after.state),
      `the service moved in_progress -> ${after.state}, but WORK_ITEM_TRANSITIONS.in_progress offers ${JSON.stringify(WORK_ITEM_TRANSITIONS.in_progress)}`,
    )
  } finally {
    store.close()
  }
})
