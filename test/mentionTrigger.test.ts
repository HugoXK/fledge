import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { buildApp, type BuiltApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { encryptSecret } from '../src/lib/secrets.js'
import type { Runner } from '../src/jobs/runner.js'
import { json, makeUser, MemoryMailer, readBody, startFakeServer, testConfig } from './helpers.js'

// #637: a `@fledge` mention in a comment is a trigger, on the same command
// surface as `/fledge` and behind the same trusted-comment filter. These cases
// drive the real webhook route: the matcher, the claim (the comment id is the
// dedupe key), the review it starts and the audit row are exercised together.
const PR_URL = 'https://github.com/HugoXK/mention-demo/pull/9'
const ISSUE_URL = 'https://github.com/HugoXK/mention-demo/issues/12'
const HEAD_SHA = 'aaaabbbbccccddddeeeeffff0000111122223333'
const WEBHOOK_SECRET = 'secret'
const BOT_LOGIN = 'fledge-platform[bot]'

const runner: Runner = { name: 'capture', async run() { return { status: 'running' } } }

interface Comment {
  path: string
  body: string
}

interface Harness {
  built: BuiltApp
  store: Store
  repoId: string
  comments: Comment[]
  deliver: (body: string, options?: { association?: string; commentId?: number; login?: string; delivery?: string; draft?: boolean; closed?: boolean; issueTarget?: boolean; headSha?: string }) => Promise<number>
  close: () => Promise<void>
}

async function harness(): Promise<Harness> {
  const comments: Comment[] = []
  let draft = false
  const github = await startFakeServer(async (request, response) => {
    const raw = await readBody(request)
    comments.push({ path: request.url ?? '', body: raw.toString('utf8') })
    const path = (request.url ?? '').split('?')[0] ?? ''
    const pull = /\/pulls\/(\d+)$/.exec(path)
    if (pull !== null && (request.method ?? 'GET') === 'GET') {
      json(response, 200, {
        number: Number(pull[1]),
        html_url: PR_URL,
        title: 'Fix it',
        state: 'open',
        head: { ref: 'dev/mention', sha: headSha },
        base: { ref: 'main' },
        mergeable: true,
        mergeable_state: 'clean',
        draft,
        merged: false,
        changed_files: 1,
        body: '',
      })
      return
    }
    json(response, 201, { id: comments.length })
  })
  const config = testConfig({
    github: { ...testConfig().github, apiBase: github.url },
    githubApp: { id: '1', slug: 'fledge-platform', privateKeyPath: '/tmp/fake.pem', webhookSecret: WEBHOOK_SECRET, useUserToken: true },
  })
  const store = new Store(':memory:')
  const user = makeUser(store, { login: 'mention-user', status: 'approved' })
  store.setUserGithubToken(user.id, encryptSecret('gh-user-token', config.tokenEncryptionKey), 'repo')
  const repo = store.createRepo({
    id: 'repo_mention',
    userId: user.id,
    owner: 'HugoXK',
    name: 'mention-demo',
    defaultBranch: 'main',
    tokenEnc: '',
    permission: 'admin',
    repoRole: 'maintainer',
    installationId: 42,
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
    canReview: true,
    reviewerEnabled: true,
  })
  // A review job has to pass the role-age gate, which a console refresh would do.
  store.updateRepo(repo.id, { role_checked_at: new Date().toISOString() })
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner, startScheduler: false })
  built.jobs.carryOverReaderOverride = () => ({ read: async () => 'open' })

  let delivery = 0
  let headSha = HEAD_SHA
  const deliver = async (body: string, options: { association?: string; commentId?: number; login?: string; delivery?: string; draft?: boolean; closed?: boolean; issueTarget?: boolean; headSha?: string } = {}): Promise<number> => {
    const number = options.issueTarget === true ? 12 : 9
    draft = options.draft === true
    headSha = options.headSha ?? HEAD_SHA
    const payload = {
      action: 'created',
      installation: { id: 42 },
      repository: { full_name: 'HugoXK/mention-demo' },
      issue: {
        number,
        html_url: options.issueTarget === true ? ISSUE_URL : PR_URL,
        title: 'Fix it',
        body: 'details',
        state: options.closed === true ? 'closed' : 'open',
        ...(options.issueTarget === true ? {} : { pull_request: { url: `https://api.github.com/repos/HugoXK/mention-demo/pulls/${number}` } }),
      },
      comment: {
        id: options.commentId ?? 200,
        body,
        author_association: options.association ?? 'MEMBER',
        user: { login: options.login ?? 'issue-command-user', type: options.login === BOT_LOGIN ? 'Bot' : 'User' },
      },
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
        'x-github-delivery': options.delivery ?? `mention-delivery-${delivery}`,
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
    comments,
    deliver,
    close: async () => {
      await built.close()
      await github.close()
    },
  }
}

function reviewJobs(store: Store, repoId: string) {
  return store.listJobsForRepo(repoId, 20).filter((job) => job.pr_url === PR_URL)
}

function mentionAudits(store: Store) {
  return store.listAudit(100).filter((row) => row.action === 'trigger.mention')
}

test('#637 a collaborator mention on a pull request starts one review job, and the audit row names actor, comment and head', async () => {
  const h = await harness()
  try {
    await h.deliver('@fledge please take another look', { association: 'COLLABORATOR', commentId: 201 })
    const jobs = reviewJobs(h.store, h.repoId)
    assert.equal(jobs.length, 1, `mentions should create exactly one review job, got ${jobs.length}`)
    assert.equal(jobs[0]?.kind, 'review', 'a mention on a pull request reviews it; it does not write to the branch')
    const audits = mentionAudits(h.store)
    assert.equal(audits.length, 1, 'one accepted trigger writes one audit row')
    const detail = audits[0]?.detail ?? ''
    assert.match(detail, /201/, 'the audit row carries the comment id')
    assert.match(detail, new RegExp(HEAD_SHA), 'the audit row carries the head SHA the review started on')
    assert.match(detail, /issue-command-user/, 'the audit row carries the actor')
    assert.ok(h.comments.some((comment) => comment.path.includes('/issues/9/comments')), 'the trigger answers on the pull request')
  } finally {
    await h.close()
  }
})

test('#637 a stranger, the bot itself, a draft pull request and a closed one do not trigger work', async () => {
  const h = await harness()
  try {
    await h.deliver('@fledge please review', { association: 'NONE', commentId: 202 })
    await h.deliver('@fledge please review', { login: BOT_LOGIN, commentId: 203 })
    await h.deliver('@fledge please review', { draft: true, commentId: 204 })
    await h.deliver('@fledge please review', { closed: true, commentId: 205 })
    assert.deepEqual(reviewJobs(h.store, h.repoId), [], 'an untrusted, self, draft or closed trigger must not spend model budget')
    assert.deepEqual(mentionAudits(h.store), [])
    // The control: the same body from a trusted author on an open pull request
    // does start a review, so the four refusals above are refusals and not a
    // harness that never fires.
    await h.deliver('@fledge please review', { association: 'MEMBER', commentId: 209 })
    assert.equal(reviewJobs(h.store, h.repoId).length, 1, 'the harness can start a review, so the four cases above were refused')
  } finally {
    await h.close()
  }
})

test('#637 the same comment delivered twice starts one review, and one mention in a body counts once', async () => {
  const h = await harness()
  try {
    await h.deliver('@fledge @fledge please review', { association: 'MEMBER', commentId: 206, delivery: 'dup-a' })
    await h.deliver('@fledge @fledge please review', { association: 'MEMBER', commentId: 206, delivery: 'dup-b' })
    assert.equal(reviewJobs(h.store, h.repoId).length, 1, 'the comment id is the dedupe key: a replayed delivery adds nothing')
  } finally {
    await h.close()
  }
})

test('#637 a mention that is not a mention by word boundary is ignored', async () => {
  const h = await harness()
  try {
    await h.deliver('ping me at foo@fledge.example', { association: 'MEMBER', commentId: 207 })
    await h.deliver('@fledged is not a trigger', { association: 'MEMBER', commentId: 208 })
    assert.deepEqual(reviewJobs(h.store, h.repoId), [])
    // Same author, same surface, a real mention: one review. So the two bodies
    // above were read and refused, not simply unparsed.
    await h.deliver('@fledge is a trigger', { association: 'MEMBER', commentId: 210 })
    assert.equal(reviewJobs(h.store, h.repoId).length, 1)
  } finally {
    await h.close()
  }
})


test('#637 a mention on an issue starts a follow-up for that issue, not a review', async () => {
  const h = await harness()
  try {
    await h.deliver('@fledge please take this one', { association: 'MEMBER', commentId: 211, issueTarget: true })
    const jobs = h.store.listJobsForRepo(h.repoId, 20)
    assert.equal(jobs.length, 1, 'one mention starts one job')
    assert.equal(jobs[0]?.kind, 'iterate', 'an issue mention is work on the issue, which may open a branch and one PR')
    assert.equal(jobs[0]?.issue_url, ISSUE_URL, 'the job names the issue it follows up on')
    assert.equal(jobs[0]?.pr_url, null, 'a mention does not invent a pull request')
    assert.ok(h.comments.some((comment) => comment.path.includes('/issues/12/comments')), 'the trigger answers on the issue')
  } finally {
    await h.close()
  }
})

test('#637 a second mention at the same head records on the job instead of starting another', async () => {
  const h = await harness()
  try {
    await h.deliver('@fledge please review', { association: 'MEMBER', commentId: 212 })
    await h.deliver('@fledge please review again', { association: 'MEMBER', commentId: 213 })
    const jobs = h.store.listJobsForRepo(h.repoId, 20)
    assert.equal(jobs.length, 1, 'the same target at the same head never opens a second job')
    assert.equal(h.store.listJobEvents(jobs[0]!.id).some((event) => event.kind === 'job.mention_recorded'), true, 'the second mention is recorded on the job that has it')
    // A new head is a new identity: the queued job is superseded, not appended to.
    h.store.updateJob(jobs[0]!.id, { status: 'queued' })
    await h.deliver('@fledge please review the new head', { association: 'MEMBER', commentId: 214, headSha: 'ffff000011112222333344445555666677778888' })
    const after = h.store.listJobsForRepo(h.repoId, 20)
    assert.equal(after.length, 2, 'a mention at a new head starts a review of that head')
    assert.equal(after.find((job) => job.id !== jobs[0]!.id)?.kind, 'review')
    const superseded = h.store.listAudit(100).filter((row) => row.action === 'trigger.mention_superseded')
    assert.equal(superseded.length, 1, 'one supersede writes one audit row')
  } finally {
    await h.close()
  }
})
