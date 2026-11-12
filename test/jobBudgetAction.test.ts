import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import type { RepoRow } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import { sha256Hex } from '../src/lib/secrets.js'
import { makeUser, MemoryMailer, testConfig } from './helpers.js'

// #357: the per-job budget was an after-the-spend alert. The owner who sets a
// budget expects it to stop spend, so the action is a repository setting with
// `alert` (today), `pause` and `cancel`, and it takes effect at the next
// checkpoint — the earliest point where a recorded cost exists and a second
// model call is not needed to find it.

function repoFor(store: Store, userId: string, id: string, input: { jobBudgetCny?: number; jobBudgetAction?: string } = {}): RepoRow {
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
    jobBudgetCny: input.jobBudgetCny ?? 0,
    // The column arrives with the fix; at the base this key is ignored, which is
    // exactly the defect this file pins.
    ...(input.jobBudgetAction === undefined ? {} : { jobBudgetAction: input.jobBudgetAction }),
  } as Parameters<Store['createRepo']>[0])
}

function build(): { store: Store; mailer: MemoryMailer; jobs: Jobs } {
  const config = testConfig()
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, mailer)
  return { store, mailer, jobs }
}

let seq = 0
function startJob(store: Store, repo: RepoRow, userId: string): { id: string; secret: string } {
  seq += 1
  const id = `job_budget_${seq}`
  const secret = `secret_${seq}`
  store.createJob({ id, repoId: repo.id, userId, trigger: 'schedule', goal: 'g', callbackHash: sha256Hex(secret), platformTokenHash: '' })
  store.updateJob(id, { status: 'running', started_at: new Date().toISOString() })
  return { id, secret }
}

test('pause stops a job at the next checkpoint once its recorded cost crosses the budget', async () => {
  const { store, jobs } = build()
  try {
    const user = makeUser(store, { login: 'budget-pause', status: 'approved' })
    const repo = repoFor(store, user.id, 'repo_budget_pause', { jobBudgetCny: 0.01, jobBudgetAction: 'pause' })
    const { id, secret } = startJob(store, repo, user.id)
    store.recordUsage(user.id, id, 1, null, repo.id)

    const result = await jobs.handleCallback(id, secret, { status: 'running', summary: 'checkpoint 1' })
    assert.equal(result.ok, true)
    const job = store.getJob(id)
    assert.equal(job?.status, 'paused', 'the pause action stops the job at the checkpoint')
    assert.match(String(job?.error), /JOB_BUDGET_PAUSED/, 'the job records why it stopped')
    assert.match(String(job?.error), /预算|budget/i, 'and records the observed cost against the budget')

    const audit = store.listAudit(50).find((row) => row.action === 'job.budget_paused')
    assert.ok(audit, 'the stop is audited')
    assert.ok(store.listNotifications(user.id, 20).some((row) => /预算/.test(row.message)), 'the owner is told the budget stopped the job')
  } finally {
    store.close()
  }
})

test('cancel stops a job at the next checkpoint once its recorded cost crosses the budget', async () => {
  const { store, jobs } = build()
  try {
    const user = makeUser(store, { login: 'budget-cancel', status: 'approved' })
    const repo = repoFor(store, user.id, 'repo_budget_cancel', { jobBudgetCny: 0.01, jobBudgetAction: 'cancel' })
    const { id, secret } = startJob(store, repo, user.id)
    store.recordUsage(user.id, id, 1, null, repo.id)

    const result = await jobs.handleCallback(id, secret, { status: 'running', summary: 'checkpoint 1' })
    assert.equal(result.ok, true)
    const job = store.getJob(id)
    assert.equal(job?.status, 'cancelled')
    assert.match(String(job?.error), /JOB_BUDGET_CANCELLED/)
    assert.ok(store.listAudit(50).some((row) => row.action === 'job.budget_cancelled'))
  } finally {
    store.close()
  }
})

test('a late callback cannot revive a job the budget stopped', async () => {
  const { store, jobs } = build()
  try {
    const user = makeUser(store, { login: 'budget-late', status: 'approved' })
    const repo = repoFor(store, user.id, 'repo_budget_late', { jobBudgetCny: 0.01, jobBudgetAction: 'pause' })
    const { id, secret } = startJob(store, repo, user.id)
    store.recordUsage(user.id, id, 1, null, repo.id)
    await jobs.handleCallback(id, secret, { status: 'running', summary: 'checkpoint 1' })
    assert.equal(store.getJob(id)?.status, 'paused')

    const late = await jobs.handleCallback(id, secret, { status: 'succeeded', summary: 'finished anyway' })
    assert.equal(late.ok, false, 'a terminal callback after the stop is refused')
    assert.equal(store.getJob(id)?.status, 'paused', 'and the terminal state stays paused')
  } finally {
    store.close()
  }
})

test('alert is the default and only writes the audit row after the spend', async () => {
  const { store, jobs } = build()
  try {
    const user = makeUser(store, { login: 'budget-alert', status: 'approved' })
    const repo = repoFor(store, user.id, 'repo_budget_alert', { jobBudgetCny: 0.01 })
    assert.equal(store.getRepo(repo.id)?.job_budget_action, 'alert', 'the column defaults to alert')
    const { id, secret } = startJob(store, repo, user.id)
    store.recordUsage(user.id, id, 1, null, repo.id)

    await jobs.handleCallback(id, secret, { status: 'running', summary: 'checkpoint 1' })
    assert.equal(store.getJob(id)?.status, 'running', 'alert does not stop anything')

    await jobs.handleCallback(id, secret, { status: 'succeeded', summary: 'done' })
    assert.equal(store.getJob(id)?.status, 'succeeded', 'the job still finishes normally')
    assert.ok(store.listAudit(50).some((row) => row.action === 'job.budget_exceeded'), 'the audit row is still written')
  } finally {
    store.close()
  }
})

test('a job under the budget and a job with no recorded cost are both left alone', async () => {
  const { store, jobs } = build()
  try {
    const user = makeUser(store, { login: 'budget-under', status: 'approved' })
    const repo = repoFor(store, user.id, 'repo_budget_under', { jobBudgetCny: 100, jobBudgetAction: 'pause' })
    const under = startJob(store, repo, user.id)
    store.recordUsage(user.id, under.id, 0.0001, null, repo.id)
    await jobs.handleCallback(under.id, under.secret, { status: 'running', summary: 'checkpoint 1' })
    assert.equal(store.getJob(under.id)?.status, 'running', 'a job under the budget keeps running')

    // No ledger row is "unknown", not "zero": a provider error deducts nothing,
    // and the budget must not read that as a spend that fits. A repository holds
    // one active job, so this case gets its own.
    const unknownRepo = repoFor(store, user.id, 'repo_budget_unknown', { jobBudgetCny: 100, jobBudgetAction: 'pause' })
    const unknown = startJob(store, unknownRepo, user.id)
    await jobs.handleCallback(unknown.id, unknown.secret, { status: 'running', summary: 'checkpoint 1' })
    assert.equal(store.getJob(unknown.id)?.status, 'running', 'an unknown cost is not compared')
    assert.ok(store.listAudit(50).some((row) => row.action === 'job.budget_unknown'), 'the checkpoint says the cost is not known yet')
  } finally {
    store.close()
  }
})
