import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp, type BuiltApp } from '../src/app.js'
import { Store } from '../src/db.js'
import type { JobRow, RepoRow } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { aheadOfViewer, rankQueued } from '../src/lib/queueRank.js'
import { humanTimeShort } from '../src/lib/time.js'
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

// The boundary this test exists to protect is "no detail of another tenant's job
// is rendered", so reading only the text before the first `<` would miss a chip
// or an arrival appended inside the same element. The whole element's text is
// read, tags stripped, and compared by equality; the queue block itself is
// asserted the same way, so extra markup inside it fails the test.
function elementHtml(html: string, attr: string): string {
  const open = new RegExp(`<([a-z0-9]+)[^>]*\\b${attr}(?=[\\s=>])[^>]*>`).exec(html)
  assert.ok(open, `the page renders ${attr}`)
  const tag = open[1]!
  const start = open.index + open[0].length
  const tags = new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, 'g')
  tags.lastIndex = start
  let depth = 1
  let match: RegExpExecArray | null
  while ((match = tags.exec(html)) !== null) {
    depth += match[0].startsWith('</') ? -1 : 1
    if (depth === 0) return html.slice(start, match.index)
  }
  assert.fail(`the ${attr} element is closed`)
}

function textOf(html: string, attr: string): string {
  return elementHtml(html, attr).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
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
  aliceDashboard: string
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
  // The other tenant's priority (30) and arrival (10:00) are values no own job
  // has, so a leak of either is visible as a value the page cannot legitimately
  // print: own jobs are priority 20 at 10:02 and priority 10 at 10:03.
  create({ id: 'job_queue_bob', repoId: bobRepo.id, userId: bob.id, trigger: 'followup', priority: 30, createdAt: '2026-11-13T10:00:00.000Z' })
  create({ id: 'job_queue_followup', repoId: followRepo.id, userId: alice.id, trigger: 'followup', priority: 20, createdAt: '2026-11-13T10:02:00.000Z' })
  create({ id: 'job_queue_manual', repoId: manualRepo.id, userId: alice.id, trigger: 'manual', priority: 10, createdAt: '2026-11-13T10:03:00.000Z' })

  const { cookie } = sessionFor(built, alice)
  const headers = locale === 'en' ? { cookie: `${cookie}; fledge_lang=en` } : { cookie }
  const aliceJobPage = await built.app.inject({ method: 'GET', url: `/repos/${manualRepo.id}/jobs/job_queue_manual`, headers })
  const aliceRepoPage = await built.app.inject({ method: 'GET', url: `/repos/${manualRepo.id}`, headers })
  const aliceDashboard = await built.app.inject({ method: 'GET', url: '/dashboard', headers })
  assert.equal(aliceJobPage.statusCode, 200)
  assert.equal(aliceRepoPage.statusCode, 200)
  assert.equal(aliceDashboard.statusCode, 200)
  return { built, store, aliceJobPage: aliceJobPage.body, aliceRepoPage: aliceRepoPage.body, aliceDashboard: aliceDashboard.body }
}

test('the job page prints position, total and the trigger that created it, and the count-only sentence for other tenants', async () => {
  const data = await fixture('zh')
  try {
    assert.equal(textOf(data.aliceJobPage, 'data-job-queue-position'), '队列位置 3 / 共 3 · 优先级 10（手动）')
    // The acceptance is one exact sentence, not a "contains no identifier"
    // substring check: priority is another tenant's trigger class.
    assert.equal(textOf(data.aliceJobPage, 'data-queue-others'), '另有 1 个排队任务在前，不显示详情。')
    // The rendered queue block is asserted whole: the sentence, the rule, the
    // own-ahead label and row. An extra chip or line inside it changes this text.
    const otherArrival = humanTimeShort('2026-11-13T10:00:00.000Z')
    const ownArrival = humanTimeShort('2026-11-13T10:02:00.000Z')
    assert.equal(textOf(data.aliceJobPage, 'data-queue'), [
      '队列位置 3 / 共 3 · 优先级 10（手动）',
      '按优先级、再按进入顺序排队；同一位置可能有多个任务。仓库里已有运行中或更早的排队任务时，这个位置不会立即开始。',
      '你的排队任务，按优先级、再按进入顺序：',
      `acme/one 优先级 20（跟进） · ${ownArrival}`,
      '另有 1 个排队任务在前，不显示详情。',
    ].join(' '))
    const owned = [...data.aliceJobPage.matchAll(/<div class="list-row" data-queue-owned-job="([^"]+)">/g)].map((match) => match[1])
    assert.deepEqual(owned, ['job_queue_followup'])
    assert.match(data.aliceJobPage, /acme\/one/)
    assert.match(data.aliceJobPage, /优先级 20（跟进）/)
    // No identifier of the other tenant's job, and none of the two values the
    // fixture gives only to it: login, repository, id, priority 30, arrival
    // 10:00. The text check above catches a leaks inside the block; these catch
    // one anywhere else on the page.
    assert.doesNotMatch(data.aliceJobPage, /bob/)
    assert.doesNotMatch(data.aliceJobPage, /acme\/beta/)
    assert.doesNotMatch(data.aliceJobPage, /job_queue_bob/)
    assert.doesNotMatch(data.aliceJobPage, /P30|优先级 30|priority 30/)
    assert.ok(!data.aliceJobPage.includes(otherArrival), 'the other tenant arrival is not rendered anywhere')
    assert.doesNotMatch(data.aliceJobPage, /2026-11-13T10:00/)
  } finally {
    await data.built.close()
  }
})

test('the dashboard and the repository list show position and priority inside the job cell, and nothing for a running job', async () => {
  const data = await fixture('zh')
  try {
    // The dashboard lists alice's own two queued jobs; the other tenant's job is
    // ahead in the instance queue, so the ranks are 2/3 and 3/3, not 1/2 and 2/2.
    const dashboardRanks = [...data.aliceDashboard.matchAll(/data-queue-rank>([^<]*)</g)].map((match) => match[1])
    assert.deepEqual(dashboardRanks, ['#3/3 · P10', '#2/3 · P20'])  // newest first
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
    assert.equal(textOf(data.aliceJobPage, 'data-job-queue-position'), 'Queue position 3 of 3 · priority 10 (manual)')
    assert.equal(textOf(data.aliceJobPage, 'data-queue-others'), '1 other queued job is ahead; its details are not shown.')
    assert.match(data.aliceRepoPage, /data-queue-rank>#3\/3 · P10</)
  } finally {
    await data.built.close()
  }
})
