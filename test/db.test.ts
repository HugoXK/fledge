import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { addDays } from '../src/lib/time.js'
import { makeUser } from './helpers.js'

test('users, repos, jobs, tokens and usage persist in SQLite', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'octo', status: 'pending' })
    assert.equal(user.status, 'pending')
    assert.equal(user.quota_cny, 1)
    store.setUserStatus(user.id, 'approved', 'test')
    assert.equal(store.userById(user.id)?.status, 'approved')
    store.markApprovalSent(user.id)
    assert.notEqual(store.userById(user.id)?.approval_sent_at, null)

    const repo = store.createRepo({
      id: 'repo_1',
      userId: user.id,
      owner: 'octo',
      name: 'demo',
      defaultBranch: 'main',
      tokenEnc: 'v1:test',
      goal: 'fix bugs',
      autoIterate: true,
      intervalMinutes: 60,
    })
    assert.equal(store.listRepos(user.id).length, 1)
    assert.equal(store.getRepoByOwnerName(user.id, 'OCTO', 'DEMO')?.id, repo.id)

    const job = store.createJob({
      id: 'job_1',
      repoId: repo.id,
      userId: user.id,
      trigger: 'manual',
      goal: 'fix bugs',
      callbackHash: 'hash',
      platformTokenHash: 'tokenhash',
    })
    assert.equal(job.status, 'queued')
    assert.equal(store.activeJobForRepo(repo.id)?.id, job.id)
    store.updateJob(job.id, { status: 'running', started_at: new Date().toISOString() })
    assert.equal(store.countActiveJobs(), 1)
    store.updateJob(job.id, { status: 'succeeded', finished_at: new Date().toISOString() })
    assert.equal(store.countActiveJobs(), 0)

    store.createApiToken({
      id: 'tok_1',
      userId: user.id,
      kind: 'pat',
      name: 'cli',
      tokenHash: 'abc',
      prefix: 'flg_abcd',
      expiresAt: null,
    })
    assert.equal(store.findApiToken('abc')?.name, 'cli')
    assert.equal(store.listApiTokens(user.id).length, 1)

    store.recordUsage(user.id, job.id, 0.02)
    assert.equal(store.userById(user.id)?.quota_used_usd, 0.02)
    assert.equal(store.usageTotal(user.id), 0.02)

    store.createApprovalToken('approvehash', user.id, 'approve', addDays(1))
    assert.equal(store.findApprovalToken('approvehash')?.action, 'approve')
    store.useApprovalToken('approvehash')
    assert.equal(store.findApprovalToken('approvehash'), undefined)

    store.notify(user.id, 'test', 'hello')
    assert.equal(store.listNotifications(user.id).length, 1)
    store.markNotificationsRead(user.id)
    assert.equal(store.listNotifications(user.id)[0]?.read_at !== null, true)
  } finally {
    store.close()
  }
})
