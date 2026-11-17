import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp, type BuiltApp } from '../src/app.js'
import { Store, type NotificationOutboxState } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { scheduleConsole } from '../src/schedules/console.js'
import { scheduleConsolePage } from '../src/views/pages.js'
import { makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #544, the delivery fact: the console used to answer `unknown` for every
// repository because the page said no outbox existed. The outbox exists (#544
// slice 7) and a dispatched occurrence names its job, so the honest answer is
// the state of the notification that job queued — `none` when it queued
// nothing, and `unknown` only when nobody read the outbox at all.

const HOUR = 3_600_000
const NOW = Date.parse('2026-11-16T00:00:00Z')

function harness(name: string): { store: Store; userId: string; repoId: string } {
  const store = new Store(':memory:')
  const user = makeUser(store, { login: `${name}-owner`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_${name}`, userId: user.id, owner: 'o', name,
    defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
    repoRole: 'maintainer', goal: 'fix bugs', autoIterate: true, intervalMinutes: 1440,
  })
  return { store, userId: user.id, repoId: repo.id }
}

function dispatched(store: Store, repoId: string, jobId: string): ReturnType<typeof store.saveSchedule> {
  const row = store.saveSchedule({ id: `sch_${repoId}`, repoId, kind: 'interval', everyMs: HOUR })
  const logicalTime = Math.floor(NOW / HOUR) * HOUR
  store.claimScheduleOccurrence({ id: `occ_${repoId}`, scheduleId: row.id, repoId, logicalTime, timingRevision: row.timing_revision, leaseToken: 'tok', leaseMs: HOUR, now: NOW })
  store.settleScheduleOccurrence({ scheduleId: row.id, logicalTime, timingRevision: row.timing_revision, leaseToken: 'tok', state: 'dispatched', jobId, dispatchedAt: NOW, lagMs: 0, now: NOW })
  return row
}

const noJobs = (): string | null => null
const fake = (states: NotificationOutboxState[]) => (): Array<{ state: NotificationOutboxState }> => states.map((state) => ({ state }))

// -- the link between a job and the notification it queued ------------------

test('an outbox row remembers the job it belongs to, and a job with no row answers empty', () => {
  const { store, userId, repoId } = harness('delivery-link')
  try {
    const job = store.createJob({ id: 'job_linked', repoId, userId, trigger: 'schedule', goal: 'g', callbackHash: 'cb_linked', platformTokenHash: '' })
    const queued = store.enqueueNotification({
      transport: 'webhook', destination: 'webhook', payload: { event: 'job.succeeded', jobId: job.id },
      idempotencyKey: `job.${job.id}:succeeded:webhook`, jobId: job.id, now: NOW,
    })
    assert.equal(queued.row.job_id, job.id, 'the row names the job, so the console never guesses from a key string')
    assert.deepEqual(store.notificationsForJob(job.id).map((row) => row.state), ['pending'])
    assert.deepEqual(store.notificationsForJob('job_nobody'), [], 'a job that queued nothing answers empty, not every row')
  } finally { store.close() }
})

// -- the console's answer ---------------------------------------------------

test('the console reports the delivery state of the newest dispatched run', () => {
  const { store, repoId, userId } = harness('delivery-sent')
  try {
    const job = store.createJob({ id: 'job_sent', repoId, userId, trigger: 'schedule', goal: 'g', callbackHash: 'cb_sent', platformTokenHash: '' })
    const row = dispatched(store, repoId, job.id)
    const state = scheduleConsole({
      repoId, row, occurrences: store.listScheduleOccurrences(repoId, 10), now: NOW, jobStatus: noJobs,
      jobDeliveries: fake(['sent']),
    })
    assert.equal(state.delivery, 'sent', 'a notification the transport accepted reads sent, not unknown')
  } finally { store.close() }
})

test('a run that queued no notification reads none, and no run at all stays unknown', () => {
  const { store, repoId, userId } = harness('delivery-none')
  try {
    const job = store.createJob({ id: 'job_none', repoId, userId, trigger: 'schedule', goal: 'g', callbackHash: 'cb_none', platformTokenHash: '' })
    const row = dispatched(store, repoId, job.id)
    const ran = scheduleConsole({
      repoId, row, occurrences: store.listScheduleOccurrences(repoId, 10), now: NOW, jobStatus: noJobs,
      jobDeliveries: fake([]),
    })
    assert.equal(ran.delivery, 'none', 'a job that queued nothing is none, not unknown')

    const empty = scheduleConsole({ repoId, row, occurrences: [], now: NOW, jobStatus: noJobs, jobDeliveries: fake([]) })
    assert.equal(empty.delivery, 'unknown', 'nothing has run, so nothing is known')

    const skipped = scheduleConsole({ repoId, row, occurrences: [{ ...store.listScheduleOccurrences(repoId, 10)[0]!, state: 'skipped', job_id: null }], now: NOW, jobStatus: noJobs, jobDeliveries: fake([]) })
    assert.equal(skipped.delivery, 'none', 'a skipped instant dispatched no job, so it queued nothing rather than unknown')
  } finally { store.close() }
})

test('several notifications read as the worst of them, because one needs attention', () => {
  const { store, repoId, userId } = harness('delivery-worst')
  try {
    const job = store.createJob({ id: 'job_worst', repoId, userId, trigger: 'schedule', goal: 'g', callbackHash: 'cb_worst', platformTokenHash: '' })
    const row = dispatched(store, repoId, job.id)
    const state = (states: NotificationOutboxState[]) => scheduleConsole({
      repoId, row, occurrences: store.listScheduleOccurrences(repoId, 10), now: NOW, jobStatus: noJobs,
      jobDeliveries: fake(states),
    }).delivery
    assert.equal(state(['sent', 'retry']), 'retry', 'a retry behind a sent row is still visible')
    assert.equal(state(['dead', 'unknown']), 'unconfirmed', 'an unconfirmed send outranks a definite refusal')
    assert.equal(state(['retry', 'sending']), 'retry')
    assert.equal(state(['sent', 'sent']), 'sent')
  } finally { store.close() }
})

// -- the page ---------------------------------------------------------------

test('the page prints the delivery it knows instead of "no delivery outbox in this slice"', () => {
  const { store, repoId, userId } = harness('delivery-page')
  try {
    const job = store.createJob({ id: 'job_page', repoId, userId, trigger: 'schedule', goal: 'g', callbackHash: 'cb_page', platformTokenHash: '' })
    const row = dispatched(store, repoId, job.id)
    const user = store.userById(userId)!
    const viewer = { user, csrfToken: 'csrf_test' }
    const page = (deliveries: Array<{ state: NotificationOutboxState }>) => scheduleConsolePage({
      config: testConfig(), locale: 'en', viewer, repo: store.getRepo(repoId)!, state: scheduleConsole({
        repoId, row, occurrences: store.listScheduleOccurrences(repoId, 10), now: NOW, jobStatus: noJobs,
        jobDeliveries: () => deliveries,
      }),
      form: { cron: '', every: '', timezone: '', startAt: '', endAt: '', misfire: 'skip', grace: '', dailyRuns: '' },
      runNowKey: 'cmd_page',
    } as never)

    const sent = page([{ state: 'sent' }])
    assert.match(sent, /data-delivery="sent"/, 'the state is machine-readable')
    assert.match(sent, />sent</, 'and named in words')
    assert.doesNotMatch(sent, /no delivery outbox in this slice/, 'the slice is not a reason to print a lie')

    const none = page([])
    assert.match(none, /data-delivery="none"/)
    assert.match(none, /not queued/, 'a run that queued nothing says so')

    const retry = page([{ state: 'sent' }, { state: 'retry' }])
    assert.match(retry, /data-delivery="retry"/)

    const unconfirmed = page([{ state: 'unknown' }])
    assert.match(unconfirmed, /data-delivery="unconfirmed"/, 'the outbox unknown is never confused with a page that did not look')
    assert.doesNotMatch(unconfirmed, /nothing has run yet/)
  } finally { store.close() }
})

// -- the route --------------------------------------------------------------

test('the schedule console route reads the outbox for the run it shows', async () => {
  const store = new Store(':memory:')
  const built: BuiltApp = await buildApp({ config: testConfig(), store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'delivery-route-owner', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_delivery_route', userId: user.id, owner: 'o', name: 'delivery-route',
      defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
      repoRole: 'maintainer', goal: 'fix bugs', autoIterate: true, intervalMinutes: 1440,
    })
    const job = store.createJob({ id: 'job_route', repoId: repo.id, userId: user.id, trigger: 'schedule', goal: 'g', callbackHash: 'cb_route', platformTokenHash: '' })
    dispatched(store, repo.id, job.id)
    store.enqueueNotification({
      transport: 'webhook', destination: 'webhook', payload: { event: 'job.succeeded', jobId: job.id },
      idempotencyKey: `job.${job.id}:succeeded:webhook`, jobId: job.id, now: NOW,
    })
    const session = sessionFor(built, user)
    const response = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/schedule`, headers: { cookie: session.cookie } })
    assert.equal(response.statusCode, 200)
    assert.match(response.body, /data-delivery="pending"/, 'the queued notification is visible on the console')
  } finally { await built.close() }
})
