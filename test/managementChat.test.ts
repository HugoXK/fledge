import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { buildApp, type BuiltApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { encryptSecret } from '../src/lib/secrets.js'
import type { Runner } from '../src/jobs/runner.js'
import { json, makeUser, MemoryMailer, readBody, startFakeServer, testConfig } from './helpers.js'

// #540 slice 6: the chat half of the management contract. An issue-comment
// command is a third surface on the same service as the console forms — the
// receipt, the revision fence and the refusal codes are not re-implemented in the
// webhook handler. These cases drive the real webhook route, so the parser, the
// dedupe, the command and the reply are exercised together.
const ISSUE_URL = 'https://github.com/HugoXK/issue-demo/issues/5'
const WEBHOOK_SECRET = 'secret'

const runner: Runner = { name: 'capture', async run() { return { status: 'running' } } }

interface Harness {
  built: BuiltApp
  store: Store
  repoId: string
  deliver: (command: string, options?: { commentId?: number }) => Promise<number>
  // Every reply the platform posts on the issue, in order. A chat command that
  // never reaches this route was never answered, which is the whole subject of
  // the crashed-delivery case below.
  comments: string[]
  // Makes the credential read that follows the claim fail, so a delivery dies in
  // the window the claim exists for; `repairToken` restores it for the redelivery.
  breakToken: () => void
  repairToken: () => void
  close: () => Promise<void>
}

async function harness(): Promise<Harness> {
  const comments: string[] = []
  const github = await startFakeServer(async (request, response) => {
    if (request.method === 'POST' && (request.url ?? '').endsWith('/comments')) {
      comments.push((await readBody(request)).toString())
    }
    json(response, 201, { id: 1 })
  })
  const config = testConfig({
    github: { ...testConfig().github, apiBase: github.url },
    githubApp: { id: '1', slug: 'fledge-platform', privateKeyPath: '/tmp/fake.pem', webhookSecret: WEBHOOK_SECRET, useUserToken: true },
  })
  const store = new Store(':memory:')
  const user = makeUser(store, { login: 'issue-command-chat', status: 'approved' })
  store.setUserGithubToken(user.id, encryptSecret('gh-user-token', config.tokenEncryptionKey), 'repo')
  const setTokenKey = (key: string): void => {
    store.setUserGithubToken(user.id, encryptSecret('gh-user-token', key), 'repo')
  }
  const repo = store.createRepo({
    id: 'repo_chat_cmd',
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
  store.createWorkItem({ id: 'work_chat_cmd', repoId: repo.id, userId: user.id, title: 'Fix it', detail: 'details', issueUrl: ISSUE_URL, state: 'assigned' })
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner, startScheduler: false })

  const deliver = async (command: string, options: { commentId?: number } = {}): Promise<number> => {
    const payload = {
      action: 'created',
      installation: { id: 42 },
      repository: { full_name: 'HugoXK/issue-demo' },
      issue: { number: 5, html_url: ISSUE_URL, title: 'Fix it', body: 'details' },
      comment: { id: options.commentId ?? 500, body: command, author_association: 'MEMBER' },
    }
    const raw = Buffer.from(JSON.stringify(payload))
    const signature = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex')}`
    const response = await built.app.inject({
      method: 'POST',
      url: '/api/github/webhook',
      headers: { 'content-type': 'application/json', 'x-github-event': 'issue_comment', 'x-hub-signature-256': signature },
      payload: raw,
    })
    return response.statusCode
  }

  return {
    built,
    store,
    repoId: repo.id,
    deliver,
    comments,
    breakToken: () => setTokenKey(Buffer.alloc(32, 7).toString('base64')),
    repairToken: () => setTokenKey(config.tokenEncryptionKey),
    close: async () => {
      await built.close()
      await github.close()
    },
  }
}

test('a /fledge plan comment is one management command in the chat channel, not a direct enqueue', async () => {
  const h = await harness()
  try {
    assert.equal(await h.deliver('/fledge plan', { commentId: 700 }), 200)
    const jobs = h.store.listJobsForRepo(h.repoId, 50)
    assert.equal(jobs.length, 1, `the comment must queue exactly one job, queued ${jobs.length}`)

    const receipts = h.store.listCommandReceipts(50)
    assert.equal(receipts.length, 1, `the chat command must leave one receipt, found ${receipts.length}`)
    const receipt = receipts[0]
    assert.ok(receipt !== undefined, 'the receipt must exist')
    assert.equal(receipt.operation, 'task.create')
    assert.equal(receipt.channel, 'chat', 'the receipt must name the chat channel, not web')
    assert.equal(receipt.status, 'succeeded')
    assert.equal(receipt.idempotency_key, 'issue_command:700')
    assert.doesNotMatch(receipt.idempotency_key, /issue_command:700:/, 'the key must be one scope, one key')

    const audited = h.store.listAudit(50).filter((row) => row.action === 'management.command')
    assert.equal(audited.length, 1, `the receipt and the business write must share one audit row, found ${audited.length}`)
  } finally {
    await h.close()
  }
})

test('a redelivered /fledge fix comment answers the same receipt and queues nothing new', async () => {
  const h = await harness()
  try {
    assert.equal(await h.deliver('/fledge fix', { commentId: 701 }), 200)
    assert.equal(await h.deliver('/fledge fix', { commentId: 701 }), 200)
    const jobs = h.store.listJobsForRepo(h.repoId, 50)
    assert.equal(jobs.length, 1, `a redelivered comment must not queue a second job, queued ${jobs.length}`)
    const receipts = h.store.listCommandReceipts(50)
    assert.equal(receipts.length, 1, `a redelivered comment must answer the same receipt, found ${receipts.length}`)
    const receipt = receipts[0]
    assert.ok(receipt !== undefined, 'the receipt must exist')
    assert.equal(receipt.channel, 'chat')
    assert.equal(h.comments.length, 1, `the duplicate must not say anything a second time, said ${h.comments.length}`)
  } finally {
    await h.close()
  }
})

// #540 finding 3: the comment marker is a claim, not a tombstone. A process that
// dies between writing the marker and writing the command receipt used to leave a
// comment that no later delivery would ever answer — the marker returned before
// the receipt was consulted, so the work was dropped silently. The state below is
// the shape a killed delivery leaves: a claim older than its lease, and nothing
// else — no receipt, no job, no answer.
test('a delivery killed between the comment marker and the receipt is answered by a redelivery', async () => {
  const h = await harness()
  try {
    h.store.setSetting('issue_command:702', `claimed:${new Date(Date.now() - 10 * 60_000).toISOString()}`)
    assert.equal(h.store.listCommandReceipts(50).length, 0, 'the crash left no receipt, which is the point')
    assert.equal(h.store.listJobsForRepo(h.repoId, 50).length, 0, 'the crash left no job, which is the point')

    assert.equal(await h.deliver('/fledge fix', { commentId: 702 }), 200)
    const jobs = h.store.listJobsForRepo(h.repoId, 50)
    assert.equal(jobs.length, 1, `the redelivery must queue the job the crash lost, queued ${jobs.length}`)
    assert.equal(h.store.listCommandReceipts(50).length, 1, 'the redelivery must leave the receipt the crash lost')
    assert.equal(h.comments.length, 1, `the redelivery must answer on the issue, answered ${h.comments.length} times`)
    assert.match(h.comments[0] ?? '', /queued/, 'the answer must name the queued job')

    // The claim is settled once the answer is posted: the next delivery is the
    // duplicate the marker exists to absorb, and it must stay silent.
    assert.equal(await h.deliver('/fledge fix', { commentId: 702 }), 200)
    assert.equal(h.store.listJobsForRepo(h.repoId, 50).length, 1, 'a later delivery must not queue a second job')
    assert.equal(h.comments.length, 1, `a later delivery must not answer twice, answered ${h.comments.length} times`)
  } finally {
    await h.close()
  }
})

// The markers already in the table were written by the slice that had no state to
// record. They must not become permanent silence either: all such a row can prove
// is that a delivery started, so it is read as a claim whose lease has lapsed.
test('a marker written before the claim existed does not silence a redelivery', async () => {
  const h = await harness()
  try {
    h.store.setSetting('issue_command:703', new Date(Date.now() - 60_000).toISOString())
    assert.equal(await h.deliver('/fledge status', { commentId: 703 }), 200)
    assert.equal(h.comments.length, 1, `the redelivery must still be answered, answered ${h.comments.length} times`)
    assert.equal(await h.deliver('/fledge status', { commentId: 703 }), 200)
    assert.equal(h.comments.length, 1, `the settled marker must absorb the duplicate, answered ${h.comments.length} times`)
  } finally {
    await h.close()
  }
})

// The crash is not the only way a delivery dies before it answers: a credential it
// has to read can fail too. That delivery knows it failed, so it hands the claim
// back at once instead of making the comment wait out the five-minute lease.
test('a delivery that throws before it answers releases its claim at once', async () => {
  const h = await harness()
  try {
    h.breakToken()
    assert.equal(await h.deliver('/fledge fix', { commentId: 704 }), 500, 'the delivery must fail visibly, not swallow the comment')
    assert.equal(h.comments.length, 0, 'a delivery that never reached the command cannot have answered')

    // No lease has lapsed — this redelivery is the next request, not a later one.
    h.repairToken()
    assert.equal(await h.deliver('/fledge fix', { commentId: 704 }), 200)
    assert.equal(h.store.listJobsForRepo(h.repoId, 50).length, 1, 'the redelivery must queue the job the failed delivery lost')
    assert.equal(h.store.listCommandReceipts(50).length, 1, 'the redelivery must leave its receipt')
    assert.equal(h.comments.length, 1, `the redelivery must answer on the issue, answered ${h.comments.length} times`)
  } finally {
    await h.close()
  }
})
