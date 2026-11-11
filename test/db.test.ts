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
    reopened.db.exec('PRAGMA user_version = 34;')
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

test('existing instance and job tokens are backfilled with their repository', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'backfill-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_backfill', userId: user.id, owner: 'o', name: 'b', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.createJob({ id: 'job_backfill', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate' })
    const instance = store.createApiToken({ id: 'tok_instance', userId: user.id, kind: 'instance', name: `flybot:${repo.id}`, tokenHash: 'h1', prefix: 'flg', expiresAt: null })
    const jobToken = store.createApiToken({ id: 'tok_job', userId: user.id, kind: 'job', name: 'job:job_backfill', tokenHash: 'h2', prefix: 'flg', expiresAt: null })
    assert.equal(instance.repo_id, null)
    assert.equal(jobToken.repo_id, null)
    store.backfillTokenRepoIds()
    assert.equal(store.findApiToken('h1')?.repo_id, repo.id)
    assert.equal(store.findApiToken('h2')?.repo_id, repo.id)
  } finally {
    store.close()
  }
})

test('model providers and provider models can be selected per repository', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'provider-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_provider', userId: user.id, owner: 'o', name: 'p', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const provider = store.createModelProvider({ id: 'prv_a', userId: user.id, label: 'Provider A', baseUrl: 'https://a.example/v1', keyEnc: 'enc', allowPrivate: false })
    const first = store.createProviderModel({ id: 'pvm_a1', providerId: provider.id, model: 'model-a', label: 'A' })
    const second = store.createProviderModel({ id: 'pvm_a2', providerId: provider.id, model: 'model-b', label: 'B' })
    assert.equal(store.listModelProviders(user.id).length, 1)
    assert.equal(store.listProviderModels(provider.id).length, 2)
    store.setRepoModelSelection(repo.id, [first.id, second.id], second.id)
    const selected = store.listRepoModelSelection(repo.id)
    assert.deepEqual(selected.map((model) => model.id), [first.id, second.id])
    assert.equal(selected.find((model) => model.is_default === 1)?.id, second.id)
    assert.equal(store.providerModelForRun(repo.id, second.id)?.model, 'model-b')
    assert.equal(store.deleteProviderModel(first.id, user.id), true)
    assert.equal(store.listRepoModelSelection(repo.id).length, 1)
  } finally {
    store.close()
  }
})

test('legacy user models and own model migrate to providers', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'legacy-model-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_legacy_models', userId: user.id, owner: 'o', name: 'l', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const legacy = store.createUserModel({ id: 'mdl_legacy', userId: user.id, label: 'Legacy', baseUrl: 'https://legacy.example/v1', keyEnc: 'enc', model: 'legacy-model', allowPrivate: false })
    store.setRepoModels(repo.id, [legacy.id], legacy.id)
    store.setUserOwnModel(user.id, 'https://own.example/v1', 'own-enc', 'own-model')
    store.deleteSetting('models_v2')
    store.migrateModelsV2()
    assert.equal(store.listModelProviders(user.id).length, 2)
    assert.equal(store.listRepoModelSelection(repo.id).length, 1)
    const labels = store.listUserProviderModels(user.id).map((model) => model.model)
    assert.ok(labels.includes('legacy-model'))
    assert.ok(labels.includes('own-model'))
  } finally {
    store.close()
  }
})

test('repository bot model assignments persist and are cleaned with the selection', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'bot-model-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_bot_models', userId: user.id, owner: 'o', name: 'b', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const provider = store.createModelProvider({ id: 'prv_bot', userId: user.id, label: 'Provider', baseUrl: 'https://p.example/v1', keyEnc: 'enc', allowPrivate: false })
    const first = store.createProviderModel({ id: 'pvm_bot_a', providerId: provider.id, model: 'a', label: 'A' })
    const second = store.createProviderModel({ id: 'pvm_bot_b', providerId: provider.id, model: 'b', label: 'B' })
    store.setRepoModelSelection(repo.id, [first.id, second.id], first.id)
    store.setRepoBotModel(repo.id, 'lead', first.id)
    store.setRepoBotModel(repo.id, 'product', second.id)
    assert.equal(store.listRepoBotModels(repo.id).length, 2)
    store.setRepoModelSelection(repo.id, [second.id], second.id)
    const remaining = store.listRepoBotModels(repo.id)
    assert.deepEqual(remaining.map((entry) => entry.role), ['product'])
  } finally {
    store.close()
  }
})

test('the per-user private model permission persists', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'private-permission-user', status: 'approved' })
    assert.equal(store.userById(user.id)?.allow_private_models, 0)
    store.setUserAllowPrivateModels(user.id, true)
    assert.equal(store.userById(user.id)?.allow_private_models, 1)
  } finally {
    store.close()
  }
})

test('usage attribution and stage metrics aggregate the window', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'metrics-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_metrics2', userId: user.id, owner: 'o', name: 'm', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.recordUsage(user.id, null, 0.5, null, repo.id)
    store.recordUsage(user.id, null, 0.25, null, null)
    store.event('team_participation_low', { userId: user.id, repoId: repo.id })
    store.event('team_attribution_grounded', { userId: user.id, repoId: repo.id })
    store.createJob({ id: 'job_scope_metric', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '', kind: 'scope' })
    const attribution = store.usageAttribution('2000-01-01T00:00:00.000Z')
    assert.equal(attribution.unattributedUsd, 0.25)
    assert.equal(attribution.attributedUsd, 0.5)
    const stages = store.stageMetrics('2000-01-01T00:00:00.000Z')
    assert.equal(stages.scope, 1)
    assert.equal(stages.leadOnly, 1)
    assert.equal(stages.grounded, 1)
  } finally {
    store.close()
  }
})

test('job events, personal delivery and cost read models are windowed', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'read-model-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_read_models', userId: user.id, owner: 'o', name: 'rm', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const old = store.createJob({ id: 'job_old_metric', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb-old', platformTokenHash: '', kind: 'iterate' })
    store.updateJob(old.id, { status: 'succeeded', pr_url: 'https://github.com/o/rm/pull/1', pr_state: 'merged', started_at: '2000-01-01T00:00:00.000Z', finished_at: '2000-01-01T00:10:00.000Z' })
    store.db.exec("UPDATE jobs SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = 'job_old_metric'")

    const job = store.createJob({ id: 'job_read_metric', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb-new', platformTokenHash: '', kind: 'iterate' })
    store.updateJob(job.id, { status: 'succeeded', pr_url: 'https://github.com/o/rm/pull/2', pr_state: 'merged', started_at: new Date(Date.now() - 10 * 60_000).toISOString(), finished_at: new Date().toISOString(), review_score: null })
    store.createJob({ id: 'job_read_failed', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb-fail', platformTokenHash: '', kind: 'review' })
    store.updateJob('job_read_failed', { status: 'failed', review_score: 40 })

    store.recordJobEvent({ jobId: job.id, repoId: repo.id, userId: user.id, kind: 'job.enqueued', step: 'iterate' })
    store.recordJobEvent({ jobId: job.id, repoId: repo.id, userId: user.id, kind: 'team.role', role: 'lead', step: 'delegate', meta: '{"calls":2}' })
    assert.equal(store.listJobEvents(job.id).length, 2)
    assert.equal(store.listJobEvents(job.id)[0]?.kind, 'team.role')

    store.recordUsage(user.id, job.id, 0.2, JSON.stringify({ model: 'model-a' }), repo.id)
    store.recordUsage(user.id, null, 0.1, JSON.stringify({ model: 'model-b' }), null)

    const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString()
    const product = store.productMetrics(since)
    assert.equal(product.jobs, 2)
    assert.equal(product.succeeded, 1)
    assert.equal(product.failed, 1)

    const delivery = store.deliveryMetrics(since)
    assert.equal(delivery.jobs, 2)
    assert.equal(delivery.succeeded, 1)
    assert.equal(delivery.merged, 1)
    assert.equal(delivery.mergeRate, 100)
    assert.ok(delivery.medianJobMs !== null && delivery.medianJobMs >= 0)

    const daily = store.dailyMetrics(since)
    assert.ok(daily.length > 0)
    assert.ok(daily.some((row) => row.jobs >= 1))

    const personal = store.personalMetrics(user.id, since)
    assert.equal(personal.jobs, 2)
    assert.equal(personal.merged, 1)
    assert.ok(Math.abs(personal.costUsd - 0.3) < 1e-9)

    const repoCosts = store.repoCostMetrics(since)
    assert.equal(repoCosts[0]?.repoId, repo.id)
    assert.equal(repoCosts[0]?.costUsd, 0.2)
    const modelCosts = store.modelCostMetrics(since)
    assert.ok(modelCosts.some((row) => row.model === 'model-a' && row.costUsd === 0.2))
    assert.ok(modelCosts.some((row) => row.model === 'model-b' && row.costUsd === 0.1))
  } finally {
    store.close()
  }
})

test('artifact versions, evaluations and promotions keep a decision ledger', () => {
  const store = new Store(':memory:')
  try {
    const artifact = store.createArtifactVersion({ id: 'art_1', artifact: 'playbook', version: 1, hash: 'hash-1', content: 'candidate text' })
    assert.equal(artifact.status, 'candidate')
    store.createEvaluation({ id: 'eval_1', artifactId: artifact.id, dataset: 'heldout', metric: 'merge_rate', value: 0.7, ciLow: 0.6, ciHigh: 0.8, samples: 40 })
    assert.equal(store.listEvaluations(artifact.id).length, 1)
    store.createPromotion({ id: 'promo_1', artifactId: artifact.id, decision: 'defer', reason: 'need more samples', evidenceHash: 'ev-hash' })
    assert.equal(store.listPromotions(artifact.id)[0]?.decision, 'defer')
    store.promoteArtifactVersion(artifact.id)
    assert.equal(store.listArtifactVersions('playbook')[0]?.status, 'promoted')
  } finally {
    store.close()
  }
})

test('alerts surface stalled jobs, stale PRs and near-budget repositories', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'alert-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_alerts', userId: user.id, owner: 'o', name: 'alerts', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440, monthlyBudgetCny: 1 })
    store.createJob({ id: 'job_stalled_alert', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb-alert', platformTokenHash: '' })
    store.updateJob('job_stalled_alert', { status: 'running', started_at: '2000-01-01T00:00:00.000Z' })
    store.createJob({ id: 'job_pr_alert', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb-pr', platformTokenHash: '' })
    store.updateJob('job_pr_alert', { status: 'succeeded', pr_url: 'https://github.com/o/alerts/pull/1', pr_state: 'open' })
    store.db.exec("UPDATE jobs SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = 'job_pr_alert'")
    store.recordUsage(user.id, null, 0.9, null, repo.id)
    store.markRepoCredential(repo.id, 'invalid')
    const alerts = store.alerts({ usdCny: 1 })
    assert.ok(alerts.some((alert) => alert.kind === 'job_stalled' && alert.repoLabel === 'o/alerts' && (alert.minutes ?? 0) > 0))
    assert.ok(alerts.some((alert) => alert.kind === 'pr_stale' && alert.prUrl === 'https://github.com/o/alerts/pull/1'))
    assert.ok(alerts.some((alert) => alert.kind === 'budget_near_limit' && (alert.spentCny ?? 0) >= 0.9))
    assert.ok(alerts.some((alert) => alert.kind === 'credential_invalid' && alert.state === 'invalid'))
    assert.equal(store.alerts({ usdCny: 1, userId: 'someone-else' }).length, 0)
  } finally {
    store.close()
  }
})

test('webhook deliveries are claimed once and can be retried after failure', () => {
  const store = new Store(':memory:')
  try {
    assert.equal(store.claimWebhookDelivery('delivery-1', 'check_suite', 'completed'), true)
    assert.equal(store.claimWebhookDelivery('delivery-1', 'check_suite', 'completed'), false)
    store.finishWebhookDelivery('delivery-1', 'processed')
    assert.equal(store.claimWebhookDelivery('delivery-1', 'check_suite', 'completed'), false)
    assert.equal(store.claimWebhookDelivery('delivery-2', 'check_suite', 'completed'), true)
    store.finishWebhookDelivery('delivery-2', 'failed', 'boom')
    assert.equal(store.claimWebhookDelivery('delivery-2', 'check_suite', 'completed'), true)
  } finally {
    store.close()
  }
})

test('orphan cleanup removes pending work for missing jobs and repositories', () => {
  const store = new Store(':memory:')
  try {
    store.setSetting('retry_pending:job_missing', '{"dueAt":"2000-01-01T00:00:00.000Z"}')
    store.setSetting('pending_followup:repo_missing:1', '{}')
    const result = store.cleanupOrphans()
    assert.equal(result.retries, 1)
    assert.equal(result.followups, 1)
    assert.equal(store.getSetting('retry_pending:job_missing'), undefined)
    assert.equal(store.getSetting('pending_followup:repo_missing:1'), undefined)
  } finally {
    store.close()
  }
})

test('webhook deliveries keep metadata, payload and filters', () => {
  const store = new Store(':memory:')
  try {
    assert.equal(store.claimWebhookDelivery('delivery-meta', 'check_suite', 'completed', { payloadJson: '{"ok":true}', repositoryFullName: 'o/r', installationId: 7 }), true)
    const row = store.getWebhookDelivery('delivery-meta')
    assert.equal(row?.repository_full_name, 'o/r')
    assert.equal(row?.installation_id, 7)
    assert.equal(row?.payload_json, '{"ok":true}')
    assert.equal(store.listWebhookDeliveries({ status: 'processing', event: 'check_suite' }, 10, 0).length, 1)
    assert.equal(store.countWebhookDeliveries({ event: 'check_suite' }), 1)
    store.finishWebhookDelivery('delivery-meta', 'failed', 'boom')
    assert.equal(store.listWebhookDeliveries({ status: 'failed' }, 10, 0)[0]?.error, 'boom')
  } finally {
    store.close()
  }
})

test('job continuity fields persist on the row', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'continuity', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_continuity', userId: user.id, owner: 'octo', name: 'continuity',
      defaultBranch: 'main', tokenEnc: 'v1:test', goal: 'fix', autoIterate: false, intervalMinutes: 1440,
    })
    const job = store.createJob({
      id: 'job_continuity', repoId: repo.id, userId: user.id, trigger: 'schedule',
      goal: 'fix', callbackHash: 'h', platformTokenHash: 'p', kind: 'iterate',
    })
    store.updateJob(job.id, {
      continuity_json: '{"schema_version":1,"summary":"x"}',
      output_kind: 'zero',
      continuity_used: 1,
    })
    const row = store.getJob(job.id)
    assert.equal(row?.output_kind, 'zero')
    assert.equal(row?.continuity_used, 1)
    assert.match(row?.continuity_json ?? '', /schema_version/)
  } finally {
    store.close()
  }
})
