import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import type { Runner, RunnerContext } from '../src/jobs/runner.js'
import { makeUser, MemoryMailer, testConfig } from './helpers.js'

function repoFor(store: Store, userId: string, id: string): ReturnType<Store['createRepo']> {
  return store.createRepo({
    id,
    userId,
    owner: 'o',
    name: id,
    defaultBranch: 'main',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
    canReview: true,
    reviewerEnabled: true,
  })
}

test('QUEUE_DISPATCH enqueues first and dispatches the claimed job on the tick', async () => {
  const config = testConfig({ runner: { ...testConfig().runner, queueDispatch: true, maxActiveJobs: 1 } })
  const store = new Store(':memory:')
  const calls: RunnerContext[] = []
  const runner: Runner = {
    name: 'capture',
    async run(context) {
      calls.push(context)
      return { status: 'succeeded', summary: 'ok' }
    },
  }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'queue-user', status: 'approved' })
    const repo = repoFor(store, user.id, 'repo_queue_one')

    const queued = await jobs.enqueue(repo, 'manual')
    assert.equal(queued.ok, true)
    assert.equal(queued.job?.status, 'queued')
    assert.equal(queued.job?.lease_owner, null)
    assert.equal(calls.length, 0)

    await jobs.tick()

    assert.equal(calls.length, 1)
    const done = store.getJob(queued.job!.id)
    assert.equal(done?.status, 'succeeded')
    assert.equal(done?.lease_owner, null)
  } finally {
    store.close()
  }
})

test('the dispatcher respects maxActiveJobs and releases the next repo after the first finishes', async () => {
  const config = testConfig({ runner: { ...testConfig().runner, queueDispatch: true, maxActiveJobs: 1 } })
  const store = new Store(':memory:')
  const calls: RunnerContext[] = []
  const runner: Runner = {
    name: 'capture',
    async run(context) {
      calls.push(context)
      return { status: 'running' }
    },
  }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'queue-cap-user', status: 'approved' })
    const one = repoFor(store, user.id, 'repo_queue_one')
    const two = repoFor(store, user.id, 'repo_queue_two')
    const first = await jobs.enqueue(one, 'manual')
    const second = await jobs.enqueue(two, 'manual')
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)

    await jobs.tick()
    assert.equal(calls.length, 1)
    const firstJob = store.getJob(first.job!.id)
    assert.equal(firstJob?.status, 'running')
    assert.equal(store.getJob(second.job!.id)?.status, 'queued')

    store.updateJob(first.job!.id, { status: 'succeeded', finished_at: new Date().toISOString() })
    store.releaseJobLease(first.job!.id)
    await jobs.tick()
    assert.equal(calls.length, 2)
    assert.equal(store.getJob(second.job!.id)?.status, 'running')
  } finally {
    store.close()
  }
})
