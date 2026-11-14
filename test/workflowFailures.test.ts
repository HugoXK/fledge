import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #542 slice 1: a failed Actions run on the default branch used to be invisible,
// because the follow-up path only acts on a PR that already has a Fledge job.
// These cases drive the real webhook route, so what they assert is what GitHub
// actually posts: the intake decision is stored, a green run stores nothing, and
// the console names the decision instead of showing an empty page.

const HOOK_SECRET = 'webhook-secret-542'

type Built = Awaited<ReturnType<typeof buildApp>>

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

async function setup(): Promise<{ store: Store; built: Built; cookie: string; repo: { id: string } }> {
  const base = testConfig()
  const config = testConfig({ githubApp: { ...base.githubApp, id: '1', privateKeyPath: '/nonexistent/private-key.pem', webhookSecret: HOOK_SECRET } })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  const user = makeUser(store, { login: 'workflow-intake', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_workflow',
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
  return { store, built, cookie: `${sessionFor(built, user).cookie}; fledge_lang=en`, repo }
}

function failureCount(store: Store): number {
  const row = store.db.prepare('SELECT COUNT(*) AS n FROM workflow_failures').get() as { n: number }
  return Number(row.n)
}

test('a failed run on the default branch is recorded and shown in the console', async () => {
  const { store, built, cookie, repo } = await setup()
  try {
    assert.equal(await deliver(built, payload(), 'delivery-542-main'), 200)

    const page = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}`, headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /#9001/, 'the page links the failed run')
    assert.match(page.body, /Nightly security/, 'the page names the workflow that failed')
    assert.match(page.body, /Recorded, queued for analysis/, 'the page says the failure was recorded and is queued')
    assert.match(page.body, /Awaiting analysis/, 'a queued row names what it is waiting for')
    assert.doesNotMatch(page.body, /No default-branch failure has been recorded yet/, 'the empty state does not hide a recorded failure')

    const rows = store.listWorkflowFailuresForRepo(repo.id)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.run_id, 9001)
    assert.equal(rows[0]?.status, 'queued')
    assert.equal(rows[0]?.head_branch, 'main')
  } finally {
    await built.app.close()
    store.close()
  }
})

test('a pull-request run is recorded as ignored, and a green run records nothing', async () => {
  const { store, built, cookie, repo } = await setup()
  try {
    assert.equal(await deliver(built, payload({ event: 'pull_request', head_branch: 'fledge/w', pull_requests: [{ number: 3 }] }), 'delivery-542-pr'), 200)

    const page = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}`, headers: { cookie } })
    assert.match(page.body, /Ignored/, 'a run Fledge will not triage says so')
    assert.match(page.body, /the PR follow-up owns it/, 'the reason names who owns that run instead')

    const rows = store.listWorkflowFailuresForRepo(repo.id)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.status, 'ignored')
    assert.equal(rows[0]?.reason, 'pull_request')

    assert.equal(await deliver(built, payload({ id: 9002, conclusion: 'success' }), 'delivery-542-green'), 200)
    assert.equal(failureCount(store), 1, 'a green run is not a failure and is not recorded')
  } finally {
    await built.app.close()
    store.close()
  }
})

test('a tag run is not triaged and the console says why', async () => {
  const { store, built, cookie, repo } = await setup()
  try {
    assert.equal(await deliver(built, payload({ id: 9003, head_branch: 'v0.3.4' }), 'delivery-542-tag'), 200)

    const page = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}`, headers: { cookie } })
    assert.match(page.body, /Not on the default branch/, 'the run is visible and its refusal is explained')

    const rows = store.listWorkflowFailuresForRepo(repo.id)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.status, 'ignored')
    assert.equal(rows[0]?.reason, 'not_default_branch')
    assert.equal(rows[0]?.head_branch, 'v0.3.4')
  } finally {
    await built.app.close()
    store.close()
  }
})

test('the same run attempt is one row and a second attempt is another', async () => {
  const { store, built, repo } = await setup()
  try {
    assert.equal(await deliver(built, payload(), 'delivery-542-a'), 200)
    assert.equal(await deliver(built, payload(), 'delivery-542-b'), 200)
    assert.equal(failureCount(store), 1, 'a redelivered failure does not double-count')

    assert.equal(await deliver(built, payload({ run_attempt: 2 }), 'delivery-542-attempt-2'), 200)
    assert.equal(failureCount(store), 2, 'a rerun is a new attempt and a new row')
    assert.equal(store.listWorkflowFailuresForRepo(repo.id).filter((row) => row.attempt === 2).length, 1)
  } finally {
    await built.app.close()
    store.close()
  }
})

test('a workflow name from the payload is text on the page, never markup', async () => {
  const { store, built, cookie, repo } = await setup()
  try {
    assert.equal(await deliver(built, payload({ id: 9004, name: '<img src=x onerror=alert(1)>' }), 'delivery-542-xss'), 200)

    const page = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}`, headers: { cookie } })
    assert.match(page.body, /&lt;img src=x onerror=alert\(1\)&gt;/, 'the name is escaped')
    assert.doesNotMatch(page.body, /<img src=x onerror=alert\(1\)>/, 'the payload cannot inject markup')
  } finally {
    await built.app.close()
    store.close()
  }
})

test('a completed run for a repository Fledge does not know stores nothing', async () => {
  const { store, built } = await setup()
  try {
    assert.equal(await deliver(built, payload({}, { repository: { full_name: 'someone/else' } }), 'delivery-542-unknown'), 200)
    assert.equal(failureCount(store), 0)
  } finally {
    await built.app.close()
    store.close()
  }
})
