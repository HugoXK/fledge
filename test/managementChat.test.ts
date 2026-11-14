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
  close: () => Promise<void>
}

async function harness(): Promise<Harness> {
  const github = await startFakeServer(async (_request, response) => {
    json(response, 201, { id: 1 })
  })
  const config = testConfig({
    github: { ...testConfig().github, apiBase: github.url },
    githubApp: { id: '1', slug: 'fledge-platform', privateKeyPath: '/tmp/fake.pem', webhookSecret: WEBHOOK_SECRET, useUserToken: true },
  })
  const store = new Store(':memory:')
  const user = makeUser(store, { login: 'issue-command-chat', status: 'approved' })
  store.setUserGithubToken(user.id, encryptSecret('gh-user-token', config.tokenEncryptionKey), 'repo')
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
  } finally {
    await h.close()
  }
})
