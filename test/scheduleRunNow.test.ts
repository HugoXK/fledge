import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import type { ScheduleOccurrenceRow } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import type { Runner, RunnerContext } from '../src/jobs/runner.js'
import { MemoryMailer, formBody, makeUser, sessionFor, testConfig } from './helpers.js'

// #544 slice 8: "Run now" is an explicit command with its own identity.
//
// The card asks for one property: the same command key returns the same
// occurrence, a new key is a distinct instance, and neither moves the recurrence
// cursor. The occurrence is the record, so the assertions read rows rather than
// a counter — one occurrence per key, one job behind it, and a refusal that
// settles the row so the replay answers the same thing.

interface Harness {
  store: Store
  jobs: Jobs
  contexts: RunnerContext[]
  userId: string
  repoId: string
}

function harness(name: string, role: 'maintainer' | 'developer' = 'maintainer'): Harness {
  const config = testConfig()
  const store = new Store(':memory:')
  const contexts: RunnerContext[] = []
  const runner: Runner = {
    name: 'capture',
    async run(context) {
      contexts.push(context)
      return { status: 'running' }
    },
  }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  const user = makeUser(store, { login: `${name}-user`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_${name}`, userId: user.id, owner: 'o', name,
    defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
    repoRole: role, goal: 'fix bugs', autoIterate: true, intervalMinutes: 1440,
  })
  return { store, jobs, contexts, userId: user.id, repoId: repo.id }
}

function saveSchedule(h: Harness, id = 'sch_run_now'): void {
  h.store.saveSchedule({ id, repoId: h.repoId, kind: 'interval', everyMs: 24 * 60 * 60_000 })
  h.store.createWorkItem({ id: `work_${id}`, repoId: h.repoId, userId: h.userId, title: 'fix it', issueUrl: `https://github.com/o/${h.repoId}/issues/1`, state: 'triaged' })
}

function occurrences(h: Harness): ScheduleOccurrenceRow[] {
  return h.store.listScheduleOccurrences(h.repoId, 50)
}

test('the same command key returns the same occurrence and starts one job', async () => {
  const h = harness('run-once')
  try {
    saveSchedule(h)
    const repo = h.store.getRepo(h.repoId)!
    const first = await h.jobs.runScheduleNow(repo, 'cmd-key-1')
    assert.equal(first.ok, true)
    assert.equal(first.replayed, false)
    assert.equal(typeof first.jobId, 'string')

    const second = await h.jobs.runScheduleNow(repo, 'cmd-key-1')
    assert.equal(second.ok, true)
    assert.equal(second.replayed, true, 'the same key answers the first press')
    assert.equal(second.occurrence?.id, first.occurrence?.id)
    assert.equal(second.jobId, first.jobId)

    assert.equal(occurrences(h).length, 1, 'one key, one occurrence')
    assert.equal(h.store.listJobsForRepo(h.repoId).length, 1, 'one key, one job')
    assert.equal(occurrences(h)[0]?.state, 'dispatched')
    assert.equal(occurrences(h)[0]?.command_key, 'cmd-key-1')
  } finally {
    h.store.close()
  }
})

test('a new key is a distinct instance, and neither key moves the recurrence cursor', async () => {
  const h = harness('run-distinct')
  try {
    saveSchedule(h)
    const cursor = Date.parse('2026-01-01T00:00:00Z')
    h.store.run('UPDATE schedules SET last_occurrence_at = ? WHERE repo_id = ?', cursor, h.repoId)
    const repo = h.store.getRepo(h.repoId)!

    const first = await h.jobs.runScheduleNow(repo, 'cmd-key-a')
    // The admission path still refuses a second run while the first is live, so
    // the first job is finished before the second key is pressed.
    const job = h.store.listJobsForRepo(h.repoId)[0]!
    h.store.updateJob(job.id, { status: 'succeeded', finished_at: new Date().toISOString() })
    const second = await h.jobs.runScheduleNow(repo, 'cmd-key-b')
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.notEqual(second.occurrence?.id, first.occurrence?.id)
    assert.equal(occurrences(h).length, 2)
    assert.equal(h.store.listJobsForRepo(h.repoId).length, 2)
    assert.equal(h.store.scheduleForRepo(h.repoId)?.last_occurrence_at, cursor, 'run-now never moves the schedule')
  } finally {
    h.store.close()
  }
})

test('a refused run still settles the row, so the replay answers the same refusal', async () => {
  const h = harness('run-refused')
  try {
    saveSchedule(h)
    h.store.updateRepo(h.repoId, { enabled: 0 })
    const repo = h.store.getRepo(h.repoId)!
    const first = await h.jobs.runScheduleNow(repo, 'cmd-key-refused')
    assert.equal(first.ok, false)
    assert.equal(first.code, 'REPO_DISABLED')
    assert.equal(occurrences(h).length, 1, 'the refusal is recorded, not dropped')
    assert.equal(occurrences(h)[0]?.state, 'skipped')
    assert.equal(occurrences(h)[0]?.reason, 'REPO_DISABLED')
    assert.equal(h.store.listJobsForRepo(h.repoId).length, 0)

    const replay = await h.jobs.runScheduleNow(repo, 'cmd-key-refused')
    assert.equal(replay.ok, false)
    assert.equal(replay.replayed, true)
    assert.equal(replay.code, 'REPO_DISABLED', 'the same key keeps answering the same thing')
    assert.equal(occurrences(h).length, 1)
  } finally {
    h.store.close()
  }
})

test('a repository without a schedule and a malformed key are refused before any row', async () => {
  const h = harness('run-missing')
  try {
    const repo = h.store.getRepo(h.repoId)!
    const missing = await h.jobs.runScheduleNow(repo, 'cmd-key-missing')
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'schedule_missing')
    assert.equal(occurrences(h).length, 0)

    saveSchedule(h)
    const empty = await h.jobs.runScheduleNow(repo, '')
    assert.equal(empty.ok, false)
    assert.equal(empty.code, 'command_key_invalid')
    assert.equal(occurrences(h).length, 0, 'an invalid key writes nothing')
  } finally {
    h.store.close()
  }
})

test('the console route starts one run per rendered key and says when it replayed', async () => {
  const h = harness('run-route')
  const config = testConfig()
  const built = await buildApp({ config, store: h.store, mailer: new MemoryMailer(), runner: { name: 'capture', async run() { return { status: 'running' as const } } }, startScheduler: false })
  try {
    saveSchedule(h)
    const user = h.store.userById(h.userId)!
    const session = sessionFor(built, user)
    const repo = h.store.getRepo(h.repoId)!
    const post = (key: string) => built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/schedule/run-now`,
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: session.csrf, command_key: key }),
    })

    const page = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/schedule`, headers: { cookie: session.cookie } })
    assert.match(page.body, /name="command_key"/, 'the page carries the key the button submits')

    const first = await post('cmd-key-route')
    assert.equal(first.statusCode, 302)
    assert.equal(occurrences(h).length, 1)
    assert.equal(h.store.listJobsForRepo(repo.id).length, 1)

    const replay = await post('cmd-key-route')
    assert.equal(replay.statusCode, 302)
    assert.equal(occurrences(h).length, 1, 'a double click is one command')
    assert.equal(h.store.listJobsForRepo(repo.id).length, 1)
  } finally {
    await built.close()
  }
})

// #1047: the console's Run now redirects with the sentence the job service
// wrote, which is Chinese only. An English console therefore prints a Chinese
// paragraph, while the repository page's own Run now builds the same refusal
// from its code and prints English. The refusal has to travel as a code and its
// parameter so the banner can build it in the reader's language.
test('a refused Run now answers in the console language, not the service language', async () => {
  const h = harness('run-refused')
  const base = testConfig()
  const config = testConfig({ runner: { ...base.runner, maxActiveJobs: 0, queueDispatch: false } })
  const built = await buildApp({ config, store: h.store, mailer: new MemoryMailer(), runner: { name: 'capture', async run() { return { status: 'running' as const } } }, startScheduler: false })
  try {
    saveSchedule(h)
    const user = h.store.userById(h.userId)!
    const session = sessionFor(built, user)
    const repo = h.store.getRepo(h.repoId)!
    const cookie = `${session.cookie}; fledge_lang=en`
    const post = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/schedule/run-now`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: session.csrf, command_key: 'cmd-key-refused' }),
    })
    assert.equal(post.statusCode, 302)
    const location = String(post.headers.location)
    assert.match(location, /refused=/, 'the refusal is reported on the page it returns to')
    const page = await built.app.inject({ method: 'GET', url: location, headers: { cookie } })
    assert.match(page.body, /The platform already has 0 jobs running at once/, 'the English console prints the English sentence')
    assert.doesNotMatch(page.body, /平台当前已有/, 'the service\'s Chinese sentence does not reach the English console')
  } finally {
    await built.close()
  }
})
