import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import { encryptSecret, sha256Hex } from '../src/lib/secrets.js'
import { makeUser, MemoryMailer, testConfig } from './helpers.js'

// #1284 (b): the job-end sync forces `pr_ready`/`open` whenever the job reports
// a pull request, even when the maintainer already merged or closed the item.
// One issue keeps one pull request, so a later job legitimately reports the URL
// of a pull request whose item is terminal — that report must link, not reopen.
const SIGNING_KEY = 'work-item-job-end-signing-key-1284'
const PR_URL = 'https://github.com/o/r/pull/9'

function setup() {
  const config = testConfig()
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  const user = makeUser(store, { login: 'job-end-user' })
  const repo = store.createRepo({
    id: 'repo_job_end',
    userId: user.id,
    owner: 'o',
    name: 'r',
    defaultBranch: 'main',
    tokenEnc: encryptSecret('token', config.tokenEncryptionKey),
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  return { store, jobs, user, repo }
}

async function finish(store: Store, jobs: Jobs, userId: string, repoId: string, jobId: string, itemId: string): Promise<void> {
  store.createJob({
    id: jobId,
    repoId,
    userId,
    trigger: 'manual',
    goal: 'keep the terminal state',
    callbackHash: sha256Hex(SIGNING_KEY),
    platformTokenHash: '',
    kind: 'iterate',
    workItemId: itemId,
  })
  store.updateJob(jobId, { status: 'running', started_at: new Date().toISOString() })
  await jobs.handleCallback(jobId, SIGNING_KEY, { status: 'succeeded', prUrl: PR_URL, summary: 'done' })
}

test('a job reporting a merged pull request URL leaves the work item merged', async () => {
  const { store, jobs, user, repo } = setup()
  try {
    const mergedAt = '2026-11-01T00:00:00.000Z'
    store.createWorkItem({
      id: 'work_merged',
      repoId: repo.id,
      userId: user.id,
      title: 'Merged item',
      prUrl: PR_URL,
      state: 'merged',
      prState: 'merged',
      mergedAt,
    })
    await finish(store, jobs, user.id, repo.id, 'job_merged', 'work_merged')
    const merged = store.getWorkItem('work_merged')
    assert.equal(merged?.state, 'merged', 'a job result does not reopen a merged item')
    assert.equal(merged?.pr_state, 'merged', 'the pull-request state stays merged')
    assert.equal(merged?.merged_at, mergedAt, 'the merge date is not rewritten')
    assert.equal(merged?.job_id, 'job_merged', 'the job is still linked')

    // The companion guard: an in-progress item still moves to PR ready and is
    // linked, so the fix cannot pass by refusing the pull request outright.
    store.createWorkItem({
      id: 'work_active',
      repoId: repo.id,
      userId: user.id,
      title: 'Active item',
      state: 'in_progress',
    })
    await finish(store, jobs, user.id, repo.id, 'job_active', 'work_active')
    const active = store.getWorkItem('work_active')
    assert.equal(active?.state, 'pr_ready', 'a running item still moves to PR ready')
    assert.equal(active?.pr_state, 'open')
    assert.equal(active?.pr_url, PR_URL)
    assert.equal(active?.job_id, 'job_active')
  } finally {
    store.close()
  }
})
