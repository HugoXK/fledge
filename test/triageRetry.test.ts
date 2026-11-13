import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { sha256Hex } from '../src/lib/secrets.js'
import { formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #390 review: the retry button is the other way into a run, and it used to
// rewrite every kind outside review/plan to `iterate` — so a failed, read-only
// triage run was retried as a job that may write. This drives the HTTP route,
// because that is where the rewrite was reachable from.

function repoFor(store: Store, userId: string, suffix: string) {
  return store.createRepo({ id: `repo_retry_${suffix}`, userId, owner: 'o', name: `r-${suffix}`, defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'developer', goal: '', autoIterate: false, intervalMinutes: 1440 })
}

test('the retry button keeps a triage run a triage run', async () => {
  const store = new Store(':memory:')
  const built = await buildApp({ config: testConfig(), store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'triage-retry', status: 'approved' })
    const repo = repoFor(store, user.id, 'triage')
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
    const retried = store.listJobsForRepo(repo.id).find((row) => row.id !== 'job_triage_retry')
    assert.notEqual(retried, undefined, 'the retry starts a new run')
    assert.equal(retried?.kind, 'triage', 'a retried triage run does not become an iterate job')
    assert.equal(retried?.work_type, 'triage', 'and it keeps the triage contract')
    // The no-branch/no-PR rule is asserted where the real runner reports — the
    // callback test — because the mock runner answers every non-review kind with
    // a synthetic pull request.
  } finally {
    await built.close()
  }
})

test('the resume button keeps a triage run a triage run', async () => {
  const store = new Store(':memory:')
  const built = await buildApp({ config: testConfig(), store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'triage-resume', status: 'approved' })
    const repo = repoFor(store, user.id, 'resume')
    store.createJob({ id: 'job_triage_paused', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'triage the backlog', callbackHash: sha256Hex('pause-secret'), platformTokenHash: '', kind: 'triage', workType: 'triage' })
    store.updateJob('job_triage_paused', { status: 'paused', error: 'paused for a deploy' })
    const { cookie, csrf } = sessionFor(built, user)
    const response = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/jobs/job_triage_paused/resume`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf }),
    })
    assert.equal(response.statusCode, 302)
    const resumed = store.listJobsForRepo(repo.id).find((row) => row.id !== 'job_triage_paused')
    assert.notEqual(resumed, undefined, 'the resume starts a new run')
    assert.equal(resumed?.kind, 'triage', 'resume and retry share one rule')
    assert.equal(resumed?.work_type, 'triage')
  } finally {
    await built.close()
  }
})

test('a retry does not turn a declared work type with no handler into iterate work', async () => {
  const store = new Store(':memory:')
  const built = await buildApp({ config: testConfig(), store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'typed-retry', status: 'approved' })
    const repo = repoFor(store, user.id, 'typed')
    // Only a directly written row can carry an unimplemented contract; the point
    // of the carry-through is that a retry refuses instead of re-labelling it.
    store.createJob({ id: 'job_security_retry', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'security pass', callbackHash: sha256Hex('typed-secret'), platformTokenHash: '', kind: 'iterate', workType: 'security' })
    store.updateJob('job_security_retry', { status: 'failed', error: 'bridge error', finished_at: new Date().toISOString() })
    const { cookie, csrf } = sessionFor(built, user)
    const response = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/jobs/job_security_retry/retry`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf }),
    })
    assert.equal(response.statusCode, 302)
    assert.match(String(response.headers.location), /error=/)
    assert.equal(store.listJobsForRepo(repo.id).length, 1, 'the refusal writes no iterate row')
  } finally {
    await built.close()
  }
})
