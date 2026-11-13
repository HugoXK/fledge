import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import type { RepoRow, UserRow } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import type { Runner } from '../src/jobs/runner.js'
import { sha256Hex } from '../src/lib/secrets.js'
import { jobPage, repoPage } from '../src/views/pages.js'
import { makeUser, MemoryMailer, testConfig } from './helpers.js'

function setup(login: string): { store: Store; jobs: Jobs; user: UserRow; repo: RepoRow } {
  const config = testConfig()
  const store = new Store(':memory:')
  const runner: Runner = { name: 'noop', async run() { return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  const user = makeUser(store, { login, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_${login}`,
    userId: user.id,
    owner: 'acme',
    name: login,
    defaultBranch: 'main',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  return { store, jobs, user, repo }
}

async function failJob(
  store: Store,
  jobs: Jobs,
  repo: RepoRow,
  user: UserRow,
  id: string,
  error: string,
  errorCode?: string,
): Promise<void> {
  const secret = `secret-${id}`
  store.createJob({ id, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(secret), platformTokenHash: '' })
  store.updateJob(id, { status: 'running', started_at: new Date().toISOString(), ...(errorCode === undefined ? {} : { error_code: errorCode }) })
  const result = await jobs.handleCallback(id, secret, { status: 'failed', error })
  assert.equal(result.ok, true)
}

test('a failed job creates exactly one postmortem and a replayed callback does not duplicate it', async () => {
  const { store, jobs, user, repo } = setup('pm-one')
  try {
    await failJob(store, jobs, repo, user, 'job_pm_one', 'FlyBot bridge unreachable: connection refused')

    const postmortems = store.listPostmortemsForRepo(repo.id)
    assert.equal(postmortems.length, 1)
    assert.equal(postmortems[0]?.job_id, 'job_pm_one')
    assert.equal(postmortems[0]?.status, 'open')
    assert.equal(postmortems[0]?.category, 'bridge')
    assert.match(postmortems[0]?.suspected_cause ?? '', /bridge unreachable/)
    assert.equal(postmortems[0]?.evidence_state, 'verified')

    const secret = 'secret-job_pm_one'
    const replay = await jobs.handleCallback('job_pm_one', secret, { status: 'failed', error: 'FlyBot bridge unreachable: connection refused' })
    assert.equal(replay.ok, true)
    assert.equal(store.listPostmortemsForRepo(repo.id).length, 1)
    assert.equal(store.listPostmortemRecurrences(repo.id).length, 1)
    assert.equal(store.listPostmortemRecurrences(repo.id)[0]?.count, 1)
  } finally {
    store.close()
  }
})

test('a second job with the same recurrence key increments the ledger without a duplicate row', async () => {
  const { store, jobs, user, repo } = setup('pm-repeat')
  try {
    await failJob(store, jobs, repo, user, 'job_pm_repeat_1', '任务超时未回报')
    await failJob(store, jobs, repo, user, 'job_pm_repeat_2', '任务超时未回报')

    const recurrences = store.listPostmortemRecurrences(repo.id)
    assert.equal(recurrences.length, 1)
    assert.equal(recurrences[0]?.count, 2)
    assert.notEqual(recurrences[0]?.first_seen_at, null)
    assert.notEqual(recurrences[0]?.last_seen_at, null)
    assert.deepEqual(JSON.parse(recurrences[0]?.repositories_json ?? '[]'), [repo.id])
    assert.equal(store.listPostmortemsForRepo(repo.id).length, 2)
    assert.equal(store.getPostmortemForJob('job_pm_repeat_1')?.recurrence_key, store.getPostmortemForJob('job_pm_repeat_2')?.recurrence_key)
  } finally {
    store.close()
  }
})

test('a postmortem closes only after a linked preventive action is verified', async () => {
  const { store, jobs, user, repo } = setup('pm-close')
  try {
    await failJob(store, jobs, repo, user, 'job_pm_close', 'GitHub token 权限不足')
    const postmortem = store.listPostmortemsForRepo(repo.id)[0]
    assert.ok(postmortem !== undefined)

    const premature = store.verifyPreventiveAction(postmortem.id)
    assert.equal(premature.ok, false)
    assert.equal(store.getPostmortem(postmortem.id)?.status, 'open')

    const linked = store.linkPreventiveAction(postmortem.id, { kind: 'test', reference: 'https://github.com/acme/pm-close/pull/9' })
    assert.equal(linked?.status, 'open')
    assert.equal(linked?.preventive_verified, 0)

    const closed = store.verifyPreventiveAction(postmortem.id)
    assert.equal(closed.ok, true)
    const stored = store.getPostmortem(postmortem.id)
    assert.equal(stored?.status, 'closed')
    assert.equal(stored?.preventive_kind, 'test')
    assert.equal(stored?.preventive_action, 'https://github.com/acme/pm-close/pull/9')
    assert.equal(stored?.preventive_verified, 1)
    assert.notEqual(stored?.closed_at, null)
    assert.equal(store.listPostmortemsForRepo(repo.id, { openOnly: true }).length, 0)
  } finally {
    store.close()
  }
})

test('a cancelled job also gets exactly one postmortem', async () => {
  const { store, jobs, user, repo } = setup('pm-cancelled')
  try {
    store.createJob({ id: 'job_pm_cancelled', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'hash', platformTokenHash: '' })
    const cancelled = await jobs.cancelJob('job_pm_cancelled', '用户取消任务')
    assert.equal(cancelled.ok, true)
    const postmortems = store.listPostmortemsForRepo(repo.id)
    assert.equal(postmortems.length, 1)
    assert.equal(postmortems[0]?.category, 'cancelled')
    assert.equal(postmortems[0]?.evidence_state, 'verified')
  } finally {
    store.close()
  }
})

test('a succeeded job creates no postmortem', async () => {
  const { store, jobs, user, repo } = setup('pm-success')
  try {
    const secret = 'secret-pm-success'
    store.createJob({ id: 'job_pm_success', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(secret), platformTokenHash: '' })
    store.updateJob('job_pm_success', { status: 'running', started_at: new Date().toISOString() })
    const result = await jobs.handleCallback('job_pm_success', secret, { status: 'succeeded', summary: 'done' })
    assert.equal(result.ok, true)
    assert.equal(store.getPostmortemForJob('job_pm_success'), undefined)
    assert.equal(store.listPostmortemsForRepo(repo.id).length, 0)
  } finally {
    store.close()
  }
})

test('a postmortem without evidence is unverified instead of guessing a cause', () => {
  const { store, user, repo } = setup('pm-unverified')
  try {
    store.createJob({ id: 'job_pm_unverified', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'hash', platformTokenHash: '' })
    store.updateJob('job_pm_unverified', { status: 'failed', finished_at: new Date().toISOString() })
    const record = store.createPostmortemForJob('job_pm_unverified')
    assert.ok(record !== undefined)
    assert.equal(record.postmortem.evidence_state, 'unverified')
    assert.equal(record.postmortem.suspected_cause, null)
  } finally {
    store.close()
  }
})

test('a repeated cause is escalated once, not once per job', async () => {
  const { store, jobs, user, repo } = setup('pm-escalate')
  try {
    await failJob(store, jobs, repo, user, 'job_pm_escalate_1', '模型供应商限流')
    const first = store.listPostmortemRecurrences(repo.id)[0]
    assert.equal(first?.escalated_at, null)
    assert.equal(store.listNotifications(user.id, 50).filter((entry) => entry.kind === 'ops').length, 0)

    await failJob(store, jobs, repo, user, 'job_pm_escalate_2', '模型供应商限流')
    const second = store.listPostmortemRecurrences(repo.id)[0]
    assert.notEqual(second?.escalated_at, null)
    const escalations = store.listNotifications(user.id, 50).filter((entry) => entry.kind === 'ops' && /复发|recurring/i.test(entry.message))
    assert.equal(escalations.length, 1)

    await failJob(store, jobs, repo, user, 'job_pm_escalate_3', '模型供应商限流')
    assert.equal(store.listPostmortemRecurrences(repo.id)[0]?.count, 3)
    assert.equal(store.listNotifications(user.id, 50).filter((entry) => entry.kind === 'ops' && /复发|recurring/i.test(entry.message)).length, 1)
  } finally {
    store.close()
  }
})

test('the repository page shows open postmortems and recurrence, and the job page links one postmortem', async () => {
  const { store, jobs, user, repo } = setup('pm-render')
  const config = testConfig()
  try {
    await failJob(store, jobs, repo, user, 'job_pm_render_1', '任务超时未回报')
    await failJob(store, jobs, repo, user, 'job_pm_render_2', '任务超时未回报')
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }

    const repository = repoPage({
      config,
      locale: 'en',
      viewer,
      repo,
      jobs: store.listJobsForRepo(repo.id),
      postmortems: store.listPostmortemsForRepo(repo.id, { openOnly: true }),
      recurrences: store.listPostmortemRecurrences(repo.id),
    })
    assert.match(repository, /id="postmortems"/)
    assert.match(repository, /job_pm_render_1/)
    assert.match(repository, /Seen 2/)
    assert.doesNotMatch(repository, /undefined/)

    const job = store.getJob('job_pm_render_1')!
    const detail = jobPage({
      config,
      locale: 'en',
      viewer,
      repo,
      job,
      events: store.listJobEvents(job.id, 200),
      postmortem: store.getPostmortemForJob(job.id),
    })
    assert.match(detail, /id="postmortem"/)
    assert.match(detail, /Open postmortem/)
    assert.match(detail, /#postmortems/)
    assert.equal((detail.match(/id="postmortem"/g) ?? []).length, 1)
  } finally {
    store.close()
  }
})
