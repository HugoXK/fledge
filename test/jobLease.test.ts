import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { makeUser } from './helpers.js'

function setup(): { store: Store; repoId: string; repo2Id: string; userId: string } {
  const store = new Store(':memory:')
  const user = makeUser(store, { login: 'lease-user', status: 'approved' })
  const makeRepo = (id: string) => store.createRepo({
    id,
    userId: user.id,
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
  const repo = makeRepo('repo_lease')
  const repo2 = makeRepo('repo_lease_2')
  return { store, repoId: repo.id, repo2Id: repo2.id, userId: user.id }
}

function makeJob(store: Store, repoId: string, userId: string, id: string, priority = 0): void {
  store.createJob({
    id,
    repoId,
    userId,
    trigger: 'schedule',
    goal: 'g',
    callbackHash: 'h',
    platformTokenHash: '',
    kind: 'iterate',
    priority,
  })
}

test('claimQueuedJob leases the highest-priority queued job exactly once', () => {
  const { store, repoId, repo2Id, userId } = setup()
  try {
    makeJob(store, repo2Id, userId, 'job_low', 0)
    makeJob(store, repoId, userId, 'job_high', 10)

    const first = store.claimQueuedJob('worker-1', 60_000)
    assert.equal(first?.id, 'job_high')
    assert.equal(first?.lease_owner, 'worker-1')
    assert.ok(first?.lease_until)

    const second = store.claimQueuedJob('worker-2', 60_000)
    assert.equal(second?.id, 'job_low')
    assert.equal(second?.lease_owner, 'worker-2')

    assert.equal(store.claimQueuedJob('worker-3', 60_000), undefined)
  } finally {
    store.close()
  }
})

test('only one queued job per repository is claimable at a time', () => {
  const { store, repoId, userId } = setup()
  try {
    makeJob(store, repoId, userId, 'job_first', 0)
    makeJob(store, repoId, userId, 'job_second', 10)

    const first = store.claimQueuedJob('worker-1', 60_000)
    assert.equal(first?.id, 'job_second')
    assert.equal(store.claimQueuedJob('worker-2', 60_000), undefined)

    store.updateJob('job_second', { status: 'running' })
    assert.equal(store.claimQueuedJob('worker-2', 60_000), undefined)

    store.updateJob('job_second', { status: 'succeeded', finished_at: new Date().toISOString() })
    const next = store.claimQueuedJob('worker-2', 60_000)
    assert.equal(next?.id, 'job_first')
  } finally {
    store.close()
  }
})

test('a lease can only be renewed or released by its owner', () => {
  const { store, repoId, userId } = setup()
  try {
    makeJob(store, repoId, userId, 'job_a')
    const claimed = store.claimQueuedJob('worker-1', 60_000)
    assert.equal(claimed?.id, 'job_a')

    assert.equal(store.renewJobLease('job_a', 'worker-2', 60_000), false)
    assert.equal(store.renewJobLease('job_a', 'worker-1', 60_000), true)

    store.releaseJobLease('job_a')
    const reclaimed = store.claimQueuedJob('worker-2', 60_000)
    assert.equal(reclaimed?.id, 'job_a')
    assert.equal(reclaimed?.lease_owner, 'worker-2')
  } finally {
    store.close()
  }
})

test('an expired lease is reclaimable by another worker', async () => {
  const { store, repoId, userId } = setup()
  try {
    makeJob(store, repoId, userId, 'job_exp')
    const first = store.claimQueuedJob('worker-1', 1)
    assert.equal(first?.id, 'job_exp')

    await new Promise((resolve) => setTimeout(resolve, 15))
    const expired = store.expiredLeaseJobs(new Date().toISOString())
    assert.ok(expired.some((job) => job.id === 'job_exp'))

    const second = store.claimQueuedJob('worker-2', 60_000)
    assert.equal(second?.id, 'job_exp')
    assert.equal(second?.lease_owner, 'worker-2')
  } finally {
    store.close()
  }
})
