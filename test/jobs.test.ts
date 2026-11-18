import test from 'node:test'
import assert from 'node:assert/strict'
import { Store, formatReviewOutcomeDetail, parseReviewOverrideDetail } from '../src/db.js'
import type { JobRow, RepoRow, WorkItemRow } from '../src/db.js'
import { InstanceManager } from '../src/flybot/instances.js'
import { PLAYBOOK_VERSION, playbookFingerprint } from '../src/flybot/playbook.js'
import { Jobs } from '../src/jobs/service.js'
import { buildCarryOver, buildRunDigest, classifyOutput, decideNextJob, failureStreak, isMetaTitle, lastDurationMs } from '../src/jobs/continuity.js'
import type { CarryOverLinkState, CarryOverReader, SchedulerState } from '../src/jobs/continuity.js'
import type { Runner, RunnerContext } from '../src/jobs/runner.js'
import { encryptSecret, sha256Hex } from '../src/lib/secrets.js'
import { metricsSnapshot } from '../src/lib/metrics.js'
import { REVIEW_INSTRUCTION_MAX, REVIEW_INSTRUCTION_LABEL } from '../src/lib/followUpInstruction.js'
import { nextTime } from '../src/schedules/next.js'
import { scheduleFromRow } from '../src/schedules/tick.js'
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
    const repo = store.createRepo({ id: 'repo_dispatch', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440, canReview: true, reviewerEnabled: true })
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
    const repo = store.createRepo({ id: 'repo_branch', userId: user.id, owner: 'o', name: 'branch', defaultBranch: 'main', targetBranch: 'develop', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const result = await jobs.enqueue(repo, 'manual')
    assert.equal(result.ok, true)
    assert.equal(result.job?.base_branch, 'develop')
    assert.equal(contexts[0]?.upstream.defaultBranch, 'develop')
    store.updateJob(result.job!.id, { status: 'succeeded', finished_at: new Date().toISOString() })
    const invalid = store.createRepo({ id: 'repo_branch_invalid', userId: user.id, owner: 'o', name: 'branch-invalid', defaultBranch: 'main', targetBranch: 'bad..branch', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const rejected = await jobs.enqueue(invalid, 'manual')
    assert.equal(rejected.ok, false)
    assert.equal(rejected.code, 'BRANCH_INVALID')
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
    const repo = store.createRepo({ id: 'repo_summary', userId: user.id, owner: 'o', name: 's', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
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
    const repo = store.createRepo({ id: 'repo_merge', userId: user.id, owner: 'o', name: 'm', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
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
    const repo = store.createRepo({ id: 'repo_followup_retry', userId: user.id, owner: 'o', name: 'fr', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
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
      store.createRepo({ id, userId: user.id, owner: 'o', name: id, defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
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
    store.createRepo({ id: 'repo_digest_busy', userId: user.id, owner: 'o', name: 'dbusy', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.createRepo({ id: 'repo_digest_busy_2', userId: user.id, owner: 'o', name: 'dbusy2', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.createJob({ id: 'job_busy_1', repoId: 'repo_digest_busy', userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'h1', platformTokenHash: '' })
    store.createJob({ id: 'job_busy_2', repoId: 'repo_digest_busy_2', userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'h2', platformTokenHash: '' })
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
    const path = request.url ?? ''
    if (path.includes('/comments')) {
      comments.push({ path, body })
      json(response, 201, { id: 1 })
      return
    }
    if (path.includes('/pulls/42/files')) {
      json(response, 200, [{ filename: 'src/x.ts', status: 'modified', additions: 1, deletions: 0 }])
      return
    }
    if (path.includes('/pulls/42/reviews')) {
      json(response, 200, [])
      return
    }
    if (path.includes('/commits/sha1/check-runs')) {
      json(response, 200, { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] })
      return
    }
    if (path.includes('/commits/sha1/status')) {
      json(response, 200, { state: 'success', statuses: [] })
      return
    }
    if (path.includes('/pulls/42')) {
      json(response, 200, { number: 42, html_url: 'https://github.com/owner/repo/pull/42', title: 'Fix', state: 'open', head: { ref: 'fledge/x', sha: 'sha1' }, base: { ref: 'main' }, mergeable: true, mergeable_state: 'clean', draft: false, merged: false })
      return
    }
    json(response, 404, { message: 'not found' })
  })
  const config = testConfig({ github: { ...testConfig().github, apiBase: github.url } })
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, mailer)
  try {
    const user = makeUser(store, { login: 'attribution-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_attr', userId: user.id, owner: 'owner', name: 'repo', defaultBranch: 'main', upstreamHtmlUrl: 'https://github.com/owner/repo', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
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

test('a repository model bypasses the platform quota check in enqueue and dispatch', async () => {
  const base = testConfig()
  const config = testConfig({ runner: { ...base.runner, queueDispatch: true } })
  const store = new Store(':memory:')
  const runner: Runner = { name: 'capture', async run() { return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'repo-model-quota', status: 'approved', quota: 0 })
    const repo = store.createRepo({ id: 'repo_model_quota', userId: user.id, owner: 'o', name: 'model-quota', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'developer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const plain = store.createRepo({ id: 'repo_plain_quota', userId: user.id, owner: 'o', name: 'plain-quota', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'developer', goal: '', autoIterate: false, intervalMinutes: 1440 })

    const provider = store.createModelProvider({ id: 'prv_model_quota', userId: user.id, label: 'Own', baseUrl: 'https://own.example/v1', keyEnc: encryptSecret('own-key', config.tokenEncryptionKey), allowPrivate: false })
    const model = store.createProviderModel({ id: 'pvm_model_quota', providerId: provider.id, model: 'own-model', label: 'Own model' })
    store.setRepoModelSelection(repo.id, [model.id], model.id)

    const queued = await jobs.enqueue(repo, 'manual')
    assert.equal(queued.ok, true, 'a repository selection is an own model')
    await jobs.tick()
    const dispatched = store.getJob(queued.job!.id)
    assert.notEqual(dispatched?.status, 'quota_exhausted', 'dispatch uses the same own-model answer as enqueue')

    const refused = await jobs.enqueue(plain, 'manual')
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'QUOTA_EXHAUSTED', 'a repository without a selection is still platform-funded')
  } finally {
    store.close()
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
    const repoA = store.createRepo({ id: 'repo_a', userId: user.id, owner: 'o', name: 'a', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const repoB = store.createRepo({ id: 'repo_b', userId: other.id, owner: 'o', name: 'b', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
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

test('one exhausted user does not end the scheduled review pass for the repositories behind it', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const runner: Runner = { name: 'capture', async run() { return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    // #960: the refusal is per user, the pass is per instance. A repository whose
    // own user cannot pay must not decide what happens to everybody after it.
    const exhausted = makeUser(store, { login: 'pass-quota-empty', status: 'approved', quota: 0 })
    const healthy = makeUser(store, { login: 'pass-quota-healthy', status: 'approved' })
    const repoA = store.createRepo({ id: 'repo_pass_a', userId: exhausted.id, owner: 'o', name: 'pass-a', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440, canReview: true, reviewerEnabled: true })
    const repoB = store.createRepo({ id: 'repo_pass_b', userId: healthy.id, owner: 'o', name: 'pass-b', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440, canReview: true, reviewerEnabled: true })

    await jobs.tick()

    // The refusal stays on the repository that earned it.
    assert.equal(store.listJobsForRepo(repoA.id, 6)[0]?.status, 'quota_exhausted')
    // ...and it does not end the pass for a repository whose own user can pay.
    const behind = store.listJobsForRepo(repoB.id, 6)[0]
    assert.equal(behind?.kind, 'review', 'a per-user quota refusal must not stop the review scan for everyone behind it')
  } finally {
    store.close()
  }
})

test('one exhausted user does not end the auto pass for the repositories behind it', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const runner: Runner = { name: 'capture', async run() { return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    // #960, the auto pass: same rule, a `discover` refusal instead of a review one.
    const exhausted = makeUser(store, { login: 'auto-pass-empty', status: 'approved', quota: 0 })
    const healthy = makeUser(store, { login: 'auto-pass-healthy', status: 'approved' })
    const repoA = store.createRepo({ id: 'repo_auto_pass_a', userId: exhausted.id, owner: 'o', name: 'auto-a', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: true, intervalMinutes: 1440 })
    const repoB = store.createRepo({ id: 'repo_auto_pass_b', userId: healthy.id, owner: 'o', name: 'auto-b', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: true, intervalMinutes: 1440 })

    await jobs.tick()

    assert.equal(store.listJobsForRepo(repoA.id, 6)[0]?.status, 'quota_exhausted')
    const behind = store.listJobsForRepo(repoB.id, 6)[0]
    assert.notEqual(behind, undefined, 'an automatic pass must reach the repository behind a refused one')
    assert.notEqual(behind?.status, 'quota_exhausted', 'the repository behind pays for nobody else')
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
    const repo = store.createRepo({ id: 'repo_question', userId: user.id, owner: 'o', name: 'q', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
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
    const repo = store.createRepo({ id: 'repo_mail', userId: user.id, owner: 'o', name: 'm', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
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
    const repo = store.createRepo({ id: 'repo_digest', userId: user.id, owner: 'o', name: 'digest', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
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

function digestTime(at: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(at))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

test('the digest prints the planner next run for a scheduled repository', async () => {
  const config = testConfig({ digest: { hour: 0, timeZone: 'Asia/Shanghai' } })
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, mailer)
  try {
    const user = makeUser(store, { login: 'digest-schedule', status: 'approved' })
    const now = Date.now()
    const repo = store.createRepo({ id: 'repo_digest_schedule', userId: user.id, owner: 'o', name: 'schedule', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: true, intervalMinutes: 1440 })
    store.updateRepo(repo.id, { last_run_at: new Date(now - 10 * 60_000).toISOString() })
    const row = store.saveSchedule({ id: 'sch_digest', repoId: repo.id, kind: 'cron', expression: '0 9 * * 1-5', timezone: 'Asia/Shanghai' })
    const schedule = scheduleFromRow(row)
    assert.ok(schedule !== null)
    const expected = digestTime(nextTime(schedule, Date.now())!)
    const intervalAnswer = digestTime(now - 10 * 60_000 + 15 * 60_000)
    assert.notEqual(expected, intervalAnswer, 'the fixture separates the planner answer from the interval answer')

    await jobs.tick()
    const digest = mailer.messages.find((message) => /今日摘要/.test(message.subject))
    assert.ok(digest, 'the digest was sent')
    assert.match(digest.text, new RegExp(`下次自动迭代：o/schedule · ${escapeRegExp(expected)}`))
    assert.doesNotMatch(digest.text, new RegExp(escapeRegExp(intervalAnswer)))
  } finally {
    store.close()
  }
})

test('the digest says a disabled repository will not run when it has no schedule row', async () => {
  const config = testConfig({ digest: { hour: 0, timeZone: 'Asia/Shanghai' } })
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, mailer)
  try {
    const user = makeUser(store, { login: 'digest-disabled', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_digest_disabled', userId: user.id, owner: 'o', name: 'disabled', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: true, intervalMinutes: 1440 })
    store.updateRepo(repo.id, { enabled: 0, last_run_at: new Date(Date.now() - 10 * 60_000).toISOString() })

    await jobs.tick()
    const digest = mailer.messages.find((message) => /今日摘要/.test(message.subject))
    assert.ok(digest, 'the digest was sent')
    assert.match(digest.text, /下次自动迭代：o\/disabled · 仓库已停用，自动运行不会开始/)
    assert.doesNotMatch(digest.text, /下次自动迭代：o\/disabled · \d{2}\/\d{2}/, 'no instant is promised for a disabled repository')
  } finally {
    store.close()
  }
})

test('the digest says a disabled repository will not run even with a schedule row', async () => {
  const config = testConfig({ digest: { hour: 0, timeZone: 'Asia/Shanghai' } })
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, mailer)
  try {
    const user = makeUser(store, { login: 'digest-disabled-scheduled', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_digest_disabled_scheduled', userId: user.id, owner: 'o', name: 'disabled-scheduled', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: true, intervalMinutes: 1440 })
    store.updateRepo(repo.id, { enabled: 0, last_run_at: new Date(Date.now() - 10 * 60_000).toISOString() })
    const row = store.saveSchedule({ id: 'sch_digest_disabled', repoId: repo.id, kind: 'cron', expression: '0 9 * * 1-5', timezone: 'Asia/Shanghai' })
    const schedule = scheduleFromRow(row)
    assert.ok(schedule !== null)
    const expected = digestTime(nextTime(schedule, Date.now())!)

    await jobs.tick()
    const digest = mailer.messages.find((message) => /今日摘要/.test(message.subject))
    assert.ok(digest, 'the digest was sent')
    assert.match(digest.text, /下次自动迭代：o\/disabled-scheduled · 仓库已停用，自动运行不会开始/, 'enabled answers before the saved row')
    assert.doesNotMatch(digest.text, new RegExp(escapeRegExp(expected)), 'a paused repository is not promised a run')
  } finally {
    store.close()
  }
})

// #940: a paused schedule row keeps its cron and its enabled repository, so the
// digest kept printing the instant the worker skips with `reason: 'paused'`. The
// email owns its own Chinese wording (#713), so it must say paused itself.
test('the digest says a paused schedule will not run', async () => {
  const config = testConfig({ digest: { hour: 0, timeZone: 'Asia/Shanghai' } })
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, mailer)
  try {
    const user = makeUser(store, { login: 'digest-schedule-paused', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_digest_paused_schedule', userId: user.id, owner: 'o', name: 'paused', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: true, intervalMinutes: 1440 })
    store.updateRepo(repo.id, { last_run_at: new Date(Date.now() - 10 * 60_000).toISOString() })
    const row = store.saveSchedule({ id: 'sch_digest_paused_schedule', repoId: repo.id, kind: 'cron', expression: '0 9 * * 1-5', timezone: 'Asia/Shanghai' })
    const schedule = scheduleFromRow(row)
    assert.ok(schedule !== null)
    const skipped = digestTime(nextTime(schedule, Date.now())!)
    store.setScheduleStatus(repo.id, 'paused', Date.now())

    await jobs.tick()
    const digest = mailer.messages.find((message) => /今日摘要/.test(message.subject))
    assert.ok(digest, 'the digest was sent')
    assert.match(digest.text, /下次自动迭代：o\/paused · 排期已暂停：恢复后从下一个时刻开始/, 'a paused schedule is not promised a run')
    assert.doesNotMatch(digest.text, new RegExp(escapeRegExp(skipped)), 'the skipped instant is gone from the digest')
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
    const repo = store.createRepo({ id: 'repo_plan', userId: user.id, owner: 'o', name: 'p', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: 'plan goal', autoIterate: false, intervalMinutes: 1440 })
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
    const repo = store.createRepo({ id: 'repo_followup', userId: user.id, owner: 'o', name: 'f', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
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

test('a follow-up carries the reviewer’s instruction, and two different requests on one commit are not duplicates', async () => {
  // #251: the follow-up input had no field for the maintainer's words, and both
  // the duplicate key and the parked key were built from `reason`, which is the
  // constant `review requested changes`. Two different requests on the same
  // commit therefore collapsed into one.
  const config = testConfig()
  const store = new Store(':memory:')
  const contexts: RunnerContext[] = []
  const runner: Runner = { name: 'capture', async run(context) { contexts.push(context); return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'followup-instruction', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_instruction', userId: user.id, owner: 'o', name: 'i', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const prUrl = 'https://github.com/o/i/pull/9'
    const first = await jobs.followUp(repo, { prUrl, branch: 'fledge/fix', reason: 'review requested changes', headSha: 'abc', instruction: 'Also cover the empty case in test/jobs.test.ts.' })
    assert.equal(first.ok, true)
    assert.match(first.job?.goal ?? '', /Reviewer asked: Also cover the empty case in test\/jobs\.test\.ts\./, 'the goal carries the sentence the reviewer wrote')
    store.updateJob(first.job?.id ?? '', { status: 'failed' })

    const second = await jobs.followUp(repo, { prUrl, branch: 'fledge/fix', reason: 'review requested changes', headSha: 'abc', instruction: 'Please keep the 404 path out of this PR.' })
    assert.equal(second.ok, true, 'a different request on the same commit is its own follow-up')
    assert.match(second.job?.goal ?? '', /Reviewer asked: Please keep the 404 path out of this PR\./)
    store.updateJob(second.job?.id ?? '', { status: 'failed' })

    const repeat = await jobs.followUp(repo, { prUrl, branch: 'fledge/fix', reason: 'review requested changes', headSha: 'abc', instruction: 'Also cover the empty case in test/jobs.test.ts.' })
    assert.equal(repeat.ok, false, 'the identical request on the same commit is still a duplicate')
    assert.equal(repeat.code, 'DUPLICATE_FOLLOWUP')

    const reasonOnly = await jobs.followUp(repo, { prUrl: 'https://github.com/o/i/pull/10', branch: 'fledge/two', reason: 'check failed', headSha: 'def' })
    assert.equal(reasonOnly.ok, true)
    assert.doesNotMatch(reasonOnly.job?.goal ?? '', /Reviewer asked:/, 'a follow-up with no instruction keeps its old shape')
  } finally {
    store.close()
  }
})

test('two different updates parked behind a review job become one follow-up carrying both', async () => {
  // #637: the parked key carried the request's fingerprint, so two updates that
  // arrived before the first model call parked as two rows and later became two
  // jobs. One review is one running task: the second update merges into the
  // parked request and the release pass queues one job that carries both.
  const config = testConfig()
  const store = new Store(':memory:')
  const runner: Runner = { name: 'capture', async run() { return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'followup-parked', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_parked', userId: user.id, owner: 'o', name: 'p', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const reviewJob = store.createJob({ id: 'job_review_active', repoId: repo.id, userId: user.id, trigger: 'schedule', goal: 'review the PR', callbackHash: 'cb-review', platformTokenHash: '', kind: 'review' })
    store.updateJob(reviewJob.id, { status: 'running' })
    const prUrl = 'https://github.com/o/p/pull/11'
    const first = await jobs.followUp(repo, { prUrl, branch: 'fledge/p', reason: 'review requested changes', headSha: 'fff', instruction: 'First request.', trigger: { kind: 'review', commentId: '301' } })
    const second = await jobs.followUp(repo, { prUrl, branch: 'fledge/p', reason: 'mention', headSha: 'fff', instruction: 'Second request.', trigger: { kind: 'mention', commentId: '302', actor: 'alice' } })
    assert.equal(first.code, 'JOB_ACTIVE')
    assert.equal(second.code, 'JOB_ACTIVE')
    const parked = store.listSettings(`pending_followup:${repo.id}:`)
    assert.equal(parked.length, 1, 'two updates in flight become one parked request')
    const merged = JSON.parse(parked[0]?.value ?? '{}') as { requests?: Array<{ instruction?: string; trigger?: { actor?: string; commentId?: string } }> }
    assert.deepEqual((merged.requests ?? []).map((request) => request.instruction), ['First request.', 'Second request.'], 'the merged request carries both triggers')
    assert.equal(merged.requests?.[1]?.trigger?.actor, 'alice', 'the merged request keeps who sent the second trigger')

    // Finishing the review runs the release pass, which queues ONE follow-up
    // carrying both requests: two jobs for one review is the defect.
    const followUpGoals = (): string[] => store.listJobsPageForUser(user.id, 50, 0)
      .filter((job) => job.trigger === 'followup')
      .map((job) => job.goal)
    store.updateJob(reviewJob.id, { status: 'succeeded' })
    await jobs.tick()
    assert.equal(followUpGoals().length, 1, 'one merged update becomes one job, not two')
    const queued = followUpGoals()[0] ?? ''
    assert.match(queued, /First request\./, 'the queued follow-up carries the first request')
    assert.match(queued, /Second request\./, 'the queued follow-up carries the second request')
    assert.equal(store.listSettings(`pending_followup:${repo.id}:`).length, 0, 'nothing stays parked after the release pass')
  } finally {
    store.close()
  }
})

test('a long review body cannot push the follow-up directives out of the goal', async () => {
  // `enqueue` caps the whole goal at 4000 characters and appends the carry-over
  // block after it, so the instruction's own bound decides whether the agent
  // still reads "do not open a second PR" and the rest of the directives. A
  // bound equal to the goal's cap would make the review body the last thing the
  // agent is told.
  const config = testConfig()
  const store = new Store(':memory:')
  const runner: Runner = { name: 'capture', async run() { return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'followup-long', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_long', userId: user.id, owner: 'o', name: 'l', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const result = await jobs.followUp(repo, {
      prUrl: 'https://github.com/o/l/pull/13',
      branch: 'fledge/l',
      reason: 'review requested changes',
      headSha: 'ghi',
      instruction: 'x'.repeat(6000),
    })
    assert.equal(result.ok, true)
    const goal = result.job?.goal ?? ''
    assert.ok(goal.length <= 4000, 'the goal stays inside the bound `enqueue` applies')
    assert.match(goal, /Continue on the same branch and update the existing PR\. Do not open a second PR or create a new issue\./, 'the directive the follow-up exists for is still there')
    assert.match(goal, /run the relevant checks, and callback with the branch and PR URL\./, 'the closing directive is still there')
    const line = goal.split('\n').find((row) => row.startsWith(`${REVIEW_INSTRUCTION_LABEL}: `)) ?? ''
    assert.ok(line.length > REVIEW_INSTRUCTION_LABEL.length, 'the instruction is still carried, not dropped')
    assert.ok(line.length <= `${REVIEW_INSTRUCTION_LABEL}: `.length + REVIEW_INSTRUCTION_MAX, `the instruction is clipped to its own bound, not the goal's (${line.length} chars)`)
    assert.match(line, /…$/, 'a clipped instruction says it was clipped')
  } finally {
    store.close()
  }
})

test('a repository without a selected role cannot enqueue jobs', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const contexts: RunnerContext[] = []
  const runner: Runner = { name: 'capture', async run(context) { contexts.push(context); return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'role-required-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_role_required', userId: user.id, owner: 'o', name: 'rr', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: null, goal: '', autoIterate: true, intervalMinutes: 1440 })
    const result = await jobs.enqueue(repo, 'manual')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'ROLE_REQUIRED')
    await jobs.tick()
    assert.equal(contexts.length, 0)
  } finally {
    store.close()
  }
})

test('a developer cannot run review jobs', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const runner: Runner = { name: 'capture', async run() { return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'developer-review-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_developer_review', userId: user.id, owner: 'o', name: 'dr', defaultBranch: 'main', tokenEnc: 'x', permission: 'write', repoRole: 'developer', canReview: true, reviewerEnabled: true, goal: '', autoIterate: false, intervalMinutes: 1440 })
    const result = await jobs.enqueue(repo, 'manual', undefined, 'review')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'ROLE_FORBIDDEN')
  } finally {
    store.close()
  }
})

test('maintainer auto-merge reaches the runner only when enabled', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const contexts: RunnerContext[] = []
  const runner: Runner = { name: 'capture', async run(context) { contexts.push(context); return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'auto-merge-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_auto_merge', userId: user.id, owner: 'o', name: 'am', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', autoMerge: true, goal: '', autoIterate: false, intervalMinutes: 1440 })
    const result = await jobs.enqueue(repo, 'manual')
    assert.equal(result.ok, true)
    assert.equal(contexts[0]?.repoRole, 'maintainer')
    assert.equal(contexts[0]?.autoMerge, true)

    store.updateJob(result.job!.id, { status: 'succeeded', finished_at: new Date().toISOString() })
    const developer = store.createRepo({ id: 'repo_auto_merge_dev', userId: user.id, owner: 'o', name: 'amd', defaultBranch: 'main', tokenEnc: 'x', permission: 'write', repoRole: 'developer', autoMerge: true, goal: '', autoIterate: false, intervalMinutes: 1440 })
    const devResult = await jobs.enqueue(developer, 'manual')
    assert.equal(devResult.ok, true)
    assert.equal(contexts[1]?.repoRole, 'developer')
    assert.equal(contexts[1]?.autoMerge, false)
  } finally {
    store.close()
  }
})

test('a late runner result does not resurrect a finalized job', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  let jobsRef: Jobs
  const runner: Runner = {
    name: 'race',
    async run(context) {
      const finished = await jobsRef.handleCallback(context.job.id, context.callback.secret, { status: 'succeeded', summary: 'finished during handoff' })
      assert.equal(finished.ok, true)
      return { status: 'running' }
    },
  }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  jobsRef = jobs
  try {
    const user = makeUser(store, { login: 'finalize-race-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_finalize_race', userId: user.id, owner: 'o', name: 'race', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const result = await jobs.enqueue(repo, 'manual')
    assert.equal(result.ok, true)
    assert.equal(store.getJob(result.job!.id)?.status, 'succeeded')
  } finally {
    store.close()
  }
})

test('job credentials expose the job base branch', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const contexts: RunnerContext[] = []
  const runner: Runner = { name: 'capture', async run(context) { contexts.push(context); return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'credential-branch-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_credential_branch', userId: user.id, owner: 'o', name: 'cb', defaultBranch: 'main', targetBranch: 'develop', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const result = await jobs.enqueue(repo, 'manual')
    assert.equal(result.ok, true)
    const credential = await jobs.credential(result.job!.id, contexts[0]!.callback.secret)
    assert.equal(credential.ok, true)
    assert.equal(credential.defaultBranch, 'develop')
    assert.equal(credential.upstream?.defaultBranch, 'develop')
    assert.equal(credential.repoRole, 'maintainer')
    assert.equal(credential.autoMerge, false)
  } finally {
    store.close()
  }
})

test('maintainer auto-merge merges only after checks pass and no changes are requested', async () => {
  const merges: string[] = []
  let reviews: Array<Record<string, unknown>> = []
  const github = await startFakeServer((request, response) => {
    const method = request.method ?? 'GET'
    const url = request.url ?? ''
    if (method === 'GET' && url === '/repos/o/r/pulls/1') {
      json(response, 200, {
        number: 1,
        html_url: 'https://github.com/o/r/pull/1',
        title: 'fix',
        state: 'open',
        head: { ref: 'fledge/fix', sha: 'abc' },
        base: { ref: 'main' },
        mergeable: true,
        mergeable_state: 'clean',
        draft: false,
        merged: false,
      })
      return
    }
    if (method === 'GET' && url === '/repos/o/r/commits/abc/check-runs?per_page=100') {
      json(response, 200, { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] })
      return
    }
    if (method === 'GET' && url === '/repos/o/r/commits/abc/status') {
      json(response, 200, { state: 'success', statuses: [] })
      return
    }
    if (method === 'GET' && url === '/repos/o/r/pulls/1/reviews?per_page=100') {
      json(response, 200, reviews)
      return
    }
    if (method === 'GET' && url === '/repos/o/r/branches/main/protection') {
      json(response, 200, { required_status_checks: { contexts: ['ci'] }, required_pull_request_reviews: { required_approving_review_count: 0 } })
      return
    }
    if (method === 'PUT' && url === '/repos/o/r/pulls/1/merge') {
      merges.push('merge')
      json(response, 200, { merged: true, sha: 'def' })
      return
    }
    if (method === 'POST' && url === '/repos/o/r/issues/1/comments') {
      json(response, 200, {})
      return
    }
    json(response, 404, { message: 'Not Found' })
  })
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: github.url } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'auto-merge-pass-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_auto_merge_pass', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', autoMerge: true, upstreamHtmlUrl: 'https://github.com/o/r', forkHtmlUrl: 'https://github.com/o/r', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const secret = 'auto-merge-secret'
    store.createJob({ id: 'job_auto_merge_pass', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob('job_auto_merge_pass', { status: 'running', branch: 'fledge/fix', started_at: new Date().toISOString() })
    const result = await jobs.handleCallback('job_auto_merge_pass', secret, { status: 'succeeded', prUrl: 'https://github.com/o/r/pull/1', summary: 'done' })
    assert.equal(result.ok, true)
    assert.equal(merges.length, 1)

    reviews = [{ state: 'CHANGES_REQUESTED', user: { login: 'reviewer' }, submitted_at: '2026-11-03T00:00:00Z' }]
    store.createJob({ id: 'job_auto_merge_blocked', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob('job_auto_merge_blocked', { status: 'running', branch: 'fledge/fix', started_at: new Date().toISOString() })
    await jobs.handleCallback('job_auto_merge_blocked', secret, { status: 'succeeded', prUrl: 'https://github.com/o/r/pull/1', summary: 'done' })
    assert.equal(merges.length, 1)
  } finally {
    store.close()
    await github.close()
  }
})

test('auto-merge refuses a low review score and a manual maintainer merge overrides it', async () => {
  const merges: string[] = []
  const github = await startFakeServer((request, response) => {
    const method = request.method ?? 'GET'
    const url = request.url ?? ''
    if (method === 'GET' && url === '/repos/o/r/pulls/1') {
      json(response, 200, { number: 1, html_url: 'https://github.com/o/r/pull/1', title: 'fix', state: 'open', head: { ref: 'fledge/fix', sha: 'abc' }, base: { ref: 'main' }, mergeable: true, mergeable_state: 'clean', draft: false, merged: false })
      return
    }
    if (method === 'GET' && url === '/repos/o/r/commits/abc/check-runs?per_page=100') {
      json(response, 200, { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] })
      return
    }
    if (method === 'GET' && url === '/repos/o/r/commits/abc/status') {
      json(response, 200, { state: 'success', statuses: [] })
      return
    }
    if (method === 'GET' && url === '/repos/o/r/pulls/1/reviews?per_page=100') {
      json(response, 200, [])
      return
    }
    if (method === 'GET' && url === '/repos/o/r/branches/main/protection') {
      json(response, 200, { required_status_checks: { contexts: ['ci'] }, required_pull_request_reviews: { required_approving_review_count: 0 } })
      return
    }
    if (method === 'PUT' && url === '/repos/o/r/pulls/1/merge') {
      merges.push('merge')
      json(response, 200, { merged: true, sha: 'def' })
      return
    }
    json(response, 404, { message: 'Not Found' })
  })
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: github.url } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'review-score-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_review_score', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', autoMerge: true, upstreamHtmlUrl: 'https://github.com/o/r', forkHtmlUrl: 'https://github.com/o/r', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const item = store.createWorkItem({ id: 'work_review_score', repoId: repo.id, userId: user.id, title: 'fix', prUrl: 'https://github.com/o/r/pull/1', state: 'pr_ready' })
    const review = store.createJob({ id: 'job_review_score', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'review', callbackHash: 'review-hash', platformTokenHash: '', kind: 'review', workItemId: item.id })
    store.updateJob(review.id, { status: 'succeeded', review_score: 60, finished_at: new Date().toISOString() })

    const secret = 'low-score-secret'
    store.createJob({ id: 'job_iterate_score', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'iterate', baseBranch: 'main', workItemId: item.id })
    store.updateJob('job_iterate_score', { status: 'running', branch: 'fledge/fix', started_at: new Date().toISOString() })
    const result = await jobs.handleCallback('job_iterate_score', secret, { status: 'succeeded', prUrl: 'https://github.com/o/r/pull/1', summary: 'done' })
    assert.equal(result.ok, true)
    assert.equal(merges.length, 0, 'a score below 80 must block auto-merge')
    assert.ok(store.listAudit().some((entry) => entry.action === 'job.merge_skipped' && (entry.detail ?? '').includes('review gate')))

    const manual = await jobs.manualMerge(repo, store.getJob('job_iterate_score')!)
    assert.equal(manual.ok, true)
    assert.equal(merges.length, 1, 'a manual maintainer merge may override the score')
    assert.ok(store.listAudit().some((entry) => entry.action === 'job.merge_review_override'))
  } finally {
    store.close()
    await github.close()
  }
})

test('review jobs require a fresh GitHub permission check', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'stale-role-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_stale_role', userId: user.id, owner: 'o', name: 'sr', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', canReview: true, reviewerEnabled: true, roleCheckedAt: '2020-01-01T00:00:00.000Z', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const result = await jobs.enqueue(repo, 'manual', undefined, 'review')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'ROLE_STALE')
  } finally {
    store.close()
  }
})

test('stopping a repository cancels its active job', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'cancel-repo-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_cancel', userId: user.id, owner: 'o', name: 'cancel', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.createJob({ id: 'job_cancel', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob('job_cancel', { status: 'running', started_at: new Date().toISOString() })
    await jobs.cancelRepoJobs(repo.id, 'repository disabled')
    assert.equal(store.getJob('job_cancel')?.status, 'failed')
    assert.equal(store.getJob('job_cancel')?.error, 'repository disabled')
    assert.equal(store.activeJobForRepo(repo.id), undefined)
  } finally {
    store.close()
  }
})

test('a stale review role is refreshed before enqueue', async () => {
  const github = await startFakeServer((request, response) => {
    if (request.url === '/user') {
      json(response, 200, { login: 'role-refresh-job-user', id: 1 })
      return
    }
    if (request.url === '/repos/role-refresh-job-user/own') {
      json(response, 200, {
        name: 'own',
        full_name: 'role-refresh-job-user/own',
        default_branch: 'main',
        private: false,
        html_url: 'https://github.com/role-refresh-job-user/own',
        owner: { login: 'role-refresh-job-user' },
        permissions: { admin: true, maintain: true, push: true, pull: true },
      })
      return
    }
    json(response, 404, { message: 'Not Found' })
  })
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: github.url } })
  const store = new Store(':memory:')
  const runner: Runner = { name: 'capture', async run() { return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'role-refresh-job-user', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_role_refresh_job',
      userId: user.id,
      owner: 'role-refresh-job-user',
      name: 'own',
      defaultBranch: 'main',
      tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey),
      permission: 'admin',
      repoRole: 'maintainer',
      canReview: true,
      reviewerEnabled: true,
      roleCheckedAt: '2020-01-01T00:00:00.000Z',
      goal: '',
      autoIterate: false,
      intervalMinutes: 1440,
    })
    const result = await jobs.enqueue(repo, 'manual', undefined, 'review')
    assert.equal(result.ok, true)
    const refreshed = store.getRepo(repo.id)!
    assert.equal(refreshed.repo_role, 'maintainer')
    assert.notEqual(refreshed.role_checked_at, '2020-01-01T00:00:00.000Z')
    assert.equal(refreshed.permission, 'admin')
  } finally {
    store.close()
    await github.close()
  }
})

test('a work item follows its job to PR ready', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const contexts: RunnerContext[] = []
  const runner: Runner = { name: 'capture', async run(context) { contexts.push(context); return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'work-item-job-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_work_item_job', userId: user.id, owner: 'o', name: 'wij', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const item = store.createWorkItem({ id: 'work_job', repoId: repo.id, userId: user.id, title: 'Fix parser', state: 'triaged' })
    const result = await jobs.enqueue(repo, 'manual', 'work goal', 'iterate', { workItemId: item.id })
    assert.equal(result.ok, true)
    assert.equal(store.getWorkItem(item.id)?.state, 'in_progress')
    assert.equal(store.getWorkItem(item.id)?.job_id, result.job?.id)
    const secret = contexts[0]!.callback.secret
    await jobs.handleCallback(result.job!.id, secret, { status: 'succeeded', prUrl: 'https://github.com/o/wij/pull/3', issueUrl: 'https://github.com/o/wij/issues/2', summary: 'done' })
    const updated = store.getWorkItem(item.id)!
    assert.equal(updated.state, 'pr_ready')
    assert.equal(updated.pr_url, 'https://github.com/o/wij/pull/3')
    assert.equal(updated.pr_state, 'open')
  } finally {
    store.close()
  }
})

test('a failed job returns its work item to triaged instead of leaving it active', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const contexts: RunnerContext[] = []
  const runner: Runner = { name: 'capture', async run(context) { contexts.push(context); return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'work-item-fail-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_work_item_fail', userId: user.id, owner: 'o', name: 'wif', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const item = store.createWorkItem({ id: 'work_fail', repoId: repo.id, userId: user.id, title: 'Fix parser', state: 'triaged' })
    const result = await jobs.enqueue(repo, 'manual', 'work goal', 'iterate', { workItemId: item.id })
    assert.equal(result.ok, true)
    await jobs.handleCallback(result.job!.id, contexts[0]!.callback.secret, { status: 'failed', error: 'bridge 502' })
    assert.equal(store.getWorkItem(item.id)?.state, 'triaged')
  } finally {
    store.close()
  }
})

test('flybot preflight records the base SHA and scheduled work is not blocked by an open work item', async () => {
  const github = await startFakeServer((request, response) => {
    if (request.url === '/repos/o/preflight/branches/main') {
      json(response, 200, { name: 'main', commit: { sha: 'abc123' } })
      return
    }
    json(response, 404, { message: 'Not Found' })
  })
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: github.url } })
  const store = new Store(':memory:')
  const runner: Runner = { name: 'flybot', async run() { return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'preflight-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_preflight', userId: user.id, owner: 'o', name: 'preflight', defaultBranch: 'main', targetBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const first = await jobs.enqueue(repo, 'manual')
    assert.equal(first.ok, true)
    assert.equal(first.job?.base_sha, 'abc123')
    store.updateJob(first.job!.id, { status: 'succeeded', finished_at: new Date().toISOString() })
    store.createWorkItem({ id: 'work_preflight', repoId: repo.id, userId: user.id, title: 'Open work', state: 'in_progress' })
    const scheduled = await jobs.enqueue(repo, 'schedule')
    assert.equal(scheduled.ok, true)
    assert.notEqual(scheduled.code, 'WORK_ITEM_OPEN')
  } finally {
    store.close()
    await github.close()
  }
})

test('a running job can be cancelled and a paused job can be resumed', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const contexts: RunnerContext[] = []
  const runner: Runner = { name: 'capture', async run(context) { contexts.push(context); return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'job-control-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_job_control', userId: user.id, owner: 'o', name: 'jc', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const item = store.createWorkItem({ id: 'work_cancel', repoId: repo.id, userId: user.id, title: 'Cancel me', state: 'in_progress' })
    store.createJob({ id: 'job_cancel', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate', workItemId: item.id })
    store.updateJob('job_cancel', { status: 'running', started_at: new Date().toISOString() })
    const cancelled = await jobs.cancelJob('job_cancel', 'user cancelled')
    assert.equal(cancelled.ok, true)
    assert.equal(store.getJob('job_cancel')?.status, 'cancelled')
    assert.equal(store.getWorkItem(item.id)?.state, 'closed')

    store.createJob({ id: 'job_pause', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g2', callbackHash: 'cb2', platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob('job_pause', { status: 'running', started_at: new Date().toISOString() })
    const paused = await jobs.pauseJob('job_pause')
    assert.equal(paused.ok, true)
    assert.equal(store.getJob('job_pause')?.status, 'paused')
    const resumed = await jobs.resumeJob('job_pause')
    assert.equal(resumed.ok, true)
    assert.ok(resumed.job)
    assert.equal(store.getJob('job_pause')?.status, 'cancelled')
    assert.equal(contexts.length, 1)
    assert.equal(resumed.job?.status, 'running')
  } finally {
    store.close()
  }
})

test('auto-merge is skipped when branch protection is unavailable', async () => {
  const merges: string[] = []
  const github = await startFakeServer((request, response) => {
    const method = request.method ?? 'GET'
    const url = request.url ?? ''
    if (method === 'GET' && url === '/repos/o/r/pulls/4') {
      json(response, 200, { number: 4, html_url: 'https://github.com/o/r/pull/4', title: 'fix', state: 'open', head: { ref: 'fledge/fix', sha: 'abc' }, base: { ref: 'main' }, mergeable: true, mergeable_state: 'clean', draft: false, merged: false })
      return
    }
    if (method === 'GET' && url === '/repos/o/r/commits/abc/check-runs?per_page=100') {
      json(response, 200, { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] })
      return
    }
    if (method === 'GET' && url === '/repos/o/r/commits/abc/status') {
      json(response, 200, { state: 'success', statuses: [] })
      return
    }
    if (method === 'GET' && url === '/repos/o/r/pulls/4/reviews?per_page=100') {
      json(response, 200, [])
      return
    }
    if (method === 'GET' && url === '/repos/o/r/branches/main/protection') {
      json(response, 404, { message: 'Not Found' })
      return
    }
    if (method === 'PUT' && url === '/repos/o/r/pulls/4/merge') {
      merges.push('merge')
      json(response, 200, { merged: true })
      return
    }
    if (method === 'POST' && url === '/repos/o/r/issues/4/comments') {
      json(response, 200, {})
      return
    }
    json(response, 404, { message: 'Not Found' })
  })
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: github.url } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'auto-merge-protection-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_auto_merge_protection', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', autoMerge: true, requireProtection: true, upstreamHtmlUrl: 'https://github.com/o/r', forkHtmlUrl: 'https://github.com/o/r', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const secret = 'auto-merge-protection-secret'
    store.createJob({ id: 'job_auto_merge_protection', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob('job_auto_merge_protection', { status: 'running', branch: 'fledge/fix', started_at: new Date().toISOString() })
    await jobs.handleCallback('job_auto_merge_protection', secret, { status: 'succeeded', prUrl: 'https://github.com/o/r/pull/4', summary: 'done' })
    assert.equal(merges.length, 0)
  } finally {
    store.close()
    await github.close()
  }
})

test('repository monthly and per-job budgets are enforced and attributed', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'budget-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_budget', userId: user.id, owner: 'o', name: 'b', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', monthlyBudgetCny: 1, jobBudgetCny: 0.01, goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.recordUsage(user.id, null, 0.2, null, repo.id)
    assert.equal(store.repoUsageSince(repo.id, '2000-01-01T00:00:00.000Z'), 0.2)
    const blocked = await jobs.enqueue(repo, 'manual')
    assert.equal(blocked.ok, false)
    assert.equal(blocked.code, 'REPO_BUDGET_EXHAUSTED')

    const cheap = store.createRepo({ id: 'repo_budget_job', userId: user.id, owner: 'o', name: 'bj', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', jobBudgetCny: 0.01, goal: '', autoIterate: false, intervalMinutes: 1440 })
    const secret = 'budget-job-secret'
    store.createJob({ id: 'job_budget', repoId: cheap.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob('job_budget', { status: 'running', started_at: new Date().toISOString() })
    store.recordUsage(user.id, 'job_budget', 0.02, null, cheap.id)
    await jobs.handleCallback('job_budget', secret, { status: 'succeeded', summary: 'done' })
    assert.equal(store.listNotifications(user.id).some((entry) => entry.message.includes('超过单任务预算')), true)
  } finally {
    store.close()
  }
})

test('job completion and questions can be forwarded to a notification webhook', async () => {
  const events: Array<Record<string, unknown>> = []
  const webhook = await startFakeServer(async (request, response) => {
    const body = JSON.parse((await readBody(request)).toString('utf8')) as Record<string, unknown>
    events.push(body)
    json(response, 200, { ok: true })
  })
  const config = testConfig({ notifyWebhookUrl: webhook.url, notifyWebhookSecret: 'hook-secret', notifyWebhookAllowedHosts: ['127.0.0.1'] })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'webhook-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_webhook', userId: user.id, owner: 'o', name: 'hook', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const secret = 'webhook-job-secret'
    store.createJob({ id: 'job_webhook', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob('job_webhook', { status: 'running', started_at: new Date().toISOString() })
    await jobs.handleCallback('job_webhook', secret, { status: 'succeeded', summary: 'done' })
    // #544 slice 7: the webhook is queued first, and the tick's one delivery
    // pass is what touches the transport.
    await jobs.tick()
    for (let i = 0; i < 20 && events.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(events.length, 1)
    assert.equal(events[0]?.event, 'job.succeeded')
    assert.equal(events[0]?.jobId, 'job_webhook')
    assert.equal(events[0]?.text, 'iterate job job_webhook succeeded')
  } finally {
    store.close()
    await webhook.close()
  }
})

test('enforced stage mode rejects a callback without stage evidence', async () => {
  const store = new Store(':memory:')
  const jobs = new Jobs(store, testConfig(), { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'stage-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_stage', userId: user.id, owner: 'o', name: 'stage', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', stageMode: 'enforced', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const secret = 'stage-secret'
    store.createJob({ id: 'job_stage', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob('job_stage', { status: 'running', started_at: new Date().toISOString() })
    const result = await jobs.handleCallback('job_stage', secret, {
      status: 'succeeded',
      summary: 'done',
      branch: 'fledge/stage',
      prUrl: 'https://github.com/o/stage/pull/1',
      attribution: { implementedBy: 'Lead', testedBy: 'Lead' },
      evidence: { tests: 'ok' },
    })
    assert.equal(result.ok, false)
    assert.equal(result.status, 422)
    const job = store.getJob('job_stage')
    assert.equal(job?.status, 'failed')
    assert.match(job?.error ?? '', /STAGE_EVIDENCE_MISSING/)
    assert.equal(store.listNotifications(user.id).some((entry) => entry.message.includes('缺少阶段证据')), true)
  } finally {
    store.close()
  }
})

test('shadow stage mode records missing evidence without blocking', async () => {
  const store = new Store(':memory:')
  const jobs = new Jobs(store, testConfig(), { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'shadow-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_shadow', userId: user.id, owner: 'o', name: 'shadow', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', stageMode: 'shadow', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const secret = 'shadow-secret'
    store.createJob({ id: 'job_shadow', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob('job_shadow', { status: 'running', started_at: new Date().toISOString() })
    const result = await jobs.handleCallback('job_shadow', secret, {
      status: 'succeeded',
      summary: 'done',
      branch: 'fledge/shadow',
      prUrl: 'https://github.com/o/shadow/pull/1',
      attribution: { implementedBy: 'Dev-1', testedBy: 'Test' },
      evidence: { tests: 'ok' },
    })
    assert.equal(result.ok, true)
    assert.equal(store.getJob('job_shadow')?.status, 'succeeded')
    assert.equal(store.all<{ name: string }>('SELECT name FROM events WHERE job_id = ?', 'job_shadow').some((entry) => entry.name === 'stage_evidence_missing'), true)
  } finally {
    store.close()
  }
})

test('three consecutive job failures raise one ops notice', async () => {
  const store = new Store(':memory:')
  const jobs = new Jobs(store, testConfig(), { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'ops-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_ops', userId: user.id, owner: 'o', name: 'ops', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    for (let i = 1; i <= 4; i += 1) {
      const secret = `ops-secret-${i}`
      const id = `job_ops_${i}`
      store.createJob({ id, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
      store.updateJob(id, { status: 'running', started_at: new Date().toISOString() })
      await jobs.handleCallback(id, secret, { status: 'failed', error: 'boom' })
    }
    const notices = store.listNotifications(user.id).filter((entry) => entry.message.includes('连续 3 个任务失败'))
    assert.equal(notices.length, 1)
  } finally {
    store.close()
  }
})

test('a running job with no heartbeat is failed as stalled', async () => {
  const store = new Store(':memory:')
  const jobs = new Jobs(store, testConfig(), { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'heartbeat-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_heartbeat', userId: user.id, owner: 'o', name: 'h', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.createJob({ id: 'job_heartbeat', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate' })
    store.updateJob('job_heartbeat', { status: 'running', started_at: '2000-01-01T00:00:00.000Z' })
    await jobs.tick()
    const job = store.getJob('job_heartbeat')
    assert.equal(job?.status, 'failed')
    assert.match(job?.error ?? '', /停滞/)
  } finally {
    store.close()
  }
})

test('a repository the dispatcher refuses is reported with its reason, not as idle', async () => {
  const store = new Store(':memory:')
  const jobs = new Jobs(store, testConfig(), { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const blocked = (reason: string): number =>
      metricsSnapshot().counters
        .filter((entry) => entry.name === 'fledge_automation_blocked_total' && entry.labels.reason === reason)
        .reduce((sum, entry) => sum + entry.value, 0)
    const idleAlerts = (): number =>
      store.alerts({ usdCny: 1, automationIdleMinutes: 30 })
        .filter((alert) => alert.kind === 'automation_idle_with_work').length

    const user = makeUser(store, { login: 'refused-user', status: 'pending' })
    const repo = store.createRepo({ id: 'repo_refused', userId: user.id, owner: 'o', name: 'refused', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: true, intervalMinutes: 1440 })
    store.createWorkItem({ id: 'work_refused', repoId: repo.id, userId: user.id, title: 'Ready work', priority: 1 })
    store.db.exec("UPDATE work_items SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = 'work_refused'")
    assert.equal(idleAlerts(), 0)

    // The dispatcher names the approval it waits for instead of starting a job.
    const before = blocked('user_not_ready')
    await jobs.tick()
    assert.equal(blocked('user_not_ready'), before + 1)
    assert.equal(store.listJobsForRepo(repo.id).length, 0)
    // The alert side reads the same decision: an unapproved user is not idle.
    assert.equal(idleAlerts(), 0)

    // Approving the user makes the same repository idle, so the silence above
    // was the refusal and not a broken alert.
    store.setUserStatus(user.id, 'approved', 'test')
    assert.equal(idleAlerts(), 1)
  } finally {
    store.close()
  }
})

test('a repository whose bridge instance is not up is reported as instance_not_ready, not idle', async () => {
  const base = testConfig()
  const config = testConfig({ flybot: { ...base.flybot, instanceImage: 'image' } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const blocked = (reason: string): number =>
      metricsSnapshot().counters
        .filter((entry) => entry.name === 'fledge_automation_blocked_total' && entry.labels.reason === reason)
        .reduce((sum, entry) => sum + entry.value, 0)
    const idleAlerts = (): number =>
      store.alerts({ usdCny: 1, automationIdleMinutes: 30, instancesManaged: true })
        .filter((alert) => alert.kind === 'automation_idle_with_work').length

    const user = makeUser(store, { login: 'refused-instance-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_refused_instance', userId: user.id, owner: 'o', name: 'starting', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: true, intervalMinutes: 1440 })
    store.saveRepoInstance({
      repo_id: repo.id, user_id: user.id, container: 'c', network: 'n', data_dir: '/tmp/starting', bridge_script: '/tmp/bridge',
      dsh_port: 1, bridge_port: 2, model_port: 3, model_bind: '127.0.0.1', image: 'image', status: 'starting',
      chief_session: null, team_json: null, bridge_token_enc: null, bridge_pid: null, log_pid: null, last_error: null,
      created_at: '2026-11-16T09:00:00.000Z', updated_at: '2026-11-16T09:00:00.000Z', last_health_at: null,
    })
    store.createWorkItem({ id: 'work_refused_instance', repoId: repo.id, userId: user.id, title: 'Ready work', priority: 1 })
    store.db.exec("UPDATE work_items SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = 'work_refused_instance'")

    const before = blocked('instance_not_ready')
    await jobs.tick()
    assert.equal(blocked('instance_not_ready'), before + 1)
    assert.equal(store.listJobsForRepo(repo.id).length, 0)
    assert.equal(idleAlerts(), 0)

    store.updateRepoInstance(repo.id, { status: 'ready' })
    assert.equal(idleAlerts(), 1)
  } finally {
    store.close()
  }
})

test('three consecutive failures pause auto-iterate', async () => {
  const store = new Store(':memory:')
  const jobs = new Jobs(store, testConfig(), { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'pause-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_pause', userId: user.id, owner: 'o', name: 'p', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: true, intervalMinutes: 1440 })
    for (let i = 1; i <= 3; i += 1) {
      const secret = `pause-secret-${i}`
      const id = `job_pause_${i}`
      store.createJob({ id, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
      store.updateJob(id, { status: 'running', started_at: new Date().toISOString() })
      await jobs.handleCallback(id, secret, { status: 'failed', error: 'boom' })
    }
    assert.equal(store.getRepo(repo.id)?.auto_iterate, 0)
    assert.equal(store.getRepo(repo.id)?.consecutive_failures, 3)
    assert.equal(store.listNotifications(user.id).some((entry) => entry.message.includes('自动迭代已暂停')), true)
  } finally {
    store.close()
  }
})

test('a credential 403 pauses the repository before enqueue', async () => {
  const github = await startFakeServer((request, response) => {
    if (request.url?.startsWith('/repos/o/c/branches/')) {
      json(response, 403, { message: 'Resource not accessible by personal access token' })
      return
    }
    json(response, 404, { message: 'not found' })
  })
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: github.url } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'credential-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_credential', userId: user.id, owner: 'o', name: 'c', defaultBranch: 'main', tokenEnc: encryptSecret('bad-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: true, intervalMinutes: 1440 })
    const result = await jobs.enqueue(repo, 'manual', 'plan this', 'plan')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'REPO_CREDENTIAL_INVALID')
    assert.equal(store.getRepo(repo.id)?.credential_state, 'invalid')
    assert.equal(store.getRepo(repo.id)?.auto_iterate, 0)
  } finally {
    store.close()
    await github.close()
  }
})

test('manual merge rejects a job without a pull request', async () => {
  const store = new Store(':memory:')
  const jobs = new Jobs(store, testConfig(), { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'merge-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_merge', userId: user.id, owner: 'o', name: 'm', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const job = store.createJob({ id: 'job_merge', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate' })
    const result = await jobs.manualMerge(repo, job)
    assert.equal(result.ok, false)
    assert.match(result.message ?? '', /没有 PR/)
  } finally {
    store.close()
  }
})

test('the auto-pause still fires when the repeated-failure notice was already sent', async () => {
  const store = new Store(':memory:')
  const jobs = new Jobs(store, testConfig(), { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'pause-dedupe-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_pause_dedupe', userId: user.id, owner: 'o', name: 'p', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: true, intervalMinutes: 1440 })
    store.setSetting(`ops:repo_failing:${repo.id}`, new Date().toISOString())
    for (let i = 1; i <= 3; i += 1) {
      const secret = `pause-dedupe-${i}`
      const id = `job_pause_dedupe_${i}`
      store.createJob({ id, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
      store.updateJob(id, { status: 'running', started_at: new Date().toISOString() })
      await jobs.handleCallback(id, secret, { status: 'failed', error: 'boom' })
    }
    assert.equal(store.getRepo(repo.id)?.auto_iterate, 0)
  } finally {
    store.close()
  }
})

test('a branch-readable but contents-forbidden token is rejected by preflight', async () => {
  const github = await startFakeServer((request, response) => {
    if (request.url?.startsWith('/repos/o/contents/branches/')) {
      json(response, 200, { name: 'main', commit: { sha: 'abc' } })
      return
    }
    if (request.url?.startsWith('/repos/o/contents/contents/')) {
      json(response, 403, { message: 'Resource not accessible by personal access token' })
      return
    }
    json(response, 404, { message: 'not found' })
  })
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: github.url } })
  const store = new Store(':memory:')
  const runner = { name: 'flybot', async run() { return { status: 'running' as const } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'contents-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_contents', userId: user.id, owner: 'o', name: 'contents', defaultBranch: 'main', tokenEnc: encryptSecret('bad-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: true, intervalMinutes: 1440 })
    const result = await jobs.enqueue(repo, 'manual')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'REPO_CREDENTIAL_INVALID')
    assert.equal(store.getRepo(repo.id)?.credential_state, 'invalid')
    assert.equal(store.getRepo(repo.id)?.auto_iterate, 0)
  } finally {
    store.close()
    await github.close()
  }
})

test('mergeCleanPrs merges only pull requests that pass every check', async () => {
  const merges: string[] = []
  const github = await startFakeServer((request, response) => {
    const method = request.method ?? 'GET'
    const url = request.url ?? ''
    const match = /^\/repos\/o\/r\/pulls\/(4|5)$/.exec(url)
    if (method === 'GET' && match !== null) {
      const number = Number(match[1])
      json(response, 200, { number, html_url: `https://github.com/o/r/pull/${number}`, title: 'fix', state: 'open', head: { ref: 'fledge/fix', sha: `sha${number}` }, base: { ref: 'main' }, mergeable: true, mergeable_state: 'clean', draft: false, merged: false })
      return
    }
    if (method === 'GET' && /^\/repos\/o\/r\/commits\/sha(4|5)\/check-runs\?per_page=100$/.test(url)) {
      json(response, 200, { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] })
      return
    }
    if (method === 'GET' && /^\/repos\/o\/r\/commits\/sha(4|5)\/status$/.test(url)) {
      json(response, 200, { state: 'success', statuses: [] })
      return
    }
    if (method === 'GET' && /^\/repos\/o\/r\/pulls\/(4|5)\/reviews\?per_page=100$/.test(url)) {
      json(response, 200, [])
      return
    }
    if (method === 'GET' && url === '/repos/o/r/branches/main/protection') {
      json(response, 200, { protected: false, required_status_checks: { contexts: [] }, required_pull_request_reviews: { required_approving_review_count: 0 } })
      return
    }
    if (method === 'PUT' && /^\/repos\/o\/r\/pulls\/(4|5)\/merge$/.test(url)) {
      merges.push(url)
      json(response, 200, { merged: true, sha: 'merged' })
      return
    }
    json(response, 404, { message: 'Not Found' })
  })
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: github.url } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'bulk-merge-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_bulk_merge', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', requireProtection: false, upstreamHtmlUrl: 'https://github.com/o/r', forkHtmlUrl: 'https://github.com/o/r', goal: '', autoIterate: false, intervalMinutes: 1440 })
    for (const number of [4, 5]) {
      const id = `job_bulk_${number}`
      store.createJob({ id, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
      store.updateJob(id, { status: 'succeeded', pr_url: `https://github.com/o/r/pull/${number}`, finished_at: new Date().toISOString() })
    }
    const result = await jobs.mergeCleanPrs(repo.id)
    assert.equal(result.merged.length, 2)
    assert.equal(result.skipped.length, 0)
    assert.equal(merges.length, 2)
  } finally {
    store.close()
    await github.close()
  }
})

test('a job writes a durable event timeline from enqueue to finish', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'timeline-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_timeline', userId: user.id, owner: 'o', name: 'timeline', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const queued = await jobs.enqueue(repo, 'manual')
    assert.equal(queued.ok, true)
    const job = queued.job!
    const secret = 'callback-secret'
    store.run('UPDATE jobs SET callback_hash = ? WHERE id = ?', sha256Hex(secret), job.id)

    const progress = await jobs.handleCallback(job.id, secret, { status: 'running', summary: 'halfway' })
    assert.equal(progress.ok, true)
    const finished = await jobs.handleCallback(job.id, secret, { status: 'succeeded', summary: 'done' })
    assert.equal(finished.ok, true)

    const kinds = store.listJobEvents(job.id).map((event) => event.kind)
    assert.ok(kinds.includes('job.enqueued'))
    assert.ok(kinds.includes('job.running'))
    assert.ok(kinds.includes('job.progress'))
    assert.ok(kinds.includes('job.succeeded'))
  } finally {
    store.close()
  }
})

test('manual merge is blocked when the PR changes a forbidden path', async () => {
  const github = await startFakeServer((request, response) => {
    const path = request.url ?? ''
    if (path.includes('/pulls/7/files')) {
      json(response, 200, [
        { filename: 'src/ok.ts', status: 'modified', additions: 1, deletions: 0 },
        { filename: '.github/workflows/ci.yml', status: 'modified', additions: 1, deletions: 0 },
      ])
      return
    }
    if (path.includes('/pulls/7')) {
      json(response, 200, { number: 7, html_url: 'https://github.com/owner/guarded/pull/7', title: 'Fix', state: 'open', head: { ref: 'fledge/x', sha: 'sha7' }, base: { ref: 'main' }, mergeable: true, mergeable_state: 'clean', draft: false, merged: false })
      return
    }
    json(response, 404, { message: 'not found' })
  })
  const config = testConfig({ github: { ...testConfig().github, apiBase: github.url } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'path-guard-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_path_guard', userId: user.id, owner: 'owner', name: 'guarded', defaultBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440, allowPaths: 'src/', denyPaths: '.github/', upstreamHtmlUrl: 'https://github.com' })
    store.updateRepo(repo.id, { role_checked_at: new Date().toISOString() })
    const job = store.createJob({ id: 'job_path_guard', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate' })
    store.updateJob(job.id, { pr_url: 'https://github.com/owner/guarded/pull/7', branch: 'fledge/x', status: 'succeeded' })
    const result = await jobs.manualMerge(store.getRepo(repo.id)!, store.getJob(job.id)!)
    assert.equal(result.ok, false)
    assert.match(result.message ?? '', /受保护路径|path/i)
    const guard = JSON.parse(store.getJob(job.id)?.path_guard_json ?? '{}') as { ok?: boolean; violations?: unknown[] }
    assert.equal(guard.ok, false)
    assert.equal(guard.violations?.length, 1)
  } finally {
    store.close()
    await github.close()
  }
})

test('transient failures schedule one durable retry and permanent failures do not', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'retry-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_retry', userId: user.id, owner: 'o', name: 'retry', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const secret = 'retry-secret'
    store.createJob({ id: 'job_retry', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'iterate' })
    store.updateJob('job_retry', { status: 'running' })
    const result = await jobs.handleCallback('job_retry', secret, { status: 'failed', error: 'FlyBot bridge 502' })
    assert.equal(result.ok, true)
    const pending = store.listSettings('retry_pending:')
    assert.equal(pending.length, 1)
    assert.match(pending[0]?.value ?? '', /"attempt":1/)

    store.createJob({ id: 'job_retry_quota', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'iterate' })
    store.updateJob('job_retry_quota', { status: 'running' })
    await jobs.handleCallback('job_retry_quota', secret, { status: 'failed', error: '平台额度已用完' })
    assert.equal(store.listSettings('retry_pending:').length, 1)

    store.createJob({ id: 'job_retry_limited', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'iterate', retryAttempt: 2 })
    store.updateJob('job_retry_limited', { status: 'running' })
    await jobs.handleCallback('job_retry_limited', secret, { status: 'failed', error: 'FlyBot bridge 502' })
    assert.equal(store.listSettings('retry_pending:').length, 1)
  } finally {
    store.close()
  }
})

// Fake GitHub shared by the auto-merge tests below: every listed pull request
// is open, mergeable and green, and merge calls are recorded, not performed.
async function startGreenPullRequests(repo: string, numbers: number[], headRef: string) {
  const merges: string[] = []
  const server = await startFakeServer((request, response) => {
    const method = request.method ?? 'GET'
    const url = request.url ?? ''
    const pulls = numbers.join('|')
    const pull = new RegExp(`^/repos/o/${repo}/pulls/(${pulls})$`).exec(url)
    if (method === 'GET' && pull !== null) {
      const number = Number(pull[1])
      json(response, 200, { number, html_url: `https://github.com/o/${repo}/pull/${number}`, title: 'fix', state: 'open', head: { ref: headRef, sha: `sha${number}` }, base: { ref: 'main' }, mergeable: true, mergeable_state: 'clean', draft: false, merged: false })
      return
    }
    if (method === 'GET' && new RegExp(`^/repos/o/${repo}/commits/sha(${pulls})/check-runs\\?per_page=100$`).test(url)) {
      json(response, 200, { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] })
      return
    }
    if (method === 'GET' && new RegExp(`^/repos/o/${repo}/commits/sha(${pulls})/status$`).test(url)) {
      json(response, 200, { state: 'success', statuses: [] })
      return
    }
    if (method === 'GET' && new RegExp(`^/repos/o/${repo}/pulls/(${pulls})/reviews\\?per_page=100$`).test(url)) {
      json(response, 200, [])
      return
    }
    if (method === 'GET' && url === `/repos/o/${repo}/branches/main/protection`) {
      json(response, 200, { protected: false, required_status_checks: { contexts: [] }, required_pull_request_reviews: { required_approving_review_count: 0 } })
      return
    }
    if (method === 'PUT' && new RegExp(`^/repos/o/${repo}/pulls/(${pulls})/merge$`).test(url)) {
      merges.push(url)
      json(response, 200, { merged: true, sha: 'merged' })
      return
    }
    json(response, 404, { message: 'Not Found' })
  })
  return { server, merges }
}

test('the auto-merge reconciler merges an open Fledge PR once checks are green', async () => {
  const merges: string[] = []
  const github = await startFakeServer((request, response) => {
    const method = request.method ?? 'GET'
    const path = request.url ?? ''
    if (method === 'GET' && path === '/repos/o/reconcile/pulls/3') return json(response, 200, { number: 3, html_url: 'https://github.com/o/reconcile/pull/3', title: 'fix', state: 'open', head: { ref: 'fledge/x', sha: 'sha3' }, base: { ref: 'main' }, mergeable: true, mergeable_state: 'clean', draft: false, merged: false })
    if (method === 'GET' && path === '/repos/o/reconcile/commits/sha3/check-runs?per_page=100') return json(response, 200, { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] })
    if (method === 'GET' && path === '/repos/o/reconcile/commits/sha3/status') return json(response, 200, { state: 'success', statuses: [] })
    if (method === 'GET' && path === '/repos/o/reconcile/pulls/3/reviews?per_page=100') return json(response, 200, [])
    if (method === 'GET' && path === '/repos/o/reconcile/branches/main/protection') return json(response, 200, { required_status_checks: { contexts: ['ci'] }, required_pull_request_reviews: { required_approving_review_count: 0 } })
    if (method === 'PUT' && path === '/repos/o/reconcile/pulls/3/merge') { merges.push(path); return json(response, 200, { merged: true, sha: 'merged3' }) }
    if (method === 'POST' && path === '/repos/o/reconcile/issues/3/comments') return json(response, 200, {})
    return json(response, 404, { message: 'Not Found' })
  })
  const config = testConfig({ github: { ...testConfig().github, apiBase: github.url } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'reconcile-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_reconcile', userId: user.id, owner: 'o', name: 'reconcile', defaultBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', autoMerge: true, roleCheckedAt: new Date().toISOString(), upstreamHtmlUrl: 'https://github.com', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const job = store.createJob({ id: 'job_reconcile', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob(job.id, { status: 'succeeded', branch: 'fledge/x', pr_url: 'https://github.com/o/reconcile/pull/3', pr_state: 'open', finished_at: new Date().toISOString() })
    await jobs.reconcileAutoMerge()
    assert.equal(merges.length, 1)
    assert.equal(store.getJob(job.id)?.pr_state, 'merged')
  } finally {
    store.close()
    await github.close()
  }
})

test('the auto-merge reconciler does not merge a queued iterate job', async () => {
  const { server, merges } = await startGreenPullRequests('queued', [3], 'fledge/x')
  const config = testConfig({ github: { ...testConfig().github, apiBase: server.url } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'queued-reconcile-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_queued', userId: user.id, owner: 'o', name: 'queued', defaultBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', autoMerge: true, roleCheckedAt: new Date().toISOString(), upstreamHtmlUrl: 'https://github.com', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const job = store.createJob({ id: 'job_queued_only', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob(job.id, { branch: 'fledge/x', pr_url: 'https://github.com/o/queued/pull/3', pr_state: 'open' })
    await jobs.reconcileAutoMerge()
    assert.equal(merges.length, 0)
    assert.equal(store.getJob(job.id)?.pr_state, 'open')
    assert.equal(store.listAudit(50).filter((row) => row.action === 'job.auto_merged').length, 0)
  } finally {
    store.close()
    await server.close()
  }
})

test('the auto-merge reconciler does not merge a failed iterate job', async () => {
  const { server, merges } = await startGreenPullRequests('failed', [3], 'fledge/x')
  const config = testConfig({ github: { ...testConfig().github, apiBase: server.url } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'failed-reconcile-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_failed', userId: user.id, owner: 'o', name: 'failed', defaultBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', autoMerge: true, roleCheckedAt: new Date().toISOString(), upstreamHtmlUrl: 'https://github.com', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const job = store.createJob({ id: 'job_failed_only', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob(job.id, { status: 'failed', branch: 'fledge/x', pr_url: 'https://github.com/o/failed/pull/3', pr_state: 'open', error: 'bridge 502' })
    await jobs.reconcileAutoMerge()
    assert.equal(merges.length, 0)
    assert.equal(store.getJob(job.id)?.pr_state, 'open')
  } finally {
    store.close()
    await server.close()
  }
})

test('a queued follow-up blocks a merge even when an older job for the same PR succeeded', async () => {
  const { server, merges } = await startGreenPullRequests('followup', [3], 'fledge/x')
  const config = testConfig({ github: { ...testConfig().github, apiBase: server.url } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'followup-reconcile-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_followup', userId: user.id, owner: 'o', name: 'followup', defaultBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', autoMerge: true, roleCheckedAt: new Date().toISOString(), upstreamHtmlUrl: 'https://github.com', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const prUrl = 'https://github.com/o/followup/pull/3'
    const first = store.createJob({ id: 'job_first_succeeded', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob(first.id, { status: 'succeeded', branch: 'fledge/x', pr_url: prUrl, pr_state: 'open', finished_at: new Date().toISOString() })
    const second = store.createJob({ id: 'job_second_queued', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob(second.id, { branch: 'fledge/x', pr_url: prUrl, pr_state: 'open' })
    store.run('UPDATE jobs SET created_at = ? WHERE id = ?', '2026-01-01T00:00:00.000Z', first.id)
    store.run('UPDATE jobs SET created_at = ? WHERE id = ?', '2026-01-01T00:00:01.000Z', second.id)
    await jobs.reconcileAutoMerge()
    assert.equal(merges.length, 0)
    assert.equal(store.getJob(first.id)?.pr_state, 'open')
  } finally {
    store.close()
    await server.close()
  }
})

test('the newest job for a PR wins when created_at ties', async () => {
  const { server, merges } = await startGreenPullRequests('tie', [3], 'fledge/x')
  const config = testConfig({ github: { ...testConfig().github, apiBase: server.url } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'tie-reconcile-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_tie', userId: user.id, owner: 'o', name: 'tie', defaultBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', autoMerge: true, roleCheckedAt: new Date().toISOString(), upstreamHtmlUrl: 'https://github.com', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const prUrl = 'https://github.com/o/tie/pull/3'
    const first = store.createJob({ id: 'job_tie_succeeded', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob(first.id, { status: 'succeeded', branch: 'fledge/x', pr_url: prUrl, pr_state: 'open', finished_at: new Date().toISOString() })
    const second = store.createJob({ id: 'job_tie_queued', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob(second.id, { branch: 'fledge/x', pr_url: prUrl, pr_state: 'open' })
    store.run('UPDATE jobs SET created_at = ? WHERE id IN (?, ?)', '2026-01-02T00:00:00.000Z', first.id, second.id)
    await jobs.reconcileAutoMerge()
    assert.equal(merges.length, 0)
    assert.equal(store.getJob(first.id)?.pr_state, 'open')
  } finally {
    store.close()
    await server.close()
  }
})

test('the callback-path merge refuses a job that is not the newest succeeded iterate job', async () => {
  const { server, merges } = await startGreenPullRequests('callback', [3], 'fledge/x')
  const config = testConfig({ github: { ...testConfig().github, apiBase: server.url } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'callback-reconcile-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_callback', userId: user.id, owner: 'o', name: 'callback', defaultBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', autoMerge: true, roleCheckedAt: new Date().toISOString(), upstreamHtmlUrl: 'https://github.com', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const job = store.createJob({ id: 'job_callback_queued', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob(job.id, { branch: 'fledge/x', pr_url: 'https://github.com/o/callback/pull/3', pr_state: 'open' })
    await jobs.reconcilePr(repo, 'https://github.com/o/callback/pull/3')
    assert.equal(merges.length, 0)
    assert.equal(store.getJob(job.id)?.pr_state, 'open')
  } finally {
    store.close()
    await server.close()
  }
})

test('mergeCleanPrs skips a PR whose newest iterate job is not succeeded', async () => {
  const { server, merges } = await startGreenPullRequests('r', [4, 5], 'fledge/fix')
  const config = testConfig({ github: { ...testConfig().github, apiBase: server.url } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'bulk-skip-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_bulk_skip', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', requireProtection: false, upstreamHtmlUrl: 'https://github.com/o/r', forkHtmlUrl: 'https://github.com/o/r', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const done = store.createJob({ id: 'job_bulk_succeeded', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob(done.id, { status: 'succeeded', branch: 'fledge/fix', pr_url: 'https://github.com/o/r/pull/4', pr_state: 'open', finished_at: new Date().toISOString() })
    const waiting = store.createJob({ id: 'job_bulk_queued', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob(waiting.id, { branch: 'fledge/fix', pr_url: 'https://github.com/o/r/pull/5', pr_state: 'open' })
    const result = await jobs.mergeCleanPrs(repo.id)
    assert.deepEqual(result.merged, ['job_bulk_succeeded'])
    assert.equal(result.skipped.length, 1)
    assert.equal(result.skipped[0]?.jobId, 'job_bulk_queued')
    assert.match(result.skipped[0]?.message ?? '', /queued/)
    assert.equal(merges.length, 1)
  } finally {
    store.close()
    await server.close()
  }
})

test('the bulk merge leaves a merged or closed pull request out of its candidates', async () => {
  const merges: string[] = []
  const requested: string[] = []
  const github = await startFakeServer((request, response) => {
    const method = request.method ?? 'GET'
    const url = request.url ?? ''
    requested.push(url)
    const pull = /^\/repos\/o\/merged\/pulls\/(4|5|6)$/.exec(url)
    if (method === 'GET' && pull !== null) {
      const number = Number(pull[1])
      // 5 is already merged on GitHub and 6 was closed without merging; both of
      // their newest iterate jobs succeeded earlier, which is exactly the row
      // the bulk merge must not pick up again.
      json(response, 200, { number, html_url: `https://github.com/o/merged/pull/${number}`, title: 'fix', state: number === 4 ? 'open' : 'closed', head: { ref: 'fledge/fix', sha: `sha${number}` }, base: { ref: 'main' }, mergeable: true, mergeable_state: 'clean', draft: false, merged: number === 5 })
      return
    }
    if (method === 'GET' && /^\/repos\/o\/merged\/commits\/sha(4|5|6)\/check-runs\?per_page=100$/.test(url)) {
      json(response, 200, { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] })
      return
    }
    if (method === 'GET' && /^\/repos\/o\/merged\/commits\/sha(4|5|6)\/status$/.test(url)) {
      json(response, 200, { state: 'success', statuses: [] })
      return
    }
    if (method === 'GET' && /^\/repos\/o\/merged\/pulls\/(4|5|6)\/reviews\?per_page=100$/.test(url)) {
      json(response, 200, [])
      return
    }
    if (method === 'GET' && url === '/repos/o/merged/branches/main/protection') {
      json(response, 200, { protected: false, required_status_checks: { contexts: [] }, required_pull_request_reviews: { required_approving_review_count: 0 } })
      return
    }
    if (method === 'PUT' && /^\/repos\/o\/merged\/pulls\/(4|5|6)\/merge$/.test(url)) {
      merges.push(url)
      json(response, 200, { merged: true, sha: 'merged' })
      return
    }
    json(response, 404, { message: 'Not Found' })
  })
  const config = testConfig({ github: { ...testConfig().github, apiBase: github.url } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'bulk-merged-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_bulk_merged', userId: user.id, owner: 'o', name: 'merged', defaultBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', requireProtection: false, roleCheckedAt: new Date().toISOString(), upstreamHtmlUrl: 'https://github.com', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const open = store.createJob({ id: 'job_bulk_open', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob(open.id, { status: 'succeeded', branch: 'fledge/fix', pr_url: 'https://github.com/o/merged/pull/4', pr_state: 'open', finished_at: new Date().toISOString() })
    const merged = store.createJob({ id: 'job_bulk_merged', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob(merged.id, { status: 'succeeded', branch: 'fledge/fix', pr_url: 'https://github.com/o/merged/pull/5', pr_state: 'merged', finished_at: new Date().toISOString() })
    const closed = store.createJob({ id: 'job_bulk_closed', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob(closed.id, { status: 'succeeded', branch: 'fledge/fix', pr_url: 'https://github.com/o/merged/pull/6', pr_state: 'closed', finished_at: new Date().toISOString() })

    assert.deepEqual(store.listNewestPrJobsForRepo(repo.id).map((row) => row.id).sort(), ['job_bulk_open'])
    const result = await jobs.mergeCleanPrs(repo.id)
    assert.deepEqual(result.merged, ['job_bulk_open'])
    assert.deepEqual(result.skipped, [])
    assert.deepEqual(merges, ['/repos/o/merged/pulls/4/merge'])
    assert.equal(requested.some((url) => url.includes('/pulls/5') || url.includes('/pulls/6')), false)
    assert.equal(store.getJob(merged.id)?.pr_state, 'merged')
    assert.equal(store.getJob(closed.id)?.pr_state, 'closed')
  } finally {
    store.close()
    await github.close()
  }
})

test('open operational alerts notify the owner once and clear after resolution', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'ops-alert-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_ops_alert', userId: user.id, owner: 'o', name: 'ops', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440, monthlyBudgetCny: 1 })
    store.recordUsage(user.id, null, 0.9, null, repo.id)
    assert.equal(store.listNotifications(user.id).length, 0)
    assert.equal(await jobs.notifyOpsAlerts(), 1)
    assert.equal(store.listNotifications(user.id).length, 1)
    assert.equal(await jobs.notifyOpsAlerts(), 0)
    assert.equal(store.listNotifications(user.id).length, 1)
    store.updateRepo(repo.id, { monthly_budget_cny: 0 })
    assert.equal(await jobs.notifyOpsAlerts(), 0)
    store.updateRepo(repo.id, { monthly_budget_cny: 1 })
    assert.equal(await jobs.notifyOpsAlerts(), 1)
  } finally {
    store.close()
  }
})

test('a claimed green test is contradicted when the test check fails', async () => {
  const github = await startFakeServer((request, response) => {
    const path = request.url ?? ''
    if (path.includes('/pulls/8/files')) return json(response, 200, [{ filename: 'src/x.ts', status: 'modified', additions: 1, deletions: 0 }])
    if (path.includes('/pulls/8/reviews')) return json(response, 200, [])
    if (path.includes('/commits/sha8/check-runs')) return json(response, 200, { check_runs: [{ name: 'test (22)', status: 'completed', conclusion: 'failure' }] })
    if (path.includes('/commits/sha8/status')) return json(response, 200, { state: 'success', statuses: [] })
    if (path.includes('/pulls/8')) return json(response, 200, { number: 8, html_url: 'https://github.com/o/evidence/pull/8', title: 'fix', state: 'open', head: { ref: 'fledge/x', sha: 'sha8' }, base: { ref: 'main' }, mergeable: true, mergeable_state: 'clean', draft: false, merged: false })
    return json(response, 404, { message: 'Not Found' })
  })
  const config = testConfig({ github: { ...testConfig().github, apiBase: github.url } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'evidence-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_evidence', userId: user.id, owner: 'o', name: 'evidence', defaultBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', roleCheckedAt: new Date().toISOString(), upstreamHtmlUrl: 'https://github.com', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const job = store.createJob({ id: 'job_evidence', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob(job.id, { status: 'succeeded', branch: 'fledge/x', pr_url: 'https://github.com/o/evidence/pull/8', evidence_json: JSON.stringify({ testGreen: 'tests pass' }) })
    const result = await jobs.recheck(job.id)
    assert.equal(result.ok, false)
    const verification = JSON.parse(store.getJob(job.id)?.verification_json ?? '{}') as { testEvidence?: { state?: string } }
    assert.equal(verification.testEvidence?.state, 'contradicted')
  } finally {
    store.close()
    await github.close()
  }
})

test('an iterate job with an existing issue PR is rejected as duplicate', async () => {
  const github = await startFakeServer((request, response) => {
    if ((request.url ?? '').includes('/pulls?state=open')) {
      return json(response, 200, [{ number: 9, html_url: 'https://github.com/o/dup/pull/9', title: 'Fix #42', body: 'Fixes https://github.com/o/dup/issues/42', head: { ref: 'fledge/existing' }, base: { ref: 'main' } }])
    }
    return json(response, 404, { message: 'Not Found' })
  })
  const config = testConfig({ github: { ...testConfig().github, apiBase: github.url } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'flybot', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'dup-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_dup', userId: user.id, owner: 'o', name: 'dup', defaultBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const item = store.createWorkItem({ id: 'work_dup', repoId: repo.id, userId: user.id, title: 'Fix #42', detail: '', issueUrl: 'https://github.com/o/dup/issues/42' })
    const result = await jobs.enqueue(repo, 'manual', 'Fix this issue', 'iterate', { workItemId: item.id })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'DUPLICATE_WORK')
    assert.match(result.error ?? '', /pull\/9/)
    assert.equal(store.listJobsForRepo(repo.id).length, 0)
  } finally {
    store.close()
    await github.close()
  }
})

test('an iterate job whose fix already landed is refused as already-fixed, not as work in flight', async () => {
  // #174: the preflight only listed open pull requests, so a re-run of work that
  // had already merged was blocked with the same verdict as a genuine duplicate.
  const github = await startFakeServer((request, response) => {
    const path = request.url ?? ''
    if (path.includes('/pulls?state=open')) return json(response, 200, [])
    if (path.includes('/pulls?state=closed')) {
      return json(response, 200, [
        { number: 7, html_url: 'https://github.com/o/dup/pull/7', title: 'Fix it', body: 'Fixes https://github.com/o/dup/issues/42', head: { ref: 'fix' }, base: { ref: 'main' }, merged_at: '2026-11-09T10:00:00Z', merge_commit_sha: 'merge-sha-7' },
      ])
    }
    if (path.includes('/issues/42')) return json(response, 200, { number: 42, state: 'closed' })
    // Everything after the duplicate check succeeds, so the red half at the base
    // is the missing verdict and the job it let through, not an unrelated refusal.
    if (path.includes('/branches/main')) return json(response, 200, { name: 'main', commit: { sha: 'sha-main' } })
    if (path.includes('/contents/')) return json(response, 200, [])
    return json(response, 404, { message: 'Not Found' })
  })
  const config = testConfig({ github: { ...testConfig().github, apiBase: github.url } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'flybot', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'fixed-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_fixed', userId: user.id, owner: 'o', name: 'dup', defaultBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const item = store.createWorkItem({ id: 'work_fixed', repoId: repo.id, userId: user.id, title: 'Fix #42', detail: '', issueUrl: 'https://github.com/o/dup/issues/42' })
    const result = await jobs.enqueue(repo, 'manual', 'Fix this issue', 'iterate', { workItemId: item.id })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'ALREADY_FIXED', 'already-fixed work is still reported as a duplicate in flight')
    const audit = store.listAudit().find((row) => row.action === 'job.duplicate_work')
    assert.match(audit?.detail ?? '', /already fixed by https:\/\/github\.com\/o\/dup\/pull\/7/, 'the audit row does not name the merged pull request')
    assert.match(audit?.detail ?? '', /merge-sha-7/, 'the audit row does not carry the merge commit')
    assert.equal(store.listJobsForRepo(repo.id).length, 0, 'a job was created for work that already landed')
  } finally {
    store.close()
    await github.close()
  }
})

test('a merged pull request that only mentions the issue lets the work through while the issue is open', async () => {
  // #174 review at fe217420: a merged `Follow-up to #42` was enough to refuse a
  // job and to tell the maintainer the fix was already in. The issue is the fact
  // that decides it, so an open issue is not a fix however the pull request reads.
  const github = await startFakeServer((request, response) => {
    const path = request.url ?? ''
    if (path.includes('/pulls?state=open')) return json(response, 200, [])
    if (path.includes('/pulls?state=closed')) {
      return json(response, 200, [
        { number: 7, html_url: 'https://github.com/o/dup/pull/7', title: 'Follow-up to #42', body: 'This does not close #42', head: { ref: 'follow-up' }, base: { ref: 'main' }, merged_at: '2026-11-09T10:00:00Z', merge_commit_sha: 'merge-sha-7' },
      ])
    }
    if (path.includes('/issues/42')) return json(response, 200, { number: 42, state: 'open' })
    if (path.includes('/branches/main')) return json(response, 200, { name: 'main', commit: { sha: 'sha-main' } })
    if (path.includes('/contents/')) return json(response, 200, [])
    return json(response, 404, { message: 'Not Found' })
  })
  const config = testConfig({ github: { ...testConfig().github, apiBase: github.url } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'flybot', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'mention-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_mention', userId: user.id, owner: 'o', name: 'dup', defaultBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const item = store.createWorkItem({ id: 'work_mention', repoId: repo.id, userId: user.id, title: 'Fix #42', detail: '', issueUrl: 'https://github.com/o/dup/issues/42' })
    const result = await jobs.enqueue(repo, 'manual', 'Fix this issue', 'iterate', { workItemId: item.id })
    assert.notEqual(result.code, 'ALREADY_FIXED', 'an open issue was reported as already fixed')
    assert.equal(store.listJobsForRepo(repo.id).length, 1, 'the job was refused for an issue nobody fixed')
    assert.equal(store.listAudit().filter((row) => row.action === 'job.duplicate_work').length, 0, 'a mention was recorded as a fact')
  } finally {
    store.close()
    await github.close()
  }
})

test('a rejected pull request preflight fails open and still starts the job', async () => {
  const github = await startFakeServer((request, response) => {
    const path = request.url ?? ''
    if (path.includes('/pulls?state=open')) return json(response, 403, { message: 'Resource not accessible by integration' })
    if (path.includes('/branches/main')) return json(response, 200, { name: 'main', commit: { sha: 'sha-main' } })
    if (path.includes('/contents/')) return json(response, 200, [])
    return json(response, 404, { message: 'Not Found' })
  })
  const config = testConfig({ github: { ...testConfig().github, apiBase: github.url } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'flybot', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'forbidden-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_forbidden', userId: user.id, owner: 'o', name: 'dup', defaultBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const item = store.createWorkItem({ id: 'work_forbidden', repoId: repo.id, userId: user.id, title: 'Fix #42', detail: '', issueUrl: 'https://github.com/o/dup/issues/42' })
    const result = await jobs.enqueue(repo, 'manual', 'Fix this issue', 'iterate', { workItemId: item.id })
    assert.equal(result.ok, true)
    assert.equal(store.listJobsForRepo(repo.id).length, 1)
    assert.equal(store.listAudit().filter((row) => row.action === 'job.duplicate_work').length, 0)
  } finally {
    store.close()
    await github.close()
  }
})

test('a non-flybot runner makes no duplicate lookup', async () => {
  // #113 review F3: the duplicate preflight used to run before the `runner.name
  // !== 'flybot'` guard the sibling preflight has, so a deployment with another
  // runner decrypted the repo token and made GitHub reads it never made before.
  const requested: string[] = []
  const github = await startFakeServer((request, response) => {
    requested.push(request.url ?? '')
    return json(response, 404, { message: 'Not Found' })
  })
  const config = testConfig({ github: { ...testConfig().github, apiBase: github.url } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'capture', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'other-runner-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_other_runner', userId: user.id, owner: 'o', name: 'dup', defaultBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const item = store.createWorkItem({ id: 'work_other_runner', repoId: repo.id, userId: user.id, title: 'Fix #42', detail: '', issueUrl: 'https://github.com/o/dup/issues/42' })
    const result = await jobs.enqueue(repo, 'manual', 'Fix this issue', 'iterate', { workItemId: item.id })
    assert.equal(result.ok, true)
    assert.equal(requested.filter((url) => url.includes('/pulls?state=open')).length, 0, 'no duplicate lookup for a non-flybot runner')
    assert.equal(store.listJobsForRepo(repo.id).length, 1, 'the job is still created')
  } finally {
    store.close()
    await github.close()
  }
})

test('a dispatch without an issue reference makes no GitHub call', async () => {
  const requested: string[] = []
  const github = await startFakeServer((request, response) => {
    requested.push(request.url ?? '')
    return json(response, 404, { message: 'Not Found' })
  })
  const config = testConfig({ github: { ...testConfig().github, apiBase: github.url } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'noref-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_noref', userId: user.id, owner: 'o', name: 'dup', defaultBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const result = await jobs.enqueue(repo, 'manual', 'Improve the landing page copy', 'iterate')
    assert.equal(result.ok, true)
    assert.deepEqual(requested, [])
    assert.equal(store.listJobsForRepo(repo.id).length, 1)
  } finally {
    store.close()
    await github.close()
  }
})

test('scheduled jobs carry the previous run and open work, and classify meta output', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const contexts: RunnerContext[] = []
  const runner: Runner = {
    name: 'capture',
    async run(context) {
      contexts.push(context)
      return { status: 'running' }
    },
  }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  // #365: the block reads live state through GitHub; this case is about what the
  // goal carries, so the reader answers without a request.
  jobs.carryOverReaderOverride = () => ({ read: async () => 'open' })
  try {
    const user = makeUser(store, { login: 'continuity-user', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_continuity_job', userId: user.id, owner: 'o', name: 'continuity',
      defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
      repoRole: 'developer', goal: 'fix bugs', autoIterate: true, intervalMinutes: 60,
    })
    store.createJob({
      id: 'job_prev', repoId: repo.id, userId: user.id, trigger: 'schedule',
      goal: 'fix bugs', callbackHash: 'h', platformTokenHash: '', kind: 'iterate',
    })
    const at = new Date().toISOString()
    store.updateJob('job_prev', {
      status: 'succeeded', summary: 'created issue #1',
      issue_url: 'https://github.com/o/continuity/issues/1',
      started_at: at, finished_at: at,
    })
    store.createWorkItem({
      id: 'work_open', repoId: repo.id, userId: user.id,
      title: 'fix the thing', issueUrl: 'https://github.com/o/continuity/issues/1',
      state: 'triaged',
    })

    const result = await jobs.enqueue(repo, 'schedule', undefined, 'iterate')
    assert.equal(result.ok, true)
    const goal = contexts[0]?.goal ?? ''
    assert.match(goal, /\[Carry-over/)
    assert.match(goal, /created issue #1/)
    // #788: the line states the live state the read observed, and the row's own
    // state is not presented as it.
    assert.match(goal, /work_open observed \d{2}:\d{2}Z open/)
    assert.doesNotMatch(goal, /work_open state=/)
    assert.equal(store.getJob(result.job!.id)?.continuity_used, 1)

    // The invariant allows one active job per repository, so the carried-over job
    // has to finish before the meta-output case enqueues its own.
    store.updateJob(result.job!.id, { status: 'succeeded', finished_at: new Date().toISOString() })
    store.releaseJobLease(result.job!.id)

    const secret = 'callback-secret'
    store.createJob({
      id: 'job_meta', repoId: repo.id, userId: user.id, trigger: 'schedule',
      goal: '存量清账', callbackHash: sha256Hex(secret), platformTokenHash: '',
    })
    store.updateJob('job_meta', { status: 'running' })
    const cb = await jobs.handleCallback('job_meta', secret, {
      status: 'succeeded', issueUrl: 'https://github.com/o/continuity/issues/2', summary: '存量清账',
    })
    assert.equal(cb.ok, true)
    const row = store.getJob('job_meta')
    assert.equal(row?.output_kind, 'meta')
    assert.match(row?.continuity_json ?? '', /"output_kind":"meta"/)
    const metaItem = store.findWorkItemByIssueUrl(repo.id, 'https://github.com/o/continuity/issues/2')
    assert.equal(metaItem?.state, 'closed')
  } finally {
    store.close()
  }
})

function queueRepoFor(store: Store, userId: string, id: string): ReturnType<Store['createRepo']> {
  return store.createRepo({
    id,
    userId,
    owner: 'o',
    name: id,
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
}

function leaseSetup(): { store: Store; repoId: string; repo2Id: string; userId: string } {
  const store = new Store(':memory:')
  const user = makeUser(store, { login: 'lease-user', status: 'approved' })
  const repo = queueRepoFor(store, user.id, 'repo_lease')
  const repo2 = queueRepoFor(store, user.id, 'repo_lease_2')
  return { store, repoId: repo.id, repo2Id: repo2.id, userId: user.id }
}

function leaseMakeJob(store: Store, repoId: string, userId: string, id: string, priority = 0): void {
  store.createJob({
    id,
    repoId,
    userId,
    trigger: 'schedule',
    goal: 'g',
    callbackHash: 'h',
    platformTokenHash: '',
    kind: 'iterate',
    priority,
  })
}

test('claimQueuedJob leases the highest-priority queued job exactly once', () => {
  const { store, repoId, repo2Id, userId } = leaseSetup()
  try {
    leaseMakeJob(store, repo2Id, userId, 'job_low', 0)
    leaseMakeJob(store, repoId, userId, 'job_high', 10)

    const first = store.claimQueuedJob('worker-1', 60_000)
    assert.equal(first?.id, 'job_high')
    assert.equal(first?.lease_owner, 'worker-1')
    assert.ok(first?.lease_until)

    const second = store.claimQueuedJob('worker-2', 60_000)
    assert.equal(second?.id, 'job_low')
    assert.equal(second?.lease_owner, 'worker-2')

    assert.equal(store.claimQueuedJob('worker-3', 60_000), undefined)
  } finally {
    store.close()
  }
})

// #545: two jobs that arrive together are ordered by whatever the query happens
// to return, because nothing stable distinguishes them. The ticket is that
// distinction: allocated in the insert transaction, never reused, and the only
// tie-break below priority.
function leaseMakeJobAt(store: Store, repoId: string, userId: string, id: string, priority: number, createdAt: string): void {
  store.createJob({
    id,
    repoId,
    userId,
    trigger: 'schedule',
    goal: 'g',
    callbackHash: 'h',
    platformTokenHash: '',
    kind: 'iterate',
    priority,
    createdAt,
  })
}

const SAME_ARRIVAL = '2026-11-13T00:00:00.000Z'

// One active job per repository, so each queue row needs its own repo.
function ticketRepo(store: Store, userId: string, id: string): string {
  return queueRepoFor(store, userId, id).id
}

test('a queued job gets a persistent ticket, so equal arrivals keep a stable order', () => {
  const { store, userId } = leaseSetup()
  try {
    leaseMakeJobAt(store, ticketRepo(store, userId, 'repo_t_a'), userId, 'job_a', 0, SAME_ARRIVAL)
    leaseMakeJobAt(store, ticketRepo(store, userId, 'repo_t_b'), userId, 'job_b', 0, SAME_ARRIVAL)
    leaseMakeJobAt(store, ticketRepo(store, userId, 'repo_t_c'), userId, 'job_c', 0, SAME_ARRIVAL)

    assert.equal(store.getJob('job_a')?.queue_seq, 1, 'the first arrival holds the first ticket')
    assert.equal(store.getJob('job_b')?.queue_seq, 2)
    assert.equal(store.getJob('job_c')?.queue_seq, 3)
    assert.deepEqual(store.listQueuedJobs().map((job) => job.id), ['job_a', 'job_b', 'job_c'])
  } finally {
    store.close()
  }
})

test('a priority change takes a tail ticket, and a no-op save keeps the one it has', () => {
  const { store, userId } = leaseSetup()
  try {
    leaseMakeJobAt(store, ticketRepo(store, userId, 'repo_t_a'), userId, 'job_a', 0, SAME_ARRIVAL)
    leaseMakeJobAt(store, ticketRepo(store, userId, 'repo_t_b'), userId, 'job_b', 0, SAME_ARRIVAL)
    leaseMakeJobAt(store, ticketRepo(store, userId, 'repo_t_c'), userId, 'job_c', 0, SAME_ARRIVAL)

    store.updateJob('job_a', { priority: 0 })
    assert.equal(store.getJob('job_a')?.queue_seq, 1, 'saving the same priority is not a new arrival')

    store.updateJob('job_a', { priority: 5 })
    assert.equal(store.getJob('job_a')?.queue_seq, 4, 'a real change goes to the tail of its new level')
    // Priority first, ticket second: the promoted job now leads, and the two it
    // passed keep their order relative to each other.
    assert.deepEqual(store.listQueuedJobs().map((job) => job.id), ['job_a', 'job_b', 'job_c'])
    // Saving the new value again is a no-op, not another move.
    store.updateJob('job_a', { priority: 5 })
    assert.equal(store.getJob('job_a')?.queue_seq, 4)
  } finally {
    store.close()
  }
})

test('the claim follows the ticket, not the clock, when two jobs arrive together', () => {
  const { store, userId } = leaseSetup()
  try {
    leaseMakeJobAt(store, ticketRepo(store, userId, 'repo_t_a'), userId, 'job_a', 0, SAME_ARRIVAL)
    leaseMakeJobAt(store, ticketRepo(store, userId, 'repo_t_b'), userId, 'job_b', 0, SAME_ARRIVAL)

    const first = store.claimQueuedJob('worker-1', 60_000)
    assert.equal(first?.id, 'job_a')
    assert.equal(first?.queue_seq, 1)
    const second = store.claimQueuedJob('worker-2', 60_000)
    assert.equal(second?.id, 'job_b')
    assert.equal(second?.queue_seq, 2)
  } finally {
    store.close()
  }
})

// -- scheduled-iteration continuity -----------------------------------------

const now = Date.now()
const iso = (offsetMs = 0): string => new Date(now + offsetMs).toISOString()

function repo(overrides: Partial<RepoRow> = {}): RepoRow {
  return {
    id: 'repo_1', user_id: 'usr_1', owner: 'octo', name: 'demo',
    default_branch: 'main', token_enc: 'x', goal: 'fix bugs',
    enabled: 1, auto_iterate: 1, interval_minutes: 60, last_run_at: null,
    last_status: null, created_at: iso(-86_400_000),
    upstream_owner: 'octo', upstream_name: 'demo', fork_owner: 'octo',
    fork_name: 'demo', upstream_default_branch: 'main',
    fork_default_branch: 'main', is_fork: 0, fork_created: 0,
    permission: 'write', can_review: 1, can_create_issue: 1,
    reviewer_enabled: 0, review_interval_minutes: 1440,
    last_review_at: null, last_review_status: null,
    upstream_html_url: 'https://github.com/octo/demo',
    fork_html_url: 'https://github.com/octo/demo',
    installation_id: null, target_branch: 'main', job_mode: 'iterate',
    repo_role: 'developer', auto_merge: 0, role_checked_at: null,
    plan_required: 0, allow_paths: '', deny_paths: '', merge_method: 'squash',
    require_protection: 1, monthly_budget_cny: 0, job_budget_cny: 0,
    protection_state: null, protection_checked_at: null, stage_mode: 'off',
    models_dirty: 0, credential_state: 'ok', consecutive_failures: 0,
    allow_private_models: 0, ...overrides,
  } as RepoRow
}

function workItem(overrides: Partial<WorkItemRow> = {}): WorkItemRow {
  return {
    id: 'work_1', repo_id: 'repo_1', user_id: 'usr_1', title: 'fix the thing',
    detail: '', issue_url: 'https://github.com/octo/demo/issues/1', pr_url: null,
    state: 'triaged', closed_reason: null, priority: 0, assignee_user_id: null, job_id: null,
    pr_state: null, merged_at: null, merge_commit: null,
    created_at: iso(-3_600_000), updated_at: iso(-3_600_000), ...overrides,
  }
}

function job(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 'job_1', repo_id: 'repo_1', user_id: 'usr_1', status: 'succeeded',
    trigger: 'schedule', goal: 'fix bugs', branch: null, base_branch: 'main',
    pr_url: null, summary: 'did a thing', error: null, cost_usd: 0,
    platform_token_hash: null, callback_hash: 'h', kind: 'iterate',
    issue_url: null, pr_state: null, review_score: null,
    attribution_json: null, evidence_json: null, checkpoint: null,
    team_stats_json: null, work_item_id: null, priority: 0,
    plan_approved_at: null, plan_approved_by: null, plan_rejected_at: null,
    plan_allow_paths: null, plan_deny_paths: null, base_sha: null,
    callback_fingerprint: null, path_guard_json: null,
    verification_json: null, continuity_json: null, output_kind: null,
    continuity_used: 0, retry_attempt: 0, retry_of: null,
    created_at: iso(-3_600_000), started_at: iso(-3_000_000),
    last_callback_at: null, finished_at: iso(-2_400_000), ...overrides,
  } as JobRow
}

test('meta titles are recognised and classified separately', () => {
  assert.equal(isMetaTitle('【存量清账】open PR 82 + open issue 248'), true)
  assert.equal(isMetaTitle('fix: the about-you entry'), false)
  assert.equal(classifyOutput({ status: 'succeeded', kind: 'iterate', prUrl: 'https://x/pr/1' }), 'pr')
  assert.equal(classifyOutput({ status: 'succeeded', kind: 'iterate', issueUrl: 'https://x/issues/1' }), 'issue')
  assert.equal(classifyOutput({ status: 'succeeded', kind: 'iterate' }), 'zero')
  assert.equal(classifyOutput({ status: 'succeeded', kind: 'iterate', issueUrl: 'https://x/issues/1', summary: '存量清账' }), 'meta')
  assert.equal(classifyOutput({ status: 'succeeded', kind: 'review' }), 'review')
  assert.equal(classifyOutput({ status: 'failed', kind: 'iterate', prUrl: 'https://x/pr/1' }), 'failed')
  // The carry-over block names the forbidden words, so reading the goal would
  // classify every scheduled issue as meta.
  const carried = buildRunDigest(
    job({
      id: 'job_carried',
      goal: '[Carry-over - auto-generated state, not a new goal]\nDo not create inventory, backlog, or "存量/盘点/清账" issues.',
      issue_url: 'https://x/issues/1',
    }),
    { status: 'succeeded' },
  )
  assert.equal(carried.output_kind, 'issue')
})

test('carry-over is bounded, names the open work and is explicitly data', async () => {
  const { text } = await buildCarryOver({
    recent: [job({ id: 'job_2', summary: 'created issue #2', issue_url: 'https://x/issues/2' })],
    openWork: [workItem({ pr_url: 'https://x/pr/3', state: 'pr_ready' })],
    maxChars: 500,
  })
  assert.ok(text.length <= 500)
  assert.match(text, /not a new goal/)
  assert.match(text, /Recent runs:/)
  assert.match(text, /Open work:/)
  assert.match(text, /work_1 priority=0/)
  assert.doesNotMatch(text, /work_1 state=/)
  assert.match(text, /https:\/\/x\/pr\/3/)
})

test('a due repo with no open work stays idle until discovery is due', async () => {
  const next = await decideNextJob({
    repo: repo(), now, lastRunAt: iso(-2 * 3_600_000), intervalMinutes: 60,
    lastDurationMs: 1_000, failureStreak: 0, openWork: [], reviewerEnabled: false, reviewDue: true,
    lastDiscoverAt: iso(-60 * 60_000), discoverIntervalMinutes: 720,
  })
  assert.deepEqual(next, { kind: 'none', reason: 'idle' })
})

test('an idle repo runs one discovery session when the discovery interval is due', async () => {
  const next = await decideNextJob({
    repo: repo(), now, lastRunAt: iso(-2 * 3_600_000), intervalMinutes: 60,
    lastDurationMs: 1_000, failureStreak: 0, openWork: [], reviewerEnabled: false, reviewDue: true,
    lastDiscoverAt: iso(-13 * 60 * 60_000), discoverIntervalMinutes: 720,
  })
  assert.deepEqual(next, { kind: 'discover' })
})

test('open work continues instead of starting another isolated iterate', async () => {
  const pr = workItem({ pr_url: 'https://x/pr/3', state: 'pr_ready' })
  const followup = await decideNextJob({
    repo: repo({ repo_role: 'developer' }), now, lastRunAt: iso(-2 * 3_600_000),
    intervalMinutes: 60, lastDurationMs: 0, failureStreak: 0, openWork: [pr], reviewerEnabled: true, reviewDue: true,
  })
  assert.equal(followup.kind, 'followup')
  assert.equal(followup.kind === 'followup' ? followup.workItemId : null, 'work_1')

  const review = await decideNextJob({
    repo: repo({ repo_role: 'maintainer' }), now, lastRunAt: iso(-2 * 3_600_000),
    intervalMinutes: 60, lastDurationMs: 0, failureStreak: 0, openWork: [pr], reviewerEnabled: true, reviewDue: true,
  })
  assert.equal(review.kind, 'review')
  assert.equal(review.kind === 'review' ? review.prUrl : null, 'https://x/pr/3')

  const scoped = await decideNextJob({
    repo: repo(), now, lastRunAt: iso(-2 * 3_600_000), intervalMinutes: 60,
    lastDurationMs: 0, failureStreak: 0, openWork: [workItem()], reviewerEnabled: false, reviewDue: false,
  })
  assert.equal(scoped.kind, 'followup')
})

// -- #789: the decision that produces the run is evidence-linked too ---------

function fakeArtifactReader(outcome: CarryOverLinkState | 'throw'): CarryOverReader & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    async read(link: string) {
      reads.push(link)
      if (outcome === 'throw') throw new Error('the state could not be read')
      return outcome
    },
  }
}

function dueState(overrides: Partial<SchedulerState> = {}): SchedulerState {
  return {
    repo: repo({ repo_role: 'developer' }), now, lastRunAt: iso(-2 * 3_600_000),
    intervalMinutes: 60, lastDurationMs: 0, failureStreak: 0,
    openWork: [workItem()], reviewerEnabled: false, reviewDue: false, ...overrides,
  }
}

test('a merged artifact turns the chosen item into a fresh iterate, not a continuation', async () => {
  const read = fakeArtifactReader('merged')
  const next = await decideNextJob(dueState({ openWork: [workItem({ pr_url: 'https://x/pr/3', state: 'pr_ready' })] }), { read })
  assert.equal(next.kind, 'iterate')
  assert.equal(next.kind === 'iterate' ? next.staleWorkItemId : null, 'work_1')
  assert.equal(next.kind === 'iterate' ? next.artifactState : null, 'merged')
  assert.deepEqual(read.reads, ['https://x/pr/3'])

  // A merged pull request is the finished state of the work; a due review
  // window does not turn it back into a review job.
  const reviewing = fakeArtifactReader('merged')
  const reviewNext = await decideNextJob(dueState({
    repo: repo({ repo_role: 'maintainer' }), reviewerEnabled: true, reviewDue: true,
    openWork: [workItem({ pr_url: 'https://x/pr/3', state: 'pr_ready' })],
  }), { read: reviewing })
  assert.equal(reviewNext.kind, 'iterate')
})

test('a closed issue is not continued either', async () => {
  const read = fakeArtifactReader('closed')
  const next = await decideNextJob(dueState(), { read })
  assert.equal(next.kind, 'iterate')
  assert.equal(next.kind === 'iterate' ? next.artifactState : null, 'closed')
  assert.deepEqual(read.reads, ['https://github.com/octo/demo/issues/1'])
})

test('an open artifact still continues the item with one read', async () => {
  const read = fakeArtifactReader('open')
  const next = await decideNextJob(dueState(), { read })
  assert.equal(next.kind, 'followup')
  assert.equal(next.kind === 'followup' ? next.workItemId : null, 'work_1')
  assert.deepEqual(read.reads, ['https://github.com/octo/demo/issues/1'])
})

test('a failed read keeps the item and continues it', async () => {
  const read = fakeArtifactReader('throw')
  const next = await decideNextJob(dueState(), { read })
  assert.equal(next.kind, 'followup')
  assert.equal(read.reads.length, 1)
})

test('a held-back, link-less or idle repository costs no read', async () => {
  const notDue = fakeArtifactReader('merged')
  const held = await decideNextJob(dueState({ lastRunAt: iso(-30 * 60_000) }), { read: notDue })
  assert.equal(held.kind, 'none')
  assert.deepEqual(notDue.reads, [])

  const noLink = fakeArtifactReader('merged')
  const continued = await decideNextJob(dueState({ openWork: [workItem({ issue_url: null })] }), { read: noLink })
  assert.equal(continued.kind, 'followup')
  assert.deepEqual(noLink.reads, [])

  const idle = fakeArtifactReader('merged')
  const none = await decideNextJob(dueState({
    openWork: [], lastDiscoverAt: iso(-60 * 60_000), discoverIntervalMinutes: 720,
  }), { read: idle })
  assert.equal(none.kind, 'none')
  assert.deepEqual(idle.reads, [])
})

test('the interval respects the last duration and backs off after failures', async () => {
  const recent = [job({ status: 'failed' }), job({ id: 'job_0', status: 'failed' })]
  assert.equal(failureStreak(recent), 2)
  assert.equal(lastDurationMs(recent), 600_000)
  assert.equal(
    failureStreak([
      job({ id: 'job_zero_1', status: 'succeeded', output_kind: 'zero' }),
      job({ id: 'job_zero_2', status: 'succeeded', output_kind: 'zero' }),
    ]),
    2,
  )
  assert.equal(
    failureStreak([
      job({ id: 'job_review_failed', kind: 'review', status: 'failed' }),
      job({ id: 'job_iterate_ok', status: 'succeeded', output_kind: 'pr' }),
    ]),
    0,
  )
  const notDue = await decideNextJob({
    repo: repo(), now, lastRunAt: iso(-30 * 60_000), intervalMinutes: 60,
    lastDurationMs: 60 * 60_000, failureStreak: 1, openWork: [workItem()], reviewerEnabled: false, reviewDue: true,
  })
  assert.equal(notDue.kind, 'none')
  const backedOff = await decideNextJob({
    repo: repo(), now, lastRunAt: iso(-90 * 60_000), intervalMinutes: 60,
    lastDurationMs: 0, failureStreak: 3, openWork: [workItem()], reviewerEnabled: false, reviewDue: true,
  })
  assert.equal(backedOff.kind, 'none')
})


test('discovery never runs more often than every 60 minutes', async () => {
  const early = await decideNextJob({
    repo: repo(), now, lastRunAt: null, intervalMinutes: 15,
    lastDurationMs: 0, failureStreak: 0, openWork: [], reviewerEnabled: false, reviewDue: false,
    lastDiscoverAt: iso(-30 * 60_000), discoverIntervalMinutes: 15,
  })
  assert.equal(early.kind, 'none')
  const due = await decideNextJob({
    repo: repo(), now, lastRunAt: null, intervalMinutes: 15,
    lastDurationMs: 0, failureStreak: 0, openWork: [], reviewerEnabled: false, reviewDue: false,
    lastDiscoverAt: iso(-61 * 60_000), discoverIntervalMinutes: 15,
  })
  assert.equal(due.kind, 'discover')
})

test('the scheduler runs one discovery session when idle, then idles', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const runner: Runner = { name: 'capture', async run() { return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'scheduler-discover', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_scheduler_discover', userId: user.id, owner: 'o', name: 'discover',
      defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
      repoRole: 'developer', goal: 'fix bugs', autoIterate: true, intervalMinutes: 60,
    })
    await jobs.tick()
    const created = store.listJobsForRepo(repo.id)
    assert.equal(created.length, 1)
    assert.equal(created[0]?.kind, 'discover')
    assert.ok(store.getSetting(`discover:${repo.id}`) !== undefined)

    store.updateJob(created[0]!.id, { status: 'succeeded', finished_at: new Date().toISOString() })
    await jobs.tick()
    assert.equal(store.listJobsForRepo(repo.id).length, 1, 'discovery must not repeat before its interval')
    assert.equal(store.getRepo(repo.id)?.last_status, 'idle')
  } finally {
    store.close()
  }
})

test('the scheduler starts a fresh iterate when the chosen item is stale', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'capture', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'scheduler-stale', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_scheduler_stale', userId: user.id, owner: 'o', name: 'stale',
      defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
      repoRole: 'developer', goal: 'keep the parser honest', autoIterate: true, intervalMinutes: 60,
    })
    store.createWorkItem({
      id: 'work_stale', repoId: repo.id, userId: user.id, title: 'fix parser',
      issueUrl: 'https://github.com/o/stale/issues/4', state: 'triaged',
    })
    jobs.carryOverReaderOverride = () => fakeArtifactReader('closed')

    await jobs.tick()
    const created = store.listJobsForRepo(repo.id)
    assert.equal(created.length, 1)
    assert.equal(created[0]?.kind, 'iterate')
    assert.equal(created[0]?.trigger, 'schedule')
    assert.equal(created[0]?.work_item_id, null, 'the run is fresh, not owned by the stale row')
    assert.match(created[0]?.goal ?? '', /keep the parser honest/)
    assert.doesNotMatch(created[0]?.goal ?? '', /work_stale/)
    assert.equal(store.getWorkItem('work_stale')?.state, 'closed')
    assert.equal(store.listOpenWorkItems(repo.id).length, 0)
  } finally {
    store.close()
  }
})

test('the scheduler still continues a live item through its work item id', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'capture', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'scheduler-live', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_scheduler_live', userId: user.id, owner: 'o', name: 'live',
      defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
      repoRole: 'developer', goal: 'fix bugs', autoIterate: true, intervalMinutes: 60,
    })
    store.createWorkItem({
      id: 'work_live', repoId: repo.id, userId: user.id, title: 'fix parser',
      issueUrl: 'https://github.com/o/live/issues/4', state: 'triaged',
    })
    jobs.carryOverReaderOverride = () => fakeArtifactReader('open')

    await jobs.tick()
    const created = store.listJobsForRepo(repo.id)
    assert.equal(created.length, 1)
    assert.equal(created[0]?.work_item_id, 'work_live')
    assert.equal(store.getWorkItem('work_live')?.state, 'in_progress')
  } finally {
    store.close()
  }
})

test('a discover callback cannot open a branch or pull request', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'discover-pr-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_discover_pr', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'developer', upstreamHtmlUrl: 'https://github.com/o/r', goal: '', autoIterate: true, intervalMinutes: 60 })
    const secret = 'discover-pr-secret'
    store.createJob({ id: 'job_discover_pr', repoId: repo.id, userId: user.id, trigger: 'schedule', goal: 'discover', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'discover' })
    store.updateJob('job_discover_pr', { status: 'running', started_at: new Date().toISOString() })
    const result = await jobs.handleCallback('job_discover_pr', secret, { status: 'succeeded', branch: 'fledge/x', prUrl: 'https://github.com/o/r/pull/1', summary: 'found' })
    assert.equal(result.status, 422)
    assert.match(String(result.error), /DISCOVERY_PR_FORBIDDEN/)
    assert.equal(store.getJob('job_discover_pr')?.status, 'failed')
    assert.ok(store.listAudit().some((entry) => entry.action === 'job.discovery_pr_forbidden'))

    store.createJob({ id: 'job_discover_heartbeat', repoId: repo.id, userId: user.id, trigger: 'schedule', goal: 'discover', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'discover' })
    store.updateJob('job_discover_heartbeat', { status: 'running', started_at: new Date().toISOString() })
    const heartbeat = await jobs.handleCallback('job_discover_heartbeat', secret, { status: 'running', branch: 'fledge/x' })
    assert.equal(heartbeat.status, 400)
  } finally {
    store.close()
  }
})

// #803: discover no longer promotes unconditionally. With the switch off the
// callback leaves the backlog alone; with it on, exactly one `proposed` item is
// the bridge into the normal work-item queue (never a branch or PR).
test('a discover callback with an issue creates exactly one proposed work item when promotion is on', async () => {
  const config = testConfig({ autoPromoteDiscovery: true, autoPromoteDiscoveryDailyCap: 3 })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'discover-issue-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_discover_issue', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'developer', upstreamHtmlUrl: 'https://github.com/o/r', goal: '', autoIterate: true, intervalMinutes: 60 })
    const secret = 'discover-issue-secret'
    store.createJob({ id: 'job_discover_issue', repoId: repo.id, userId: user.id, trigger: 'schedule', goal: 'discover', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'discover' })
    store.updateJob('job_discover_issue', { status: 'running', started_at: new Date().toISOString() })
    const issueUrl = 'https://github.com/o/r/issues/7'
    const result = await jobs.handleCallback('job_discover_issue', secret, { status: 'succeeded', issueUrl, summary: 'found a concrete bug' })
    assert.equal(result.ok, true)
    const item = store.findWorkItemByIssueUrl(repo.id, issueUrl)
    assert.equal(item?.state, 'proposed')
    assert.equal(item?.pr_url, null)
    assert.equal(store.listWorkItems(repo.id).length, 1)
    assert.equal(store.getJob('job_discover_issue')?.output_kind, 'issue')
    assert.ok(store.listAudit().some((entry) => entry.action === 'job.discovery_promoted'))

    await jobs.tick()
    const after = store.listJobsForRepo(repo.id)
    assert.equal(after.length, 2, 'the proposed issue feeds the next work session')
    assert.equal(after[0]?.kind, 'iterate')
    assert.equal(after[0]?.work_item_id, item?.id)
  } finally {
    store.close()
  }
})

test('a discover callback leaves the backlog unchanged when promotion is off', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'discover-no-promote-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_discover_no_promote', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'developer', upstreamHtmlUrl: 'https://github.com/o/r', goal: '', autoIterate: true, intervalMinutes: 60 })
    const secret = 'discover-no-promote-secret'
    store.createJob({ id: 'job_discover_no_promote', repoId: repo.id, userId: user.id, trigger: 'schedule', goal: 'discover', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'discover' })
    store.updateJob('job_discover_no_promote', { status: 'running', started_at: new Date().toISOString() })
    const issueUrl = 'https://github.com/o/r/issues/8'
    const result = await jobs.handleCallback('job_discover_no_promote', secret, { status: 'succeeded', issueUrl, summary: 'found a concrete bug' })
    assert.equal(result.ok, true)
    assert.equal(store.findWorkItemByIssueUrl(repo.id, issueUrl), undefined)
    assert.equal(store.listWorkItems(repo.id).length, 0)
    assert.equal(store.getJob('job_discover_no_promote')?.output_kind, 'issue')
    const skipped = store.listAudit().find((entry) => entry.action === 'job.discovery_promotion_skipped')
    assert.ok(skipped !== undefined)
    assert.ok(String(skipped.detail).includes('disabled'))

    await jobs.tick()
    assert.equal(store.listWorkItems(repo.id).length, 0)
    assert.equal(store.listJobsForRepo(repo.id).filter((job) => job.kind === 'iterate').length, 0)
  } finally {
    store.close()
  }
})

// #803 asks for a work item only after a *successful* discovery, and #513 makes
// a branch or pull request a failure of discovery's issue-only contract. So a
// failed run must not promote its issue, whatever issue URL it carries.
test('a failed discover callback carrying an issue URL creates no work item', async () => {
  const config = testConfig({ autoPromoteDiscovery: true, autoPromoteDiscoveryDailyCap: 3 })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'discover-failed-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_discover_failed', userId: user.id, owner: 'o', name: 'failed', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'developer', upstreamHtmlUrl: 'https://github.com/o/failed', goal: '', autoIterate: true, intervalMinutes: 60 })
    const secret = 'discover-failed-secret'
    store.createJob({ id: 'job_discover_failed', repoId: repo.id, userId: user.id, trigger: 'schedule', goal: 'discover', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'discover' })
    store.updateJob('job_discover_failed', { status: 'running', started_at: new Date().toISOString() })
    const issueUrl = 'https://github.com/o/failed/issues/11'
    const result = await jobs.handleCallback('job_discover_failed', secret, { status: 'failed', issueUrl, summary: 'gave up without a concrete issue' })
    assert.equal(result.ok, true)
    assert.equal(store.getJob('job_discover_failed')?.status, 'failed')
    assert.equal(store.findWorkItemByIssueUrl(repo.id, issueUrl), undefined)
    assert.equal(store.listWorkItems(repo.id).length, 0)
    assert.ok(!store.listAudit().some((entry) => entry.action === 'job.discovery_promoted'))
    const skipped = store.listAudit().find((entry) => entry.action === 'job.discovery_promotion_skipped')
    assert.ok(skipped !== undefined)
    assert.ok(String(skipped.detail).includes('not-succeeded'))
  } finally {
    store.close()
  }
})

test('the forbidden-PR discovery failure does not promote its issue', async () => {
  const config = testConfig({ autoPromoteDiscovery: true, autoPromoteDiscoveryDailyCap: 3 })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'discover-forbidden-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_discover_forbidden', userId: user.id, owner: 'o', name: 'forbidden', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'developer', upstreamHtmlUrl: 'https://github.com/o/forbidden', goal: '', autoIterate: true, intervalMinutes: 60 })
    const secret = 'discover-forbidden-secret'
    store.createJob({ id: 'job_discover_forbidden', repoId: repo.id, userId: user.id, trigger: 'schedule', goal: 'discover', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'discover' })
    store.updateJob('job_discover_forbidden', { status: 'running', started_at: new Date().toISOString() })
    const issueUrl = 'https://github.com/o/forbidden/issues/12'
    const result = await jobs.handleCallback('job_discover_forbidden', secret, { status: 'succeeded', branch: 'flybot/x', prUrl: 'https://github.com/o/forbidden/pull/1', issueUrl, summary: 'opened a PR by mistake' })
    assert.equal(result.status, 422)
    assert.equal(store.getJob('job_discover_forbidden')?.status, 'failed')
    assert.equal(store.findWorkItemByIssueUrl(repo.id, issueUrl), undefined)
    assert.equal(store.listWorkItems(repo.id).length, 0)
    assert.ok(!store.listAudit().some((entry) => entry.action === 'job.discovery_promoted'))
  } finally {
    store.close()
  }
})

// The digest classification closes a backlog-report result one block later, so
// promoting it first spent a cap slot and audited a promotion that was undone.
test('a discovery result classified as a backlog report does not promote', async () => {
  const config = testConfig({ autoPromoteDiscovery: true, autoPromoteDiscoveryDailyCap: 3 })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'discover-meta-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_discover_meta', userId: user.id, owner: 'o', name: 'meta', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'developer', upstreamHtmlUrl: 'https://github.com/o/meta', goal: '', autoIterate: true, intervalMinutes: 60 })
    const secret = 'discover-meta-secret'
    store.createJob({ id: 'job_discover_meta', repoId: repo.id, userId: user.id, trigger: 'schedule', goal: 'discover', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'discover' })
    store.updateJob('job_discover_meta', { status: 'running', started_at: new Date().toISOString() })
    const issueUrl = 'https://github.com/o/meta/issues/13'
    const result = await jobs.handleCallback('job_discover_meta', secret, { status: 'succeeded', issueUrl, summary: 'inventory of the backlog' })
    assert.equal(result.ok, true)
    assert.equal(store.getJob('job_discover_meta')?.output_kind, 'meta')
    assert.equal(store.findWorkItemByIssueUrl(repo.id, issueUrl), undefined)
    assert.equal(store.listWorkItems(repo.id).length, 0)
    assert.ok(!store.listAudit().some((entry) => entry.action === 'job.discovery_promoted'))
    const skipped = store.listAudit().find((entry) => entry.action === 'job.discovery_promotion_skipped')
    assert.ok(skipped !== undefined)
    assert.ok(String(skipped.detail).includes('meta-issue'))
  } finally {
    store.close()
  }
})

test('the scheduler idles with no work and starts once a work item appears', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const contexts: RunnerContext[] = []
  const runner: Runner = {
    name: 'capture',
    async run(context) {
      contexts.push(context)
      return { status: 'running' }
    },
  }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'scheduler-idle', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_scheduler_idle', userId: user.id, owner: 'o', name: 'idle',
      defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
      repoRole: 'developer', goal: 'fix bugs', autoIterate: true, intervalMinutes: 60,
    })
    store.setSetting(`discover:${repo.id}`, new Date().toISOString())
    await jobs.tick()
    assert.equal(store.listJobsForRepo(repo.id).length, 0, 'no work means no work job')
    assert.equal(store.getRepo(repo.id)?.last_status, 'idle')

    store.createWorkItem({
      id: 'work_scheduler_idle', repoId: repo.id, userId: user.id,
      title: 'fix the thing', issueUrl: 'https://github.com/o/idle/issues/1', state: 'triaged',
    })
    await jobs.tick()
    const created = store.listJobsForRepo(repo.id)
    assert.equal(created.length, 1)
    assert.equal(created[0]?.kind, 'iterate')
    assert.equal(created[0]?.work_item_id, 'work_scheduler_idle')
    assert.equal(contexts.length, 1)
  } finally {
    store.close()
  }
})

test('an open work item starts after the short work cooldown, not the legacy interval', async () => {
  const item = workItem()
  const justDone = await decideNextJob({
    repo: repo(), now, lastRunAt: iso(-9 * 60_000), intervalMinutes: 15,
    lastDurationMs: 0, failureStreak: 0, openWork: [item], reviewerEnabled: false, reviewDue: true,
  })
  assert.equal(justDone.kind, 'none')
  const ready = await decideNextJob({
    repo: repo(), now, lastRunAt: iso(-16 * 60_000), intervalMinutes: 15,
    lastDurationMs: 0, failureStreak: 0, openWork: [item], reviewerEnabled: false, reviewDue: true,
  })
  assert.equal(ready.kind, 'followup')
})

// #801: the success cooldown is a throttle, not a capacity signal. A work job
// that succeeded leaves the next open item due at once; a failure keeps the
// backoff it already had, and an empty queue still idles instead of running.
test('a successful work job leaves the next open item due at once', async () => {
  const open = [workItem(), workItem({ id: 'work_2', created_at: iso(-60_000) })]
  const success = await decideNextJob({
    repo: repo(), now, lastRunAt: iso(-1_000), intervalMinutes: 15,
    lastDurationMs: 0, failureStreak: 0, lastWorkSucceeded: true,
    openWork: open, reviewerEnabled: false, reviewDue: false,
  })
  assert.equal(success.kind, 'followup')

  // One failure is the plain cooldown: success is what skips the wait, not a
  // failed job that happens not to have reached the backoff yet.
  const oneFailure = await decideNextJob({
    repo: repo(), now, lastRunAt: iso(-1_000), intervalMinutes: 15,
    lastDurationMs: 0, failureStreak: 1, lastWorkSucceeded: false,
    openWork: open, reviewerEnabled: false, reviewDue: false,
  })
  assert.equal(oneFailure.kind, 'none')

  // The backoff still holds a repeating failure down.
  const backingOff = await decideNextJob({
    repo: repo(), now, lastRunAt: iso(-5 * 60_000), intervalMinutes: 15,
    lastDurationMs: 0, failureStreak: 2, lastWorkSucceeded: false,
    openWork: open, reviewerEnabled: false, reviewDue: false,
  })
  assert.equal(backingOff.kind, 'none')
  if (backingOff.kind !== 'none' || backingOff.reason !== 'not due') throw new Error('expected a blocked decision')
  assert.equal(backingOff.blockedBy, 'failure_backoff')

  // No open item is idle even when the last job succeeded, as long as discovery
  // is not due: a success never invents work.
  const empty = await decideNextJob({
    repo: repo(), now, lastRunAt: iso(-1_000), intervalMinutes: 15,
    lastDurationMs: 0, failureStreak: 0, lastWorkSucceeded: true,
    openWork: [], reviewerEnabled: false, reviewDue: false, lastDiscoverAt: iso(-60_000),
  })
  assert.equal(empty.kind, 'none')
  assert.equal(empty.kind === 'none' ? empty.reason : null, 'idle')
})

test('a successful job dispatches the second open item in the same tick', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const contexts: RunnerContext[] = []
  const runner: Runner = {
    name: 'capture',
    async run(context) {
      contexts.push(context)
      return { status: 'running' }
    },
  }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'scheduler-continuity', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_scheduler_continuity', userId: user.id, owner: 'o', name: 'continuity',
      defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
      repoRole: 'developer', goal: 'fix bugs', autoIterate: true, intervalMinutes: 60,
    })
    store.setSetting(`discover:${repo.id}`, new Date().toISOString())
    // The first item is already delivered, so the scheduler sees exactly one
    // open item and the question is only whether it waits out the cooldown.
    const finished = store.createWorkItem({
      id: 'work_continuity_1', repoId: repo.id, userId: user.id,
      title: 'first item', issueUrl: 'https://github.com/o/continuity/issues/1',
      state: 'closed', closedReason: 'delivered',
    })
    const nextUp = store.createWorkItem({
      id: 'work_continuity_2', repoId: repo.id, userId: user.id,
      title: 'second item', issueUrl: 'https://github.com/o/continuity/issues/2', state: 'triaged',
    })
    assert.ok(finished.id !== nextUp.id)
    // The first item's job just succeeded, and the repository's last run is that
    // success — one second ago, far inside the 15-minute success cooldown.
    const at = new Date().toISOString()
    store.createJob({ id: 'job_continuity_1', repoId: repo.id, userId: user.id, trigger: 'schedule', goal: 'g', callbackHash: 'h1', platformTokenHash: '' })
    store.updateJob('job_continuity_1', { status: 'succeeded', started_at: at, finished_at: at, work_item_id: 'work_continuity_1' })
    store.updateRepo(repo.id, { last_run_at: at, last_status: 'succeeded' })

    await jobs.tick()
    const created = store.listJobsForRepo(repo.id)
    assert.equal(created.length, 2, 'the second item starts without waiting out the success cooldown')
    assert.equal(created[0]?.work_item_id, 'work_continuity_2')
    assert.equal(contexts.length, 1)
  } finally {
    store.close()
  }
})

test('a failing job still waits out the backoff instead of looping', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const runner: Runner = {
    name: 'capture',
    async run() {
      return { status: 'running' }
    },
  }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'scheduler-backoff', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_scheduler_backoff', userId: user.id, owner: 'o', name: 'backoff',
      defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
      repoRole: 'developer', goal: 'fix bugs', autoIterate: true, intervalMinutes: 60,
    })
    store.setSetting(`discover:${repo.id}`, new Date().toISOString())
    store.createWorkItem({
      id: 'work_backoff_1', repoId: repo.id, userId: user.id,
      title: 'first item', issueUrl: 'https://github.com/o/backoff/issues/1', state: 'triaged',
    })
    store.createWorkItem({
      id: 'work_backoff_2', repoId: repo.id, userId: user.id,
      title: 'second item', issueUrl: 'https://github.com/o/backoff/issues/2', state: 'triaged',
    })
    const at = new Date().toISOString()
    for (const id of ['job_backoff_1', 'job_backoff_2']) {
      store.createJob({ id, repoId: repo.id, userId: user.id, trigger: 'schedule', goal: 'g', callbackHash: id, platformTokenHash: '' })
      store.updateJob(id, { status: 'failed', started_at: at, finished_at: at })
    }
    store.updateRepo(repo.id, { last_run_at: at, last_status: 'failed' })

    await jobs.tick()
    assert.equal(store.listJobsForRepo(repo.id).length, 2, 'two failures back off instead of dispatching again')
  } finally {
    store.close()
  }
})

test('a due maintainer continues the open PR when the review interval is not due', async () => {
  const pr = workItem({ pr_url: 'https://x/pr/3', state: 'pr_ready' })
  const next = await decideNextJob({
    repo: repo({ repo_role: 'maintainer' }), now, lastRunAt: iso(-2 * 3_600_000),
    intervalMinutes: 60, lastDurationMs: 0, failureStreak: 0, openWork: [pr],
    reviewerEnabled: true, reviewDue: false,
  })
  assert.equal(next.kind, 'followup')
  assert.equal(next.kind === 'followup' ? next.prUrl : null, 'https://x/pr/3')
})

test('the database refuses a second active job for a repository', () => {
  const { store, repoId, userId } = leaseSetup()
  try {
    leaseMakeJob(store, repoId, userId, 'job_first', 0)
    assert.throws(() => leaseMakeJob(store, repoId, userId, 'job_second', 10), /UNIQUE|constraint/i)

    store.updateJob('job_first', { status: 'succeeded', finished_at: new Date().toISOString() })
    leaseMakeJob(store, repoId, userId, 'job_second', 10)
    assert.equal(store.getJob('job_second')?.status, 'queued')
  } finally {
    store.close()
  }
})

// #248 pinned "only one queued job per repository is claimable at a time" with a
// read-time check; #245 replaced that check with the partial unique index, so
// two queued rows for one repository can no longer exist at all. The claiming
// half of that case still holds and is kept: a claimed job is not offered again,
// and a finished one frees the repository for the next job.
test('a claimed job is not claimable again until it finishes', () => {
  const { store, repoId, userId } = leaseSetup()
  try {
    leaseMakeJob(store, repoId, userId, 'job_first', 0)
    const first = store.claimQueuedJob('worker-1', 60_000)
    assert.equal(first?.id, 'job_first')
    assert.equal(store.claimQueuedJob('worker-2', 60_000), undefined, 'a running job is not offered again')

    store.updateJob('job_first', { status: 'succeeded', finished_at: new Date().toISOString() })
    leaseMakeJob(store, repoId, userId, 'job_second', 10)
    assert.equal(store.claimQueuedJob('worker-2', 60_000)?.id, 'job_second')
  } finally {
    store.close()
  }
})

test('a lease can only be renewed or released by its owner', () => {
  const { store, repoId, userId } = leaseSetup()
  try {
    leaseMakeJob(store, repoId, userId, 'job_a')
    const claimed = store.claimQueuedJob('worker-1', 60_000)
    assert.equal(claimed?.id, 'job_a')

    assert.equal(store.renewJobLease('job_a', 'worker-2', 60_000), false)
    assert.equal(store.renewJobLease('job_a', 'worker-1', 60_000), true)

    store.releaseJobLease('job_a')
    const reclaimed = store.claimQueuedJob('worker-2', 60_000)
    assert.equal(reclaimed?.id, 'job_a')
    assert.equal(reclaimed?.lease_owner, 'worker-2')
  } finally {
    store.close()
  }
})

test('an expired lease is reclaimable by another worker', async () => {
  const { store, repoId, userId } = leaseSetup()
  try {
    leaseMakeJob(store, repoId, userId, 'job_exp')
    const first = store.claimQueuedJob('worker-1', 1)
    assert.equal(first?.id, 'job_exp')

    await new Promise((resolve) => setTimeout(resolve, 15))
    const expired = store.expiredLeaseJobs(new Date().toISOString())
    assert.ok(expired.some((job) => job.id === 'job_exp'))

    const second = store.claimQueuedJob('worker-2', 60_000)
    assert.equal(second?.id, 'job_exp')
    assert.equal(second?.lease_owner, 'worker-2')
  } finally {
    store.close()
  }
})

test('an expired lease is failed by the tick reaper', async () => {
  const config = testConfig({ runner: { ...testConfig().runner, queueDispatch: true } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'dead-lease-user', status: 'approved' })
    const repo = queueRepoFor(store, user.id, 'repo_dead_lease')
    leaseMakeJob(store, repo.id, user.id, 'job_dead_lease')
    assert.equal(store.claimQueuedJob('dead-worker', 1)?.id, 'job_dead_lease')
    await new Promise((resolve) => setTimeout(resolve, 15))
    await jobs.tick()
    const row = store.getJob('job_dead_lease')
    assert.equal(row?.status, 'failed')
    assert.match(row?.error ?? '', /租约过期/)
  } finally {
    store.close()
  }
})

test('QUEUE_DISPATCH enqueues first and dispatches the claimed job on the tick', async () => {
  const config = testConfig({ runner: { ...testConfig().runner, queueDispatch: true, maxActiveJobs: 1 } })
  const store = new Store(':memory:')
  const calls: RunnerContext[] = []
  const runner: Runner = {
    name: 'capture',
    async run(context) {
      calls.push(context)
      return { status: 'succeeded', summary: 'ok' }
    },
  }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'queue-user', status: 'approved' })
    const repo = queueRepoFor(store, user.id, 'repo_queue_one')

    const queued = await jobs.enqueue(repo, 'manual')
    assert.equal(queued.ok, true)
    assert.equal(queued.job?.status, 'queued')
    assert.equal(queued.job?.lease_owner, null)
    assert.equal(calls.length, 0)

    await jobs.tick()

    assert.equal(calls.length, 1)
    const done = store.getJob(queued.job!.id)
    assert.equal(done?.status, 'succeeded')
    assert.equal(done?.lease_owner, null)
  } finally {
    store.close()
  }
})

test('a queued job older than ten minutes is not failed before the dispatcher claims it', async () => {
  const config = testConfig({ runner: { ...testConfig().runner, queueDispatch: true, maxActiveJobs: 1 } })
  const store = new Store(':memory:')
  const calls: RunnerContext[] = []
  const runner: Runner = {
    name: 'capture',
    async run(context) {
      calls.push(context)
      return { status: 'succeeded', summary: 'ok' }
    },
  }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'queue-old-user', status: 'approved' })
    const repo = queueRepoFor(store, user.id, 'repo_queue_old')
    const queued = await jobs.enqueue(repo, 'manual')
    assert.equal(queued.ok, true)
    store.run('UPDATE jobs SET created_at = ? WHERE id = ?', new Date(Date.now() - 20 * 60_000).toISOString(), queued.job!.id)

    await jobs.tick()

    assert.equal(calls.length, 1)
    assert.equal(store.getJob(queued.job!.id)?.status, 'succeeded')
  } finally {
    store.close()
  }
})

test('queue admission control rejects a full queue', async () => {
  const config = testConfig({ runner: { ...testConfig().runner, queueDispatch: true, maxQueueDepth: 1, maxUserQueue: 10 } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'queue-full-user', status: 'approved' })
    const one = queueRepoFor(store, user.id, 'repo_queue_full_one')
    const two = queueRepoFor(store, user.id, 'repo_queue_full_two')
    assert.equal((await jobs.enqueue(one, 'manual')).ok, true)
    const rejected = await jobs.enqueue(two, 'manual')
    assert.equal(rejected.ok, false)
    assert.equal(rejected.code, 'QUEUE_FULL')
  } finally {
    store.close()
  }
})

test('queue admission control rejects a user backlog', async () => {
  const config = testConfig({ runner: { ...testConfig().runner, queueDispatch: true, maxQueueDepth: 10, maxUserQueue: 1 } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'queue-limit-user', status: 'approved' })
    const one = queueRepoFor(store, user.id, 'repo_queue_limit_one')
    const two = queueRepoFor(store, user.id, 'repo_queue_limit_two')
    assert.equal((await jobs.enqueue(one, 'manual')).ok, true)
    const rejected = await jobs.enqueue(two, 'manual')
    assert.equal(rejected.ok, false)
    assert.equal(rejected.code, 'QUEUE_LIMIT')
  } finally {
    store.close()
  }
})

test('the dispatcher respects maxActiveJobs and releases the next repo after the first finishes', async () => {
  const config = testConfig({ runner: { ...testConfig().runner, queueDispatch: true, maxActiveJobs: 1 } })
  const store = new Store(':memory:')
  const calls: RunnerContext[] = []
  const runner: Runner = {
    name: 'capture',
    async run(context) {
      calls.push(context)
      return { status: 'running' }
    },
  }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'queue-cap-user', status: 'approved' })
    const one = queueRepoFor(store, user.id, 'repo_queue_one')
    const two = queueRepoFor(store, user.id, 'repo_queue_two')
    const first = await jobs.enqueue(one, 'manual')
    const second = await jobs.enqueue(two, 'manual')
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)

    await jobs.tick()
    assert.equal(calls.length, 1)
    const firstJob = store.getJob(first.job!.id)
    assert.equal(firstJob?.status, 'running')
    assert.equal(store.getJob(second.job!.id)?.status, 'queued')

    store.updateJob(first.job!.id, { status: 'succeeded', finished_at: new Date().toISOString() })
    store.releaseJobLease(first.job!.id)
    await jobs.tick()
    assert.equal(calls.length, 2)
    assert.equal(store.getJob(second.job!.id)?.status, 'running')
  } finally {
    store.close()
  }
})

test('only the one-active-job index is reported as a busy queue', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const runner: Runner = { name: 'noop', async run() { return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer(), new InstanceManager(store, config))
  const stubCreateJob = (thunk: () => never): void => {
    Object.defineProperty(store, 'createJob', { value: () => thunk(), configurable: true })
  }
  try {
    const user = makeUser(store, { login: 'busy-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_busy', userId: user.id, owner: 'o', name: 'busy', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    // A concurrent enqueue wins the race between the read-time check and this
    // insert: SQLite names the column of the partial unique index, and the
    // caller must see a busy queue instead of a 500.
    stubCreateJob(() => {
      store.db.exec(`INSERT INTO jobs (id, repo_id, user_id, status, trigger, goal, callback_hash, created_at) VALUES ('job_busy_racer', 'repo_busy', '${user.id}', 'queued', 'manual', 'g', 'cb_racer', '${new Date().toISOString()}')`)
      throw new Error('UNIQUE constraint failed: jobs.repo_id')
    })
    assert.deepEqual(await jobs.enqueue(repo, 'manual'), { ok: false, error: '这个仓库已有任务在运行', code: 'JOB_ACTIVE' })

    // Any other constraint failure is a bug and has to surface instead.
    store.db.exec("UPDATE jobs SET status = 'failed' WHERE id = 'job_busy_racer'")
    stubCreateJob(() => { throw new Error('UNIQUE constraint failed: jobs.id') })
    await assert.rejects(() => jobs.enqueue(repo, 'manual'), /jobs\.id/)
  } finally {
    store.close()
  }
})

// #261 review finding: `summary` is the progress field every running heartbeat
// writes, so a review that reported progress and then failed transiently is the
// production shape — and it must still get its one retry.
test('a review that reported one progress heartbeat still gets its one retry', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'review-heartbeat-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_review_heartbeat', userId: user.id, owner: 'o', name: 'heartbeat', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 720, canReview: true, reviewerEnabled: true })
    const secret = 'review-heartbeat-secret'

    store.createJob({ id: 'job_review_heartbeat', repoId: repo.id, userId: user.id, trigger: 'schedule', goal: 'review', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'review' })
    store.updateJob('job_review_heartbeat', { status: 'running', pr_url: 'https://github.com/o/heartbeat/pull/4' })
    await jobs.handleCallback('job_review_heartbeat', secret, { status: 'running', summary: 'reviewing pull request 4: reading the diff' })
    assert.equal(store.getJob('job_review_heartbeat')?.summary, 'reviewing pull request 4: reading the diff', 'the heartbeat stored a progress line')

    await jobs.handleCallback('job_review_heartbeat', secret, { status: 'failed', error: 'FlyBot bridge 502' })
    const pending = store.listSettings('retry_pending:')
    assert.equal(pending.length, 1, 'progress is not a posted verdict, so the transient failure still retries')
    assert.equal(pending[0]?.key, 'retry_pending:job_review_heartbeat')
  } finally {
    store.close()
  }
})

// The half that actually runs: the due retry becomes one review job that keeps
// the original's pull request and work item, and never a second work item.
test('a due review retry becomes one review job with retry_of and retry_attempt', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'review-release-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_review_release', userId: user.id, owner: 'o', name: 'release', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 720, canReview: true, reviewerEnabled: true })
    const item = store.createWorkItem({ id: 'work_review_release', repoId: repo.id, userId: user.id, title: 'review the pull request', prUrl: 'https://github.com/o/release/pull/5', state: 'pr_ready' })
    const secret = 'review-release-secret'

    store.createJob({ id: 'job_review_release', repoId: repo.id, userId: user.id, trigger: 'schedule', goal: 'review', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'review', workItemId: item.id })
    store.updateJob('job_review_release', { status: 'running', pr_url: 'https://github.com/o/release/pull/5' })
    await jobs.handleCallback('job_review_release', secret, { status: 'failed', error: 'FlyBot bridge 502' })

    const key = 'retry_pending:job_review_release'
    const pending = JSON.parse(store.getSetting(key) ?? '{}') as Record<string, unknown>
    store.setSetting(key, JSON.stringify({ ...pending, dueAt: new Date(Date.now() - 1_000).toISOString() }))
    await jobs.tick()

    assert.equal(store.getSetting(key), undefined, 'a released retry row is consumed once')
    const retries = store.listJobsForRepo(repo.id, 10).filter((job) => job.retry_of === 'job_review_release')
    assert.equal(retries.length, 1, 'exactly one review job is created')
    const retry = retries[0]!
    assert.equal(retry.kind, 'review')
    assert.equal(retry.retry_attempt, 1)
    assert.equal(retry.pr_url, 'https://github.com/o/release/pull/5', 'the retry keeps the pull request it reviews')
    assert.equal(retry.work_item_id, item.id, 'and the work item it belongs to')
    assert.equal(store.listWorkItems(repo.id).length, 1, 'no second work item is created')

    await jobs.tick()
    assert.equal(store.listJobsForRepo(repo.id, 10).filter((job) => job.retry_of === 'job_review_release').length, 1, 'a second tick does not duplicate the retry')
  } finally {
    store.close()
  }
})

test('a failed review schedules one retry and keeps its pull request and work item', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'review-retry-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_review_retry', userId: user.id, owner: 'o', name: 'reviewed', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 720, canReview: true, reviewerEnabled: true })
    const item = store.createWorkItem({ id: 'work_review', repoId: repo.id, userId: user.id, title: 'review the pull request', prUrl: 'https://github.com/o/reviewed/pull/9', state: 'pr_ready' })
    const secret = 'review-secret'

    store.createJob({ id: 'job_review_retry', repoId: repo.id, userId: user.id, trigger: 'schedule', goal: 'review', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'review', workItemId: item.id })
    store.updateJob('job_review_retry', { status: 'running', pr_url: 'https://github.com/o/reviewed/pull/9' })
    await jobs.handleCallback('job_review_retry', secret, { status: 'failed', error: 'FlyBot bridge 502' })
    const pending = store.listSettings('retry_pending:')
    assert.equal(pending.length, 1)
    assert.equal(pending[0]?.key, 'retry_pending:job_review_retry')
    const row = JSON.parse(pending[0]?.value ?? '{}') as { attempt?: number; kind?: string; workItemId?: string | null; prUrl?: string | null }
    assert.equal(row.attempt, 1)
    assert.equal(row.kind, 'review')
    assert.equal(row.workItemId, 'work_review')
    assert.equal(row.prUrl, 'https://github.com/o/reviewed/pull/9')

    // One retry is the bound: a second transient failure stays manual.
    store.createJob({ id: 'job_review_retry_2', repoId: repo.id, userId: user.id, trigger: 'schedule', goal: 'review', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'review', retryAttempt: 1 })
    store.updateJob('job_review_retry_2', { status: 'running' })
    await jobs.handleCallback('job_review_retry_2', secret, { status: 'failed', error: 'FlyBot bridge 502' })
    assert.equal(store.listSettings('retry_pending:').length, 1)

    // A quota failure is not transient for a review either.
    store.createJob({ id: 'job_review_quota', repoId: repo.id, userId: user.id, trigger: 'schedule', goal: 'review', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'review' })
    store.updateJob('job_review_quota', { status: 'running' })
    await jobs.handleCallback('job_review_quota', secret, { status: 'failed', error: '平台额度已用完' })
    assert.equal(store.listSettings('retry_pending:').length, 1)

    // A review that already produced a result is not re-run blindly: its comments
    // are posted, so a blind retry could duplicate the COMMENT review.
    store.createJob({ id: 'job_review_posted', repoId: repo.id, userId: user.id, trigger: 'schedule', goal: 'review', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'review' })
    store.updateJob('job_review_posted', { status: 'running', review_score: 4, summary: 'posted 3 review comments' })
    await jobs.handleCallback('job_review_posted', secret, { status: 'failed', error: 'FlyBot bridge 502' })
    assert.equal(store.listSettings('retry_pending:').length, 1)
  } finally {
    store.close()
  }
})

test('a concrete adversarial risk blocks auto-merge, while a bare score is not evidence', async () => {
  const merges: string[] = []
  const github = await startFakeServer((request, response) => {
    const method = request.method ?? 'GET'
    const url = request.url ?? ''
    if (method === 'GET' && url === '/repos/o/r/pulls/1') {
      json(response, 200, { number: 1, html_url: 'https://github.com/o/r/pull/1', title: 'fix', state: 'open', head: { ref: 'fledge/fix', sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, base: { ref: 'main' }, mergeable: true, mergeable_state: 'clean', draft: false, merged: false, changed_files: 1 })
      return
    }
    if (method === 'GET' && url === '/repos/o/r/commits/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/check-runs?per_page=100') {
      json(response, 200, { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] })
      return
    }
    if (method === 'GET' && url === '/repos/o/r/commits/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/status') {
      json(response, 200, { state: 'success', statuses: [] })
      return
    }
    if (method === 'GET' && url === '/repos/o/r/pulls/1/reviews?per_page=100') {
      json(response, 200, [])
      return
    }
    if (method === 'GET' && url === '/repos/o/r/branches/main') {
      json(response, 200, { name: 'main', commit: { sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } })
      return
    }
    if (method === 'GET' && url === '/repos/o/r/pulls/1/files?per_page=100&page=1') {
      json(response, 200, [{ filename: 'src/x.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-const a = 0\n+const a = 1' }])
      return
    }
    if (method === 'GET' && url === '/repos/o/r/branches/main/protection') {
      json(response, 200, { required_status_checks: { contexts: ['ci'] }, required_pull_request_reviews: { required_approving_review_count: 0 } })
      return
    }
    if (method === 'PUT' && url === '/repos/o/r/pulls/1/merge') {
      merges.push('merge')
      json(response, 200, { merged: true, sha: 'def' })
      return
    }
    json(response, 404, { message: 'Not Found' })
  })
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: github.url }, autoMerge: { ...base.autoMerge, reconcileMinutes: 0 } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'adversarial-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_adversarial', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', autoMerge: true, upstreamHtmlUrl: 'https://github.com/o/r', forkHtmlUrl: 'https://github.com/o/r', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const secret = 'adversarial-secret'
    store.createJob({ id: 'job_adversarial_risk', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob('job_adversarial_risk', { status: 'running', branch: 'fledge/fix', started_at: new Date().toISOString() })
    let calls = 0
    jobs.adversarialModel = async () => {
      calls += 1
      return [
        'Concrete risk: src/x.ts:1',
        'Failure mode: the constant flips every read, so the page renders a stale value',
        'Repro: open the page twice with the patch applied',
        'Checks: read the diff',
      ].join('\n')
    }
    const blocked = await jobs.handleCallback('job_adversarial_risk', secret, { status: 'succeeded', prUrl: 'https://github.com/o/r/pull/1', summary: 'done' })
    assert.equal(blocked.ok, true)
    assert.equal(merges.length, 0, 'a concrete risk must block the automatic merge')
    const riskEvent = store.listJobEvents('job_adversarial_risk').find((event) => event.kind === 'job.adversarial')
    assert.ok(riskEvent !== undefined, 'the adversarial verdict is recorded on the job')
    assert.match(String(riskEvent?.meta ?? ''), /src\/x\.ts:1/)
    // Auto-merge reconciliation retries a blocked PR every few minutes; the same
    // tip must not buy a second review, or a blocked PR would cost a call per pass.
    assert.equal(calls, 1)
    await jobs.reconcileAutoMerge()
    assert.equal(calls, 1, 'a stored verdict for this tip is reused instead of re-reviewed')
    assert.equal(merges.length, 0)

    // The next run clears nothing by itself: a second job that answers with a
    // score has not run an adversarial review, so the merge is not blocked by it
    // either — and the page can say the answer was rejected.
    store.createJob({ id: 'job_adversarial_vague', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob('job_adversarial_vague', { status: 'running', branch: 'fledge/fix', started_at: new Date().toISOString() })
    jobs.adversarialModel = async () => 'Score: 95/100\n\nLooks good.'
    const passed = await jobs.handleCallback('job_adversarial_vague', secret, { status: 'succeeded', prUrl: 'https://github.com/o/r/pull/1', summary: 'done' })
    assert.equal(passed.ok, true)
    assert.equal(merges.length, 1, 'a bare score is rejected, not treated as a pass of the adversarial contract')
    const vagueEvent = store.listJobEvents('job_adversarial_vague').find((event) => event.kind === 'job.adversarial')
    assert.match(String(vagueEvent?.meta ?? ''), /score/i)
  } finally {
    store.close()
    await github.close()
  }
})

test('one blocked tip keeps one audit row and one notification, and a moved head starts a new count', async () => {
  const merges: string[] = []
  // The head sha the fake repository reports. Moving it mid-test is the second
  // half: a new commit asks for a new review, and for nothing else.
  let headSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const github = await startFakeServer((request, response) => {
    const method = request.method ?? 'GET'
    const url = request.url ?? ''
    if (method === 'GET' && url === '/repos/o/r/pulls/1') {
      json(response, 200, { number: 1, html_url: 'https://github.com/o/r/pull/1', title: 'fix', state: 'open', head: { ref: 'fledge/fix', sha: headSha }, base: { ref: 'main' }, mergeable: true, mergeable_state: 'clean', draft: false, merged: false, changed_files: 1 })
      return
    }
    if (method === 'GET' && url === `/repos/o/r/commits/${headSha}/check-runs?per_page=100`) {
      json(response, 200, { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] })
      return
    }
    if (method === 'GET' && url === `/repos/o/r/commits/${headSha}/status`) {
      json(response, 200, { state: 'success', statuses: [] })
      return
    }
    if (method === 'GET' && url === '/repos/o/r/pulls/1/reviews?per_page=100') {
      json(response, 200, [])
      return
    }
    if (method === 'GET' && url === '/repos/o/r/branches/main') {
      json(response, 200, { name: 'main', commit: { sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } })
      return
    }
    if (method === 'GET' && url === '/repos/o/r/pulls/1/files?per_page=100&page=1') {
      json(response, 200, [{ filename: 'src/x.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-const a = 0\n+const a = 1' }])
      return
    }
    if (method === 'GET' && url === '/repos/o/r/branches/main/protection') {
      json(response, 200, { required_status_checks: { contexts: ['ci'] }, required_pull_request_reviews: { required_approving_review_count: 0 } })
      return
    }
    if (method === 'PUT' && url === '/repos/o/r/pulls/1/merge') {
      merges.push('merge')
      json(response, 200, { merged: true, sha: 'def' })
      return
    }
    json(response, 404, { message: 'Not Found' })
  })
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: github.url }, autoMerge: { ...base.autoMerge, reconcileMinutes: 0 } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'adversarial-repeat-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_adversarial_repeat', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', autoMerge: true, upstreamHtmlUrl: 'https://github.com/o/r', forkHtmlUrl: 'https://github.com/o/r', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const secret = 'adversarial-repeat-secret'
    const jobId = 'job_adversarial_repeat'
    store.createJob({ id: jobId, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob(jobId, { status: 'running', branch: 'fledge/fix', started_at: new Date().toISOString() })
    let calls = 0
    const riskAnswer = [
      'Concrete risk: src/x.ts:1',
      'Failure mode: the constant flips every read, so the page renders a stale value',
      'Repro: open the page twice with the patch applied',
      'Checks: read the diff',
    ].join('\n')
    // The answer the fake model gives for the tip under test; the last tip in this
    // test is the one that clears the risk.
    let answer = riskAnswer
    jobs.adversarialModel = async () => {
      calls += 1
      return answer
    }
    const blocked = await jobs.handleCallback(jobId, secret, { status: 'succeeded', prUrl: 'https://github.com/o/r/pull/1', summary: 'done' })
    assert.equal(blocked.ok, true)
    assert.equal(merges.length, 0, 'a concrete risk must block the automatic merge')
    // One tip, one record. The verdict is reused on every later pass of the same
    // head sha, so its consequences must be recorded once too: a blocked PR that
    // pages the maintainer once per pass is a blocked PR that trains them to
    // ignore the page, and the audit trail stops saying "one review, one refusal".
    const counts = () => ({
      risk: store.listAudit(200).filter((row) => row.action === 'job.adversarial_risk').length,
      blocked: store.listAudit(200).filter((row) => row.action === 'job.merge_adversarial_blocked').length,
      notified: store.listNotifications(user.id, 100).filter((row) => row.message.includes('独立对抗式审核')).length,
      verdicts: store.listJobEvents(jobId).filter((event) => event.kind === 'job.adversarial').length,
    })
    const first = counts()
    assert.deepEqual(first, { risk: 1, blocked: 1, notified: 1, verdicts: 1 })
    for (let pass = 1; pass <= 4; pass += 1) {
      await jobs.reconcileAutoMerge()
      assert.deepEqual(counts(), first, `reconcile pass ${String(pass)} changed the record for one unchanged tip`)
      assert.equal(merges.length, 0, 'the reused verdict still blocks')
    }
    assert.equal(calls, 1, 'a stored verdict for this tip is reused instead of re-reviewed')

    // A new commit is a new review — exactly one. The reuse is keyed on the head
    // sha, and the events it compares against come back newest-first from
    // `Store.listJobEvents` (`ORDER BY id DESC`), so reading them in the other
    // direction compares every later tip against the first one, the reuse never
    // fires again and the counts grow once per pass for every tip after the
    // first. Same defect as above, one commit later.
    headSha = 'cccccccccccccccccccccccccccccccccccccccc'
    await jobs.reconcileAutoMerge()
    const moved = counts()
    assert.deepEqual(moved, { risk: 2, blocked: 2, notified: 2, verdicts: 2 }, 'a moved head buys exactly one more review and one more record')
    assert.equal(calls, 2, 'the new tip is reviewed exactly once')
    for (let pass = 1; pass <= 2; pass += 1) {
      await jobs.reconcileAutoMerge()
      assert.deepEqual(counts(), moved, `reconcile pass ${String(pass)} on the new tip changed its record`)
      assert.equal(merges.length, 0, 'the reused verdict on the new tip still blocks')
    }
    assert.equal(calls, 2, 'the new tip is reviewed once, not once per pass')

    // A third tip follows the same rule: one new review, then reuse for as long
    // as it is the head — the count is per tip, not per job and not per pass.
    headSha = 'dddddddddddddddddddddddddddddddddddddddd'
    await jobs.reconcileAutoMerge()
    const third = counts()
    assert.deepEqual(third, { risk: 3, blocked: 3, notified: 3, verdicts: 3 }, 'a third tip buys exactly one more review and one more record')
    assert.equal(calls, 3, 'the third tip is reviewed exactly once')
    for (let pass = 1; pass <= 3; pass += 1) {
      await jobs.reconcileAutoMerge()
      assert.deepEqual(counts(), third, `reconcile pass ${String(pass)} on the third tip changed its record`)
      assert.equal(merges.length, 0, 'the reused verdict on the third tip still blocks')
    }
    assert.equal(calls, 3, 'the third tip is reviewed once, not once per pass')

    // The tip that clears the risk. A fresh answer of "No concrete risk" lets the
    // merge through on that same pass, and nothing about the earlier refusals is
    // recorded again: the refusal count belongs to the tips that were refused.
    headSha = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    answer = ['No concrete risk', 'Checks: read the diff, ran npm run check'].join('\n')
    await jobs.reconcileAutoMerge()
    assert.equal(merges.length, 1, 'a tip that clears the risk merges')
    assert.equal(calls, 4, 'the clearing tip is reviewed exactly once')
    assert.deepEqual(counts(), { risk: 3, blocked: 3, notified: 3, verdicts: 4 }, 'a cleared tip adds no refusal row and no notification')
  } finally {
    store.close()
    await github.close()
  }
})

// #366 slice 1, the dispatcher half: the pure summariser is tested in
// test/temporal.test.ts, but the properties that matter at dispatch time are
// that the previous run's base is the one read, that the line reaches the goal,
// that the delta is stored, and that a first run reads nothing at all.
const TEMPORAL_PREVIOUS_SHA = '4f2c1a9e8d3b2a1c0f9e8d7c6b5a4f3e2d1c0b9a'

function temporalServer(requests: string[]) {
  return startFakeServer((request, response) => {
    const path = request.url ?? ''
    requests.push(path)
    if (path.includes('/pulls?state=open')) return json(response, 200, [])
    if (path.includes('/compare/')) return json(response, 200, { status: 'ahead', ahead_by: 3 })
    if (path.includes('/commits/')) return json(response, 200, { sha: TEMPORAL_PREVIOUS_SHA, commit: { committer: { date: '2026-11-10T00:00:00Z' } } })
    if (path.includes('/pulls?state=closed')) {
      return json(response, 200, [
        { number: 815, html_url: 'https://github.com/o/temporal/pull/815', title: 'b', merged_at: '2026-11-10T02:00:00Z', updated_at: '2026-11-10T02:00:00Z' },
        { number: 812, html_url: 'https://github.com/o/temporal/pull/812', title: 'a', merged_at: '2026-11-10T01:00:00Z', updated_at: '2026-11-10T01:00:00Z' },
      ])
    }
    if (path.includes('/branches/')) return json(response, 200, { name: 'main', commit: { sha: 'base-sha-now' } })
    if (path.includes('/contents/')) return json(response, 200, [])
    return json(response, 404, { message: 'Not Found' })
  })
}

function temporalRepo(store: Store, userId: string, id: string, key: string): RepoRow {
  return store.createRepo({
    id,
    userId,
    owner: 'o',
    name: 'temporal',
    defaultBranch: 'main',
    tokenEnc: encryptSecret('gh-token', key),
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
}

test('an iterate job records the delta from the previous finished run, not a fresh read', async () => {
  const requests: string[] = []
  const github = await temporalServer(requests)
  const config = testConfig({ github: { ...testConfig().github, apiBase: github.url } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'flybot', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'temporal-user', status: 'approved' })
    const repo = temporalRepo(store, user.id, 'repo_temporal_dispatch', config.tokenEncryptionKey)
    const previous = store.createJob({
      id: 'job_temporal_prev',
      repoId: repo.id,
      userId: user.id,
      trigger: 'manual',
      goal: 'previous run',
      callbackHash: 'h',
      platformTokenHash: '',
      baseSha: TEMPORAL_PREVIOUS_SHA,
      createdAt: '2026-11-10T00:00:00.000Z',
    })
    store.updateJob(previous.id, { status: 'succeeded', finished_at: '2026-11-10T00:05:00.000Z' })

    const result = await jobs.enqueue(repo, 'manual', 'Fix it', 'iterate', {})
    assert.equal(result.ok, true, result.error ?? 'enqueue failed')
    const job = store.getJob(result.job!.id)!
    const delta = JSON.parse(job.temporal_json ?? 'null') as { sinceSha: string | null; status: string; aheadBy: number; mergedPrs: number[]; complete: boolean }
    assert.equal(delta.sinceSha, TEMPORAL_PREVIOUS_SHA, 'the delta was not built from the previous run base')
    assert.equal(delta.status, 'ahead')
    assert.equal(delta.aheadBy, 3)
    assert.deepEqual(delta.mergedPrs, [815, 812], 'the merged pull requests the walk returned were not stored')
    assert.match(job.goal, /Since 4f2c1a9: 3 commits ahead, 2 merged PRs \(#812, #815\)/, 'the goal does not carry the delta line')
    assert.equal(requests.filter((path) => path.includes('/compare/')).length, 1, 'the compare read is not made exactly once')
  } finally {
    store.close()
    await github.close()
  }
})

test('a first iterate job says there is no previous run and makes no compare call', async () => {
  const requests: string[] = []
  const github = await temporalServer(requests)
  const config = testConfig({ github: { ...testConfig().github, apiBase: github.url } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'flybot', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'temporal-first', status: 'approved' })
    const repo = temporalRepo(store, user.id, 'repo_temporal_first', config.tokenEncryptionKey)
    const result = await jobs.enqueue(repo, 'manual', 'Fix it', 'iterate', {})
    assert.equal(result.ok, true, result.error ?? 'enqueue failed')
    const job = store.getJob(result.job!.id)!
    assert.match(job.goal, /Since: no previous run/)
    assert.deepEqual(JSON.parse(job.temporal_json ?? 'null'), { sinceSha: null, status: 'ahead', aheadBy: 0, mergedPrs: [], complete: true })
    assert.equal(requests.filter((path) => path.includes('/compare/')).length, 0, 'a first run compared something')
    assert.equal(requests.filter((path) => path.includes('/commits/')).length, 0, 'a first run looked up a commit')
  } finally {
    store.close()
    await github.close()
  }
})

test('a goal near the length cap still carries the temporal line', async () => {
  const requests: string[] = []
  const github = await temporalServer(requests)
  const config = testConfig({ github: { ...testConfig().github, apiBase: github.url } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'flybot', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'temporal-long', status: 'approved' })
    const repo = temporalRepo(store, user.id, 'repo_temporal_long', config.tokenEncryptionKey)
    const previous = store.createJob({
      id: 'job_temporal_long_prev',
      repoId: repo.id,
      userId: user.id,
      trigger: 'manual',
      goal: 'previous run',
      callbackHash: 'h',
      platformTokenHash: '',
      baseSha: TEMPORAL_PREVIOUS_SHA,
      createdAt: '2026-11-10T00:00:00.000Z',
    })
    store.updateJob(previous.id, { status: 'succeeded', finished_at: '2026-11-10T00:05:00.000Z' })

    // A goal that would fill the whole budget: the data line is what has to
    // survive the cap, because the caller cannot get it back any other way.
    const result = await jobs.enqueue(repo, 'manual', 'x'.repeat(3990), 'iterate', {})
    assert.equal(result.ok, true, result.error ?? 'enqueue failed')
    const job = store.getJob(result.job!.id)!
    assert.ok(job.goal.length <= 4000, `goal is ${String(job.goal.length)} characters`)
    assert.match(job.goal, /Since 4f2c1a9: 3 commits ahead, 2 merged PRs \(#812, #815\)/, 'the cap squeezed the delta line out')
  } finally {
    store.close()
    await github.close()
  }
})

// #247: the attempt is the unit a worker owns. These cover the two crash
// boundaries the card names and the fence that stops a taken-over worker from
// writing over the attempt it lost.

test('a dispatch attempt reaped after the bridge accepted is terminal, and its late success is refused', async () => {
  const bridge = await startFakeServer(async (request, response) => {
    await readBody(request)
    json(response, 200, { ok: true })
  })
  const config = testConfig()
  const store = new Store(':memory:')
  let accepted!: () => void
  const bridgeAccepted = new Promise<void>((resolve) => { accepted = resolve })
  let release!: () => void
  const runnerReleased = new Promise<void>((resolve) => { release = resolve })
  // The fake runner stands in for the bridge client: the dispatch is accepted
  // only once the bridge has answered, and the worker then dies silently.
  const runner: Runner = {
    name: 'capture',
    async run() {
      await fetch(bridge.url, { method: 'POST', body: '{}' })
      accepted()
      await runnerReleased
      return { status: 'succeeded', summary: 'late success' }
    },
  }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'attempt-crash', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_attempt_crash', userId: user.id, owner: 'o', name: 'attempt-crash', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const dispatched = jobs.enqueue(repo, 'manual')
    const neverDispatched = setTimeout(() => { throw new Error('the bridge was never dispatched') }, 5_000)
    neverDispatched.unref()
    await bridgeAccepted
    clearTimeout(neverDispatched)

    const job = store.get<JobRow>('SELECT * FROM jobs WHERE repo_id = ?', repo.id)!
    const running = store.jobAttempts(job.id)
    assert.equal(running.length, 1)
    assert.equal(running[0]!.status, 'running')
    assert.equal(running[0]!.worker, 'inline')
    assert.equal(running[0]!.attempt, 1)
    assert.equal(running[0]!.lease_epoch, 1)
    assert.ok(running[0]!.dispatch_id.startsWith(`${job.id}:`))

    // The worker stops renewing: its five-minute lease lapses and the tick's
    // stale-running recovery reaps the job.
    store.updateJob(job.id, { lease_until: '2000-01-01T00:00:00.000Z' })
    await jobs.tick()

    const reaped = store.jobAttempts(job.id)
    assert.equal(reaped.length, 1, 'the work item keeps exactly one attempt row')
    assert.equal(reaped[0]!.status, 'reaped')
    assert.match(reaped[0]!.error ?? '', /租约/)
    assert.notEqual(reaped[0]!.finished_at, null)
    assert.equal(store.getJob(job.id)?.status, 'failed')
    assert.equal(store.getJob(job.id)?.error_code, 'JOB_LEASE_EXPIRED')
    assert.equal(store.all<JobRow>("SELECT * FROM jobs WHERE repo_id = ? AND status = 'queued'", repo.id).length, 0, 'a reap must not reset the job to queued')

    // The crashed worker comes back and reports a success for the attempt it lost.
    release()
    const result = await dispatched
    assert.equal(result.ok, false)

    const after = store.jobAttempts(job.id)
    assert.equal(after.length, 1, 'the late report adds no second attempt row')
    assert.equal(after[0]!.status, 'reaped', 'a late success must not rewrite the reaped outcome')
    assert.notEqual(after[0]!.refused_at, null, 'the late report is recorded on the attempt it lost')
    assert.match(after[0]!.refused_reason ?? '', /late/i)
    assert.equal(store.getJob(job.id)?.status, 'failed')
  } finally {
    release()
    store.close()
    await bridge.close()
  }
})

test('a dispatch that dies before the bridge accepts leaves one terminal failed attempt', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const runner: Runner = { name: 'capture', async run() { throw new Error('bridge refused the dispatch') } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'attempt-refused', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_attempt_refused', userId: user.id, owner: 'o', name: 'attempt-refused', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const result = await jobs.enqueue(repo, 'manual')
    assert.equal(result.ok, false)

    const job = store.get<JobRow>('SELECT * FROM jobs WHERE repo_id = ?', repo.id)!
    const attempts = store.jobAttempts(job.id)
    assert.equal(attempts.length, 1)
    assert.equal(attempts[0]!.status, 'failed')
    assert.match(attempts[0]!.error ?? '', /bridge refused the dispatch/)
    assert.notEqual(attempts[0]!.finished_at, null)
    assert.equal(job.status, 'failed')
    assert.equal(job.error_code, 'BRIDGE_ERROR')
    assert.equal(job.lease_owner, null)
  } finally {
    store.close()
  }
})

test('a superseded lease epoch cannot finalise an attempt, and a re-dispatch carries attempt N+1', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'attempt-fence', status: 'approved' })
    const repo = queueRepoFor(store, user.id, 'repo_fence')
    store.createJob({ id: 'job_fence', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'h', platformTokenHash: '' })

    const first = store.startJobAttempt('job_fence', 'worker-a', 60_000)!
    assert.equal(first.attempt, 1)
    assert.equal(first.epoch, 1)
    // The lease lapses and the reaper records the attempt as a terminal outcome.
    assert.equal(store.claimJobTerminal('job_fence', 'failed', null, { error: '任务租约过期：worker 未续约。', error_code: 'JOB_LEASE_EXPIRED' }, { epoch: first.epoch, outcome: 'reaped', error: '任务租约过期：worker 未续约。' }), true)

    // A re-dispatch of the same row starts attempt 2 and links it to the reaped row.
    store.updateJob('job_fence', { status: 'queued' })
    const second = store.startJobAttempt('job_fence', 'worker-b', 60_000)!
    assert.equal(second.attempt, 2)
    assert.equal(second.epoch, 2)
    const rows = store.jobAttempts('job_fence')
    assert.equal(rows.length, 2)
    assert.equal(rows[1]!.retry_of, rows[0]!.id)

    // The worker whose epoch was taken over cannot write a success for its attempt.
    assert.equal(store.claimJobTerminal('job_fence', 'succeeded', null, { summary: 'late' }, { epoch: first.epoch, outcome: 'succeeded' }), false)
    assert.equal(store.getJob('job_fence')?.status, 'running')
    assert.equal(store.refuseJobAttempt('job_fence', first.epoch, 'late success from a lost lease'), true)
    const finalRows = store.jobAttempts('job_fence')
    assert.notEqual(finalRows[0]!.refused_at, null)
    assert.equal(finalRows[1]!.status, 'running')
  } finally {
    store.close()
  }
})

test('a retried job records attempt N+1 and links it to the attempt it continues', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'attempt-retry', status: 'approved' })
    const repo = queueRepoFor(store, user.id, 'repo_attempt_retry')
    store.createJob({ id: 'job_attempt_source', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'h', platformTokenHash: '' })
    const source = store.startJobAttempt('job_attempt_source', 'worker-a', 60_000)!
    assert.equal(store.claimJobTerminal('job_attempt_source', 'failed', null, { error: 'task crashed', error_code: 'JOB_LEASE_EXPIRED' }, { epoch: source.epoch, outcome: 'reaped', error: 'task crashed' }), true)

    store.createJob({ id: 'job_attempt_retry', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'h', platformTokenHash: '', retryOf: 'job_attempt_source' })
    const next = store.startJobAttempt('job_attempt_retry', 'worker-b', 60_000)!
    assert.equal(next.attempt, 2)

    const rows = store.jobAttempts('job_attempt_retry')
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.attempt, 2)
    assert.equal(rows[0]!.retry_of, source.id)
  } finally {
    store.close()
  }
})

test('an override records the decision it overturned — job, review, score, model and tip', async () => {
  // #980: the override write was only asserted to exist. A detail that lost the
  // decision identity (job, model, tip) kept the suite green, so this reads the
  // structured record the page and the trend both consume.
  const merges: string[] = []
  const github = await startFakeServer((request, response) => {
    const method = request.method ?? 'GET'
    const url = request.url ?? ''
    if (method === 'GET' && url === '/repos/o/r/pulls/1') {
      json(response, 200, { number: 1, html_url: 'https://github.com/o/r/pull/1', title: 'fix', state: 'open', head: { ref: 'fledge/fix', sha: 'abc' }, base: { ref: 'main' }, mergeable: true, mergeable_state: 'clean', draft: false, merged: false })
      return
    }
    if (method === 'GET' && url === '/repos/o/r/commits/abc/check-runs?per_page=100') {
      json(response, 200, { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] })
      return
    }
    if (method === 'GET' && url === '/repos/o/r/commits/abc/status') {
      json(response, 200, { state: 'success', statuses: [] })
      return
    }
    if (method === 'GET' && url === '/repos/o/r/pulls/1/reviews?per_page=100') {
      json(response, 200, [])
      return
    }
    if (method === 'GET' && url === '/repos/o/r/branches/main/protection') {
      json(response, 200, { required_status_checks: { contexts: ['ci'] }, required_pull_request_reviews: { required_approving_review_count: 0 } })
      return
    }
    if (method === 'PUT' && url === '/repos/o/r/pulls/1/merge') {
      merges.push('merge')
      json(response, 200, { merged: true, sha: 'def' })
      return
    }
    json(response, 404, { message: 'Not Found' })
  })
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: github.url } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  const tip = 'c'.repeat(40)
  try {
    const user = makeUser(store, { login: 'override-record-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_override_record', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', autoMerge: true, upstreamHtmlUrl: 'https://github.com/o/r', forkHtmlUrl: 'https://github.com/o/r', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const item = store.createWorkItem({ id: 'work_override_record', repoId: repo.id, userId: user.id, title: 'fix', prUrl: 'https://github.com/o/r/pull/1', state: 'changes_requested' })
    const review = store.createJob({ id: 'job_override_review', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'review', callbackHash: 'review-hash', platformTokenHash: '', kind: 'review', workItemId: item.id })
    store.updateJob(review.id, { status: 'succeeded', review_score: 60, finished_at: new Date().toISOString() })
    // The decision row is the one source the override names, so seed it with the
    // identity the record has to carry through.
    store.audit(user.id, 'work_item.review_outcome', formatReviewOutcomeDetail({
      workItemId: item.id, outcome: 'changes_requested', score: 60, reviewJobId: review.id, model: 'model-980', tip,
    }))
    const secret = 'override-record-secret'
    store.createJob({ id: 'job_override_iterate', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'iterate', baseBranch: 'main', workItemId: item.id })
    store.updateJob('job_override_iterate', { status: 'running', branch: 'fledge/fix', pr_url: 'https://github.com/o/r/pull/1', started_at: new Date().toISOString() })

    const manual = await jobs.manualMerge(repo, store.getJob('job_override_iterate')!)
    assert.equal(manual.ok, true)
    assert.equal(merges.length, 1)

    const row = store.listAudit().find((entry) => entry.action === 'job.merge_review_override')
    assert.ok(row, 'the override is audited')
    const detail = row.detail ?? ''
    assert.ok(detail.startsWith('job_override_iterate: review '), 'the detail names the iterate job that merged')
    const parsed = parseReviewOverrideDetail(detail)
    assert.ok(parsed, 'the detail parses as the structured record, not a bare sentence')
    assert.equal(parsed.reviewJobId, 'job_override_review', 'the review job that made the decision')
    assert.equal(parsed.score, 60, 'the score that decision recorded')
    assert.equal(parsed.model, 'model-980', 'the model that answered the review')
    assert.equal(parsed.tip, tip, 'the tip that review covered')
    assert.match(parsed.reason, /changes_requested|review gate/i, 'the reason still names the block')
  } finally {
    store.close()
    await github.close()
  }
})
