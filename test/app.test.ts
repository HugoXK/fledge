import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { sha256Hex } from '../src/lib/secrets.js'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { GithubApp } from '../src/repos/app.js'
import { makeUser, MemoryMailer, testConfig } from './helpers.js'

function appConfig() {
  return testConfig({ githubApp: { id: '1', slug: 'fledge-platform', privateKeyPath: '/tmp/fake.pem', webhookSecret: 'secret' } })
}

function sign(body: Buffer, secret = 'secret'): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

test('github app webhook signatures are checked', () => {
  const app = new GithubApp(appConfig())
  const body = Buffer.from('{"action":"opened"}')
  assert.equal(app.verifyWebhook(body, sign(body)), true)
  assert.equal(app.verifyWebhook(body, sign(body, 'other')), false)
  assert.equal(app.verifyWebhook(body, 'sha256=deadbeef'), false)
})

test('verified github webhooks are stored and bad ones are rejected', async () => {
  const config = appConfig()
  const store = new Store(':memory:')
  const runner = { name: 'capture', async run() { return { status: 'running' as const } } }
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner, startScheduler: false })
  try {
    const body = Buffer.from(JSON.stringify({ action: 'opened', repository: { full_name: 'o/r' } }))
    const headers = { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': 'd1', 'x-hub-signature-256': sign(body) }
    const accepted = await built.app.inject({ method: 'POST', url: '/api/github/webhook', headers, payload: body })
    assert.equal(accepted.statusCode, 200)
    assert.equal(store.countEvents('github_webhook'), 1)
    const rejected = await built.app.inject({ method: 'POST', url: '/api/github/webhook', headers: { ...headers, 'x-hub-signature-256': 'sha256=bad' }, payload: body })
    assert.equal(rejected.statusCode, 401)
    assert.equal(store.countEvents('github_webhook'), 1)
  } finally {
    await built.close()
  }
})


test('a failed check on a Fledge PR enqueues a follow-up job', async () => {
  const config = appConfig()
  const store = new Store(':memory:')
  const runner = { name: 'capture', async run() { return { status: 'running' as const } } }
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner, startScheduler: false })
  try {
    const user = makeUser(store, { login: 'followup-webhook', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_webhook', userId: user.id, owner: 'HugoXK', name: 'system1-agents', defaultBranch: 'main', tokenEnc: '', installationId: 177732813, goal: '', autoIterate: false, intervalMinutes: 1440 })
    const original = store.createJob({ id: 'job_original', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex('cb'), platformTokenHash: '' })
    store.updateJob(original.id, { status: 'succeeded', pr_url: 'https://github.com/HugoXK/system1-agents/pull/7', branch: 'fledge/fix', finished_at: new Date().toISOString() })
    const payload = {
      installation: { id: 177732813 },
      repository: { full_name: 'HugoXK/system1-agents' },
      check_run: {
        conclusion: 'failure',
        name: 'node-ut',
        head_sha: 'abc',
        pull_requests: [{ number: 7, html_url: 'https://github.com/HugoXK/system1-agents/pull/7', head: { ref: 'fledge/fix', sha: 'abc' } }],
      },
    }
    const body = Buffer.from(JSON.stringify(payload))
    const response = await built.app.inject({
      method: 'POST',
      url: '/api/github/webhook',
      headers: { 'content-type': 'application/json', 'x-github-event': 'check_run', 'x-github-delivery': 'delivery-1', 'x-hub-signature-256': sign(body) },
      payload: body,
    })
    assert.equal(response.statusCode, 200)
    const jobs = store.listJobsForRepo(repo.id)
    const followup = jobs.find((job) => job.trigger === 'followup')
    assert.ok(followup)
    assert.equal(followup?.branch, 'fledge/fix')
    assert.equal(followup?.pr_url, 'https://github.com/HugoXK/system1-agents/pull/7')
  } finally {
    await built.close()
  }
})
