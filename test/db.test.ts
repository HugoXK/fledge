import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    const repo = store.createRepo({ id: 'repo_metrics', userId: user.id, owner: 'o', name: 'm', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
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

test('a running job without started_at is still eligible for timeout cleanup', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'stale-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_stale', userId: user.id, owner: 'o', name: 'stale', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.createJob({ id: 'job_stale', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    store.updateJob('job_stale', { status: 'running' })
    assert.equal(store.getJob('job_stale')?.started_at, null)
    const stale = store.staleRunningJobs(new Date(Date.now() + 60_000).toISOString())
    assert.equal(stale.some((job) => job.id === 'job_stale'), true)
    store.createJob({ id: 'job_stale_queued', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb2', platformTokenHash: '' })
    const staleQueued = store.staleQueuedJobs(new Date(Date.now() + 60_000).toISOString())
    assert.equal(staleQueued.some((job) => job.id === 'job_stale_queued'), true)
  } finally {
    store.close()
  }
})


test('the role backfill runs once and future schema versions are refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-migrate-'))
  const path = join(dir, 'fledge.db')
  try {
    const store = new Store(path)
    const user = makeUser(store, { login: 'migrate-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_migrate', userId: user.id, owner: 'o', name: 'migrate', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: null, goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.db.exec('PRAGMA user_version = 14;')
    store.close()

    const reopened = new Store(path)
    assert.equal(reopened.getRepo(repo.id)?.repo_role, 'maintainer')
    assert.notEqual(reopened.getRepo(repo.id)?.role_checked_at, null)
    reopened.db.exec('PRAGMA user_version = 25;')
    reopened.close()

    assert.throws(() => new Store(path), /newer than this build/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pruneOldData removes old jobs, notifications and settings keys', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'prune-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_prune', userId: user.id, owner: 'o', name: 'prune', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.createJob({ id: 'job_old', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb1', platformTokenHash: '' })
    store.updateJob('job_old', { status: 'succeeded', finished_at: '2000-01-01T00:00:00.000Z' })
    store.createJob({ id: 'job_new', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb2', platformTokenHash: '' })
    store.updateJob('job_new', { status: 'succeeded', finished_at: new Date().toISOString() })
    store.notify(user.id, 'test', 'old')
    store.db.exec("UPDATE notifications SET created_at = '2000-01-01T00:00:00.000Z'")
    store.setSetting('followup:old', '2000-01-01T00:00:00.000Z')
    store.setSetting('followup:recent', new Date().toISOString())
    store.pruneOldData()
    assert.equal(store.getJob('job_old'), undefined)
    assert.ok(store.getJob('job_new'))
    assert.equal(store.listNotifications(user.id).length, 0)
    assert.equal(store.getSetting('followup:old'), undefined)
    assert.notEqual(store.getSetting('followup:recent'), undefined)
  } finally {
    store.close()
  }
})

test('work items persist, update and are found by issue or PR', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'work-item-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_work_items', userId: user.id, owner: 'o', name: 'wi', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const item = store.createWorkItem({ id: 'work_1', repoId: repo.id, userId: user.id, title: 'Fix parser', detail: 'Details', issueUrl: 'https://github.com/o/wi/issues/1', priority: 20 })
    assert.equal(item.state, 'proposed')
    assert.equal(store.findWorkItemByIssueUrl(repo.id, 'https://github.com/o/wi/issues/1')?.id, 'work_1')
    store.updateWorkItem(item.id, { state: 'pr_ready', pr_url: 'https://github.com/o/wi/pull/2', pr_state: 'open' })
    assert.equal(store.findWorkItemByPrUrl(repo.id, 'https://github.com/o/wi/pull/2')?.state, 'pr_ready')
    assert.equal(store.listWorkItems(repo.id).length, 1)
    assert.equal(store.workItemMetrics('2000-01-01T00:00:00.000Z').open, 1)
    store.updateWorkItem(item.id, { state: 'merged', merged_at: new Date().toISOString() })
    assert.equal(store.workItemMetrics('2000-01-01T00:00:00.000Z').merged, 1)
  } finally {
    store.close()
  }
})

test('usage and job tokens carry the repository for cost attribution', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'attribution-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_attribution', userId: user.id, owner: 'o', name: 'a', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.recordUsage(user.id, null, 0.2, null, repo.id)
    const usage = store.get<{ repo_id: string | null }>('SELECT repo_id FROM quota_ledger ORDER BY id DESC LIMIT 1')
    assert.equal(usage?.repo_id, repo.id)
    const token = store.createApiToken({ id: 'tok_attr', userId: user.id, kind: 'job', name: 'job:attr', tokenHash: 'hash_attr', prefix: 'flg', repoId: repo.id, expiresAt: null })
    assert.equal(token.repo_id, repo.id)
  } finally {
    store.close()
  }
})

test('answering a team question marks only question notifications read', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'inbox-user', status: 'approved' })
    store.notify(user.id, 'job', 'o/r 团队提问：continue?')
    store.notify(user.id, 'job', 'unrelated job failure')
    store.markQuestionNotificationsRead(user.id)
    const rows = store.listNotifications(user.id)
    assert.notEqual(rows.find((row) => row.message.includes('团队提问'))?.read_at, null)
    assert.equal(rows.find((row) => row.message.includes('unrelated'))?.read_at, null)
  } finally {
    store.close()
  }
})

test('user model connections and repository selections persist', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'model-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_models', userId: user.id, owner: 'o', name: 'm', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const first = store.createUserModel({ id: 'mdl_a', userId: user.id, label: 'A', baseUrl: 'https://a.example/v1', keyEnc: 'enc', model: 'model-a', allowPrivate: false })
    const second = store.createUserModel({ id: 'mdl_b', userId: user.id, label: 'B', baseUrl: 'http://192.168.1.2:11434/v1', keyEnc: 'enc', model: 'model-b', allowPrivate: true })
    assert.equal(store.listUserModels(user.id).length, 2)
    assert.equal(store.userModelById(first.id, user.id)?.label, 'A')
    store.setRepoModels(repo.id, [first.id, second.id], second.id)
    const selected = store.listRepoModels(repo.id)
    assert.deepEqual(selected.map((model) => model.id), [first.id, second.id])
    assert.equal(selected.find((model) => model.is_default === 1)?.id, second.id)
    assert.equal(store.getRepo(repo.id)?.models_dirty, 1)
    assert.equal(store.repoModelForRun(repo.id, second.id)?.model, 'model-b')
    store.markRepoModelsApplied(repo.id)
    assert.equal(store.getRepo(repo.id)?.models_dirty, 0)
    store.deleteUserModel(first.id, user.id)
    assert.equal(store.listRepoModels(repo.id).length, 1)
  } finally {
    store.close()
  }
})

test('stalled jobs and repository failure counters are persisted', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'stall-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_stall', userId: user.id, owner: 'o', name: 's', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: true, intervalMinutes: 1440 })
    store.createJob({ id: 'job_stall', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate' })
    store.updateJob('job_stall', { status: 'running', started_at: '2000-01-01T00:00:00.000Z' })
    assert.equal(store.stalledRunningJobs(new Date().toISOString()).length, 1)
    store.touchJobCallback('job_stall')
    assert.notEqual(store.getJob('job_stall')?.last_callback_at, null)
    assert.equal(store.incrementRepoFailures(repo.id), 1)
    assert.equal(store.incrementRepoFailures(repo.id), 2)
    store.resetRepoFailures(repo.id)
    assert.equal(store.getRepo(repo.id)?.consecutive_failures, 0)
    store.markRepoCredential(repo.id, 'invalid')
    assert.equal(store.getRepo(repo.id)?.credential_state, 'invalid')
  } finally {
    store.close()
  }
})

test('pull request jobs disappear from the delivery list after merge', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'delivery-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_delivery', userId: user.id, owner: 'o', name: 'd', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.createJob({ id: 'job_delivery', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate' })
    store.updateJob('job_delivery', { pr_url: 'https://github.com/o/d/pull/1' })
    assert.equal(store.listPrJobsForRepo(repo.id).length, 1)
    store.updateJobsPrState('https://github.com/o/d/pull/1', 'merged')
    assert.equal(store.listPrJobsForRepo(repo.id).length, 0)
  } finally {
    store.close()
  }
})
