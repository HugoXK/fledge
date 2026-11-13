import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import type { Runner, RunnerContext } from '../src/jobs/runner.js'
import { sha256Hex } from '../src/lib/secrets.js'
import { jobPage } from '../src/views/pages.js'
import { makeUser, MemoryMailer, testConfig } from './helpers.js'

function captureRunner(contexts: RunnerContext[]): Runner {
  return { name: 'capture', async run(context) { contexts.push(context); return { status: 'running' } } }
}

const BOARD = {
  items: [
    { issue: 12, url: 'https://github.com/o/r/issues/12', title: 'the real one', priority: 30, duplicateOf: null },
    { issue: 9, url: 'https://github.com/o/r/issues/9', title: 'second', priority: 20, duplicateOf: null },
    { issue: 7, url: 'https://github.com/o/r/issues/7', title: 'a duplicate', priority: 10, duplicateOf: 12 },
  ],
  next: { issue: 12, url: 'https://github.com/o/r/issues/12', title: 'the real one' },
}

function triageRepo(store: Store, suffix: string) {
  const user = makeUser(store, { login: `triage-${suffix}`, status: 'approved' })
  const repo = store.createRepo({ id: `repo_triage_${suffix}`, userId: user.id, owner: 'o', name: `r-${suffix}`, defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'developer', upstreamHtmlUrl: 'https://github.com/o/r', goal: '', autoIterate: true, intervalMinutes: 60, autoMerge: true })
  return { user, repo }
}

function triageJob(store: Store, repoId: string, userId: string, id: string, secret: string): void {
  store.createJob({ id, repoId, userId, trigger: 'manual', goal: 'triage', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'triage', workType: 'triage' })
  store.updateJob(id, { status: 'running', started_at: new Date().toISOString() })
}

test('an unknown work type is refused before a job row exists', async () => {
  const store = new Store(':memory:')
  const jobs = new Jobs(store, testConfig(), captureRunner([]), new MemoryMailer())
  try {
    const { repo } = triageRepo(store, 'unknown')
    const result = await jobs.enqueue(repo, 'manual', undefined, 'iterate', { workType: 'research' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'UNKNOWN_WORK_TYPE')
    assert.equal(store.listJobsForRepo(repo.id).length, 0, 'no row is written for a refused type')
  } finally {
    store.close()
  }
})

test('the triage kind and the triage work type must agree in both directions', async () => {
  const store = new Store(':memory:')
  const jobs = new Jobs(store, testConfig(), captureRunner([]), new MemoryMailer())
  try {
    const { repo } = triageRepo(store, 'mismatch')
    // A job kind cannot borrow the triage contract...
    const borrowed = await jobs.enqueue(repo, 'manual', undefined, 'iterate', { workType: 'triage' })
    assert.equal(borrowed.ok, false)
    assert.equal(borrowed.code, 'UNKNOWN_WORK_TYPE')
    // ...and a triage run cannot be given another work type, which used to store
    // `work_type='iterate'` and print the iterate contract for a run that is
    // forbidden to open a branch.
    const mislabelled = await jobs.enqueue(repo, 'manual', undefined, 'triage', { workType: 'iterate' })
    assert.equal(mislabelled.ok, false)
    assert.equal(mislabelled.code, 'UNKNOWN_WORK_TYPE')
    assert.equal(store.listJobsForRepo(repo.id).length, 0, 'neither mismatch writes a row')
  } finally {
    store.close()
  }
})

test('a work type with no handler is refused exactly like an unknown one', async () => {
  const store = new Store(':memory:')
  const jobs = new Jobs(store, testConfig(), captureRunner([]), new MemoryMailer())
  try {
    const { repo } = triageRepo(store, 'unsupported')
    for (const workType of ['dependency', 'security', 'docs', 'performance', 'accessibility', 'migration']) {
      const result = await jobs.enqueue(repo, 'manual', undefined, 'iterate', { workType })
      assert.equal(result.ok, false, `${workType} is not implemented in this slice`)
      assert.equal(result.code, 'WORK_TYPE_UNSUPPORTED')
    }
    assert.equal(store.listJobsForRepo(repo.id).length, 0)
  } finally {
    store.close()
  }
})

test('a triage callback cannot open a branch or a pull request', async () => {
  const store = new Store(':memory:')
  const jobs = new Jobs(store, testConfig(), captureRunner([]), new MemoryMailer())
  try {
    const { user, repo } = triageRepo(store, 'branch')
    const secret = 'triage-branch-secret'
    triageJob(store, repo.id, user.id, 'job_triage_branch', secret)
    const result = await jobs.handleCallback('job_triage_branch', secret, {
      status: 'succeeded',
      branch: 'fledge/x',
      prUrl: 'https://github.com/o/r/pull/1',
      triage: BOARD,
    })
    assert.equal(result.status, 422)
    assert.match(String(result.error), /TRIAGE_PR_FORBIDDEN/)
    const job = store.getJob('job_triage_branch')
    assert.equal(job?.status, 'failed')
    assert.equal(job?.pr_url, null, 'the forbidden PR is not recorded')
    assert.ok(store.listAudit().some((entry) => entry.action === 'job.triage_pr_forbidden'))
    // A heartbeat carrying a branch is refused too, before the job finishes.
    triageJob(store, repo.id, user.id, 'job_triage_beat', secret)
    const heartbeat = await jobs.handleCallback('job_triage_beat', secret, { status: 'running', branch: 'fledge/x' })
    assert.equal(heartbeat.status, 400)
  } finally {
    store.close()
  }
})

test('a triage success without a report fails as unverified', async () => {
  const store = new Store(':memory:')
  const jobs = new Jobs(store, testConfig(), captureRunner([]), new MemoryMailer())
  try {
    const { user, repo } = triageRepo(store, 'unverified')
    const secret = 'triage-unverified-secret'
    triageJob(store, repo.id, user.id, 'job_triage_unverified', secret)
    const result = await jobs.handleCallback('job_triage_unverified', secret, { status: 'succeeded', summary: 'the board is fine, trust me' })
    assert.equal(result.status, 422)
    assert.match(String(result.error), /TRIAGE_UNVERIFIED/)
    const job = store.getJob('job_triage_unverified')
    assert.equal(job?.status, 'failed')
    assert.equal(job?.error_code, 'TRIAGE_UNVERIFIED')
    assert.equal(job?.triage_json, null)
    assert.equal(store.listOpenWorkItems(repo.id).length, 0, 'a failed triage proposes nothing')
  } finally {
    store.close()
  }
})

test('a triage report is stored on the job and its first row feeds the next work session', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const contexts: RunnerContext[] = []
  const jobs = new Jobs(store, config, captureRunner(contexts), new MemoryMailer())
  try {
    const { user, repo } = triageRepo(store, 'feeds')
    const secret = 'triage-feeds-secret'
    triageJob(store, repo.id, user.id, 'job_triage_feeds', secret)
    const result = await jobs.handleCallback('job_triage_feeds', secret, { status: 'succeeded', triage: BOARD, summary: '3 open, 1 duplicate, next #12' })
    assert.equal(result.ok, true)
    const job = store.getJob('job_triage_feeds')
    assert.equal(job?.status, 'succeeded')
    assert.equal(job?.work_type, 'triage')
    assert.equal(job?.pr_url, null, 'triage leaves no pull request')
    assert.equal(job?.branch, null, 'triage leaves no branch')

    const stored = JSON.parse(String(job?.triage_json)) as { items: Array<{ issue: number }>; next: { issue: number } }
    assert.equal(stored.items.length, 3)
    assert.equal(stored.next.issue, 12)

    const items = store.listOpenWorkItems(repo.id)
    assert.equal(items.length, 1, 'only the proposed item becomes work')
    assert.equal(items[0]?.issue_url, 'https://github.com/o/r/issues/12')
    assert.equal(items[0]?.priority, 30)

    // The next scheduled tick consumes the proposal through the existing path.
    await jobs.tick()
    const after = store.listJobsForRepo(repo.id)
    assert.equal(after.length, 2, 'the triage proposal starts the next work session')
    assert.equal(after[0]?.kind, 'iterate')
    assert.equal(after[0]?.work_item_id, items[0]?.id)
    assert.equal(contexts[0]?.job.work_type, 'iterate', 'the proposal runs as iterate work')
  } finally {
    store.close()
  }
})

test('a typed job with missing evidence fails closed instead of succeeding', async () => {
  const store = new Store(':memory:')
  const jobs = new Jobs(store, testConfig(), captureRunner([]), new MemoryMailer())
  try {
    const { user, repo } = triageRepo(store, 'evidence')
    const secret = 'triage-evidence-secret'
    // A security job is not enqueueable in this slice, so the row is written the
    // way the store writes it; the callback gate is what is under test.
    store.createJob({ id: 'job_security_gate', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'security', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'iterate', workType: 'security' })
    store.updateJob('job_security_gate', { status: 'running', started_at: new Date().toISOString() })
    const result = await jobs.handleCallback('job_security_gate', secret, { status: 'succeeded', summary: 'fixed it', evidence: { testRed: 'red', testGreen: 'green' } })
    assert.equal(result.status, 422)
    assert.match(String(result.error), /WORK_TYPE_UNVERIFIED/)
    assert.match(String(result.error), /evidence\.rollback/)
    assert.equal(store.getJob('job_security_gate')?.status, 'failed')
    assert.equal(store.getJob('job_security_gate')?.error_code, 'WORK_TYPE_UNVERIFIED')
  } finally {
    store.close()
  }
})

test('the job page shows the work type, its contract and the triage board', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const { user, repo } = triageRepo(store, 'page')
    store.createJob({ id: 'job_triage_page', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'triage', callbackHash: 'cb', platformTokenHash: '', kind: 'triage', workType: 'triage' })
    store.updateJob('job_triage_page', { status: 'succeeded', triage_json: JSON.stringify({ schema_version: 1, ...BOARD }), summary: 'done' })
    const job = store.getJob('job_triage_page')!
    const page = jobPage({ config, locale: 'en', viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' }, repo, job })
    assert.match(page, /data-work-type="triage"/)
    assert.match(page, /Work type/)
    assert.match(page, /Triage/)
    assert.match(page, /Required evidence/)
    assert.match(page, /May auto-merge/)
    assert.match(page, /data-triage/)
    assert.match(page, /3 open, 1 duplicate/, 'the board summary is rendered')
    assert.match(page, /issues\/12/, 'the ranked rows link the issues')
    assert.match(page, /next/, 'the proposal is marked')
    assert.match(page, />#12</, 'the duplicate points at the issue that stays open')
  } finally {
    store.close()
  }
})
