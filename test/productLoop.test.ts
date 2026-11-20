import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { encryptSecret, sha256Hex } from '../src/lib/secrets.js'
import { RETENTION_CLASSES, SETTINGS_RETENTION } from '../scripts/lib/retention.mjs'
import { makeUser, testConfig } from './helpers.js'

// #635: the boundary is the shape of the stored record, so these cases read the
// row itself. A test that only watched a counter increment would pass on a table
// that also kept a user id.

function memoryStore(): Store {
  return new Store(':memory:')
}

function repoFor(store: Store, userId: string, id: string): string {
  store.createRepo({
    id,
    userId,
    owner: 'o',
    name: id,
    defaultBranch: 'main',
    tokenEnc: encryptSecret('token', testConfig().tokenEncryptionKey),
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  return id
}

function columns(store: Store): string[] {
  return store.all<{ name: string }>('PRAGMA table_info(product_events)').map((row) => row.name)
}

test('an off switch writes no event and no salt', () => {
  const store = memoryStore()
  const user = makeUser(store)
  const repoId = repoFor(store, user.id, 'repo-off')
  store.setSetting('product.analytics', 'off')
  assert.equal(store.recordProductEvent({ name: 'repo_connected', repoId, subject: repoId }), false)
  assert.equal(store.recordProductEvent({ name: 'first_job_started', repoId, subject: repoId }), false)
  const rows = store.all<{ n: number }>('SELECT COUNT(*) AS n FROM product_events')
  assert.equal(Number(rows[0]?.n ?? -1), 0)
  // A salt write is a write: switched off means the installation has not minted one.
  assert.equal(store.getSetting('product.salt'), undefined)
  assert.deepEqual(store.all("SELECT key FROM settings WHERE key = 'product.salt'"), [])
  assert.equal(store.productLoopMetrics(new Date(0).toISOString()).windowEvents, 0)
})

test('the same event from two different users is indistinguishable in the row', () => {
  const store = memoryStore()
  const first = makeUser(store, { login: 'first-owner' })
  const second = makeUser(store, { login: 'second-owner' })
  const at = '2026-11-19T10:00:00.000Z'
  const repoA = repoFor(store, first.id, 'repo-a')
  const repoB = repoFor(store, second.id, 'repo-b')
  assert.equal(store.recordProductEvent({ name: 'repo_connected', repoId: repoA, subject: repoA, at }), true)
  assert.equal(store.recordProductEvent({ name: 'repo_connected', repoId: repoB, subject: repoB, at }), true)
  const rows = store.all<Record<string, unknown>>('SELECT * FROM product_events ORDER BY id')
  assert.equal(rows.length, 2)
  // Nothing that names the account exists, so nothing can leak it.
  assert.deepEqual(columns(store).sort(), ['at', 'duration_ms', 'id', 'name', 'repo_hash'])
  const [rowA, rowB] = rows
  assert.equal(rowA?.name, rowB?.name)
  assert.equal(rowA?.at, rowB?.at)
  assert.equal(rowA?.duration_ms, rowB?.duration_ms)
  for (const value of Object.values(rowA ?? {}).concat(Object.values(rowB ?? {}))) {
    const text = String(value)
    for (const secret of [first.id, second.id, first.login, second.login, first.email ?? '', second.email ?? ''].filter((value) => value !== '')) {
      assert.equal(text.includes(secret), false, `row leaked ${secret}`)
    }
  }
  // The two rows differ only in the two digests, which is the whole point: the
  // repository is not reversible without the installation salt.
  assert.notEqual(rowA?.repo_hash, rowB?.repo_hash)
  assert.notEqual(rowA?.id, rowB?.id)
})

test('the same repository and event from two actors stores one identical row', () => {
  const store = memoryStore()
  const owner = makeUser(store, { login: 'owner' })
  const admin = makeUser(store, { login: 'admin', superadmin: true })
  const repoId = repoFor(store, owner.id, 'repo-same')
  const at = '2026-11-19T11:00:00.000Z'
  assert.equal(store.recordProductEvent({ name: 'human_action_retry', repoId, subject: 'job-1', at }), true)
  assert.equal(store.recordProductEvent({ name: 'human_action_retry', repoId, subject: 'job-1', at }), false)
  const rows = store.all<Record<string, unknown>>('SELECT * FROM product_events')
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.name, 'human_action_retry')
  assert.equal(JSON.stringify(rows[0]).includes(admin.id), false)
})

test('a duplicate event id is counted once', () => {
  const store = memoryStore()
  const user = makeUser(store)
  const repoId = repoFor(store, user.id, 'repo-dup')
  assert.equal(store.recordProductEvent({ name: 'repo_connected', repoId, subject: repoId }), true)
  assert.equal(store.recordProductEvent({ name: 'repo_connected', repoId, subject: repoId }), false)
  const metric = store.productLoopMetrics(new Date(0).toISOString())
  assert.equal(metric.funnel.connected, 1)
  assert.equal(metric.windowEvents, 1)
})

test('an event name that is not on the list is refused, so no content can be stored', () => {
  const store = memoryStore()
  const user = makeUser(store)
  const repoId = repoFor(store, user.id, 'repo-name')
  for (const name of ['https://example.com/?token=abc', 'user@example.com', 'the user asked for X', 'REPO_CONNECTED']) {
    assert.equal(store.recordProductEvent({ name, repoId, subject: repoId }), false)
  }
  assert.equal(store.all<{ n: number }>('SELECT COUNT(*) AS n FROM product_events')[0]?.n, 0)
})

test('the digest is stable for one installation salt and changes when it rotates', () => {
  const store = memoryStore()
  const user = makeUser(store)
  const repoId = repoFor(store, user.id, 'repo-salt')
  const before = store.productRepoHash(repoId)
  assert.equal(store.productRepoHash(repoId), before)
  const salt = store.productSalt()
  assert.equal(store.productSalt(), salt)
  const next = store.rotateProductSalt()
  assert.notEqual(next, salt)
  assert.notEqual(store.productRepoHash(repoId), before)
})

test('a quiet window reports n/a instead of a confident zero', () => {
  const store = memoryStore()
  const snapshot = store.productLoopMetrics(new Date(0).toISOString())
  assert.deepEqual(snapshot.funnel, { connected: 0, firstJob: 0, firstPr: 0, merged: 0 })
  assert.equal(snapshot.toFirstPr.medianMs, null)
  assert.equal(snapshot.toFirstPr.samples, 0)
  assert.equal(snapshot.rescue.rate, null)
  assert.equal(snapshot.evidence.completeRate, null)
  assert.equal(snapshot.evidence.unknownCostRate, null)
  assert.equal(snapshot.returning.repositories, 0)
})

test('the funnel is computed from the events, in order, per repository', () => {
  const store = memoryStore()
  const user = makeUser(store)
  const repoId = repoFor(store, user.id, 'repo-funnel')
  const base = Date.parse('2026-11-01T00:00:00.000Z')
  const at = (hours: number): string => new Date(base + hours * 3_600_000).toISOString()
  store.recordProductEvent({ name: 'repo_connected', repoId, subject: repoId, at: at(0) })
  store.recordProductEvent({ name: 'first_job_started', repoId, subject: repoId, at: at(4) })
  store.recordProductEvent({ name: 'first_pr_opened', repoId, subject: repoId, at: at(10) })
  const before = store.productLoopMetrics(at(-1))
  assert.deepEqual(before.funnel, { connected: 1, firstJob: 1, firstPr: 1, merged: 0 })
  assert.equal(before.toFirstPr.samples, 1)
  assert.equal(before.toFirstPr.medianMs, 10 * 3_600_000)
  assert.equal(before.toMerge.samples, 0)
  store.recordProductEvent({ name: 'pr_merged', repoId, subject: repoId, at: at(30) })
  const after = store.productLoopMetrics(at(-1))
  assert.deepEqual(after.funnel, { connected: 1, firstJob: 1, firstPr: 1, merged: 1 })
  assert.equal(after.toMerge.medianMs, 30 * 3_600_000)
})

test('deleting a repository takes its loop events with it', () => {
  const store = memoryStore()
  const user = makeUser(store)
  const repoId = repoFor(store, user.id, 'repo-delete')
  store.recordProductEvent({ name: 'repo_connected', repoId, subject: repoId })
  assert.equal(store.productLoopMetrics(new Date(0).toISOString()).funnel.connected, 1)
  store.deleteRepo(repoId)
  assert.equal(store.productLoopMetrics(new Date(0).toISOString()).funnel.connected, 0)
})

test('the page states the boundary and prints the counts it was given', async () => {
  const { buildApp } = await import('../src/app.js')
  const { MockRunner } = await import('../src/jobs/mock.js')
  const { MemoryMailer, sessionFor } = await import('./helpers.js')
  const store = memoryStore()
  const built = await buildApp({ config: testConfig(), store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const admin = makeUser(store, { login: 'loop-admin', superadmin: true, status: 'approved' })
    const repoId = repoFor(store, admin.id, 'repo_page')
    store.recordProductEvent({ name: 'repo_connected', repoId, subject: repoId })
    store.recordProductEvent({ name: 'first_job_started', repoId, subject: repoId })
    const { cookie } = sessionFor(built, admin)
    const page = await built.app.inject({ method: 'GET', url: '/admin/product', headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /data-loop-terms/)
    assert.match(page.body, /indistinguishable in the store|无法区分是谁做的/)
    // The counts come off the store, not off the page: connected 1, first job 1.
    assert.match(page.body, /接入仓库<\/td><td>1<\/td>/)
    assert.match(page.body, /第一次任务<\/td><td>1<\/td>/)
    // A quiet median is n/a, never a confident zero.
    assert.match(page.body, /n\/a（还没有样本）/)
  } finally {
    await built.app.close()
  }
})

test('the page says analytics is off instead of showing an empty table as zero', async () => {
  const { buildApp } = await import('../src/app.js')
  const { MockRunner } = await import('../src/jobs/mock.js')
  const { MemoryMailer, sessionFor } = await import('./helpers.js')
  const store = memoryStore()
  store.setSetting('product.analytics', 'off')
  const built = await buildApp({ config: testConfig(), store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const admin = makeUser(store, { login: 'off-admin', superadmin: true, status: 'approved' })
    const { cookie } = sessionFor(built, admin)
    const page = await built.app.inject({ method: 'GET', url: '/admin/product', headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /data-loop-off/)
    assert.equal(page.body.includes('data-loop-terms'), true)
  } finally {
    await built.app.close()
  }
})

// ---------------------------------------------------------------------------
// #635 slice 2: the export. It is one of the two ways the loop numbers leave the
// page, so it is tested at the boundary rather than only for its happy path: it
// must not answer while analytics is off, and what it does answer carries no
// digest and no account. The optional push has its own file, productWebhook.
// ---------------------------------------------------------------------------

test('the CSV export is not reachable while analytics is off', async () => {
  const { buildApp } = await import('../src/app.js')
  const { MockRunner } = await import('../src/jobs/mock.js')
  const { MemoryMailer, sessionFor } = await import('./helpers.js')
  const store = memoryStore()
  const owner = makeUser(store, { login: 'csv-off-owner' })
  const repoId = repoFor(store, owner.id, 'repo-csv-off')
  store.recordProductEvent({ name: 'repo_connected', repoId, subject: repoId })
  store.setSetting('product.analytics', 'off')
  const built = await buildApp({ config: testConfig(), store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const admin = makeUser(store, { login: 'csv-off-admin', superadmin: true, status: 'approved' })
    const { cookie } = sessionFor(built, admin)
    const csv = await built.app.inject({ method: 'GET', url: '/admin/product.csv', headers: { cookie } })
    assert.equal(csv.statusCode, 404, 'a switched-off loop answers no export')
    assert.equal(csv.body.includes('section,metric,value'), false, 'no CSV body leaks through the 404')
    const page = await built.app.inject({ method: 'GET', url: '/admin/product', headers: { cookie } })
    assert.equal(page.body.includes('/admin/product.csv'), false, 'the page offers no link it cannot honour')
  } finally {
    await built.app.close()
  }
})

test('the CSV export is the page snapshot and carries no digest or account', async () => {
  const { buildApp } = await import('../src/app.js')
  const { MockRunner } = await import('../src/jobs/mock.js')
  const { MemoryMailer, sessionFor } = await import('./helpers.js')
  const store = memoryStore()
  const built = await buildApp({ config: testConfig(), store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const admin = makeUser(store, { login: 'csv-admin', superadmin: true, status: 'approved' })
    const repoId = repoFor(store, admin.id, 'repo-csv')
    store.recordProductEvent({ name: 'repo_connected', repoId, subject: repoId })
    store.recordProductEvent({ name: 'first_job_started', repoId, subject: repoId })
    const { cookie } = sessionFor(built, admin)
    const csv = await built.app.inject({ method: 'GET', url: '/admin/product.csv?window=30', headers: { cookie } })
    assert.equal(csv.statusCode, 200)
    assert.match(String(csv.headers['content-type']), /text\/csv/)
    const lines = csv.body.trim().split('\n')
    assert.equal(lines[0], 'section,metric,value')
    assert.ok(lines.includes('funnel,connected,1'), 'the export counts what the store recorded')
    assert.ok(lines.includes('funnel,first_job,1'))
    assert.ok(lines.includes('window,days,30'))
    assert.equal(csv.body.includes(store.productRepoHash(repoId)), false, 'no repository digest in the export')
    assert.equal(csv.body.includes(admin.id), false, 'no account id in the export')
    assert.equal(csv.body.includes(admin.login), false, 'no login in the export')
    // The page and the export read the same snapshot, so the numbers agree.
    const page = await built.app.inject({ method: 'GET', url: '/admin/product?window=30', headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /接入仓库<\/td><td>1<\/td>/)
    assert.match(page.body, /href="\/admin\/product\.csv\?window=30"/)
  } finally {
    await built.app.close()
  }
})

test('loop events age out on their own window and the preview counts them', () => {
  const store = memoryStore()
  try {
    const user = makeUser(store)
    const repoId = repoFor(store, user.id, 'repo-retention')
    const stale = store.recordProductEvent({ name: 'repo_connected', repoId, subject: repoId, at: new Date(Date.now() - 731 * 86_400_000).toISOString() })
    const fresh = store.recordProductEvent({ name: 'first_job_started', repoId, subject: repoId, at: new Date(Date.now() - 2 * 86_400_000).toISOString() })
    assert.equal(stale, true)
    assert.equal(fresh, true)
    const cls = RETENTION_CLASSES.find((entry: { id: string }) => entry.id === 'productEvents') as { defaultDays?: number; where: (input: { cutoff: string; now: string }) => { sql: string } } | undefined
    assert.ok(cls, 'the loop table is a retention class, not an unmanaged table')
    assert.equal(cls.defaultDays, 730, 'two years, so a year-over-year comparison still has its window')
    const row = store.retentionCounts().find((entry) => entry.id === 'productEvents')
    assert.equal(row?.count, 1, 'only the row past the window is counted')
    store.pruneOldData()
    const remaining = store.all<{ name: string }>('SELECT name FROM product_events')
    assert.deepEqual(remaining.map((entry) => entry.name), ['first_job_started'], 'the pass removes the stale row and keeps the fresh one')
    // The push marker is a settings family with its own window, so it is counted
    // by the pass that empties settings rather than by a second list.
    const family = SETTINGS_RETENTION.find((entry: { prefix: string }) => entry.prefix === 'product_push:')
    assert.ok(family)
    assert.equal(family.days, 30)
  } finally {
    store.close()
  }
})

test('the page names the receiver state it was handed', async () => {
  const { buildApp } = await import('../src/app.js')
  const { MockRunner } = await import('../src/jobs/mock.js')
  const { MemoryMailer, sessionFor } = await import('./helpers.js')
  const store = memoryStore()
  const config = testConfig({ productWebhookUrl: 'https://receiver.example.com/hook' })
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const admin = makeUser(store, { login: 'receiver-admin', superadmin: true, status: 'approved' })
    const { cookie } = sessionFor(built, admin)
    store.setSetting('product_push:last', '2026-11-19T12:00:00.000Z')
    const page = await built.app.inject({ method: 'GET', url: '/admin/product', headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /data-loop-receiver/)
    assert.match(page.body, /Last push: 2026-11-19T12:00:00\.000Z|最近一次推送：2026-11-19T12:00:00\.000Z/)
    store.setSetting('product.analytics', 'off')
    const off = await built.app.inject({ method: 'GET', url: '/admin/product', headers: { cookie } })
    assert.match(off.body, /data-loop-off/)
    assert.equal(off.body.includes('/admin/product.csv'), false)
  } finally {
    await built.app.close()
  }
})

test('a succeeded run with no pull request is not counted as a failure', async () => {
  const { Jobs } = await import('../src/jobs/service.js')
  const { MemoryMailer } = await import('./helpers.js')
  const store = memoryStore()
  try {
    const user = makeUser(store, { login: 'review-path-owner' })
    const repoId = repoFor(store, user.id, 'repo-review-path')
    const jobs = new Jobs(store, testConfig(), { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
    store.createJob({
      id: 'job_review_path', repoId, userId: user.id, trigger: 'manual', goal: 'review the open PRs',
      callbackHash: sha256Hex('review-path-secret'), platformTokenHash: '', kind: 'review', baseBranch: 'main',
    })
    store.updateJob('job_review_path', { status: 'running', started_at: new Date().toISOString() })
    const reviewed = await jobs.handleCallback('job_review_path', 'review-path-secret', { status: 'succeeded', summary: 'Reviewed 3 PRs', reviewScore: 82 })
    assert.equal(reviewed.ok, true, reviewed.error ?? 'no error')
    const names = store.all<{ name: string }>('SELECT name FROM product_events').map((row) => row.name)
    assert.equal(names.includes('job_failed'), false, 'a review answers with no pull request and is still a success')
    assert.equal(store.productLoopMetrics(new Date(0).toISOString()).rescue.failed, 0, 'the rescue rate has no failure to divide by')

    store.createJob({
      id: 'job_failed_path', repoId, userId: user.id, trigger: 'manual', goal: 'fix the splitter',
      callbackHash: sha256Hex('failed-path-secret'), platformTokenHash: '', kind: 'iterate', baseBranch: 'main',
    })
    store.updateJob('job_failed_path', { status: 'running', started_at: new Date().toISOString() })
    const failed = await jobs.handleCallback('job_failed_path', 'failed-path-secret', { status: 'failed', error: 'the tests never went green' })
    assert.equal(failed.ok, true, failed.error ?? 'the failed report is accepted')
    assert.equal(store.getJob('job_failed_path')?.status, 'failed', 'a failed report still records the failure')
    const after = store.all<{ name: string }>('SELECT name FROM product_events').map((row) => row.name)
    assert.equal(after.filter((name) => name === 'job_failed').length, 1, 'only the failed run counts as one failure')
    assert.equal(store.productLoopMetrics(new Date(0).toISOString()).rescue.failed, 1)
  } finally {
    store.close()
  }
})

test('deleting a repository with analytics off mints no salt', () => {
  const store = memoryStore()
  try {
    const user = makeUser(store, { login: 'delete-off-owner' })
    const repoId = repoFor(store, user.id, 'repo-delete-off')
    store.setSetting('product.analytics', 'off')
    store.deleteRepo(repoId)
    // A delete is not an event and must not be the write that creates the salt.
    assert.equal(store.getSetting('product.salt'), undefined)
    assert.deepEqual(store.all("SELECT key FROM settings WHERE key = 'product.salt'"), [])
  } finally {
    store.close()
  }
})

test('the funnel prints no drop when a later stage is outside the connected cohort', async () => {
  const { buildApp } = await import('../src/app.js')
  const { MockRunner } = await import('../src/jobs/mock.js')
  const { MemoryMailer, sessionFor } = await import('./helpers.js')
  const store = memoryStore()
  const built = await buildApp({ config: testConfig(), store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const admin = makeUser(store, { login: 'cohort-admin', superadmin: true, status: 'approved' })
    const connected = repoFor(store, admin.id, 'repo-cohort-connected')
    store.recordProductEvent({ name: 'repo_connected', repoId: connected, subject: connected })
    // Two more repositories started a job inside the window without a connection
    // event in it, so the later stage is larger than the stage it would be
    // measured against. `1` connected and `3` first jobs is not a −200% drop.
    for (const id of ['repo-cohort-b', 'repo-cohort-c']) {
      const other = repoFor(store, admin.id, id)
      store.recordProductEvent({ name: 'first_job_started', repoId: other, subject: other })
    }
    store.recordProductEvent({ name: 'first_job_started', repoId: connected, subject: connected })
    const { cookie } = sessionFor(built, admin)
    const page = await built.app.inject({ method: 'GET', url: '/admin/product', headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /第一次任务<\/td><td>3<\/td><td class="muted"><\/td>/, 'the count is printed and the drop cell stays empty')
    assert.equal(page.body.includes('−-'), false, 'no double negative percentage')
    assert.equal(page.body.includes('−200%'), false, 'no impossible drop')
  } finally {
    await built.app.close()
  }
})
