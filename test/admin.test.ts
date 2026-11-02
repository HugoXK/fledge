import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

test('admin jobs and audit paginate at ten rows with friendly audit labels', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const admin = makeUser(store, { login: 'boss', admin: true })
    const repo = store.createRepo({
      id: 'repo_admin',
      userId: admin.id,
      owner: 'octo',
      name: 'demo',
      defaultBranch: 'main',
      tokenEnc: 'x',
      goal: '',
      autoIterate: false,
      intervalMinutes: 1440,
    })
    for (let i = 0; i < 12; i += 1) {
      store.createJob({ id: `job_admin_${i}`, repoId: repo.id, userId: admin.id, trigger: 'manual', goal: 'goal', callbackHash: `hash-${i}`, platformTokenHash: '', kind: i % 2 === 0 ? 'iterate' : 'review' })
      store.audit(admin.id, i % 2 === 0 ? 'token.created' : 'token.revoked', i % 2 === 0 ? 'flybot-cli' : null)
    }
    const { cookie } = sessionFor(built, admin)
    const page = await built.app.inject({ method: 'GET', url: '/admin?jobsPage=2&auditPage=2', headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /2 \/ 2 · 12/)
    assert.match(page.body, /创建 token/)
    assert.match(page.body, /撤销 token/)
    assert.match(page.body, /flybot-cli/)
    assert.match(page.body, /@boss/)
    assert.match(page.body, /每页 10 条/)
    assert.match(page.body, /data-confirm=/)
    assert.doesNotMatch(page.body, /onsubmit=|onclick=/)
  } finally {
    await built.close()
  }
})

test('rejecting a user cancels active jobs and frees the global slot', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const admin = makeUser(store, { login: 'reject-admin', admin: true, status: 'approved' })
    const target = makeUser(store, { login: 'reject-target', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_reject_target', userId: target.id, owner: 'o', name: 'rt', defaultBranch: 'main', tokenEnc: 'x', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.createApiToken({ id: 'tok_reject', userId: target.id, kind: 'job', name: 'job:job_reject', tokenHash: 'reject-hash', prefix: 'flg_reje', expiresAt: null })
    store.createJob({ id: 'job_reject', repoId: repo.id, userId: target.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: 'reject-hash' })
    store.updateJob('job_reject', { status: 'running' })
    assert.equal(store.countActiveJobs(), 1)
    const { cookie, csrf } = sessionFor(built, admin)
    const rejected = await built.app.inject({
      method: 'POST',
      url: `/admin/users/${target.id}/reject`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf }),
    })
    assert.equal(rejected.statusCode, 302)
    assert.equal(store.countActiveJobs(), 0)
    assert.equal(store.getJob('job_reject')?.status, 'failed')
    assert.equal(store.findApiToken('reject-hash'), undefined)
  } finally {
    await built.close()
  }
})
