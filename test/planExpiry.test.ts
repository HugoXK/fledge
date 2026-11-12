// #359: a plan that nobody approves must not hold a repository forever. The
// work-item state machine is deliberately untouched: expiry reuses the terminal
// `closed` state and the meaning travels in `closed_reason`, so the reopening
// edge (`closed -> triaged`) and the approval authority stay exactly as they are.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import type { JobRow } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import type { Runner } from '../src/jobs/runner.js'
import { WORK_ITEM_STATES, WORK_ITEM_TRANSITIONS } from '../src/lib/workItems.js'
import { formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

const DAY = 86_400_000
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString()
const planConfig = () => testConfig({ plan: { expiryDays: 7, reminderDays: 2 } })
const silentRunner: Runner = { name: 'silent', async run() { return { status: 'running' } } }

function planJob(store: Store, input: { id: string; repoId: string; userId: string; finishedAgoMs: number }): JobRow {
  const job = store.createJob({ id: input.id, repoId: input.repoId, userId: input.userId, trigger: 'manual', goal: 'plan the work', callbackHash: 'cb', platformTokenHash: '', kind: 'plan', baseBranch: 'main' })
  store.updateJob(job.id, { status: 'succeeded', summary: 'Plan: change one file', finished_at: ago(input.finishedAgoMs) })
  return store.getJob(job.id)!
}

function linkPlanItem(store: Store, job: JobRow, itemId: string): void {
  store.updateJob(job.id, { work_item_id: itemId })
}

function expiryRepo(store: Store, user: { id: string }, id: string): ReturnType<Store['createRepo']> {
  return store.createRepo({ id, userId: user.id, owner: 'octo', name: id, defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', planRequired: true, goal: '', autoIterate: false, intervalMinutes: 1440 })
}

test('the plan-expiry work-item states are exactly the ones already in the product', () => {
  // Pinned literally: expiry must not smuggle a state or a transition in.
  assert.deepEqual([...WORK_ITEM_STATES], [
    'proposed', 'triaged', 'assigned', 'in_progress', 'pr_ready',
    'in_review', 'changes_requested', 'approved', 'merged', 'closed',
  ])
  assert.deepEqual(WORK_ITEM_TRANSITIONS, {
    proposed: ['triaged', 'closed'],
    triaged: ['assigned', 'closed'],
    assigned: ['in_progress', 'pr_ready', 'triaged', 'closed'],
    in_progress: ['pr_ready', 'triaged', 'changes_requested', 'closed'],
    pr_ready: ['in_review', 'changes_requested', 'merged', 'closed'],
    in_review: ['changes_requested', 'approved', 'merged', 'closed'],
    changes_requested: ['in_progress', 'closed'],
    approved: ['merged', 'closed'],
    merged: [],
    closed: ['triaged'],
  })
})

test('an unapproved plan past the window closes once with a reason, one audit row and no iterate job', async () => {
  const config = planConfig()
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, silentRunner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'plan-expiry-user', status: 'approved' })
    const repo = expiryRepo(store, user, 'repo_plan_expiry')
    const job = planJob(store, { id: 'job_plan_expiry', repoId: repo.id, userId: user.id, finishedAgoMs: 8 * DAY })
    const item = store.createWorkItem({ id: 'wi_plan_expiry', repoId: repo.id, userId: user.id, title: 'fix the thing', state: 'assigned', jobId: job.id })
    linkPlanItem(store, job, item.id)

    await jobs.tick()

    const closed = store.getWorkItem(item.id)!
    assert.equal(closed.state, 'closed')
    assert.equal(closed.closed_reason, 'plan_expired')
    const audits = (): number => store.listAudit(100).filter((row) => row.action === 'job.plan_expired' && (row.detail ?? '').includes(job.id)).length
    assert.equal(audits(), 1)
    const notes = (): number => store.listNotifications(user.id, 50).filter((row) => row.message.includes('过期')).length
    assert.equal(notes(), 1)

    // A second tick is a no-op: no second audit, no second notification, and no
    // iterate job started off the back of the expiry.
    await jobs.tick()
    assert.equal(store.getWorkItem(item.id)!.state, 'closed')
    assert.equal(store.getWorkItem(item.id)!.closed_reason, 'plan_expired')
    assert.equal(audits(), 1)
    assert.equal(notes(), 1)
    assert.deepEqual(store.listJobsForRepo(repo.id, 50).map((row) => row.id), [job.id])
  } finally {
    store.close()
  }
})

test('a plan inside the window gets exactly one reminder naming the deadline and the action', async () => {
  const config = planConfig()
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, silentRunner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'plan-reminder-user', status: 'approved' })
    const repo = expiryRepo(store, user, 'repo_plan_reminder')
    const job = planJob(store, { id: 'job_plan_reminder', repoId: repo.id, userId: user.id, finishedAgoMs: 5.5 * DAY })
    const item = store.createWorkItem({ id: 'wi_plan_reminder', repoId: repo.id, userId: user.id, title: 'fix', state: 'assigned', jobId: job.id })
    linkPlanItem(store, job, item.id)
    const deadline = new Date(Date.parse(store.getJob(job.id)!.finished_at!) + 7 * DAY).toISOString().slice(0, 10)

    await jobs.tick()

    const reminders = store.listNotifications(user.id, 50).filter((row) => row.message.includes(deadline))
    assert.equal(reminders.length, 1)
    assert.match(reminders[0]!.message, /批准/)
    assert.match(reminders[0]!.message, /拒绝/)
    assert.equal(store.getWorkItem(item.id)!.state, 'assigned')
    assert.equal(store.listAudit(100).filter((row) => row.action === 'job.plan_expired').length, 0)

    await jobs.tick()
    assert.equal(store.listNotifications(user.id, 50).filter((row) => row.message.includes(deadline)).length, 1)
  } finally {
    store.close()
  }
})

test('an approved or rejected plan is never expired by the deadline', async () => {
  const config = planConfig()
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, silentRunner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'plan-decided-user', status: 'approved' })
    const approvedRepo = expiryRepo(store, user, 'repo_plan_approved')
    const approved = planJob(store, { id: 'job_plan_approved', repoId: approvedRepo.id, userId: user.id, finishedAgoMs: 30 * DAY })
    store.updateJob(approved.id, { plan_approved_at: ago(29 * DAY), plan_approved_by: user.id })
    const approvedItem = store.createWorkItem({ id: 'wi_plan_approved', repoId: approvedRepo.id, userId: user.id, title: 'approved', state: 'assigned', jobId: approved.id })
    linkPlanItem(store, approved, approvedItem.id)

    const rejectedRepo = expiryRepo(store, user, 'repo_plan_rejected')
    const rejected = planJob(store, { id: 'job_plan_rejected', repoId: rejectedRepo.id, userId: user.id, finishedAgoMs: 30 * DAY })
    store.updateJob(rejected.id, { plan_rejected_at: ago(29 * DAY) })
    const rejectedItem = store.createWorkItem({ id: 'wi_plan_rejected', repoId: rejectedRepo.id, userId: user.id, title: 'rejected', state: 'assigned', jobId: rejected.id })
    linkPlanItem(store, rejected, rejectedItem.id)

    await jobs.tick()

    assert.equal(store.getWorkItem(approvedItem.id)!.state, 'assigned')
    assert.equal(store.getWorkItem(approvedItem.id)!.closed_reason, null)
    assert.equal(store.getWorkItem(rejectedItem.id)!.state, 'assigned')
    assert.equal(store.listAudit(100).filter((row) => row.action === 'job.plan_expired').length, 0)
  } finally {
    store.close()
  }
})

test('a late approval cannot revive an expired plan, and closed -> triaged still reopens it', async () => {
  const config = planConfig()
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, silentRunner, new MemoryMailer())
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: silentRunner, startScheduler: false })
  try {
    const user = makeUser(store, { login: 'plan-late-user', status: 'approved' })
    const repo = expiryRepo(store, user, 'repo_plan_late')
    const job = planJob(store, { id: 'job_plan_late', repoId: repo.id, userId: user.id, finishedAgoMs: 8 * DAY })
    const item = store.createWorkItem({ id: 'wi_plan_late', repoId: repo.id, userId: user.id, title: 'late', state: 'assigned', jobId: job.id })
    linkPlanItem(store, job, item.id)
    await jobs.tick()
    assert.equal(store.getWorkItem(item.id)!.closed_reason, 'plan_expired')

    const { cookie, csrf } = sessionFor(built, user)
    const late = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/jobs/${job.id}/approve-plan`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf }),
    })
    assert.equal(late.statusCode, 302)
    assert.match(String(late.headers.location), /error=/)
    assert.equal(store.getJob(job.id)!.plan_approved_at, null)
    assert.equal(store.getWorkItem(item.id)!.state, 'closed')
    assert.equal(store.getWorkItem(item.id)!.closed_reason, 'plan_expired')

    const reopened = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/work/${item.id}/state`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, state: 'triaged' }),
    })
    assert.equal(reopened.statusCode, 302)
    assert.equal(store.getWorkItem(item.id)!.state, 'triaged')
    // Leaving `closed` clears the reason: one close is not the item's history.
    assert.equal(store.getWorkItem(item.id)!.closed_reason, null)

    // The deadline belongs to the plan, so reopening the item does not make the
    // dead plan approvable again - a new plan is the only way back.
    const stillLate = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/jobs/${job.id}/approve-plan`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf }),
    })
    assert.equal(stillLate.statusCode, 302)
    assert.match(String(stillLate.headers.location), /error=/)
    assert.equal(store.getJob(job.id)!.plan_approved_at, null)
    assert.equal(store.getWorkItem(item.id)!.state, 'triaged')
  } finally {
    // buildApp owns the store's lifetime here: close() closes it too.
    await built.close()
  }
})

test('the repository page names the expired reason and the pending deadline', async () => {
  const config = planConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: silentRunner, startScheduler: false })
  try {
    const user = makeUser(store, { login: 'plan-page-user', status: 'approved' })
    const expiredRepo = expiryRepo(store, user, 'repo_page_expired')
    const expiredJob = planJob(store, { id: 'job_page_expired', repoId: expiredRepo.id, userId: user.id, finishedAgoMs: 8 * DAY })
    store.createWorkItem({ id: 'wi_page_expired', repoId: expiredRepo.id, userId: user.id, title: 'stale plan', state: 'closed', closedReason: 'plan_expired', jobId: expiredJob.id })

    const pendingRepo = expiryRepo(store, user, 'repo_page_pending')
    const pendingJob = planJob(store, { id: 'job_page_pending', repoId: pendingRepo.id, userId: user.id, finishedAgoMs: 1 * DAY })
    store.createWorkItem({ id: 'wi_page_pending', repoId: pendingRepo.id, userId: user.id, title: 'waiting plan', state: 'assigned', jobId: pendingJob.id })
    const deadline = new Date(Date.parse(store.getJob(pendingJob.id)!.finished_at!) + 7 * DAY).toISOString().slice(0, 10)

    const { cookie } = sessionFor(built, user)
    const expired = await built.app.inject({ method: 'GET', url: `/repos/${expiredRepo.id}`, headers: { cookie } })
    assert.equal(expired.statusCode, 200)
    assert.match(expired.body, /plan expired|计划过期/i)

    const pending = await built.app.inject({ method: 'GET', url: `/repos/${pendingRepo.id}`, headers: { cookie } })
    assert.equal(pending.statusCode, 200)
    assert.match(pending.body, new RegExp(deadline))
    assert.match(pending.body, /批准|approve/i)

    // One repository can hold a dead plan and a live one. The banner must name
    // the live plan: the expired row is oldest, and completion never clears
    // `plan_approved_at`, so a query without the deadline cutoff would print a
    // past deadline in future tense and keep naming the dead plan.
    const mixedRepo = expiryRepo(store, user, 'repo_page_mixed')
    const deadJob = planJob(store, { id: 'job_page_mixed_dead', repoId: mixedRepo.id, userId: user.id, finishedAgoMs: 9 * DAY })
    store.createWorkItem({ id: 'wi_page_mixed_dead', repoId: mixedRepo.id, userId: user.id, title: 'dead plan', state: 'closed', closedReason: 'plan_expired', jobId: deadJob.id })
    const liveJob = planJob(store, { id: 'job_page_mixed_live', repoId: mixedRepo.id, userId: user.id, finishedAgoMs: 1 * DAY })
    store.createWorkItem({ id: 'wi_page_mixed_live', repoId: mixedRepo.id, userId: user.id, title: 'live plan', state: 'assigned', jobId: liveJob.id })
    const liveDeadline = new Date(Date.parse(store.getJob(liveJob.id)!.finished_at!) + 7 * DAY).toISOString().slice(0, 10)
    const deadDeadline = new Date(Date.parse(store.getJob(deadJob.id)!.finished_at!) + 7 * DAY).toISOString().slice(0, 10)

    const mixed = await built.app.inject({ method: 'GET', url: `/repos/${mixedRepo.id}`, headers: { cookie } })
    assert.equal(mixed.statusCode, 200)
    assert.match(mixed.body, new RegExp(liveDeadline))
    assert.ok(!mixed.body.includes(deadDeadline), 'a past deadline must not be printed in future tense')
    // The work-item table legitimately links the dead plan's job row; the banner
    // is what must stop naming it, and the banner opens with `计划 <id> 将在`.
    assert.ok(mixed.body.includes(`计划 ${liveJob.id}`), 'the banner must name the live plan')
    assert.ok(!mixed.body.includes(`计划 ${deadJob.id}`), 'the banner must not name the expired plan')
  } finally {
    // buildApp owns the store's lifetime here: close() closes it too.
    await built.close()
  }
})
