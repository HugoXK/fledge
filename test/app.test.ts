import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { sha256Hex } from '../src/lib/secrets.js'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { GithubApp } from '../src/repos/app.js'
import { makeUser, MemoryMailer, testConfig } from './helpers.js'

function appConfig() {
  return testConfig({ githubApp: { id: '1', slug: 'fledge-platform', privateKeyPath: '/tmp/fake.pem', webhookSecret: 'secret', useUserToken: false } })
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
    const repo = store.createRepo({ id: 'repo_webhook', userId: user.id, owner: 'HugoXK', name: 'system1-agents', defaultBranch: 'main', tokenEnc: '', permission: 'admin', repoRole: 'maintainer', installationId: 177732813, goal: '', autoIterate: false, intervalMinutes: 1440 })
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

test('readyz reports database and instance counts', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: { name: 'capture', async run() { return { status: 'running' as const } } }, startScheduler: false })
  try {
    const response = await built.app.inject({ method: 'GET', url: '/readyz' })
    assert.equal(response.statusCode, 200)
    const body = response.json() as { ok: boolean; db: boolean; instances: { ready: number; failed: number; total: number } }
    assert.equal(body.ok, true)
    assert.equal(body.db, true)
    assert.equal(body.instances.total, 0)
  } finally {
    await built.close()
  }
})

test('issue labels set work item priority and triage state', async () => {
  const config = appConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: { name: 'capture', async run() { return { status: 'running' as const } } }, startScheduler: false })
  try {
    const user = makeUser(store, { login: 'issue-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_issue', userId: user.id, owner: 'HugoXK', name: 'issue-demo', defaultBranch: 'main', tokenEnc: '', permission: 'admin', repoRole: 'maintainer', installationId: 42, goal: '', autoIterate: false, intervalMinutes: 1440 })
    const issueUrl = 'https://github.com/HugoXK/issue-demo/issues/5'
    const send = async (labels: Array<{ name: string }>, delivery: string, action = 'opened') => {
      const payload = { action, installation: { id: 42 }, repository: { full_name: 'HugoXK/issue-demo' }, issue: { html_url: issueUrl, title: 'Fix it', body: 'details', state: 'open', labels } }
      const body = Buffer.from(JSON.stringify(payload))
      return built.app.inject({
        method: 'POST',
        url: '/api/github/webhook',
        headers: { 'content-type': 'application/json', 'x-github-event': 'issues', 'x-github-delivery': delivery, 'x-hub-signature-256': sign(body) },
        payload: body,
      })
    }
    assert.equal((await send([], 'issue-1')).statusCode, 200)
    assert.equal(store.findWorkItemByIssueUrl(repo.id, issueUrl)?.state, 'proposed')
    assert.equal((await send([{ name: 'agent-ready' }, { name: 'priority:high' }], 'issue-2', 'labeled')).statusCode, 200)
    const item = store.findWorkItemByIssueUrl(repo.id, issueUrl)
    assert.equal(item?.state, 'triaged')
    assert.equal(item?.priority, 30)
  } finally {
    await built.close()
  }
})

test('a 404 page is entirely English when the console is English', async () => {
  const config = appConfig()
  const store = new Store(':memory:')
  const runner = { name: 'capture', async run() { return { status: 'running' as const } } }
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner, startScheduler: false })
  try {
    // Both call sites of the pair: a missing page and an invalid locale.
    for (const url of ['/no-such-page-xyz', '/lang/xx']) {
      const res = await built.app.inject({ method: 'GET', url, headers: { cookie: 'fledge_lang=en' } })
      assert.equal(res.statusCode, 404, `${url} answers 404`)
      const block = /<section class="card narrow">([\s\S]*?)<\/section>/.exec(res.body)
      assert.ok(block !== null, `${url} renders the error block`)
      const markup = block[1] ?? ''
      assert.doesNotMatch(markup, /[\u4e00-\u9fff]/, `${url} error block is English: ${markup}`)
    }
    // The pair stays bilingual: the Chinese console keeps the sentence.
    const zh = await built.app.inject({ method: 'GET', url: '/no-such-page-xyz', headers: { cookie: 'fledge_lang=zh' } })
    assert.match(/<section class="card narrow">([\s\S]*?)<\/section>/.exec(zh.body)?.[1] ?? '', /你访问的页面不存在。/)
  } finally {
    await built.close()
  }
})
