import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp, type BuiltApp } from '../src/app.js'
import { Store } from '../src/db.js'
import type { JobRow, RepoRow } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { aheadOfViewer, rankQueued } from '../src/lib/queueRank.js'
import { makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #565: the queue is ordered by `priority DESC, created_at ASC` (the claimer,
// src/db.ts claimQueuedJob, and Store.listQueuedJobs), and none of that reached
// the screen. The page printed `findIndex + 1` as a bare number, every list
// showed neither position nor priority, and a second account's job was invisible
// to the ordering but not to the disclosure rule: position and total are counts,
// the ahead-list is the viewer's own jobs, and anybody else's is a number only.

function row(id: string, priority: number, createdAt: string, userId = 'user_a', status: 'queued' | 'running' = 'queued'): JobRow {
  return { id, priority, created_at: createdAt, user_id: userId, status } as JobRow
}

function textOf(html: string, attr: string): string {
  const match = new RegExp(`<[^>]*\\b${attr}\\b[^>]*>([^<]*)<`).exec(html)
  assert.ok(match, `the page renders ${attr}`)
  return match[1]!
}

test('the rank reproduces the claimer: priority first, then arrival', () => {
  const queued = [
    row('low', 0, '2026-11-13T10:00:00.000Z'),
    row('high', 20, '2026-11-13T10:01:00.000Z'),
    row('mid', 10, '2026-11-13T10:02:00.000Z'),
    row('mid-later', 10, '2026-11-13T10:03:00.000Z'),
  ]
  assert.deepEqual(rankQueued(queued, 'high'), { position: 1, total: 4 })
  assert.deepEqual(rankQueued(queued, 'mid'), { position: 2, total: 4 })
  assert.deepEqual(rankQueued(queued, 'mid-later'), { position: 3, total: 4 })
  assert.deepEqual(rankQueued(queued, 'low'), { position: 4, total: 4 })
  assert.equal(rankQueued(queued, 'not-queued'), null)
})

test('rows equal on both keys share a position instead of inventing a third key', () => {
  const tie = '2026-11-13T10:00:00.000Z'
  const queued = [row('first', 10, tie), row('second', 10, tie), row('later', 10, '2026-11-13T10:01:00.000Z')]
  assert.deepEqual(rankQueued(queued, 'first'), { position: 1, total: 3 })
  assert.deepEqual(rankQueued(queued, 'second'), { position: 1, total: 3 })
  assert.deepEqual(rankQueued(queued, 'later'), { position: 3, total: 3 })
})

test('the ahead-list is the viewer own queued jobs; a running job is not a queue neighbour', () => {
  // listActiveJobsForUser is queued + running, newest first: used as-is it puts
  // the viewer's running job in the ahead list and shifts the count.
  const active = [
    row('running', 0, '2026-11-13T09:00:00.000Z', 'alice', 'running'),
    row('their-job', 20, '2026-11-13T10:01:00.000Z', 'bob', 'queued'),
    row('mine-later', 10, '2026-11-13T10:02:00.000Z', 'alice', 'queued'),
    row('mine-now', 0, '2026-11-13T10:03:00.000Z', 'alice', 'queued'),
  ]
  const ahead = aheadOfViewer({ queued: active, viewerActive: active, viewerId: 'alice', jobId: 'mine-now' })
  assert.deepEqual(ahead.owned.map((job) => job.id), ['mine-later'])
  assert.equal(ahead.othersAhead, 1)
})

interface Fixture {
  built: BuiltApp
  store: Store
  aliceJobPage: string
  aliceRepoPage: string
}

async function fixture(locale: 'zh' | 'en' = 'zh'): Promise<Fixture> {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  const alice = makeUser(store, { login: 'alice', status: 'approved' })
  const bob = makeUser(store, { login: 'bob', status: 'approved' })
  // One active job per repository is a database invariant, so each queued job
  // gets its own repository; the queue is instance-wide, which is the point.
  const repo = (id: string, userId: string, owner: string, name: string): RepoRow => store.createRepo({
    id,
    userId,
    owner,
    name,
    defaultBranch: 'main',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  // The running job sorts before every queued one: it must not consume a
  // position and must not be an ahead neighbour.
  const runningRepo = repo('repo_queue_running', alice.id, 'acme', 'run')
  const bobRepo = repo('repo_queue_bob', bob.id, 'acme', 'beta')
  const followRepo = repo('repo_queue_followup', alice.id, 'acme', 'one')
  const manualRepo = repo('repo_queue_manual', alice.id, 'acme', 'two')
  const create = (input: { id: string; repoId: string; userId: string; trigger: string; priority: number; createdAt: string; status?: 'running' }): JobRow => {
    const job = store.createJob({
      id: input.id,
      repoId: input.repoId,
      userId: input.userId,
      trigger: input.trigger,
      goal: 'show the queue',
      callbackHash: 'cb',
      platformTokenHash: '',
      priority: input.priority,
      createdAt: input.createdAt,
    })
    if (input.status === 'running') store.updateJob(job.id, { status: 'running' })
    return store.getJob(job.id)!
  }
  create({ id: 'job_queue_running', repoId: runningRepo.id, userId: alice.id, trigger: 'manual', priority: 0, createdAt: '2026-11-13T09:00:00.000Z', status: 'running' })
  create({ id: 'job_queue_bob', repoId: bobRepo.id, userId: bob.id, trigger: 'followup', priority: 20, createdAt: '2026-11-13T10:01:00.000Z' })
  create({ id: 'job_queue_followup', repoId: followRepo.id, userId: alice.id, trigger: 'followup', priority: 20, createdAt: '2026-11-13T10:02:00.000Z' })
  create({ id: 'job_queue_manual', repoId: manualRepo.id, userId: alice.id, trigger: 'manual', priority: 10, createdAt: '2026-11-13T10:03:00.000Z' })

  const { cookie } = sessionFor(built, alice)
  const headers = locale === 'en' ? { cookie: `${cookie}; fledge_lang=en` } : { cookie }
  const aliceJobPage = await built.app.inject({ method: 'GET', url: `/repos/${manualRepo.id}/jobs/job_queue_manual`, headers })
  const aliceRepoPage = await built.app.inject({ method: 'GET', url: `/repos/${manualRepo.id}`, headers })
  assert.equal(aliceJobPage.statusCode, 200)
  assert.equal(aliceRepoPage.statusCode, 200)
  return { built, store, aliceJobPage: aliceJobPage.body, aliceRepoPage: aliceRepoPage.body }
}

test('the job page prints position, total and priority source, and the count-only sentence for other tenants', async () => {
  const data = await fixture('zh')
  try {
    assert.equal(textOf(data.aliceJobPage, 'data-queue-position'), '队列位置 3 / 共 3 · 优先级 10（手动）')
    // The acceptance is one exact sentence, not a "contains no identifier"
    // substring check: priority is another tenant's trigger class.
    assert.equal(textOf(data.aliceJobPage, 'data-queue-others'), '另有 1 个排队任务在前，不显示详情。')
    const owned = [...data.aliceJobPage.matchAll(/<div class="list-row" data-queue-owned-job="([^"]+)">/g)].map((match) => match[1])
    assert.deepEqual(owned, ['job_queue_followup'])
    assert.match(data.aliceJobPage, /acme\/one/)
    assert.match(data.aliceJobPage, /优先级 20（跟进）/)
    // No identifier of the other tenant's job: no login, no repository, no id.
    assert.doesNotMatch(data.aliceJobPage, /bob/)
    assert.doesNotMatch(data.aliceJobPage, /acme\/beta/)
    assert.doesNotMatch(data.aliceJobPage, /job_queue_bob/)
  } finally {
    await data.built.close()
  }
})

test('the repository list shows position and priority inside the job cell, and nothing for a running job', async () => {
  const data = await fixture('zh')
  try {
    assert.match(data.aliceRepoPage, /data-queue-rank>#3\/3 · P10</)
    const ranks = [...data.aliceRepoPage.matchAll(/data-queue-rank>/g)]
    assert.equal(ranks.length, 1, 'one queued job on this repository; the rank rides inside the job cell')
    // Still the four labelled columns: no fifth column was added.
    const jobTable = /<table class="job-table[^"]*" id="repo-jobs-table"[\s\S]*?<\/table>/.exec(data.aliceRepoPage)?.[0]
    assert.ok(jobTable, 'the repository page renders its job table')
    assert.equal([...jobTable.matchAll(/data-label="/g)].length, 4)
  } finally {
    await data.built.close()
  }
})

test('the same facts render in English', async () => {
  const data = await fixture('en')
  try {
    assert.equal(textOf(data.aliceJobPage, 'data-queue-position'), 'Queue position 3 of 3 · priority 10 (manual)')
    assert.equal(textOf(data.aliceJobPage, 'data-queue-others'), '1 other queued job is ahead; its details are not shown.')
    assert.match(data.aliceRepoPage, /data-queue-rank>#3\/3 · P10</)
  } finally {
    await data.built.close()
  }
})
