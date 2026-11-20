import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { sha256Hex } from '../src/lib/secrets.js'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { GithubApp } from '../src/repos/app.js'
import { localizeMessage } from '../src/i18n.js'
import { makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

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

// #1087: the not-found handler's own sentence is in the table, so the case above
// passed while every *thrown* 4xx printed its Chinese message under an English
// heading. The handler renders `httpError(status, message)` verbatim, and the
// table had no entry for any of the 22 messages the app throws, so `localizeMessage`
// fell back to the original string.
const THROWN_REFUSALS = [
  '只读成员不能修改这个仓库。',
  '只有维护者可以修改仓库设置。',
  '安装不存在。',
  '这个仓库没有可用的 GitHub token。',
  '发布记录不存在。',
  '只有 maintainer 可以编辑规则覆盖。',
  '只有 maintainer 可以修改技能包来源。',
  '任务不存在。',
  '计划任务不存在或尚未完成。',
  '工作项不存在。',
  '仅超级管理员可重试。',
  'Webhook delivery 不存在。',
  '仅超级管理员可重发。',
  '通知不存在。',
  '预览模式不可读取部署记录。',
  '仅管理员可以记录部署。',
  '仅管理员可以记录回滚。',
  '仅管理员可以停止平台。',
  '仅管理员可以恢复平台。',
  '预览模式不可删除账号。',
  '不能删除自己的账号。',
  '不能删除最后一个超级管理员。',
]

test('every thrown refusal has an English form, and the Chinese console keeps its sentence', () => {
  for (const message of THROWN_REFUSALS) {
    const english = localizeMessage('en', message) ?? ''
    assert.notEqual(english, message, `${message} has no English form`)
    assert.doesNotMatch(english, /[\u4e00-\u9fff]/, `${message} renders as ${english}, which is not English`)
    assert.equal(localizeMessage('zh', message), message, 'the Chinese console keeps the thrown sentence')
  }
})

test('no message the app throws as an http error is left untranslated', async () => {
  // The list above is a snapshot; this reads the app so a new thrown sentence
  // cannot re-open the leak one route at a time.
  const source = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8')
  const thrown = [...source.matchAll(/httpError\(\d+,\s*'([^']*)'/g)].map((match) => match[1] ?? '')
  assert.ok(thrown.length > 0, 'the app throws at least one literal message')
  for (const message of thrown) {
    const english = localizeMessage('en', message) ?? ''
    assert.doesNotMatch(english, /[\u4e00-\u9fff]/, `${message} renders as ${english} on the English console`)
  }
})

test('a 404 page from a thrown handler is entirely English on the English console', async () => {
  const config = appConfig()
  const store = new Store(':memory:')
  const runner = { name: 'capture', async run() { return { status: 'running' as const } } }
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner, startScheduler: false })
  try {
    const user = makeUser(store, { login: 'thrown-404', status: 'approved' })
    const session = sessionFor(built, user)
    const res = await built.app.inject({
      method: 'GET',
      url: '/repos/new?installation=999999999',
      headers: { cookie: `${session.cookie}; fledge_lang=en` },
    })
    assert.equal(res.statusCode, 404, 'the missing installation is a not-found page')
    const block = /<section class="card narrow">([\s\S]*?)<\/section>/.exec(res.body)
    assert.ok(block !== null, 'the error block is rendered')
    const markup = block[1] ?? ''
    assert.doesNotMatch(markup, /[\u4e00-\u9fff]/, `the thrown sentence is English too: ${markup}`)
    assert.match(markup, /Installation not found/, 'the sentence says what is missing')
  } finally {
    await built.close()
  }
})
