import assert from 'node:assert/strict'
import test from 'node:test'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { projectJobAction } from '../src/lib/actionsNeeded.js'
import { MemoryMailer, makeUser, sessionFor, testConfig } from './helpers.js'

// #1079: the dashboard's failure row is the only Retry control, and it used to
// point at `/jobs/<jobId>`, which no route serves. The projection is the one
// place that decides the target, so the href it writes has to be a page the app
// answers with 200 — not merely a path shaped like one.

test('a failed job projects the served job path, not /jobs/<id>', () => {
  const action = projectJobAction({ id: 'job_1', repoId: 'repo_1', kind: 'iterate', status: 'failed', prUrl: null })
  assert.ok(action !== null)
  assert.equal(action.href, '/repos/repo_1/jobs/job_1')
})

test('opening the failure action redirects to a job page the app serves', async () => {
  const store = new Store(':memory:')
  const built = await buildApp({ config: testConfig(), store, mailer: new MemoryMailer(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'retry-path', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_retry', userId: user.id, owner: 'o', name: 'retry', defaultBranch: 'main',
      tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
    })
    store.createJob({ id: 'job_retry', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb_retry', platformTokenHash: '', kind: 'iterate' })
    store.updateJob('job_retry', { status: 'failed', error: 'boom' })

    const action = projectJobAction({ id: 'job_retry', repoId: repo.id, kind: 'iterate', status: 'failed', prUrl: null })
    assert.ok(action !== null)
    store.recordAction({
      userId: user.id, kind: action.kind, repoId: action.repoId, objectId: action.objectId,
      reason: action.reason, href: action.href, label: action.label, urgent: action.urgent,
    })

    const { cookie } = sessionFor(built, user)
    const opened = await built.app.inject({ method: 'GET', url: `/actions/${action.id}`, headers: { cookie } })
    assert.equal(opened.statusCode, 302)
    const target = String(opened.headers.location)
    assert.equal(target, `/repos/${repo.id}/jobs/job_retry`, 'the row sends the person to the page that carries Retry')

    const page = await built.app.inject({ method: 'GET', url: target, headers: { cookie } })
    assert.equal(page.statusCode, 200, 'the redirect target is a page the app serves, not a dead end')
    assert.match(page.body, /job_retry/)
  } finally {
    await built.close()
  }
})
