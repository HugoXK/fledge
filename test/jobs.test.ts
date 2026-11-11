import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import type { JobRow, RepoRow, WorkItemRow } from '../src/db.js'
import { InstanceManager } from '../src/flybot/instances.js'
import { PLAYBOOK_VERSION, playbookFingerprint } from '../src/flybot/playbook.js'
import { Jobs } from '../src/jobs/service.js'
import { buildCarryOver, buildRunDigest, classifyOutput, decideNextJob, failureStreak, isMetaTitle, lastDurationMs } from '../src/jobs/continuity.js'
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
  const config = testConfig({ notifyWebhookUrl: webhook.url, notifyWebhookSecret: 'hook-secret' })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'webhook-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_webhook', userId: user.id, owner: 'o', name: 'hook', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const secret = 'webhook-job-secret'
    store.createJob({ id: 'job_webhook', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob('job_webhook', { status: 'running', started_at: new Date().toISOString() })
    await jobs.handleCallback('job_webhook', secret, { status: 'succeeded', summary: 'done' })
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
    assert.match(goal, /work_open state=triaged/)
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
    state: 'triaged', priority: 0, assignee_user_id: null, job_id: null,
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

test('carry-over is bounded, names the open work and is explicitly data', () => {
  const text = buildCarryOver({
    recent: [job({ id: 'job_2', summary: 'created issue #2', issue_url: 'https://x/issues/2' })],
    openWork: [workItem({ pr_url: 'https://x/pr/3', state: 'pr_ready' })],
    maxChars: 500,
  })
  assert.ok(text.length <= 500)
  assert.match(text, /not a new goal/)
  assert.match(text, /Recent runs:/)
  assert.match(text, /Open work:/)
  assert.match(text, /work_1 state=pr_ready/)
  assert.match(text, /https:\/\/x\/pr\/3/)
})

test('a due repo with no open work starts one iterate job', () => {
  const next = decideNextJob({
    repo: repo(), now, lastRunAt: iso(-2 * 3_600_000), intervalMinutes: 60,
    lastDurationMs: 1_000, failureStreak: 0, openWork: [], reviewerEnabled: false, reviewDue: true,
  })
  assert.deepEqual(next, { kind: 'iterate' })
})

test('open work continues instead of starting another isolated iterate', () => {
  const pr = workItem({ pr_url: 'https://x/pr/3', state: 'pr_ready' })
  const followup = decideNextJob({
    repo: repo({ repo_role: 'developer' }), now, lastRunAt: iso(-2 * 3_600_000),
    intervalMinutes: 60, lastDurationMs: 0, failureStreak: 0, openWork: [pr], reviewerEnabled: true, reviewDue: true,
  })
  assert.equal(followup.kind, 'followup')
  assert.equal(followup.kind === 'followup' ? followup.workItemId : null, 'work_1')

  const review = decideNextJob({
    repo: repo({ repo_role: 'maintainer' }), now, lastRunAt: iso(-2 * 3_600_000),
    intervalMinutes: 60, lastDurationMs: 0, failureStreak: 0, openWork: [pr], reviewerEnabled: true, reviewDue: true,
  })
  assert.equal(review.kind, 'review')
  assert.equal(review.kind === 'review' ? review.prUrl : null, 'https://x/pr/3')

  const scoped = decideNextJob({
    repo: repo(), now, lastRunAt: iso(-2 * 3_600_000), intervalMinutes: 60,
    lastDurationMs: 0, failureStreak: 0, openWork: [workItem()], reviewerEnabled: false, reviewDue: false,
  })
  assert.equal(scoped.kind, 'followup')
})

test('the interval respects the last duration and backs off after failures', () => {
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
  const notDue = decideNextJob({
    repo: repo(), now, lastRunAt: iso(-90 * 60_000), intervalMinutes: 60,
    lastDurationMs: 60 * 60_000, failureStreak: 1, openWork: [], reviewerEnabled: false, reviewDue: true,
  })
  assert.equal(notDue.kind, 'none')
  const backedOff = decideNextJob({
    repo: repo(), now, lastRunAt: iso(-90 * 60_000), intervalMinutes: 60,
    lastDurationMs: 0, failureStreak: 3, openWork: [], reviewerEnabled: false, reviewDue: true,
  })
  assert.equal(backedOff.kind, 'none')
})


test('a due maintainer continues the open PR when the review interval is not due', () => {
  const pr = workItem({ pr_url: 'https://x/pr/3', state: 'pr_ready' })
  const next = decideNextJob({
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
