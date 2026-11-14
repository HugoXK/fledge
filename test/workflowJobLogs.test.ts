import test from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHmac } from 'node:crypto'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { GithubClient } from '../src/repos/github.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { json, makeUser, MemoryMailer, sessionFor, startFakeServer, testConfig } from './helpers.js'

// #542 slice 2: the intake may read the failed job log, but only through the
// GitHub App/user token, only bounded, and only as a redacted excerpt. A fetch
// failure is a stored reason on the intake row, never a lost intake.

const HOOK_SECRET = 'webhook-secret-542-logs'
const TOKEN = ['ghp_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789'].join('')

type Built = Awaited<ReturnType<typeof buildApp>>
type Handler = (request: IncomingMessage, response: ServerResponse) => void

function payload(run: Record<string, unknown> = {}, top: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'completed',
    installation: { id: 42 },
    repository: { full_name: 'o/w' },
    workflow_run: {
      id: 9001,
      name: 'Nightly security',
      run_attempt: 1,
      event: 'push',
      head_branch: 'main',
      head_sha: 'a'.repeat(40),
      conclusion: 'failure',
      html_url: 'https://github.com/o/w/actions/runs/9001',
      pull_requests: [],
      ...run,
    },
    ...top,
  }
}

async function deliver(built: Built, body: Record<string, unknown>, delivery: string): Promise<number> {
  const raw = Buffer.from(JSON.stringify(body))
  const signature = `sha256=${createHmac('sha256', HOOK_SECRET).update(raw).digest('hex')}`
  const response = await built.app.inject({
    method: 'POST',
    url: '/api/github/webhook',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signature,
      'x-github-event': 'workflow_run',
      'x-github-delivery': delivery,
    },
    payload: raw,
  })
  return response.statusCode
}

async function setup(handler: Handler): Promise<{ store: Store; built: Built; cookie: string; repo: { id: string }; close: () => Promise<void> }> {
  const github = await startFakeServer(handler)
  const base = testConfig()
  const config = testConfig({
    github: { ...base.github, apiBase: github.url },
    githubApp: { ...base.githubApp, id: '1', privateKeyPath: '/nonexistent/private-key.pem', webhookSecret: HOOK_SECRET, useUserToken: true },
  })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  const user = makeUser(store, { login: 'workflow-logs', status: 'approved' })
  store.setUserGithubToken(user.id, encryptSecret('user-token', config.tokenEncryptionKey), 'repo')
  const repo = store.createRepo({
    id: 'repo_workflow_logs',
    userId: user.id,
    owner: 'o',
    name: 'w',
    defaultBranch: 'main',
    tokenEnc: 'x',
    installationId: 42,
    upstreamOwner: 'o',
    upstreamName: 'w',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  return {
    store,
    built,
    cookie: `${sessionFor(built, user).cookie}; fledge_lang=en`,
    repo,
    close: async () => {
      await built.app.close()
      store.close()
      await github.close()
    },
  }
}

function pathOf(request: IncomingMessage): string {
  return new URL(request.url ?? '/', 'http://fake.test').pathname
}

function failedJobsHandler(counter?: { runs: number; logs: number }): Handler {
  return (request, response) => {
    if (request.method === 'GET' && pathOf(request) === '/repos/o/w/actions/runs/9001/jobs') {
      if (counter !== undefined) counter.runs += 1
      return json(response, 200, {
        total_count: 2,
        jobs: [
          { id: 78, name: 'lint', status: 'completed', conclusion: 'success', html_url: 'https://github.com/o/w/actions/runs/9001/job/78' },
          { id: 77, name: 'test', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/o/w/actions/runs/9001/job/77' },
        ],
      })
    }
    if (request.method === 'GET' && pathOf(request) === '/repos/o/w/actions/jobs/77/logs') {
      if (counter !== undefined) counter.logs += 1
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(`2026-11-14T12:00:00Z running tests\nleaked ${TOKEN}\n2026-11-14T12:00:01Z AssertionError: expected 1 to equal 2\n`)
      return
    }
    json(response, 404, { message: 'not found' })
  }
}

test('getJobLog returns bounded text and never sends the token to a redirect target', async () => {
  const signed: Array<string | undefined> = []
  const storage = await startFakeServer((request, response) => {
    signed.push(request.headers.authorization)
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('redirected log body')
  })
  const api = await startFakeServer((request, response) => {
    if (request.url === '/repos/o/w/actions/jobs/77/logs') {
      response.writeHead(302, { location: `${storage.url}/signed?token=abc` })
      response.end()
      return
    }
    if (request.url === '/repos/o/w/actions/jobs/88/logs') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('x'.repeat(200))
      return
    }
    json(response, 404, { message: 'not found' })
  })
  try {
    const client = new GithubClient('test-token', api.url)
    assert.equal(await client.getJobLog('o', 'w', 77), 'redirected log body')
    assert.equal(signed[0], undefined, 'the signed URL is not given the GitHub token')

    const bounded = await client.getJobLog('o', 'w', 88, 40)
    assert.ok(bounded.startsWith('x'.repeat(40)), 'the head is kept')
    assert.match(bounded, /log truncated/)
  } finally {
    await api.close()
    await storage.close()
  }
})

test('a stored log excerpt is redacted, bounded and visible on the console', async () => {
  const counter = { runs: 0, logs: 0 }
  const h = await setup(failedJobsHandler(counter))
  try {
    assert.equal(await deliver(h.built, payload(), 'delivery-542-logs-ok'), 200)
    const rows = h.store.listWorkflowFailuresForRepo(h.repo.id)
    assert.equal(rows.length, 1)
    const excerpt = rows[0]?.log_excerpt ?? ''
    assert.equal(excerpt.includes(TOKEN), false, 'the token never reaches the row')
    assert.match(excerpt, /\[redacted-github-token\]/)
    assert.match(excerpt, /AssertionError: expected 1 to equal 2/)
    assert.equal(rows[0]?.log_error, null)
    assert.ok(excerpt.length <= 4000, 'the excerpt is bounded')

    const page = await h.built.app.inject({ method: 'GET', url: `/repos/${h.repo.id}`, headers: { cookie: h.cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /Log excerpt stored/)
    assert.doesNotMatch(page.body, new RegExp(TOKEN))
  } finally {
    await h.close()
  }
})

test('a failed log fetch records the reason and keeps the intake', async () => {
  const h = await setup((request, response) => json(response, 404, { message: 'not found' }))
  try {
    assert.equal(await deliver(h.built, payload(), 'delivery-542-logs-fail'), 200)
    const rows = h.store.listWorkflowFailuresForRepo(h.repo.id)
    assert.equal(rows.length, 1, 'the intake row survives the fetch failure')
    assert.equal(rows[0]?.status, 'queued')
    assert.equal(rows[0]?.log_excerpt, null)
    assert.match(rows[0]?.log_error ?? '', /not found/)

    const page = await h.built.app.inject({ method: 'GET', url: `/repos/${h.repo.id}`, headers: { cookie: h.cookie } })
    assert.match(page.body, /Log unavailable/)
  } finally {
    await h.close()
  }
})

test('a run with no failed job records that fact instead of an empty excerpt', async () => {
  const h = await setup((request, response) => {
    if (pathOf(request) === '/repos/o/w/actions/runs/9001/jobs') {
      return json(response, 200, { total_count: 1, jobs: [{ id: 78, name: 'lint', status: 'completed', conclusion: 'success' }] })
    }
    json(response, 404, { message: 'not found' })
  })
  try {
    assert.equal(await deliver(h.built, payload(), 'delivery-542-logs-nojob'), 200)
    const rows = h.store.listWorkflowFailuresForRepo(h.repo.id)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.log_excerpt, null)
    assert.equal(rows[0]?.log_error, 'no_failed_job')
  } finally {
    await h.close()
  }
})

test('a redelivered failure does not fetch the log twice', async () => {
  const counter = { runs: 0, logs: 0 }
  const h = await setup(failedJobsHandler(counter))
  try {
    assert.equal(await deliver(h.built, payload(), 'delivery-542-logs-a'), 200)
    assert.equal(await deliver(h.built, payload(), 'delivery-542-logs-b'), 200)
    assert.equal(counter.runs, 1, 'the first write owns the fetch')
    assert.equal(counter.logs, 1)
  } finally {
    await h.close()
  }
})
