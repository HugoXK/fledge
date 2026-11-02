import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { GithubApp } from '../src/repos/app.js'
import { MockRunner } from '../src/jobs/mock.js'
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
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
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
