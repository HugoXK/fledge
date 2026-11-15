import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { buildApp, type BuiltApp } from '../src/app.js'
import { formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #639: a relation between two tasks is a claim a person makes with a reason and
// evidence, in one project. Nothing derives it from a title: two tasks with the
// same title stay two tasks until somebody links them, and a link cannot reach
// into another repository.

interface Fixture {
  built: BuiltApp
  store: Store
  user: ReturnType<typeof makeUser>
  repoId: string
  otherRepoId: string
  sourceId: string
  targetId: string
  foreignId: string
  close: () => Promise<void>
}

async function fixture(tag: string): Promise<Fixture> {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({
    config,
    store,
    mailer: new MemoryMailer(),
    runner: { name: 'capture', async run() { return { status: 'running' as const } } },
    startScheduler: false,
  })
  const user = makeUser(store, { login: `relations-${tag}`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_rel_${tag}`,
    userId: user.id,
    owner: 'o',
    name: `rel-${tag}`,
    defaultBranch: 'main',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  const other = store.createRepo({
    id: `repo_rel_other_${tag}`,
    userId: user.id,
    owner: 'o',
    name: `rel-other-${tag}`,
    defaultBranch: 'main',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  // `jobs_one_active_per_repo` allows one queued/running job per repository, so
  // the second task in the same project starts only after the first is finished.
  const source = store.createJob({ id: `job_rel_${tag}`, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'fix the flaky retry', callbackHash: `cb-${tag}`, platformTokenHash: '' })
  store.updateJob(source.id, { status: 'succeeded' })
  const target = store.createJob({ id: `job_rel_${tag}_b`, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'fix the flaky retry', callbackHash: `cb2-${tag}`, platformTokenHash: '' })
  const foreign = store.createJob({ id: `job_rel_${tag}_foreign`, repoId: other.id, userId: user.id, trigger: 'manual', goal: 'fix the flaky retry', callbackHash: `cb3-${tag}`, platformTokenHash: '' })
  return { built, store, user, repoId: repo.id, otherRepoId: other.id, sourceId: source.id, targetId: target.id, foreignId: foreign.id, close: async () => { await built.close() } }
}

async function post(f: Fixture, payload: Record<string, string>, locale: 'zh' | 'en' = 'en'): Promise<{ statusCode: number; location: string }> {
  const session = sessionFor(f.built, f.user)
  const response = await f.built.app.inject({
    method: 'POST',
    url: `/repos/${f.repoId}/jobs/${f.sourceId}/relations`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `${session.cookie}; fledge_lang=${locale}` },
    payload: formBody({ csrf: session.csrf, ...payload }),
  })
  return { statusCode: response.statusCode, location: decodeURIComponent(String(response.headers.location ?? '')) }
}

async function page(f: Fixture, jobId: string): Promise<string> {
  const session = sessionFor(f.built, f.user)
  const response = await f.built.app.inject({ method: 'GET', url: `/repos/${f.repoId}/jobs/${jobId}`, headers: { cookie: session.cookie } })
  assert.equal(response.statusCode, 200)
  return response.body
}

const claim = { kind: 'same_problem', reason: 'both reports name the same flaky retry', evidence: 'https://github.com/o/r/issues/12' }

test('an explicit relation is saved, listed on both job pages and audited', async () => {
  const f = await fixture('ok')
  try {
    const response = await post(f, { ...claim, target_job_id: f.targetId })
    assert.equal(response.statusCode, 302)
    assert.match(response.location, /notice=/)
    assert.match(response.location, /Relation saved/)

    const rows = f.store.listTaskRelations(f.sourceId)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.kind, 'same_problem')
    assert.equal(rows[0]?.target_job_id, f.targetId)
    assert.equal(rows[0]?.created_by, f.user.id)
    assert.equal(f.store.listTaskRelations(f.targetId).length, 1, 'the target sees the same relation')

    const sourcePage = await page(f, f.sourceId)
    assert.match(sourcePage, /data-job-relation=/)
    assert.match(sourcePage, /data-relation-count>1</)
    assert.match(sourcePage, new RegExp(f.targetId))
    const targetPage = await page(f, f.targetId)
    assert.match(targetPage, new RegExp(f.sourceId))

    assert.equal(f.store.listAudit(50).some((entry) => entry.action === 'job.relation_created'), true)
    assert.equal(f.store.listJobEvents(f.sourceId, 50).some((event) => event.kind === 'job.relation_created'), true)
  } finally {
    await f.close()
  }
})

test('a target in another repository is refused and writes nothing', async () => {
  const f = await fixture('cross')
  try {
    const response = await post(f, { ...claim, target_job_id: f.foreignId })
    assert.equal(response.statusCode, 302)
    assert.match(response.location, /error=/)
    assert.match(response.location, /same repository/)
    assert.equal(f.store.listTaskRelations(f.sourceId).length, 0)
    assert.equal(f.store.listAudit(50).some((entry) => entry.action === 'job.relation_created'), false)
  } finally {
    await f.close()
  }
})

test('a task cannot be related to itself', async () => {
  const f = await fixture('self')
  try {
    const response = await post(f, { ...claim, target_job_id: f.sourceId })
    assert.match(response.location, /cannot be related to itself/)
    assert.equal(f.store.listTaskRelations(f.sourceId).length, 0)
  } finally {
    await f.close()
  }
})

test('an adjective instead of evidence is refused', async () => {
  const f = await fixture('weak')
  try {
    const response = await post(f, { kind: 'related', reason: 'they look similar', evidence: 'obviously', target_job_id: f.targetId })
    assert.match(response.location, /checkable evidence/)
    assert.equal(f.store.listTaskRelations(f.sourceId).length, 0)
  } finally {
    await f.close()
  }
})

test('the same relation saved twice is one row, not two', async () => {
  const f = await fixture('twice')
  try {
    assert.match((await post(f, { ...claim, target_job_id: f.targetId })).location, /Relation saved/)
    const again = await post(f, { ...claim, target_job_id: f.targetId })
    assert.match(again.location, /already exists/)
    assert.equal(f.store.listTaskRelations(f.sourceId).length, 1)
    const audits = f.store.listAudit(50).filter((entry) => entry.action === 'job.relation_created')
    assert.equal(audits.length, 1)
  } finally {
    await f.close()
  }
})

test('two tasks with the same goal are not related by themselves', async () => {
  const f = await fixture('title')
  try {
    // The fixture writes both tasks with goal "fix the flaky retry"; no code path
    // may create a relation from that similarity alone.
    assert.equal(f.store.listTaskRelations(f.sourceId).length, 0)
    assert.equal(f.store.listTaskRelations(f.targetId).length, 0)
    const sourcePage = await page(f, f.sourceId)
    assert.match(sourcePage, /data-relation-count>0</)
    assert.doesNotMatch(sourcePage, /data-job-relation=/)
  } finally {
    await f.close()
  }
})
