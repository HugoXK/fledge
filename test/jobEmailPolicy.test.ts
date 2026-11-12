import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import type { RepoRow } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import { jobEmailDecision } from '../src/lib/emailPolicy.js'
import { sha256Hex } from '../src/lib/secrets.js'
import { makeUser, MemoryMailer, testConfig } from './helpers.js'

// #353: the per-job mail is the flood. A repository on a 15–60 minute cadence
// sent one "任务完成" or "任务失败" message per run, so the owner woke up to
// dozens. These are the behaviours the card fixes; the pure matrix lives in
// emailPolicy.ts and is exercised through the service on purpose, because the
// bug was the service not consulting a policy at all.

const SUCCESS_SUBJECT = /\[Fledge\] 任务完成/
const FAILURE_SUBJECT = /\[Fledge\] 任务失败/

function repoFor(store: Store, userId: string, id: string): RepoRow {
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
  })
}

function build(): { config: ReturnType<typeof testConfig>; store: Store; mailer: MemoryMailer; jobs: Jobs } {
  const config = testConfig()
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, mailer)
  return { config, store, mailer, jobs }
}

let seq = 0
async function run(
  jobs: Jobs,
  store: Store,
  input: { repoId: string; userId: string; trigger: 'manual' | 'schedule' | 'followup'; status: 'succeeded' | 'failed'; error?: string; summary?: string; retryAttempt?: number },
): Promise<void> {
  seq += 1
  const id = `job_mail_${seq}`
  const secret = `secret_${seq}`
  store.createJob({
    id,
    repoId: input.repoId,
    userId: input.userId,
    trigger: input.trigger,
    goal: 'g',
    callbackHash: sha256Hex(secret),
    platformTokenHash: '',
    retryAttempt: input.retryAttempt ?? 0,
  })
  store.updateJob(id, { status: 'running' })
  const payload = input.status === 'succeeded'
    ? { status: 'succeeded' as const, summary: input.summary ?? 'done' }
    : { status: 'failed' as const, error: input.error ?? 'review requested changes' }
  const result = await jobs.handleCallback(id, secret, payload)
  assert.equal(result.ok, true, `callback for ${id} is accepted`)
}

test('a scheduled success is summarized in the daily digest instead of a per-job mail', async () => {
  const config = testConfig({ digest: { hour: 0, timeZone: 'UTC' }, inboundEmailSecret: 'secret' })
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, mailer)
  try {
    const user = makeUser(store, { login: 'sched-ok', status: 'approved' })
    const repo = repoFor(store, user.id, 'repo_sched_ok')
    await run(jobs, store, { repoId: repo.id, userId: user.id, trigger: 'schedule', status: 'succeeded', summary: 'Summarize me once' })

    assert.equal(mailer.messages.filter((message) => SUCCESS_SUBJECT.test(message.subject)).length, 0, 'a scheduled success sends no per-job mail')

    await jobs.tick()
    const digest = mailer.messages.filter((message) => /今日摘要/.test(message.subject))
    assert.equal(digest.length, 1, 'the same run is carried by the daily digest')
    assert.match(digest[0]!.text, /Summarize me once/)
  } finally {
    store.close()
  }
})

test('a manual success still sends its completion mail', async () => {
  const { store, mailer, jobs } = build()
  try {
    const user = makeUser(store, { login: 'manual-ok', status: 'approved' })
    const repo = repoFor(store, user.id, 'repo_manual_ok')
    await run(jobs, store, { repoId: repo.id, userId: user.id, trigger: 'manual', status: 'succeeded' })
    assert.equal(mailer.messages.filter((message) => SUCCESS_SUBJECT.test(message.subject)).length, 1)
  } finally {
    store.close()
  }
})

test('a scheduled success mails only when the owner turned the success switch on', async () => {
  const { store, mailer, jobs } = build()
  try {
    const user = makeUser(store, { login: 'opt-in', status: 'approved' })
    assert.equal(store.userById(user.id)?.email_job_success, 0, 'the success switch defaults off')
    const repo = repoFor(store, user.id, 'repo_opt_in')
    await run(jobs, store, { repoId: repo.id, userId: user.id, trigger: 'schedule', status: 'succeeded' })
    assert.equal(mailer.messages.filter((message) => SUCCESS_SUBJECT.test(message.subject)).length, 0)

    store.setEmailJobSuccess(user.id, true)
    await run(jobs, store, { repoId: repo.id, userId: user.id, trigger: 'schedule', status: 'succeeded' })
    assert.equal(mailer.messages.filter((message) => SUCCESS_SUBJECT.test(message.subject)).length, 1)
  } finally {
    store.close()
  }
})

test('failures for one repository coalesce into one mail per window, and a success clears the window', async () => {
  const { store, mailer, jobs } = build()
  try {
    const user = makeUser(store, { login: 'coalesce', status: 'approved' })
    const repo = repoFor(store, user.id, 'repo_coalesce')
    const failures = (): number => mailer.messages.filter((message) => FAILURE_SUBJECT.test(message.subject)).length

    await run(jobs, store, { repoId: repo.id, userId: user.id, trigger: 'schedule', status: 'failed' })
    assert.equal(failures(), 1, 'the first failure of the window mails')
    await run(jobs, store, { repoId: repo.id, userId: user.id, trigger: 'schedule', status: 'failed' })
    assert.equal(failures(), 1, 'a second failure inside the window does not mail again')

    await run(jobs, store, { repoId: repo.id, userId: user.id, trigger: 'schedule', status: 'succeeded' })
    await run(jobs, store, { repoId: repo.id, userId: user.id, trigger: 'schedule', status: 'failed' })
    assert.equal(failures(), 2, 'a success clears the window, so the next failure mails')
  } finally {
    store.close()
  }
})

test('a manual failure always mails, even inside the coalescing window', async () => {
  const { store, mailer, jobs } = build()
  try {
    const user = makeUser(store, { login: 'manual-fail', status: 'approved' })
    const repo = repoFor(store, user.id, 'repo_manual_fail')
    const failures = (): number => mailer.messages.filter((message) => FAILURE_SUBJECT.test(message.subject)).length

    await run(jobs, store, { repoId: repo.id, userId: user.id, trigger: 'schedule', status: 'failed' })
    await run(jobs, store, { repoId: repo.id, userId: user.id, trigger: 'manual', status: 'failed' })
    assert.equal(failures(), 2)
  } finally {
    store.close()
  }
})

test('a transient failure that queued a retry mails nothing until the attempt is final', async () => {
  const { store, mailer, jobs } = build()
  try {
    const user = makeUser(store, { login: 'transient', status: 'approved' })
    const repo = repoFor(store, user.id, 'repo_transient')
    const failures = (): number => mailer.messages.filter((message) => FAILURE_SUBJECT.test(message.subject)).length
    const bridgeError = 'FlyBot bridge unreachable (http://127.0.0.1:9): fetch failed'

    await run(jobs, store, { repoId: repo.id, userId: user.id, trigger: 'schedule', status: 'failed', error: bridgeError, retryAttempt: 0 })
    assert.equal(store.listSettings('retry_pending:').length, 1, 'the attempt queued a transient retry')
    assert.equal(failures(), 0, 'a retryable failure waits for its retry result instead of mailing')

    await run(jobs, store, { repoId: repo.id, userId: user.id, trigger: 'schedule', status: 'failed', error: bridgeError, retryAttempt: 2 })
    assert.equal(failures(), 1, 'the final attempt mails, because no retry follows it')
  } finally {
    store.close()
  }
})

// The matrix above drives the service, which is the behaviour the card asks
// for. These are the edges the service cannot cheaply reach: the exact window
// boundary, a negative setting, and a trigger nobody has used yet.
test('the pure policy keeps an unknown trigger on the scheduled side and honours the boundary exactly', () => {
  const base = {
    status: 'failed' as const,
    trigger: 'schedule',
    retryPending: false,
    successEmailEnabled: false,
    lastFailureMailAtMs: 1_000_000,
    nowMs: 1_000_000 + 60 * 60_000,
    cooldownMinutes: 60,
  }
  assert.equal(jobEmailDecision(base).send, true, 'sixty minutes after the last mail the window is over')

  const justInside = jobEmailDecision({ ...base, nowMs: base.nowMs - 1 })
  assert.equal(justInside.send, false)
  assert.equal(justInside.send === false ? justInside.reason : '', 'cooldown')

  const disabled = jobEmailDecision({ ...base, cooldownMinutes: 0, nowMs: base.nowMs - 1 })
  assert.equal(disabled.send, true, 'a zero window means coalescing is off, not that failures go silent')

  const negative = jobEmailDecision({ ...base, cooldownMinutes: -5, nowMs: base.nowMs - 1 })
  assert.equal(negative.send, true, 'a negative window is not a mute either')

  assert.equal(jobEmailDecision({ ...base, trigger: 'cron', nowMs: base.nowMs - 1 }).send, false, 'a trigger nobody has used yet is treated as scheduled')

  const retry = jobEmailDecision({ ...base, retryPending: true })
  assert.equal(retry.send, false)
  assert.equal(retry.send === false ? retry.reason : '', 'retry-pending')

  const scheduledSuccess = jobEmailDecision({ ...base, status: 'succeeded' })
  assert.equal(scheduledSuccess.send, false)
  assert.equal(scheduledSuccess.clearWindow, true, 'a success clears the window even when it sends nothing')
})
