import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { buildApp, type BuiltApp } from '../src/app.js'
import { MemoryMailer, flashOf, formBody, makeUser, sessionFor, testConfig } from './helpers.js'

// #639: the page posts a level, a reason and evidence to one route, and the
// refusal reaches the page as text in the request's locale. The service owns
// the code; the route owns the sentence, so both languages have to be driven
// through the real request rather than read off a unit-level message.

interface Fixture {
  built: BuiltApp
  store: Store
  user: ReturnType<typeof makeUser>
  repoId: string
  jobId: string
  close: () => Promise<void>
}

async function fixture(tag: string, priority = 10): Promise<Fixture> {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({
    config,
    store,
    mailer: new MemoryMailer(),
    runner: { name: 'capture', async run() { return { status: 'running' as const } } },
    startScheduler: false,
  })
  const user = makeUser(store, { login: `priority-route-${tag}`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_priority_route_${tag}`,
    userId: user.id,
    owner: 'o',
    name: `route-${tag}`,
    defaultBranch: 'main',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  const job = store.createJob({
    id: `job_priority_route_${tag}`,
    repoId: repo.id,
    userId: user.id,
    trigger: 'manual',
    goal: 'g',
    callbackHash: `cb-${tag}`,
    platformTokenHash: '',
    priority,
  })
  return { built, store, user, repoId: repo.id, jobId: job.id, close: async () => { await built.close() } }
}

async function post(f: Fixture, locale: 'zh' | 'en', payload: Record<string, string>): Promise<{ statusCode: number; location: string; flash: ReturnType<typeof flashOf> }> {
  const session = sessionFor(f.built, f.user)
  const response = await f.built.app.inject({
    method: 'POST',
    url: `/repos/${f.repoId}/jobs/${f.jobId}/priority`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `${session.cookie}; fledge_lang=${locale}` },
    payload: formBody({ csrf: session.csrf, ...payload }),
  })
  return { statusCode: response.statusCode, location: String(response.headers.location ?? ''), flash: flashOf(response) }
}

test('a P1 claim without evidence is refused in English when the request is English', async () => {
  const f = await fixture('en')
  try {
    const before = f.store.getJob(f.jobId)!
    const response = await post(f, 'en', { level: 'P1', reason: 'this is urgent', evidence: 'critical' })
    assert.equal(response.statusCode, 302)
    assert.ok(response.flash?.error)
    assert.match(response.flash?.error?.text ?? '', /checkable evidence/)
    assert.doesNotMatch(response.flash?.error?.text ?? '', /可核对的证据/, 'the English page does not carry the Chinese sentence')
    const after = f.store.getJob(f.jobId)!
    assert.equal(after.priority, before.priority)
    assert.equal(after.queue_seq, before.queue_seq)
  } finally {
    await f.close()
  }
})

test('the same refusal is Chinese when the request is Chinese', async () => {
  const f = await fixture('zh')
  try {
    const response = await post(f, 'zh', { level: 'P1', reason: '这是紧急的', evidence: '非常紧急' })
    assert.equal(response.statusCode, 302)
    assert.match(response.flash?.error?.text ?? '', /可核对的证据/)
    assert.doesNotMatch(response.flash?.error?.text ?? '', /checkable evidence/)
  } finally {
    await f.close()
  }
})

test('a P0 claim with a reason and evidence moves the job and answers in the request locale', async () => {
  const f = await fixture('p0')
  try {
    const response = await post(f, 'en', {
      level: 'P0',
      reason: 'the release job fails on every run since the upgrade',
      evidence: 'https://github.com/o/r/actions/runs/123',
    })
    assert.equal(response.statusCode, 302)
    assert.ok(response.flash?.notice)
    assert.match(response.flash?.notice?.text ?? '', /Priority is now P0/)
    assert.equal(f.store.getJob(f.jobId)!.priority, 30)
    assert.equal(f.store.listAudit(50).some((entry) => entry.action === 'job.priority_changed'), true)
  } finally {
    await f.close()
  }
})

test('an unknown level is refused by name, not by falling back to a default', async () => {
  const f = await fixture('bad')
  try {
    const before = f.store.getJob(f.jobId)!
    const response = await post(f, 'en', { level: 'P9', reason: 'x'.repeat(20), evidence: 'https://example.com/1' })
    assert.equal(response.statusCode, 302)
    assert.match(response.flash?.error?.key ?? '', /^PRIORITY_LEVEL_INVALID:/)
    assert.equal(f.store.getJob(f.jobId)!.priority, before.priority)
  } finally {
    await f.close()
  }
})
