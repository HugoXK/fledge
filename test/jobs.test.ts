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
    const repo = store.createRepo({ id: 'repo_attr', userId: user.id, owner: 'owner', name: 'repo', defaultBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
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
    const repo = store.createRepo({ id: 'repo_auto_merge_pass', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', autoMerge: true, goal: '', autoIterate: false, intervalMinutes: 1440 })
    const secret = 'auto-merge-secret'
    store.createJob({ id: 'job_auto_merge_pass', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob('job_auto_merge_pass', { status: 'running', started_at: new Date().toISOString() })
    const result = await jobs.handleCallback('job_auto_merge_pass', secret, { status: 'succeeded', prUrl: 'https://github.com/o/r/pull/1', summary: 'done' })
    assert.equal(result.ok, true)
    assert.equal(merges.length, 1)

    reviews = [{ state: 'CHANGES_REQUESTED', user: { login: 'reviewer' }, submitted_at: '2026-11-03T00:00:00Z' }]
    store.createJob({ id: 'job_auto_merge_blocked', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob('job_auto_merge_blocked', { status: 'running', started_at: new Date().toISOString() })
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

test('flybot preflight records the base SHA and skips scheduled work while a work item is active', async () => {
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
    store.createWorkItem({ id: 'work_preflight', repoId: repo.id, userId: user.id, title: 'Active work', state: 'in_progress' })
    const scheduled = await jobs.enqueue(repo, 'schedule')
    assert.equal(scheduled.ok, false)
    assert.equal(scheduled.code, 'WORK_ITEM_OPEN')
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
    const repo = store.createRepo({ id: 'repo_auto_merge_protection', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', autoMerge: true, requireProtection: true, goal: '', autoIterate: false, intervalMinutes: 1440 })
    const secret = 'auto-merge-protection-secret'
    store.createJob({ id: 'job_auto_merge_protection', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob('job_auto_merge_protection', { status: 'running', started_at: new Date().toISOString() })
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
