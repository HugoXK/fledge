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
    assert.equal(user.email_job_updates, 1)
    assert.equal(user.email_daily_digest, 1)
    assert.equal(user.notify_email, null)
    store.setNotifyEmail(user.id, 'me@example.com')
    store.setEmailDailyDigest(user.id, false)
    assert.equal(store.userById(user.id)?.notify_email, 'me@example.com')
    assert.equal(store.userById(user.id)?.email_daily_digest, 0)
    store.setEmailDailyDigest(user.id, true)
    store.setEmailJobUpdates(user.id, false)
    assert.equal(store.userById(user.id)?.email_job_updates, 0)
    store.setEmailJobUpdates(user.id, true)
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

test('events and product metrics are recorded', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'metrics-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_metrics', userId: user.id, owner: 'o', name: 'm', defaultBranch: 'main', tokenEnc: 'x', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const job = store.createJob({ id: 'job_metrics', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    store.updateJob(job.id, { status: 'succeeded', pr_url: 'https://github.com/o/m/pull/1', finished_at: new Date().toISOString() })
    store.event('job_enqueued', { userId: user.id, repoId: repo.id, jobId: job.id })
    store.event('pr_open', { userId: user.id, repoId: repo.id, jobId: job.id })
    assert.equal(store.countEvents('job_enqueued'), 1)
    const metrics = store.productMetrics(new Date(0).toISOString())
    assert.equal(metrics.users, 1)
    assert.equal(metrics.approved, 1)
    assert.equal(metrics.repos, 1)
    assert.equal(metrics.jobs, 1)
    assert.equal(metrics.succeeded, 1)
    assert.equal(metrics.usersWithPr, 1)
    assert.equal(metrics.events.find((event) => event.name === 'pr_open')?.n, 1)
    store.updateJob(job.id, { team_stats_json: JSON.stringify([{ role: 'lead', calls: 12 }, { role: 'test', calls: 3 }]) })
    const team = store.teamMetrics(new Date(0).toISOString())
    assert.equal(team.jobs, 1)
    assert.equal(team.avgRoles, 2)
    assert.equal(team.leadOnly, 0)
    assert.equal(team.roles.find((entry) => entry.role === 'lead')?.calls, 12)
  } finally {
    store.close()
  }
})
