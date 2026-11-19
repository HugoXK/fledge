// #634: approving a plan is a decision about one specific plan. On the base tree
// the web route writes the decision straight through (`src/app.ts:4006-4008`), a
// second POST overwrites it, the issue command writes a different audit name and
// records `repo.user_id` as the actor, and no column holds the plan the person
// read. These cases fail there; they pass when the decision is one record written
// by one function from both doors.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { buildApp, type BuiltApp } from '../src/app.js'
import { Store } from '../src/db.js'
import type { JobRow } from '../src/db.js'
import { planPacketHash } from '../src/lib/planDecision.js'
import { encryptSecret } from '../src/lib/secrets.js'
import type { Runner } from '../src/jobs/runner.js'
import { flashOf, formBody, json, makeUser, MemoryMailer, readBody, sessionFor, startFakeServer, testConfig } from './helpers.js'
import type { UserRow } from '../src/db.js'

// #634: the fixture stays under the 16-character floor on purpose —
// `scripts/secret-scan.mjs` reds a qualified `*_SECRET =` value of 16 characters
// or more, and this file is tracked, so a longer one fails the suite's own scan.
const WEBHOOK_SECRET = 'secret'
const ISSUE_URL = 'https://github.com/octo/decision/issues/1'
const PLAN_SUMMARY = 'Plan: change one file and add one test'
const PLAN_BASE = '1111111111111111111111111111111111111111'
const NEWER_BASE = '2222222222222222222222222222222222222222'
const EVIDENCE = {
  scope: 'src/lib/planDecision.ts',
  acceptance: 'one decision, one record',
  testPlan: 'POST the form twice',
  testRed: 'the second POST was written on the base tree',
  testGreen: 'the second POST is refused',
  tests: 'node:test',
  checks: 'npm run check',
  files: 4,
  risk: 'low',
  rollback: 'revert the commit',
}
const runner: Runner = { name: 'capture', async run() { return { status: 'running' } } }

interface Harness {
  built: BuiltApp
  store: Store
  user: UserRow
  repo: ReturnType<Store['createRepo']>
  job: JobRow
  item: ReturnType<Store['createWorkItem']>
  session: { raw: string; csrf: string; cookie: string }
  comments: { path: string; body: string }[]
  post: (action: string, values?: Record<string, string | number | undefined>) => Promise<Awaited<ReturnType<BuiltApp['app']['inject']>>>
  deliver: (command: string, commentId?: number) => Promise<void>
  close: () => Promise<void>
}

async function harness(options: { evidence?: boolean } = {}): Promise<Harness> {
  const comments: { path: string; body: string }[] = []
  const github = await startFakeServer(async (request, response) => {
    const raw = await readBody(request)
    comments.push({ path: request.url ?? '', body: raw.toString('utf8') })
    json(response, 201, { id: comments.length })
  })
  const config = testConfig({
    plan: { expiryDays: 7, reminderDays: 2 },
    github: { ...testConfig().github, apiBase: github.url },
    githubApp: { id: '1', slug: 'fledge-platform', privateKeyPath: '/tmp/fake.pem', webhookSecret: WEBHOOK_SECRET, useUserToken: true },
  })
  const store = new Store(':memory:')
  const user = makeUser(store, { login: 'plan-decision-user', status: 'approved' })
  store.setUserGithubToken(user.id, encryptSecret('gh-user-token', config.tokenEncryptionKey), 'repo')
  const repo = store.createRepo({
    id: 'repo_plan_decision', userId: user.id, owner: 'octo', name: 'decision', defaultBranch: 'main',
    tokenEnc: '', permission: 'admin', repoRole: 'maintainer', planRequired: true, goal: '',
    autoIterate: false, intervalMinutes: 1440, installationId: 42,
    allowPaths: 'src/', denyPaths: 'docs/',
  })
  const job = store.createJob({
    id: 'job_plan_decision', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'plan the work',
    callbackHash: 'cb', platformTokenHash: '', kind: 'plan', baseBranch: 'main',
  })
  store.updateJob(job.id, {
    status: 'succeeded', summary: PLAN_SUMMARY, base_sha: PLAN_BASE, finished_at: new Date().toISOString(),
    ...(options.evidence === false ? {} : { evidence_json: JSON.stringify(EVIDENCE) }),
  })
  const item = store.createWorkItem({ id: 'wi_plan_decision', repoId: repo.id, userId: user.id, title: 'plan', issueUrl: ISSUE_URL, state: 'triaged', jobId: job.id })
  store.updateJob(job.id, { work_item_id: item.id })
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner, startScheduler: false })
  const session = sessionFor(built, user)
  let delivery = 0
  return {
    built, store, user, repo, job: store.getJob(job.id)!, item, session, comments,
    post: async (action, values = {}) => built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/jobs/${job.id}/${action}`,
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: session.csrf, ...values }),
    }),
    deliver: async (command, commentId = 900) => {
      const payload = {
        action: 'created',
        installation: { id: 42 },
        repository: { full_name: 'octo/decision' },
        issue: { number: 1, html_url: ISSUE_URL, title: 'Fix it', body: 'details' },
        comment: { id: commentId, body: command, author_association: 'MEMBER', user: { login: user.login } },
      }
      const raw = Buffer.from(JSON.stringify(payload))
      delivery += 1
      const signature = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex')}`
      const response = await built.app.inject({
        method: 'POST',
        url: '/api/github/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issue_comment',
          'x-github-delivery': `plan-decision-${delivery}`,
          'x-hub-signature-256': signature,
        },
        payload: raw,
      })
      assert.equal(response.statusCode, 200, `webhook delivery failed: ${response.body}`)
    },
    close: async () => {
      await built.close()
      await github.close()
    },
  }
}

const hashOf = (job: JobRow): string => planPacketHash({ summary: job.summary, evidenceJson: job.evidence_json, baseSha: job.base_sha })
const audits = (store: Store, action: string): unknown[] => store.listAudit(200).filter((row) => row.action === action)

test('an approval records the plan the person read', async () => {
  const h = await harness()
  try {
    const planHash = hashOf(h.job)
    const response = await h.post('approve-plan', { planHash, allowPaths: 'src/', denyPaths: 'docs/' })
    assert.equal(response.statusCode, 302)
    assert.equal(flashOf(response)?.error, undefined, `the approval was refused: ${flashOf(response)?.error?.text ?? ''}`)
    const row = h.store.getJob(h.job.id)!
    assert.equal(row.plan_hash, planHash, 'the row keeps the hash of the plan that was approved')
    assert.equal(row.plan_approved_by, h.user.id, 'the actor is the person who decided')
    assert.notEqual(row.plan_approved_at, null)
    assert.equal(row.plan_allow_paths, 'src/')
    assert.equal(row.plan_deny_paths, 'docs/')
    assert.equal(h.store.getWorkItem(h.item.id)!.state, 'assigned')
    assert.equal(audits(h.store, 'job.plan_approved').length, 1, 'one decision, one audit row')
  } finally {
    await h.close()
  }
})

test('a second decision is refused and the first one stands', async () => {
  const h = await harness()
  try {
    const planHash = hashOf(h.job)
    await h.post('approve-plan', { planHash })
    const first = h.store.getJob(h.job.id)!
    const second = await h.post('reject-plan', { planHash, reason: 'changed my mind' })
    assert.equal(second.statusCode, 302)
    assert.ok(flashOf(second)?.error, 'a second decision is refused with a reason')
    const row = h.store.getJob(h.job.id)!
    assert.equal(row.plan_approved_at, first.plan_approved_at, 'the first decision time is unchanged')
    assert.equal(row.plan_approved_by, first.plan_approved_by, 'the first decision actor is unchanged')
    assert.equal(row.plan_rejected_at, null, 'the refusal writes nothing')
    assert.equal(audits(h.store, 'job.plan_approved').length, 1)
    assert.equal(audits(h.store, 'job.plan_rejected').length, 0)
  } finally {
    await h.close()
  }
})

test('the web form and the issue command write one record', async () => {
  const web = await harness()
  const command = await harness()
  try {
    await web.post('approve-plan', { planHash: hashOf(web.job) })
    await command.deliver('/fledge approve', 901)
    const viaWeb = web.store.getJob(web.job.id)!
    const viaCommand = command.store.getJob(command.job.id)!
    assert.equal(viaCommand.plan_approved_at === null, false, 'the command door approved the plan')
    assert.equal(viaCommand.plan_approved_by, command.user.id, 'the command records the deciding user, not the repository owner')
    assert.equal(viaCommand.plan_hash, viaWeb.plan_hash, 'both doors record the same plan hash')
    assert.equal(viaWeb.plan_allow_paths, 'src/', 'the web door starts from the repository paths')
    assert.equal(viaCommand.plan_allow_paths, viaWeb.plan_allow_paths, 'both doors record the same allow paths')
    assert.equal(viaCommand.plan_deny_paths, viaWeb.plan_deny_paths, 'both doors record the same deny paths')
    assert.equal(audits(command.store, 'job.plan_approved').length, 1)
    assert.equal(audits(command.store, 'plan.approved').length, 0, 'the second audit name is gone')
    assert.equal(command.store.getWorkItem(command.item.id)!.state, 'assigned')
  } finally {
    await web.close()
    await command.close()
  }
})

test('a plan edited behind the store is refused with a hash mismatch', async () => {
  const h = await harness()
  try {
    const shown = hashOf(h.job)
    h.store.updateJob(h.job.id, { summary: 'Plan: change two files instead' })
    const response = await h.post('approve-plan', { planHash: shown })
    assert.ok(flashOf(response)?.error, 'the stale plan is refused')
    const row = h.store.getJob(h.job.id)!
    assert.equal(row.plan_approved_at, null, 'nothing is written')
    assert.equal(row.plan_hash, null)
    assert.equal(audits(h.store, 'job.plan_approved').length, 0)
  } finally {
    await h.close()
  }
})

test('a reject needs a reason and records it with the deciding actor', async () => {
  const h = await harness()
  try {
    const planHash = hashOf(h.job)
    const bare = await h.post('reject-plan', { planHash })
    assert.ok(flashOf(bare)?.error, 'a reject without a reason is refused')
    assert.equal(h.store.getJob(h.job.id)!.plan_rejected_at, null)
    const withReason = await h.post('reject-plan', { planHash, reason: 'the scope is too wide' })
    assert.equal(withReason.statusCode, 302)
    assert.equal(flashOf(withReason)?.error, undefined)
    const row = h.store.getJob(h.job.id)!
    assert.notEqual(row.plan_rejected_at, null)
    assert.equal(row.plan_reject_reason, 'the scope is too wide')
    assert.equal(row.plan_approved_by, h.user.id, 'the rejecting actor is recorded too')
    assert.equal(audits(h.store, 'job.plan_rejected').length, 1)
  } finally {
    await h.close()
  }
})

test('a base that moved since the plan finished is refused and names both shas', async () => {
  const h = await harness()
  try {
    const newer = h.store.createJob({
      id: 'job_newer_run', repoId: h.repo.id, userId: h.user.id, trigger: 'manual', goal: 'run',
      callbackHash: 'cb2', platformTokenHash: '', kind: 'iterate', baseBranch: 'main',
    })
    h.store.updateJob(newer.id, { status: 'succeeded', base_sha: NEWER_BASE, finished_at: new Date(Date.now() + 1000).toISOString() })
    const response = await h.post('approve-plan', { planHash: hashOf(h.job) })
    const error = flashOf(response)?.error?.text ?? ''
    assert.ok(error.includes(PLAN_BASE), `the refusal names the planned base: ${error}`)
    assert.ok(error.includes(NEWER_BASE), `the refusal names the moved base: ${error}`)
    assert.equal(h.store.getJob(h.job.id)!.plan_approved_at, null)
  } finally {
    await h.close()
  }
})

test('the plan page leads with one decision, disables it without evidence and clears it once decided', async () => {
  const pending = await harness()
  const incomplete = await harness({ evidence: false })
  try {
    const page = await pending.built.app.inject({ method: 'GET', url: `/repos/${pending.repo.id}/jobs/${pending.job.id}`, headers: { cookie: pending.session.cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /data-plan-decision="pending"/)
    assert.equal((page.body.match(/data-plan-primary/g) ?? []).length, 1, 'an undecided plan renders exactly one primary action')

    const blind = await incomplete.built.app.inject({ method: 'GET', url: `/repos/${incomplete.repo.id}/jobs/${incomplete.job.id}`, headers: { cookie: incomplete.session.cookie } })
    assert.match(blind.body, /data-plan-decision="incomplete"/)
    assert.match(blind.body, /data-plan-primary[^>]*disabled/, 'the primary action is disabled with the reason')

    await pending.post('approve-plan', { planHash: hashOf(pending.job) })
    const decided = await pending.built.app.inject({ method: 'GET', url: `/repos/${pending.repo.id}/jobs/${pending.job.id}`, headers: { cookie: pending.session.cookie } })
    assert.match(decided.body, /data-plan-decision="approved"/)
    assert.equal((decided.body.match(/data-plan-primary/g) ?? []).length, 0, 'a decided plan renders no decision action')
  } finally {
    await pending.close()
    await incomplete.close()
  }
})

test('a revision is queued before the plan is rejected, so a queue refusal can be retried', async () => {
  const h = await harness()
  try {
    // A live job is the queue's own admission refusal (`JOB_ACTIVE`), the same
    // one the console already shows. It is what makes the write order observable:
    // with the rejection first, this press leaves a rejected plan and nothing
    // queued, and the retry below is refused `PLAN_ALREADY_DECIDED`.
    const busy = h.store.createJob({
      id: 'job_revise_busy', repoId: h.repo.id, userId: h.user.id, trigger: 'manual', goal: 'a run in flight',
      callbackHash: 'cb-busy', platformTokenHash: '', kind: 'iterate', baseBranch: 'main',
    })
    const refused = await h.post('revise-plan', { planHash: hashOf(h.job), reason: 'the scope is too wide' })
    assert.equal(refused.statusCode, 302)
    assert.match(flashOf(refused)?.error?.text ?? '', /JOB_ACTIVE|已有任务在运行/, 'the refusal is the queue\'s own')
    assert.equal(h.store.getJob(h.job.id)!.plan_rejected_at, null, 'a refused queue attempt decides nothing')
    assert.equal(h.store.listJobsForRepo(h.repo.id).filter((job) => job.kind === 'plan').length, 1, 'no revision was queued')

    h.store.updateJob(busy.id, { status: 'succeeded', finished_at: new Date().toISOString() })
    const retried = await h.post('revise-plan', { planHash: hashOf(h.job), reason: 'the scope is too wide' })
    assert.equal(retried.statusCode, 302)
    assert.equal(flashOf(retried)?.error, undefined, 'the retry is not refused by a decision the first press never wrote')
    const row = h.store.getJob(h.job.id)!
    assert.notEqual(row.plan_rejected_at, null)
    assert.equal(row.plan_reject_reason, 'the scope is too wide')
    const revisions = h.store.listJobsForRepo(h.repo.id).filter((job) => job.kind === 'plan' && job.id !== h.job.id)
    assert.equal(revisions.length, 1, 'the revision is queued once')
    assert.equal(revisions[0]?.work_item_id, h.item.id, 'on the same work item')
  } finally {
    await h.close()
  }
})
