import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { buildApp, type BuiltApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { encryptSecret } from '../src/lib/secrets.js'
import type { Runner } from '../src/jobs/runner.js'
import { json, makeUser, MemoryMailer, readBody, startFakeServer, testConfig } from './helpers.js'

// #360: the four job verbs act on the work item the issue is linked to. These
// cases drive the real webhook route, so the parser, the dedupe, the job action
// and the reply are exercised together: a verb that only parses would create no
// job and post no comment, which is what the red run showed.
const ISSUE_URL = 'https://github.com/HugoXK/issue-demo/issues/5'
const PR_URL = 'https://github.com/HugoXK/issue-demo/pull/9'
const WEBHOOK_SECRET = 'secret'

const runner: Runner = { name: 'capture', async run() { return { status: 'running' } } }

interface Comment {
  path: string
  body: string
}

interface Harness {
  built: BuiltApp
  store: Store
  repoId: string
  userId: string
  itemId: string
  comments: Comment[]
  deliver: (command: string, options?: { association?: string; commentId?: number; delivery?: string; issueNumber?: number }) => Promise<number>
  close: () => Promise<void>
}

async function harness(): Promise<Harness> {
  const comments: Comment[] = []
  const github = await startFakeServer(async (request, response) => {
    const raw = await readBody(request)
    comments.push({ path: request.url ?? '', body: raw.toString('utf8') })
    json(response, 201, { id: comments.length })
  })
  const config = testConfig({
    github: { ...testConfig().github, apiBase: github.url },
    githubApp: { id: '1', slug: 'fledge-platform', privateKeyPath: '/tmp/fake.pem', webhookSecret: WEBHOOK_SECRET, useUserToken: true },
  })
  const store = new Store(':memory:')
  const user = makeUser(store, { login: 'issue-command-user', status: 'approved' })
  store.setUserGithubToken(user.id, encryptSecret('gh-user-token', config.tokenEncryptionKey), 'repo')
  const repo = store.createRepo({
    id: 'repo_issue_cmd',
    userId: user.id,
    owner: 'HugoXK',
    name: 'issue-demo',
    defaultBranch: 'main',
    tokenEnc: '',
    permission: 'admin',
    repoRole: 'maintainer',
    installationId: 42,
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  const item = store.createWorkItem({ id: 'work_issue_cmd', repoId: repo.id, userId: user.id, title: 'Fix it', detail: 'details', issueUrl: ISSUE_URL, state: 'assigned' })
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner, startScheduler: false })

  let delivery = 0
  const deliver = async (command: string, options: { association?: string; commentId?: number; delivery?: string; issueNumber?: number } = {}): Promise<number> => {
    const number = options.issueNumber ?? 5
    const payload = {
      action: 'created',
      installation: { id: 42 },
      repository: { full_name: 'HugoXK/issue-demo' },
      issue: { number, html_url: `https://github.com/HugoXK/issue-demo/issues/${number}`, title: 'Fix it', body: 'details' },
      comment: { id: options.commentId ?? 100, body: command, author_association: options.association ?? 'MEMBER' },
    }
    const raw = Buffer.from(JSON.stringify(payload))
    const signature = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex')}`
    delivery += 1
    const response = await built.app.inject({
      method: 'POST',
      url: '/api/github/webhook',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': options.delivery ?? `delivery-${delivery}`,
        'x-hub-signature-256': signature,
      },
      payload: raw,
    })
    assert.equal(response.statusCode, 200, `webhook delivery failed: ${response.body}`)
    return response.statusCode
  }

  return {
    built,
    store,
    repoId: repo.id,
    userId: user.id,
    itemId: item.id,
    comments,
    deliver,
    close: async () => {
      await built.close()
      await github.close()
    },
  }
}

function jobBodies(store: Store, repoId: string) {
  return store.listJobsForRepo(repoId, 20)
}

test('a collaborator retries the work item once, and a duplicate delivery or a stranger adds nothing', async () => {
  const h = await harness()
  try {
    const source = h.store.createJob({ id: 'job_retry_source', repoId: h.repoId, userId: h.userId, trigger: 'manual', goal: 'Implement it', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate', baseBranch: 'main', workItemId: h.itemId })
    h.store.updateJob(source.id, { status: 'failed', branch: 'fledge/fix', pr_url: PR_URL, checkpoint: 'halfway', finished_at: new Date().toISOString() })

    await h.deliver('/fledge retry', { commentId: 201 })

    const afterFirst = jobBodies(h.store, h.repoId)
    assert.equal(afterFirst.length, 2, 'exactly one retry job is created')
    const retried = afterFirst.find((job) => job.id !== source.id)
    assert.ok(retried !== undefined, 'the retry job exists')
    assert.equal(retried.trigger, 'followup', 'a job with a pull request retries as a follow-up, not a second run')
    assert.equal(retried.pr_url, PR_URL, 'the retry resumes the same pull request')
    assert.equal(retried.branch, 'fledge/fix', 'the retry keeps the branch')
    assert.match(retried.goal, /Resume from checkpoint:\nhalfway/, 'the retry carries the checkpoint forward')
    assert.equal(retried.work_item_id, h.itemId, 'the retry stays on the issue work item')

    assert.equal(h.comments.length, 1, 'one reply is posted')
    const reply = h.comments[0]!
    assert.match(reply.path, /\/repos\/HugoXK\/issue-demo\/issues\/5\/comments/, 'the reply goes to the issue thread')
    assert.match((JSON.parse(reply.body) as { body: string }).body, new RegExp(`Queued job ${retried.id} to retry job ${source.id}`), 'the reply names the retry it queued')

    assert.ok(h.store.listAudit(50).some((row) => row.action === 'job.retried' && row.detail === `${source.id} -> ${retried.id}`), 'the retry is audited under the existing action')
    assert.ok(h.store.listJobEvents(source.id).some((event) => event.kind === 'job.retry_started' && event.meta === retried.id), 'the source job timeline records the retry')
    assert.ok(h.store.listJobEvents(retried.id).some((event) => event.kind === 'job.enqueued'), 'the new job timeline records its enqueue')

    // Same comment id, new delivery id: the comment-id dedupe has to hold.
    await h.deliver('/fledge retry', { commentId: 201, delivery: 'delivery-duplicate' })
    assert.equal(jobBodies(h.store, h.repoId).length, 2, 'a duplicate comment creates no second job')
    assert.equal(h.comments.length, 1, 'a duplicate comment posts no second reply')

    // A stranger's command parses to nothing: no job and no reply.
    await h.deliver('/fledge retry', { association: 'CONTRIBUTOR', commentId: 202 })
    assert.equal(jobBodies(h.store, h.repoId).length, 2, "a stranger's command creates no job")
    assert.equal(h.comments.length, 1, "a stranger's command posts no reply")

    const urls = new Set(jobBodies(h.store, h.repoId).map((job) => job.pr_url).filter((url): url is string => url !== null))
    assert.equal(urls.size, 1, 'no command creates a second pull request')
  } finally {
    await h.close()
  }
})

test('pause holds the active job and resume creates the existing resumed job on the same pull request', async () => {
  const h = await harness()
  try {
    const active = h.store.createJob({ id: 'job_pause_source', repoId: h.repoId, userId: h.userId, trigger: 'manual', goal: 'Implement it', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate', baseBranch: 'main', workItemId: h.itemId })
    h.store.updateJob(active.id, { status: 'running', branch: 'fledge/fix', pr_url: PR_URL, started_at: new Date().toISOString() })

    await h.deliver('/fledge pause', { commentId: 301 })
    assert.equal(h.store.getJob(active.id)?.status, 'paused', 'the active job is paused')
    assert.equal(h.comments.length, 1)
    assert.match((JSON.parse(h.comments[0]!.body) as { body: string }).body, new RegExp(`Paused job ${active.id}`), 'the pause reply names the job')
    assert.ok(h.store.listAudit(50).some((row) => row.action === 'job.paused' && row.detail === active.id), 'pause uses the existing audit action')
    assert.ok(h.store.listJobEvents(active.id).some((event) => event.kind === 'job.paused'), 'pause appears in the job timeline')

    await h.deliver('/fledge resume', { commentId: 302 })
    const jobs = jobBodies(h.store, h.repoId)
    const resumed = jobs.find((job) => job.id !== active.id)
    assert.ok(resumed !== undefined, 'resume creates the resumed job')
    assert.equal(h.store.getJob(active.id)?.status, 'cancelled', 'the paused row is closed as resumed')
    assert.equal(h.store.getJob(active.id)?.error, `resumed as ${resumed.id}`, 'the paused row names what replaced it')
    assert.equal(resumed.pr_url, PR_URL, 'the resumed job keeps the same pull request')
    assert.equal(resumed.trigger, 'manual', 'a resume creates its job the same way the console resume does')
    assert.match((JSON.parse(h.comments[1]!.body) as { body: string }).body, new RegExp(`Resumed job ${active.id} as job ${resumed.id}`), 'the resume reply names both jobs')
    assert.ok(h.store.listAudit(50).some((row) => row.action === 'job.resumed' && row.detail === `${active.id} -> ${resumed.id}`), 'resume uses the existing audit action')
    assert.ok(h.store.listJobEvents(active.id).some((event) => event.kind === 'job.resumed'), 'the paused job timeline records the resume')
    assert.ok(h.store.listJobEvents(resumed.id).some((event) => event.kind === 'job.resumed_from' && event.meta === active.id), 'the resumed job timeline names its source')

    const urls = new Set(jobBodies(h.store, h.repoId).map((job) => job.pr_url).filter((url): url is string => url !== null))
    assert.equal(urls.size, 1, 'pause and resume never create a second pull request')
  } finally {
    await h.close()
  }
})

test('cancel stops the active job and leaves no new job behind', async () => {
  const h = await harness()
  try {
    const active = h.store.createJob({ id: 'job_cancel_source', repoId: h.repoId, userId: h.userId, trigger: 'manual', goal: 'Implement it', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate', workItemId: h.itemId })
    h.store.updateJob(active.id, { status: 'running', started_at: new Date().toISOString() })

    await h.deliver('/fledge cancel', { commentId: 401 })
    assert.equal(h.store.getJob(active.id)?.status, 'cancelled', 'the active job is cancelled')
    assert.equal(jobBodies(h.store, h.repoId).length, 1, 'cancel creates no job')
    assert.equal(h.comments.length, 1)
    assert.match((JSON.parse(h.comments[0]!.body) as { body: string }).body, new RegExp(`Cancelled job ${active.id}`), 'the cancel reply names the job')
    assert.ok(h.store.listAudit(50).some((row) => row.action === 'job.cancelled'), 'cancel uses the existing audit action')
    assert.ok(h.store.listJobEvents(active.id).some((event) => event.kind === 'job.cancelled'), 'cancel appears in the job timeline')
  } finally {
    await h.close()
  }
})

test('a control verb with nothing to act on refuses instead of starting a job', async () => {
  const h = await harness()
  try {
    const finished = h.store.createJob({ id: 'job_finished', repoId: h.repoId, userId: h.userId, trigger: 'manual', goal: 'Implement it', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate', workItemId: h.itemId })
    h.store.updateJob(finished.id, { status: 'failed', finished_at: new Date().toISOString() })

    await h.deliver('/fledge pause', { commentId: 501 })
    await h.deliver('/fledge cancel', { commentId: 502 })
    await h.deliver('/fledge resume', { commentId: 503 })

    assert.equal(h.store.getJob(finished.id)?.status, 'failed', 'a terminal job is left alone')
    assert.equal(jobBodies(h.store, h.repoId).length, 1, 'no refusal creates a job')
    assert.equal(h.comments.length, 3, 'each refusal replies once')
    const replies = h.comments.map((comment) => (JSON.parse(comment.body) as { body: string }).body)
    assert.match(replies[0]!, /there is no queued or running job to pause/, 'pause names the missing active job')
    assert.match(replies[1]!, /there is no queued or running job to cancel/, 'cancel names the missing active job')
    assert.match(replies[2]!, /only a paused job can be resumed/, 'resume names the status it needs')

    // An issue with no work item at all is the same refusal, not a first job.
    await h.deliver('/fledge pause', { commentId: 504, issueNumber: 6 })
    assert.equal(jobBodies(h.store, h.repoId).length, 1, 'a control verb creates no work item and no job')
    assert.equal(h.comments.length, 4)
    assert.match((JSON.parse(h.comments[3]!.body) as { body: string }).body, /No work item is linked to this issue; nothing to pause/, 'the reply says there is no linked work item')
  } finally {
    await h.close()
  }
})
