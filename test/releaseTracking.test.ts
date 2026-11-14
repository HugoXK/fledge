import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { GithubClient } from '../src/repos/github.js'
import { MockRunner } from '../src/jobs/mock.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { draftBody, reconcileRelease, selectWorkflowRun, trackingUpdate } from '../src/releases/tracking.js'
import { formBody, json, makeUser, MemoryMailer, readBody, sessionFor, startFakeServer, testConfig } from './helpers.js'

// #546 slice 3: a tag is followed by its workflow run. The tests drive the real
// GithubClient against a fake API so the request shapes and the decision are
// tested together: success prepares exactly one draft, a failure prepares none,
// an existing Release is external, and a second reconcile is a no-op.

const TARGET = 'a'.repeat(40)
const TAG = 'v1.4.0'
const DRAFT_URL = 'https://github.com/o/r/releases/500'

interface RunOverrides {
  id?: number
  status?: string
  conclusion?: string | null
  headSha?: string
  headBranch?: string | null
  path?: string | null
  runAttempt?: number
}

function run(overrides: RunOverrides = {}) {
  return {
    id: overrides.id ?? 123,
    name: 'release',
    path: overrides.path === undefined ? '.github/workflows/release.yml' : overrides.path,
    status: overrides.status ?? 'completed',
    conclusion: overrides.conclusion === undefined ? 'success' : overrides.conclusion,
    head_sha: overrides.headSha ?? TARGET,
    head_branch: overrides.headBranch === undefined ? TAG : overrides.headBranch,
    run_attempt: overrides.runAttempt ?? 1,
    html_url: `https://github.com/o/r/actions/runs/${overrides.id ?? 123}`,
    event: 'push',
  }
}

function job(name: string, conclusion: string | null, status = 'completed') {
  return { id: Math.floor(Math.random() * 1_000_000), name, status, conclusion }
}

interface HarnessOptions {
  runs?: Array<ReturnType<typeof run>>
  jobs?: Array<ReturnType<typeof job>>
  release?: Record<string, unknown> | null
  createStatus?: number
  raceRelease?: Record<string, unknown>
}

async function harness(options: HarnessOptions = {}) {
  const calls: Array<{ method: string; url: string; body: Record<string, unknown> | null }> = []
  let existing = options.release ?? null
  const server = await startFakeServer(async (request, response) => {
    const method = request.method ?? 'GET'
    const url = request.url ?? ''
    const raw = await readBody(request)
    let body: Record<string, unknown> | null = null
    try {
      body = raw.length === 0 ? null : JSON.parse(raw.toString('utf8')) as Record<string, unknown>
    } catch {
      body = null
    }
    calls.push({ method, url, body })
    if (method === 'GET' && url.startsWith('/repos/o/r/releases/tags/')) {
      return existing === null ? json(response, 404, { message: 'Not Found' }) : json(response, 200, existing)
    }
    if (method === 'GET' && url.startsWith('/repos/o/r/actions/runs?')) {
      return json(response, 200, { total_count: (options.runs ?? []).length, workflow_runs: options.runs ?? [] })
    }
    if (method === 'GET' && /\/repos\/o\/r\/actions\/runs\/\d+\/jobs/.test(url)) {
      return json(response, 200, { total_count: (options.jobs ?? []).length, jobs: options.jobs ?? [] })
    }
    if (method === 'POST' && url === '/repos/o/r/releases') {
      if (options.createStatus !== undefined) {
        if (options.raceRelease !== undefined) existing = options.raceRelease
        return json(response, options.createStatus, { message: 'Validation Failed' })
      }
      existing = {
        id: 500,
        tag_name: body?.tag_name,
        name: body?.name,
        draft: true,
        prerelease: body?.prerelease,
        html_url: DRAFT_URL,
        target_commitish: body?.target_commitish,
      }
      return json(response, 201, existing)
    }
    if (method === 'PATCH' && url.startsWith('/repos/o/r/releases/')) return json(response, 200, {})
    return json(response, 404, { message: 'Not Found' })
  })
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: server.url } })
  const client = new GithubClient('gh-token', config.github.apiBase)
  return {
    client,
    calls,
    server,
    config,
    release: () => existing,
    close: async () => { await server.close() },
  }
}

function input(overrides: { draftReleaseId?: number | null; prerelease?: boolean } = {}) {
  return {
    owner: 'o',
    name: 'r',
    tagName: TAG,
    targetSha: TARGET,
    prerelease: overrides.prerelease ?? false,
    draftReleaseId: overrides.draftReleaseId ?? null,
  }
}

test('the newest run for the tag commit is selected over an unrelated run', () => {
  const info = (id: number, headSha: string) => ({
    id,
    name: 'release',
    path: '.github/workflows/release.yml',
    status: 'completed',
    conclusion: 'success',
    headSha,
    headBranch: TAG,
    runAttempt: 1,
    htmlUrl: `https://github.com/o/r/actions/runs/${id}`,
    event: 'push',
  })
  const older = info(20, TARGET)
  const unrelated = info(30, 'b'.repeat(40))
  const chosen = selectWorkflowRun([unrelated, older], TARGET)
  assert.equal(chosen?.id, 20, 'a run whose head is not the tag commit must not win')
  assert.equal(selectWorkflowRun([], TARGET), null)
})

test('a successful run with success, neutral and skipped jobs creates exactly one draft', async () => {
  const h = await harness({
    runs: [run()],
    jobs: [job('build', 'success'), job('docs', 'neutral'), job('optional', 'skipped')],
  })
  try {
    const result = await reconcileRelease(h.client, input())
    assert.equal(result.status, 'draft_created')
    const creates = h.calls.filter((call) => call.method === 'POST' && call.url === '/repos/o/r/releases')
    assert.equal(creates.length, 1)
    const body = creates[0]?.body ?? {}
    assert.equal(body.draft, true, 'the only publish-capable field is fixed to draft')
    assert.equal(body.tag_name, TAG)
    assert.equal(body.target_commitish, TARGET)
    assert.equal(body.prerelease, false)
    assert.equal(body.body, draftBody(TAG))
    assert.equal(h.calls.filter((call) => call.method === 'PATCH').length, 0, 'nothing is published or edited')

    const update = trackingUpdate(result)
    assert.equal(update.status, 'draft_created')
    assert.equal(update.runId, '123')
    assert.equal(update.runAttempt, 1)
    assert.equal(update.conclusion, 'success')
    assert.equal(update.workflowName, 'release')
    assert.equal(update.draftReleaseId, '500')
    assert.equal(update.draftUrl, DRAFT_URL)

    const again = await reconcileRelease(h.client, input({ draftReleaseId: 500 }))
    assert.equal(again.status, 'draft_exists')
    assert.equal(h.calls.filter((call) => call.method === 'POST' && call.url === '/repos/o/r/releases').length, 1, 'a second check does not create a second draft')
  } finally {
    await h.close()
  }
})

test('a failed, cancelled or timed-out run records failure and creates no draft', async () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out']) {
    const h = await harness({ runs: [run({ conclusion })], jobs: [job('build', 'success')] })
    try {
      const result = await reconcileRelease(h.client, input())
      assert.equal(result.status, 'run_failed', conclusion)
      assert.equal(h.calls.filter((call) => call.method === 'POST' && call.url === '/repos/o/r/releases').length, 0)
      assert.equal(trackingUpdate(result).conclusion, conclusion)
    } finally {
      await h.close()
    }
  }
})

test('one failed job fails the release even when the run says success', async () => {
  const h = await harness({ runs: [run()], jobs: [job('build', 'success'), job('deploy', 'failure')] })
  try {
    const result = await reconcileRelease(h.client, input())
    assert.equal(result.status, 'run_failed')
    assert.equal((result as { conclusion?: string }).conclusion, 'failure')
    assert.equal(h.calls.filter((call) => call.method === 'POST' && call.url === '/repos/o/r/releases').length, 0)
  } finally {
    await h.close()
  }
})

test('an in-progress run or job stays tracking and creates no draft', async () => {
  const running = await harness({ runs: [run({ status: 'in_progress', conclusion: null })] })
  try {
    const result = await reconcileRelease(running.client, input())
    assert.equal(result.status, 'running')
    assert.equal(trackingUpdate(result).status, 'running')
    assert.equal(running.calls.filter((call) => call.method === 'POST' && call.url === '/repos/o/r/releases').length, 0)
  } finally {
    await running.close()
  }
  const unfinished = await harness({ runs: [run()], jobs: [job('build', 'success'), job('publish', null, 'in_progress')] })
  try {
    const result = await reconcileRelease(unfinished.client, input())
    assert.equal(result.status, 'running')
    assert.equal(unfinished.calls.filter((call) => call.method === 'POST' && call.url === '/repos/o/r/releases').length, 0)
  } finally {
    await unfinished.close()
  }
})

test('an existing Release is external and is never duplicated', async () => {
  const h = await harness({
    release: { id: 77, tag_name: TAG, draft: false, prerelease: false, html_url: 'https://github.com/o/r/releases/77' },
  })
  try {
    const result = await reconcileRelease(h.client, input())
    assert.equal(result.status, 'external_release')
    assert.equal(trackingUpdate(result).externalReleaseId, '77')
    assert.equal(h.calls.filter((call) => call.method === 'POST' && call.url === '/repos/o/r/releases').length, 0)
    assert.equal(h.calls.filter((call) => call.url.startsWith('/repos/o/r/actions/runs')).length, 0, 'an external Release is decided before the run is read')
  } finally {
    await h.close()
  }
})

test('a missing run stays tracking and records no run id', async () => {
  const h = await harness({ runs: [] })
  try {
    const result = await reconcileRelease(h.client, input())
    assert.equal(result.status, 'run_missing')
    const update = trackingUpdate(result)
    assert.equal(update.status, 'run_missing')
    assert.equal(update.runId, null)
    assert.equal(h.calls.filter((call) => call.method === 'POST').length, 0)
  } finally {
    await h.close()
  }
})

test('a 422 on create re-reads the tag and records the raced Release instead of a second one', async () => {
  const h = await harness({
    runs: [run()],
    jobs: [job('build', 'success')],
    createStatus: 422,
    raceRelease: { id: 88, tag_name: TAG, draft: false, prerelease: false, html_url: 'https://github.com/o/r/releases/88' },
  })
  try {
    const result = await reconcileRelease(h.client, input())
    assert.equal(result.status, 'external_release')
    assert.equal(trackingUpdate(result).externalReleaseId, '88')
    assert.equal(h.calls.filter((call) => call.method === 'POST' && call.url === '/repos/o/r/releases').length, 1, 'the write was attempted once and never retried')
  } finally {
    await h.close()
  }
})

// The route is the maintainer surface; it must update the tracked row from the
// fake API and must refuse a repository whose chosen role is not maintainer.
async function routeHarness(options: { repoRole?: 'maintainer' | 'developer' } = {}) {
  const h = await harness({ runs: [run()], jobs: [job('build', 'success')] })
  const store = new Store(':memory:')
  const built = await buildApp({ config: h.config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  const user = makeUser(store, { login: 'release-track-user', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_release_track',
    userId: user.id,
    owner: 'o',
    name: 'r',
    defaultBranch: 'main',
    tokenEnc: encryptSecret('gh-token', h.config.tokenEncryptionKey),
    permission: 'admin',
    repoRole: options.repoRole ?? 'maintainer',
    autoMerge: false,
    roleCheckedAt: new Date().toISOString(),
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  const release = store.recordRelease({
    repoId: repo.id,
    userId: user.id,
    version: TAG,
    tagName: TAG,
    targetSha: TARGET,
    tagObjectSha: 'c'.repeat(40),
    previousTag: null,
    actor: user.login,
  })
  assert.ok(release)
  const session = sessionFor(built, user)
  const post = () => built.app.inject({
    method: 'POST',
    url: `/repos/${repo.id}/releases/${release.id}/check`,
    headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: formBody({ csrf: session.csrf }),
  })
  return {
    h,
    store,
    repo,
    release,
    post,
    close: async () => { await built.close(); await h.close() },
  }
}

test('the maintainer check route records the run and prepares one draft', async () => {
  const r = await routeHarness()
  try {
    const posted = await r.post()
    assert.equal(posted.statusCode, 302)
    assert.match(decodeURIComponent(String(posted.headers.location)), /checked=/)
    const row = r.store.releaseById(r.release.id)
    assert.equal(row?.status, 'draft_created')
    assert.equal(row?.run_id, '123')
    assert.equal(row?.draft_release_id, '500')
    assert.equal(row?.draft_url, DRAFT_URL)
    assert.equal(r.h.calls.filter((call) => call.method === 'POST' && call.url === '/repos/o/r/releases').length, 1)
  } finally {
    await r.close()
  }
})

test('a developer role cannot run the check route', async () => {
  const r = await routeHarness({ repoRole: 'developer' })
  try {
    const posted = await r.post()
    assert.equal(posted.statusCode, 302)
    assert.match(decodeURIComponent(String(posted.headers.location)), /error=/)
    assert.equal(r.store.releaseById(r.release.id)?.status, 'tagged')
    assert.equal(r.h.calls.filter((call) => call.url.startsWith('/repos/o/r/actions/runs')).length, 0)
  } finally {
    await r.close()
  }
})
