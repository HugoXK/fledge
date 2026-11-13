import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { sha256Hex } from '../src/lib/secrets.js'
import { repoPage } from '../src/views/pages.js'
import { formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #390: the triage workflow is only a feature when a person can start it. The
// contract, the parser and the page are tested elsewhere; this file covers the
// two ways in and out of a triage run — the console control that starts one and
// the retry button, which used to rewrite every other kind to `iterate`.

function triageRepo(store: Store, user: { id: string }, suffix: string, repoRole: 'maintainer' | 'developer' = 'maintainer') {
  return store.createRepo({ id: `repo_trigger_${suffix}`, userId: user.id, owner: 'o', name: `t-${suffix}`, defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole, goal: '', autoIterate: false, intervalMinutes: 1440 })
}

test('a maintainer can start a triage run from the repository page', async () => {
  const store = new Store(':memory:')
  const built = await buildApp({ config: testConfig(), store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'triage-start', status: 'approved' })
    const repo = triageRepo(store, user, 'start')
    const { cookie, csrf } = sessionFor(built, user)
    const response = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/triage`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf }),
    })
    assert.equal(response.statusCode, 302)
    const jobs = store.listJobsForRepo(repo.id)
    assert.equal(jobs.length, 1, 'the control writes one job')
    assert.equal(jobs[0]?.kind, 'triage')
    assert.equal(jobs[0]?.work_type, 'triage', 'the row carries the triage contract')
    assert.ok(store.listAudit().some((entry) => entry.action === 'triage.enqueued'), 'the start is audited')
  } finally {
    await built.close()
  }
})

test('a developer cannot start a triage run', async () => {
  const store = new Store(':memory:')
  const built = await buildApp({ config: testConfig(), store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'triage-developer', status: 'approved' })
    const repo = triageRepo(store, user, 'developer', 'developer')
    const { cookie, csrf } = sessionFor(built, user)
    const response = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/triage`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf }),
    })
    assert.equal(response.statusCode, 302)
    assert.match(String(response.headers.location), /error=/)
    assert.equal(store.listJobsForRepo(repo.id).length, 0, 'a refused trigger starts nothing')
  } finally {
    await built.close()
  }
})

test('the start control is a form post and is refused without the token', async () => {
  const store = new Store(':memory:')
  const built = await buildApp({ config: testConfig(), store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'triage-csrf', status: 'approved' })
    const repo = triageRepo(store, user, 'csrf')
    const { cookie } = sessionFor(built, user)
    const response = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/triage`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({}),
    })
    assert.equal(response.statusCode, 403)
    assert.equal(store.listJobsForRepo(repo.id).length, 0)
  } finally {
    await built.close()
  }
})

test('the retry button keeps a triage run a triage run', async () => {
  const store = new Store(':memory:')
  const built = await buildApp({ config: testConfig(), store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'triage-retry', status: 'approved' })
    const repo = triageRepo(store, user, 'retry')
    store.createJob({ id: 'job_triage_retry', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'triage the backlog', callbackHash: sha256Hex('retry-secret'), platformTokenHash: '', kind: 'triage', workType: 'triage' })
    store.updateJob('job_triage_retry', { status: 'failed', error: 'bridge error', finished_at: new Date().toISOString() })
    const { cookie, csrf } = sessionFor(built, user)
    const response = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/jobs/job_triage_retry/retry`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf }),
    })
    assert.equal(response.statusCode, 302)
    const rows = store.listJobsForRepo(repo.id)
    const retried = rows.find((row) => row.id !== 'job_triage_retry')
    assert.notEqual(retried, undefined, 'the retry starts a new run')
    assert.equal(retried?.kind, 'triage', 'a retried triage run does not become an iterate job')
    assert.equal(retried?.work_type, 'triage')
  } finally {
    await built.close()
  }
})

test('the repository page offers the triage control to a maintainer only', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'triage-page', status: 'approved' })
    const maintainer = triageRepo(store, user, 'page-m', 'maintainer')
    const developer = triageRepo(store, user, 'page-d', 'developer')
    const page = (repo: typeof maintainer): string => repoPage({ config, locale: 'en', viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' }, repo, jobs: [] })
    assert.match(page(maintainer), new RegExp(`action="/repos/${maintainer.id}/triage"`), 'the maintainer page carries the control')
    assert.match(page(maintainer), /Triage issues/)
    assert.doesNotMatch(page(developer), new RegExp(`action="/repos/${developer.id}/triage"`), 'a developer page does not offer a control the route would refuse')
  } finally {
    store.close()
  }
})
