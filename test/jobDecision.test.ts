import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import type { JobRow, RepoRow, UserRow } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { sha256Hex } from '../src/lib/secrets.js'
import { flashOf, formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #381 slice 1: a job may stop and ask. The callback carries one bounded
// decision, the job waits as `paused`, the question is an inbox card marked with
// its job, and the first answer enqueues exactly one retry carrying the answer.

// Parsed here rather than through the module under test, so this file compiles
// on the base tree and fails on behaviour instead of on a missing import.
function storedDecision(json: string | null): { question: string; options: string[]; answer: { text: string; by: string } | null } | null {
  if (json === null) return null
  const parsed = JSON.parse(json) as { question: string; options?: string[]; answer?: { text: string; by: string } | null }
  return { question: parsed.question, options: parsed.options ?? [], answer: parsed.answer ?? null }
}

const secret = 'decision-callback-secret'
const QUESTION = 'Should the migration run inside the release window?'
const WHY = 'The plan changes the schema and only a person can accept that risk.'

interface Harness {
  built: Awaited<ReturnType<typeof buildApp>>
  store: Store
  user: UserRow
  repo: RepoRow
  job: JobRow
  cookie: string
  csrf: string
  close: () => Promise<void>
}

async function harness(): Promise<Harness> {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  const user = makeUser(store, { login: 'decision-user', status: 'approved' })
  const repo = store.createRepo({ id: 'repo_decision', userId: user.id, owner: 'o', name: 'decision', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: 'ship it', autoIterate: false, intervalMinutes: 1440 })
  const job = store.createJob({ id: 'job_decision', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'ship it', callbackHash: sha256Hex(secret), platformTokenHash: '' })
  store.updateJob(job.id, { status: 'running', lease_owner: 'worker-1', lease_until: new Date(Date.now() + 60_000).toISOString() })
  const session = sessionFor(built, user)
  return {
    built,
    store,
    user,
    repo,
    job: store.getJob(job.id)!,
    cookie: session.cookie,
    csrf: session.csrf,
    // buildApp owns the store's lifetime in this harness.
    close: async () => {
      await built.close()
    },
  }
}

function callback(h: Harness, payload: Record<string, unknown>) {
  return h.built.app.inject({
    method: 'POST',
    url: `/api/jobs/${h.job.id}/callback`,
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  })
}

function answer(h: Harness, text: string) {
  return h.built.app.inject({
    method: 'POST',
    url: `/repos/${h.repo.id}/team/answer`,
    headers: { cookie: h.cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: formBody({ csrf: h.csrf, sessionId: '', questionId: `job:${h.job.id}`, custom: text }),
  })
}

test('a callback carrying two decisions is refused and the job stays running', async () => {
  const h = await harness()
  try {
    const refused = await callback(h, { status: 'succeeded', decision: [{ question: QUESTION, why: WHY }, { question: 'Second?', why: WHY }] })
    assert.equal(refused.statusCode, 400)
    assert.match(String(JSON.parse(refused.body).error), /one decision per job/)
    assert.equal(h.store.getJob(h.job.id)?.status, 'running')
    assert.equal(h.store.getJob(h.job.id)?.decision_json, null)
  } finally {
    await h.close()
  }
})

test('an accepted decision pauses the job, keeps the question and releases the lease', async () => {
  const h = await harness()
  try {
    const accepted = await callback(h, { status: 'succeeded', decision: { question: QUESTION, why: WHY, options: ['Ship it', 'Wait'] } })
    assert.equal(accepted.statusCode, 200)
    const paused = h.store.getJob(h.job.id)
    assert.equal(paused?.status, 'paused')
    assert.equal(paused?.error, WHY)
    assert.equal(paused?.lease_until, null)
    const stored = storedDecision(paused?.decision_json ?? null)
    assert.equal(stored?.question, QUESTION)
    assert.deepEqual(stored?.options, ['Ship it', 'Wait'])
    assert.equal(stored?.answer, null)

    const second = await callback(h, { status: 'succeeded', decision: { question: 'A different question?', why: WHY } })
    assert.equal(second.statusCode, 409)
    assert.match(String(JSON.parse(second.body).error), /one decision per job/)
    assert.equal(storedDecision(h.store.getJob(h.job.id)?.decision_json ?? null)?.question, QUESTION)
  } finally {
    await h.close()
  }
})

test('the dashboard inbox renders the question as a card sourced from its job', async () => {
  const h = await harness()
  try {
    await callback(h, { status: 'failed', decision: { question: QUESTION, why: WHY } })
    const page = await h.built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie: h.cookie, 'accept-language': 'en' } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /id="inbox"/)
    assert.match(page.body, new RegExp(QUESTION))
    assert.match(page.body, new RegExp(`job:${h.job.id}`))
    assert.match(page.body, /From a job/)
  } finally {
    await h.close()
  }
})

test('the first answer starts exactly one retry carrying the question and the answer', async () => {
  const h = await harness()
  try {
    await callback(h, { status: 'succeeded', decision: { question: QUESTION, why: WHY } })
    const sent = await answer(h, 'Ship it after the freeze')
    assert.equal(sent.statusCode, 302)
    const answered = storedDecision(h.store.getJob(h.job.id)?.decision_json ?? null)
    assert.equal(answered?.answer?.text, 'Ship it after the freeze')
    assert.equal(answered?.answer?.by, h.user.login)
    const retries = h.store.listJobsForRepo(h.repo.id, 50).filter((job) => job.retry_of === h.job.id)
    assert.equal(retries.length, 1)
    assert.match(retries[0]?.goal ?? '', new RegExp(QUESTION))
    assert.match(retries[0]?.goal ?? '', /Ship it after the freeze/)

    const again = await answer(h, 'A second answer')
    assert.equal(again.statusCode, 302)
    assert.equal(h.store.listJobsForRepo(h.repo.id, 50).filter((job) => job.retry_of === h.job.id).length, 1)
    assert.equal(storedDecision(h.store.getJob(h.job.id)?.decision_json ?? null)?.answer?.text, 'Ship it after the freeze')
  } finally {
    await h.close()
  }
})

// #381 verdict 5914605525 blocking item: the answer was persisted before the
// retry was judged, so every ordinary enqueue refusal (JOB_ACTIVE, QUEUE_FULL,
// REPO_DISABLED, PLATFORM_PAUSED) left the row answered — and an answered row is
// exactly what removes the card from the inbox — while no retry existed. The card
// has to survive a refused answer, and the later answer must still enqueue
// exactly one retry.
test('a refused answer keeps the card and the later answer still enqueues exactly one retry', async () => {
  const h = await harness()
  try {
    await callback(h, { status: 'succeeded', decision: { question: QUESTION, why: WHY } })
    // Another job on the same repository is running, so the retry is refused with
    // JOB_ACTIVE before any job row of its own is written.
    const busy = h.store.createJob({ id: 'job_busy', repoId: h.repo.id, userId: h.user.id, trigger: 'manual', goal: 'busy', callbackHash: '', platformTokenHash: '' })
    h.store.updateJob(busy.id, { status: 'running' })

    const refused = await answer(h, 'Ship it after the freeze')
    assert.equal(refused.statusCode, 302)
    // #472: the refusal travels as a flash message, not as a query parameter.
    assert.match(flashOf(refused)?.error?.text ?? '', /已有任务在运行|already running/)
    assert.equal(h.store.getJob(h.job.id)?.status, 'paused', 'a refused answer resumed the job')
    assert.equal(storedDecision(h.store.getJob(h.job.id)?.decision_json ?? null)?.answer, null, 'a refused retry stored the answer')
    assert.equal(h.store.listJobsForRepo(h.repo.id, 50).filter((job) => job.retry_of === h.job.id).length, 0, 'a refused answer enqueued a retry')

    // No inbox cache entry exists yet, so this read builds the list from the rows.
    const page = await h.built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie: h.cookie, 'accept-language': 'en' } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, new RegExp(`job:${h.job.id}`), 'a refused answer dropped the card from the inbox')

    // The other job finishes; the same answer now goes through, exactly once.
    h.store.updateJob(busy.id, { status: 'succeeded' })
    const accepted = await answer(h, 'Ship it after the freeze')
    assert.equal(accepted.statusCode, 302)
    assert.equal(storedDecision(h.store.getJob(h.job.id)?.decision_json ?? null)?.answer?.text, 'Ship it after the freeze')
    const retries = h.store.listJobsForRepo(h.repo.id, 50).filter((job) => job.retry_of === h.job.id)
    assert.equal(retries.length, 1)
    assert.match(retries[0]?.goal ?? '', /Ship it after the freeze/)
  } finally {
    await h.close()
  }
})

test('a malformed decision is refused instead of stored', async () => {
  const h = await harness()
  try {
    const empty = await callback(h, { status: 'succeeded', decision: { question: '   ', why: WHY } })
    assert.equal(empty.statusCode, 400)
    const five = await callback(h, { status: 'succeeded', decision: { question: QUESTION, why: WHY, options: ['a', 'b', 'c', 'd', 'e'] } })
    assert.equal(five.statusCode, 400)
    assert.equal(h.store.getJob(h.job.id)?.status, 'running')
    assert.equal(h.store.getJob(h.job.id)?.decision_json, null)
  } finally {
    await h.close()
  }
})
