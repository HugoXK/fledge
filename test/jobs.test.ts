import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { InstanceManager } from '../src/flybot/instances.js'
import { PLAYBOOK_VERSION, playbookFingerprint } from '../src/flybot/playbook.js'
import { Jobs } from '../src/jobs/service.js'
import type { Runner, RunnerContext } from '../src/jobs/runner.js'
import { encryptSecret, sha256Hex } from '../src/lib/secrets.js'
import { json, makeUser, MemoryMailer, readBody, startFakeServer, testConfig } from './helpers.js'

test('iterate dispatches to the Chief and review to the Reviewer', async () => {
  const config = testConfig({ flybot: { ...testConfig().flybot, instanceImage: 'image' } })
  const store = new Store(':memory:')
  const contexts: RunnerContext[] = []
  const runner: Runner = {
    name: 'capture',
    async run(context) {
      contexts.push(context)
      return { status: 'running' }
    },
  }
  const manager = new InstanceManager(store, config)
  const jobs = new Jobs(store, config, runner, new MemoryMailer(), manager)
  try {
    const user = makeUser(store, { login: 'dispatch-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_dispatch', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: 'x', goal: '', autoIterate: false, intervalMinutes: 1440, canReview: true, reviewerEnabled: true })
    store.saveRepoInstance({
      repo_id: repo.id, user_id: user.id, container: 'c', network: 'n', data_dir: '/tmp/dispatch', bridge_script: '/tmp/bridge',
      dsh_port: 1, bridge_port: 2, model_port: 3, model_bind: '127.0.0.1', image: 'image',
      status: 'ready', chief_session: 'chief-1',
      team_json: JSON.stringify({ chief: 'chief-1', lead: 'lead-1', product: 'p', test: 't', security: 's', reviewer: 'reviewer-1', dev1: 'd1', dev2: 'd2', reviewerScope: 'upstream', team: 'Repo', playbook: PLAYBOOK_VERSION, playbookHash: playbookFingerprint('') }),
      bridge_token_enc: encryptSecret('bridge-token', config.tokenEncryptionKey), bridge_pid: null, log_pid: null,
      last_error: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_health_at: null,
    })

    const iterate = await jobs.enqueue(repo, 'manual')
    assert.equal(iterate.ok, true)
    assert.equal(contexts[0]?.flybot?.role, 'chief')
    assert.equal(contexts[0]?.flybot?.sessionId, 'chief-1')
    assert.equal(contexts[0]?.flybot?.leadName, 'Repo Lead')

    store.updateJob(iterate.job!.id, { status: 'succeeded', finished_at: new Date().toISOString() })
    const review = await jobs.enqueue(repo, 'manual', undefined, 'review')
    assert.equal(review.ok, true)
    assert.equal(contexts[1]?.flybot?.role, 'reviewer')
    assert.equal(contexts[1]?.flybot?.sessionId, 'reviewer-1')
  } finally {
    store.close()
  }
})


test('jobs use the repository target branch and reject invalid branch names', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const contexts: RunnerContext[] = []
  const runner: Runner = { name: 'capture', async run(context) { contexts.push(context); return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'branch-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_branch', userId: user.id, owner: 'o', name: 'branch', defaultBranch: 'main', targetBranch: 'develop', tokenEnc: 'x', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const result = await jobs.enqueue(repo, 'manual')
    assert.equal(result.ok, true)
    assert.equal(result.job?.base_branch, 'develop')
    assert.equal(contexts[0]?.upstream.defaultBranch, 'develop')
    store.updateJob(result.job!.id, { status: 'succeeded', finished_at: new Date().toISOString() })
    const invalid = store.createRepo({ id: 'repo_branch_invalid', userId: user.id, owner: 'o', name: 'branch-invalid', defaultBranch: 'main', targetBranch: 'bad..branch', tokenEnc: 'x', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const rejected = await jobs.enqueue(invalid, 'manual')
    assert.equal(rejected.ok, false)
    assert.equal(rejected.code, 'BRANCH_INVALID')
  } finally {
    store.close()
  }
})


test('research jobs only read and report', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const contexts: RunnerContext[] = []
  const runner: Runner = { name: 'capture', async run(context) { contexts.push(context); return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'research-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_research', userId: user.id, owner: 'o', name: 'research', defaultBranch: 'main', tokenEnc: 'x', goal: 'Analyze the product direction.', autoIterate: false, intervalMinutes: 1440, jobMode: 'research' })
    const result = await jobs.enqueue(repo, 'manual', undefined, 'research')
    assert.equal(result.ok, true)
    assert.equal(result.job?.kind, 'research')
    assert.equal(contexts[0]?.kind, 'research')
    assert.equal(store.getRepo(repo.id)?.job_mode, 'research')
  } finally {
    store.close()
  }
})

test('a PR follow-up waits for the active review job and then queues', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const contexts: RunnerContext[] = []
  const runner: Runner = { name: 'capture', async run(context) { contexts.push(context); return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'review-followup-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_review_followup', userId: user.id, owner: 'o', name: 'rf', defaultBranch: 'main', tokenEnc: 'x', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const secret = 'review-secret'
    store.createJob({ id: 'job_review_pending', repoId: repo.id, userId: user.id, trigger: 'schedule', goal: 'review', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'review' })
    store.updateJob('job_review_pending', { status: 'running', started_at: new Date().toISOString() })
    const waiting = await jobs.followUp(repo, { prUrl: 'https://github.com/o/rf/pull/7', branch: 'fledge/fix', baseBranch: 'main', reason: 'review requested changes', headSha: 'abc' })
    assert.equal(waiting.ok, false)
    assert.equal(waiting.code, 'JOB_ACTIVE')
    assert.equal(store.listSettings('pending_followup:').length, 1)
    const finished = await jobs.handleCallback('job_review_pending', secret, { status: 'succeeded', summary: 'review complete', reviewScore: 42 })
    assert.equal(finished.ok, true)
    for (let i = 0; i < 20; i += 1) {
      if (store.listJobsForRepo(repo.id).some((job) => job.trigger === 'followup')) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const followup = store.listJobsForRepo(repo.id).find((job) => job.trigger === 'followup')
    assert.ok(followup)
    assert.equal(followup?.pr_url, 'https://github.com/o/rf/pull/7')
    assert.equal(followup?.branch, 'fledge/fix')
    assert.equal(store.listSettings('pending_followup:').length, 0)
  } finally {
    store.close()
  }
})


test('a review callback queues a same-branch fix for each Fledge PR that needs changes', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const runner: Runner = { name: 'capture', async run() { return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'review-callback-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_review_callback', userId: user.id, owner: 'o', name: 'rc', defaultBranch: 'main', tokenEnc: 'x', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const secret = 'review-callback-secret'
    store.createJob({ id: 'job_review_callback', repoId: repo.id, userId: user.id, trigger: 'schedule', goal: 'review', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'review' })
    store.updateJob('job_review_callback', { status: 'running', started_at: new Date().toISOString() })
    const result = await jobs.handleCallback('job_review_callback', secret, {
      status: 'succeeded',
      summary: 'One PR needs changes',
      reviewScore: 55,
      followUps: [{ prUrl: 'https://github.com/o/rc/pull/9', branch: 'fledge/review-fix', headSha: 'sha9', baseBranch: 'main', reason: 'review requested changes' }],
    })
    assert.equal(result.ok, true)
    const followup = store.listJobsForRepo(repo.id).find((job) => job.trigger === 'followup')
    assert.ok(followup)
    assert.equal(followup?.pr_url, 'https://github.com/o/rc/pull/9')
    assert.equal(followup?.branch, 'fledge/review-fix')
    assert.equal(followup?.base_branch, 'main')
  } finally {
    store.close()
  }
})


test('scheduled jobs follow the repository automatic job mode', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const contexts: RunnerContext[] = []
  const runner: Runner = { name: 'capture', async run(context) { contexts.push(context); return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'mode-user', status: 'approved' })
    store.createRepo({ id: 'repo_mode', userId: user.id, owner: 'o', name: 'mode', defaultBranch: 'main', tokenEnc: 'x', goal: 'Analyze direction.', autoIterate: true, intervalMinutes: 1440, jobMode: 'research' })
    await jobs.tick()
    assert.equal(contexts[0]?.kind, 'research')
  } finally {
    store.close()
  }
})

test('a running callback unwraps a nested progress summary', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'summary-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_summary', userId: user.id, owner: 'o', name: 's', defaultBranch: 'main', tokenEnc: 'x', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const secret = 'callback-secret'
    store.createJob({ id: 'job_summary', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(secret), platformTokenHash: '' })
    store.updateJob('job_summary', { status: 'running' })
    const nested = JSON.stringify({ status: 'running', summary: 'Round 4: one focused fix is in progress' })
    const result = await jobs.handleCallback('job_summary', secret, { status: 'running', summary: nested, checkpoint: 'done A; next B' })
    assert.equal(result.ok, true)
    assert.equal(store.getJob('job_summary')?.summary, 'Round 4: one focused fix is in progress')
    assert.equal(store.getJob('job_summary')?.checkpoint, 'done A; next B')
    assert.notEqual(store.getJob('job_summary')?.started_at, null)
  } finally {
    store.close()
  }
})

test('a final callback keeps earlier branch, PR links and progress when it omits them', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'merge-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_merge', userId: user.id, owner: 'o', name: 'm', defaultBranch: 'main', tokenEnc: 'x', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const secret = 'callback-secret'
    store.createJob({ id: 'job_merge', repoId: repo.id, userId: user.id, trigger: 'followup', goal: 'g', callbackHash: sha256Hex(secret), platformTokenHash: '' })
    store.updateJob('job_merge', {
      status: 'running',
      branch: 'fledge/existing',
      pr_url: 'https://github.com/o/m/pull/7',
      issue_url: 'https://github.com/o/m/issues/3',
      review_score: 88,
      summary: 'progress: one test is red',
    })
    const result = await jobs.handleCallback('job_merge', secret, { status: 'succeeded' })
    assert.equal(result.ok, true)
    const job = store.getJob('job_merge')
    assert.equal(job?.branch, 'fledge/existing')
    assert.equal(job?.pr_url, 'https://github.com/o/m/pull/7')
    assert.equal(job?.issue_url, 'https://github.com/o/m/issues/3')
    assert.equal(job?.review_score, 88)
    assert.equal(job?.summary, 'progress: one test is red')
  } finally {
    store.close()
  }
})

test('follow-up retries are not blocked forever after a failed enqueue', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'capture', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'followup-retry-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_followup_retry', userId: user.id, owner: 'o', name: 'fr', defaultBranch: 'main', tokenEnc: 'x', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.updateRepo(repo.id, { enabled: 0 })
    const first = await jobs.followUp(store.getRepo(repo.id)!, { prUrl: 'https://github.com/o/fr/pull/9', branch: 'fledge/fix', reason: 'check failed', headSha: 'sha1' })
    assert.equal(first.ok, false)
    assert.equal(first.code, 'REPO_DISABLED')
    store.updateRepo(repo.id, { enabled: 1 })
    const second = await jobs.followUp(store.getRepo(repo.id)!, { prUrl: 'https://github.com/o/fr/pull/9', branch: 'fledge/fix', reason: 'check failed', headSha: 'sha1' })
    assert.equal(second.ok, true)
  } finally {
    store.close()
  }
})

test('manual enqueue respects the global two-job limit', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'capture', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'limit-user', status: 'approved' })
    for (const id of ['repo_limit_1', 'repo_limit_2', 'repo_limit_3']) {
      store.createRepo({ id, userId: user.id, owner: 'o', name: id, defaultBranch: 'main', tokenEnc: 'x', goal: '', autoIterate: false, intervalMinutes: 1440 })
    }
    store.createJob({ id: 'job_limit_1', repoId: 'repo_limit_1', userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'h1', platformTokenHash: '' })
    store.createJob({ id: 'job_limit_2', repoId: 'repo_limit_2', userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'h2', platformTokenHash: '' })
    store.updateJob('job_limit_1', { status: 'running' })
    store.updateJob('job_limit_2', { status: 'running' })
    const result = await jobs.enqueue(store.getRepo('repo_limit_3')!, 'manual')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'JOB_LIMIT')
  } finally {
    store.close()
  }
})

test('daily digests still send while two jobs are active', async () => {
  const config = testConfig({ digest: { hour: 0, timeZone: 'UTC' } })
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  const jobs = new Jobs(store, config, { name: 'capture', async run() { return { status: 'running' } } }, mailer)
  try {
    const user = makeUser(store, { login: 'digest-busy-user', status: 'approved' })
    store.setEmailDailyDigest(user.id, true)
    store.createRepo({ id: 'repo_digest_busy', userId: user.id, owner: 'o', name: 'dbusy', defaultBranch: 'main', tokenEnc: 'x', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.createJob({ id: 'job_busy_1', repoId: 'repo_digest_busy', userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'h1', platformTokenHash: '' })
    store.createJob({ id: 'job_busy_2', repoId: 'repo_digest_busy', userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'h2', platformTokenHash: '' })
    store.updateJob('job_busy_1', { status: 'running' })
    store.updateJob('job_busy_2', { status: 'running' })
    await jobs.tick()
    assert.equal(mailer.messages.filter((message) => /今日摘要/.test(message.subject)).length, 1)
  } finally {
    store.close()
  }
})

test('a successful callback stores attribution and posts a PR automation comment', async () => {
  const comments: Array<{ path: string; body: string }> = []
  const github = await startFakeServer(async (request, response) => {
    const body = (await readBody(request)).toString('utf8')
    comments.push({ path: request.url ?? '', body })
    json(response, 201, { id: 1 })
  })
  const config = testConfig({ github: { ...testConfig().github, apiBase: github.url } })
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, mailer)
  try {
    const user = makeUser(store, { login: 'attribution-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_attr', userId: user.id, owner: 'owner', name: 'repo', defaultBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), goal: '', autoIterate: false, intervalMinutes: 1440 })
    const secret = 'callback-secret'
    store.createJob({ id: 'job_attr', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(secret), platformTokenHash: '' })
    store.updateJob('job_attr', { status: 'running' })
    const result = await jobs.handleCallback('job_attr', secret, {
      status: 'succeeded',
      prUrl: 'https://github.com/owner/repo/pull/42',
      issueUrl: 'https://github.com/owner/repo/issues/41',
      summary: 'done',
      attribution: { writtenBy: 'Dev-1', claimedBy: 'Lead', implementedBy: 'Dev-1', testedBy: 'Test', reviewedBy: 'Reviewer' },
      evidence: { tests: 'unit: 10 pass', checks: 'CI green', files: 2, risk: 'low', rollback: 'revert' },
    })
    assert.equal(result.ok, true)
    const saved = store.getJob('job_attr')
    assert.deepEqual(JSON.parse(saved?.attribution_json ?? '{}'), { writtenBy: 'Dev-1', claimedBy: 'Lead', implementedBy: 'Dev-1', testedBy: 'Test', reviewedBy: 'Reviewer' })
    assert.deepEqual(JSON.parse(saved?.evidence_json ?? '{}'), { tests: 'unit: 10 pass', checks: 'CI green', files: 2, risk: 'low', rollback: 'revert' })
    for (let i = 0; i < 20 && comments.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(comments.length, 1)
    const comment = comments[0]!
    assert.match(comment.path, /\/repos\/owner\/repo\/issues\/42\/comments/)
    const body = JSON.parse(comment.body) as { body: string }
    assert.match(body.body, /Fledge automation/)
    assert.match(body.body, /Lead claimed/)
    assert.match(body.body, /Dev-1 implemented/)
    assert.match(body.body, /Test tested/)
    assert.match(body.body, /Reviewer reviewed/)
    assert.match(body.body, /\/repos\/repo_attr\/jobs\/job_attr/)
    assert.doesNotMatch(body.body, /not recorded|pending/)
    assert.equal(mailer.messages.length, 1)
    const message = mailer.messages[0]!
    assert.match(message.subject, /任务完成/)
    assert.ok(new Set(message.text.split('\n')).has('PR：https://github.com/owner/repo/pull/42'))
    assert.match(message.text, /\/repos\/repo_attr\/jobs\/job_attr/)
  } finally {
    store.close()
    await github.close()
  }
})

test('quotaBlocked fails that user\'s active jobs and revokes their tokens', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const runner: Runner = { name: 'noop', async run() { return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'quota-a', status: 'approved' })
    const other = makeUser(store, { login: 'quota-b', status: 'approved' })
    const repoA = store.createRepo({ id: 'repo_a', userId: user.id, owner: 'o', name: 'a', defaultBranch: 'main', tokenEnc: 'x', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const repoB = store.createRepo({ id: 'repo_b', userId: other.id, owner: 'o', name: 'b', defaultBranch: 'main', tokenEnc: 'x', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const token = store.createApiToken({ id: 'tok_a', userId: user.id, kind: 'job', name: 'job:a', tokenHash: 'hash-a', prefix: 'flg_a', expiresAt: null })
    store.createJob({ id: 'job_a', repoId: repoA.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: token.token_hash })
    store.updateJob('job_a', { status: 'running' })
    store.createJob({ id: 'job_b', repoId: repoB.id, userId: other.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    store.updateJob('job_b', { status: 'running' })

    await jobs.quotaBlocked(user)

    assert.equal(store.getJob('job_a')?.status, 'quota_exhausted')
    assert.match(store.getJob('job_a')?.error ?? '', /额度/)
    assert.equal(store.findApiToken(token.token_hash), undefined)
    assert.equal(store.getRepo(repoA.id)?.last_status, 'quota_exhausted')
    assert.equal(store.getJob('job_b')?.status, 'running')
  } finally {
    store.close()
  }
})

test('a new team question sends one attention email', async () => {
  const bridge = await startFakeServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      const payload = JSON.parse(body || '{}') as { endpoint?: string }
      if (payload.endpoint === 'state') {
        json(response, 200, { value: {
          bots: [{ name: 'Repo Lead', sessionId: 'lead-1', role: 'Lead' }],
          activity: { 'lead-1': 'thinking' },
          work: { bots: { 'lead-1': { calls: 2 } } },
          rooms: {},
          questions: { 'lead-1': { id: 'q1', question: 'Which path?', detail: '', options: ['A', 'B'], multiSelect: false } },
        } })
        return
      }
      json(response, 200, { ok: true })
    })
  })
  const config = testConfig({ flybot: { ...testConfig().flybot, instanceImage: 'image' } })
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  const instances = new InstanceManager(store, config)
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, mailer, instances)
  try {
    const user = makeUser(store, { login: 'question-user', status: 'approved' })
    store.setEmailDailyDigest(user.id, false)
    const repo = store.createRepo({ id: 'repo_question', userId: user.id, owner: 'o', name: 'q', defaultBranch: 'main', tokenEnc: 'x', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.saveRepoInstance({
      repo_id: repo.id, user_id: user.id, container: 'c', network: 'n', data_dir: '/tmp/question', bridge_script: '/tmp/bridge',
      dsh_port: 1, bridge_port: Number(new URL(bridge.url).port), model_port: 2, model_bind: '127.0.0.1', image: 'image',
      status: 'ready', chief_session: 'chief-1',
      team_json: JSON.stringify({ chief: 'chief-1', lead: 'lead-1', product: 'p', test: 't', security: 's', reviewer: 'r', dev1: 'd1', dev2: 'd2', reviewerScope: 'upstream', team: 'Repo' }),
      bridge_token_enc: encryptSecret('bridge-token', config.tokenEncryptionKey), bridge_pid: null, log_pid: null,
      last_error: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_health_at: null,
    })
    store.createJob({ id: 'job_question', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    store.updateJob('job_question', { status: 'running' })
    await jobs.tick()
    assert.equal(mailer.messages.length, 1)
    const message = mailer.messages[0]!
    assert.match(message.subject, /需要你回答/)
    assert.match(message.text, /Which path\?/)
    assert.match(message.text, /#inbox/)
    await jobs.tick()
    assert.equal(mailer.messages.length, 1)
  } finally {
    store.close()
    await bridge.close()
  }
})

test('job email follows the user preference', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, mailer)
  try {
    const user = makeUser(store, { login: 'mail-pref', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_mail', userId: user.id, owner: 'o', name: 'm', defaultBranch: 'main', tokenEnc: 'x', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const secret = 'mail-secret'
    store.createJob({ id: 'job_mail', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(secret), platformTokenHash: '' })
    store.updateJob('job_mail', { status: 'running' })
    store.setEmailJobUpdates(user.id, false)
    await jobs.handleCallback('job_mail', secret, { status: 'succeeded', summary: 'done without PR' })
    assert.equal(mailer.messages.length, 0)

    const second = store.createJob({ id: 'job_mail_2', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(secret), platformTokenHash: '' })
    store.updateJob(second.id, { status: 'running' })
    store.setEmailJobUpdates(user.id, true)
    await jobs.handleCallback('job_mail_2', secret, { status: 'succeeded', summary: 'done again' })
    assert.equal(mailer.messages.length, 1)
  } finally {
    store.close()
  }
})

test('daily digest sends once and includes the day summary', async () => {
  const config = testConfig({ digest: { hour: 0, timeZone: 'UTC' }, inboundEmailSecret: 'secret' })
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, mailer)
  try {
    const user = makeUser(store, { login: 'digest-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_digest', userId: user.id, owner: 'o', name: 'digest', defaultBranch: 'main', tokenEnc: 'x', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.createJob({ id: 'job_digest', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    store.updateJob('job_digest', { status: 'succeeded', summary: 'Fixed a digest bug', pr_url: 'https://github.com/o/digest/pull/1', finished_at: new Date().toISOString() })
    await jobs.tick()
    const digests = mailer.messages.filter((message) => /今日摘要/.test(message.subject))
    assert.equal(digests.length, 1)
    assert.match(digests[0]!.text, /Fixed a digest bug/)
    assert.ok(new Set(digests[0]!.text.split('\n')).has('  PR: https://github.com/o/digest/pull/1'))
    assert.match(digests[0]!.text, /回复这封邮件/)
    assert.match(digests[0]!.replyTo ?? '', /\+[A-Za-z0-9_-]+@/)
    await jobs.tick()
    assert.equal(mailer.messages.filter((message) => /今日摘要/.test(message.subject)).length, 1)
  } finally {
    store.close()
  }
})

test('plan jobs dispatch as plan and keep a checkpoint', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const contexts: RunnerContext[] = []
  const runner: Runner = { name: 'capture', async run(context) { contexts.push(context); return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'plan-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_plan', userId: user.id, owner: 'o', name: 'p', defaultBranch: 'main', tokenEnc: 'x', goal: 'plan goal', autoIterate: false, intervalMinutes: 1440 })
    const result = await jobs.enqueue(repo, 'manual', undefined, 'plan')
    assert.equal(result.ok, true)
    assert.equal(contexts[0]?.kind, 'plan')
    assert.equal(result.job?.kind, 'plan')
  } finally {
    store.close()
  }
})

test('follow-up jobs reuse the branch and PR and are deduplicated', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const contexts: RunnerContext[] = []
  const runner: Runner = { name: 'capture', async run(context) { contexts.push(context); return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'followup-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_followup', userId: user.id, owner: 'o', name: 'f', defaultBranch: 'main', tokenEnc: 'x', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const first = await jobs.followUp(repo, { prUrl: 'https://github.com/o/f/pull/7', branch: 'fledge/fix', reason: 'check failed', headSha: 'abc' })
    assert.equal(first.ok, true)
    assert.equal(first.job?.trigger, 'followup')
    assert.equal(first.job?.branch, 'fledge/fix')
    assert.equal(first.job?.pr_url, 'https://github.com/o/f/pull/7')
    assert.match(first.job?.goal ?? '', /Continue on the same branch/)
    assert.equal(contexts[0]?.job.branch, 'fledge/fix')
    const duplicate = await jobs.followUp(repo, { prUrl: 'https://github.com/o/f/pull/7', branch: 'fledge/fix', reason: 'check failed', headSha: 'abc' })
    assert.equal(duplicate.ok, false)
    assert.equal(duplicate.code, 'DUPLICATE_FOLLOWUP')
  } finally {
    store.close()
  }
})
