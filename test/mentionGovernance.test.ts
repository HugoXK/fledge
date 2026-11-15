import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import type { Runner } from '../src/jobs/runner.js'
import { decideMention, mentionIdentity, mentionJobKind, type MentionTarget } from '../src/lib/mentionGovernance.js'
import { MemoryMailer, makeUser, testConfig } from './helpers.js'

// #637: the mention rule is a pure decision, so every branch of it is proven
// here without a webhook, and the three cases that decide the card are proven
// against the service below: a pull-request mention reviews, an issue mention
// follows up, and a second mention at the same head starts nothing.
const PR_URL = 'https://github.com/HugoXK/mention-demo/pull/9'
const ISSUE_URL = 'https://github.com/HugoXK/mention-demo/issues/12'
const HEAD = 'aaaabbbbccccddddeeeeffff0000111122223333'

const pull: MentionTarget = {
  kind: 'pull_request',
  number: 9,
  url: PR_URL,
  headSha: HEAD,
  state: 'open',
  draft: false,
  branch: 'dev/mention',
  baseBranch: 'main',
}

const issue: MentionTarget = {
  kind: 'issue',
  number: 12,
  url: ISSUE_URL,
  headSha: '',
  state: 'open',
  draft: false,
}

test('#637 identity is the target kind, number and head sha together', () => {
  assert.equal(mentionIdentity(pull), `pull_request:9:${HEAD}`)
  assert.equal(mentionIdentity(issue), 'issue:12:')
  // The same head on another number is another identity, and so is a new head.
  assert.notEqual(mentionIdentity(pull), mentionIdentity({ ...pull, number: 10 }))
  assert.notEqual(mentionIdentity(pull), mentionIdentity({ ...pull, headSha: 'ffff' }))
})

test('#637 the job kind follows the mention target', () => {
  assert.equal(mentionJobKind(pull), 'review')
  assert.equal(mentionJobKind(issue), 'iterate')
})

test('#637 a mention starts, records, supersedes or parks by what already holds the slot', () => {
  assert.deepEqual(decideMention(pull, undefined), { action: 'start' })
  // The same identity while the job is queued or running is one mention, twice.
  assert.deepEqual(decideMention(pull, { id: 'job_q', status: 'queued', mention: mentionIdentity(pull) }), { action: 'record', jobId: 'job_q' })
  assert.deepEqual(decideMention(pull, { id: 'job_r', status: 'running', mention: mentionIdentity(pull) }), { action: 'record', jobId: 'job_r' })
  // Another identity: a queued job has not run, so a newer mention takes the slot.
  assert.deepEqual(decideMention(pull, { id: 'job_q', status: 'queued', mention: 'issue:1:' }), { action: 'supersede', jobId: 'job_q' })
  // A running job is never interrupted; the mention waits, and the newest one runs.
  assert.deepEqual(decideMention(pull, { id: 'job_r', status: 'running', mention: 'issue:1:' }), { action: 'park', jobId: 'job_r' })
})

test('#637 a closed target or a draft pull request starts nothing', () => {
  assert.deepEqual(decideMention({ ...pull, draft: true }, undefined), { action: 'refuse', reason: 'draft' })
  assert.deepEqual(decideMention({ ...pull, state: 'closed' }, undefined), { action: 'refuse', reason: 'closed' })
  assert.deepEqual(decideMention({ ...issue, state: 'closed' }, undefined), { action: 'refuse', reason: 'closed' })
})

interface Harness {
  jobs: Jobs
  store: Store
  repoId: string
  close: () => void
}

function harness(): Harness {
  const config = testConfig()
  const store = new Store(':memory:')
  const runner: Runner = { name: 'capture', async run() { return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  const user = makeUser(store, { login: 'mention-user', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_mention_governance',
    userId: user.id,
    owner: 'HugoXK',
    name: 'mention-demo',
    defaultBranch: 'main',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
    canReview: true,
    reviewerEnabled: true,
  })
  // A review job has to pass the role-age gate, which a console refresh would do.
  store.updateRepo(repo.id, { role_checked_at: new Date().toISOString() })
  return { jobs, store, repoId: repo.id, close: () => store.close() }
}

test('#637 a pull-request mention starts a review of that pull request', async () => {
  const h = harness()
  try {
    const repo = h.store.getRepo(h.repoId)!
    const result = await h.jobs.mention(repo, { target: pull, commentId: '900', actor: 'hugo' })
    assert.equal(result.ok, true)
    assert.equal(result.ok ? result.action : '', 'start')
    const job = result.ok && result.action === 'start' ? h.store.getJob(result.jobId) : undefined
    assert.equal(job?.kind, 'review', 'a mention on a pull request reviews, it does not iterate')
    assert.equal(job?.pr_url, PR_URL)
    assert.equal(job?.branch, 'dev/mention')
    assert.ok(job?.status === 'queued' || job?.status === 'running', 'the mention started the only job the repository may hold')
  } finally {
    h.close()
  }
})

test('#637 a mention on an issue starts a follow-up for that issue', async () => {
  const h = harness()
  try {
    const repo = h.store.getRepo(h.repoId)!
    const result = await h.jobs.mention(repo, { target: issue, commentId: '901', actor: 'hugo' })
    assert.equal(result.ok, true)
    assert.equal(result.ok ? result.action : '', 'start')
    const job = result.ok && result.action === 'start' ? h.store.getJob(result.jobId) : undefined
    assert.equal(job?.kind, 'iterate', 'a mention on an issue is work on the issue')
    assert.equal(job?.issue_url, ISSUE_URL)
    assert.equal(job?.pr_url, null, 'it starts no pull request by itself')
  } finally {
    h.close()
  }
})

test('#637 a second mention at the same head starts no second job', async () => {
  const h = harness()
  try {
    const repo = h.store.getRepo(h.repoId)!
    const first = await h.jobs.mention(repo, { target: pull, commentId: '902', actor: 'hugo' })
    assert.equal(first.ok && first.action, 'start')
    const second = await h.jobs.mention(h.store.getRepo(h.repoId)!, { target: pull, commentId: '903', actor: 'hugo' })
    assert.equal(second.ok, true)
    assert.equal(second.ok ? second.action : '', 'record')
    assert.equal(h.store.listJobsForRepo(h.repoId, 10).length, 1, 'the second mention must not create a job')
    const firstJobId = first.ok && first.action === 'start' ? first.jobId : ''
    assert.equal(h.store.listJobEvents(firstJobId).some((event) => event.kind === 'job.mention_recorded'), true, 'the mention is recorded on the job that holds it')
    // A queued job has not run: hold it in that state, then a new head is a new
    // identity and takes the slot instead of being recorded on it.
    h.store.updateJob(firstJobId, { status: 'queued' })
    const newer = await h.jobs.mention(h.store.getRepo(h.repoId)!, { target: { ...pull, headSha: 'ffff' }, commentId: '904', actor: 'hugo' })
    assert.equal(newer.ok, true)
    assert.equal(newer.ok ? newer.action : '', 'supersede', 'a queued job has not run, so the newer mention takes the slot')
    assert.equal(h.store.getJob(firstJobId)?.status, 'superseded')
    assert.equal(h.store.listAudit(50).filter((row) => row.action === 'trigger.mention_superseded').length, 1, 'one supersede, one audit row')
  } finally {
    h.close()
  }
})

test('#637 a mention that arrives while a job runs waits for it instead of interrupting it', async () => {
  const h = harness()
  try {
    const repo = h.store.getRepo(h.repoId)!
    const first = await h.jobs.mention(repo, { target: pull, commentId: '905', actor: 'hugo' })
    assert.equal(first.ok && first.action, 'start')
    const firstJobId = first.ok && first.action === 'start' ? first.jobId : ''
    h.store.updateJob(firstJobId, { status: 'running', started_at: new Date().toISOString() })
    const second = await h.jobs.mention(h.store.getRepo(h.repoId)!, { target: { ...issue, number: 13, url: 'https://github.com/HugoXK/mention-demo/issues/13' }, commentId: '906', actor: 'hugo' })
    assert.equal(second.ok, true)
    assert.equal(second.ok ? second.action : '', 'park')
    assert.equal(h.store.getJob(firstJobId)?.status, 'running', 'a running job is never interrupted')
    assert.equal(h.store.listJobsForRepo(h.repoId, 10).length, 1, 'nothing starts while the job runs')
    // The running job ends, and the newest mention is what runs next.
    h.store.updateJob(firstJobId, { status: 'succeeded', finished_at: new Date().toISOString() })
    await h.jobs.releaseAllPendingMentions()
    const jobs = h.store.listJobsForRepo(h.repoId, 10)
    assert.equal(jobs.length, 2, 'the parked mention starts when the slot frees')
    const started = jobs.find((job) => job.id !== firstJobId)
    assert.equal(started?.kind, 'iterate')
    assert.equal(started?.issue_url, 'https://github.com/HugoXK/mention-demo/issues/13')
  } finally {
    h.close()
  }
})
