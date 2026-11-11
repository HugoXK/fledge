import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import type { RepoRow } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import type { Runner } from '../src/jobs/runner.js'
import { encryptSecret, sha256Hex } from '../src/lib/secrets.js'
import { json, makeUser, MemoryMailer, startFakeServer, testConfig } from './helpers.js'

// The origin every accepted URL in this file lives on. The repo row records it,
// so prOrigin() must derive it from the row and never from a literal host.
const ORIGIN = 'https://ghe.example.com'

interface Harness {
  store: Store
  jobs: Jobs
  repo: RepoRow
  requests: string[]
  close: () => Promise<void>
}

async function harness(options: { apiBase?: string; upstreamHtmlUrl?: string | null; forkHtmlUrl?: string | null } = {}): Promise<Harness> {
  const requests: string[] = []
  const server = await startFakeServer((request, response) => {
    requests.push(`${request.method ?? 'GET'} ${request.url ?? ''}`)
    json(response, 404, { message: 'Not Found' })
  })
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: options.apiBase ?? server.url } })
  const store = new Store(':memory:')
  const runner: Runner = { name: 'noop', async run() { return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  const user = makeUser(store, { login: 'callback-url-user', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_callback_urls',
    userId: user.id,
    owner: 'o',
    name: 'r',
    defaultBranch: 'main',
    tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey),
    permission: 'admin',
    repoRole: 'maintainer',
    autoMerge: false,
    roleCheckedAt: new Date().toISOString(),
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
    upstreamHtmlUrl: options.upstreamHtmlUrl === undefined ? `${ORIGIN}/o/r` : options.upstreamHtmlUrl,
    forkHtmlUrl: options.forkHtmlUrl ?? null,
  })
  return { store, jobs, repo, requests, close: async () => { store.close(); await server.close() } }
}

let jobCounter = 0

function runningJob(h: Harness, kind = 'iterate'): { id: string; secret: string } {
  jobCounter += 1
  const id = `job_callback_url_${jobCounter}`
  const secret = `callback-url-secret-${jobCounter}`
  // The first job keeps the harness repository so follow-up assertions can see
  // it; later jobs get their own repository row to keep the one-active-job
  // invariant while several callbacks are in flight.
  const useBase = h.store.listJobsForRepo(h.repo.id, 1).length === 0
  const repo = useBase ? h.repo : h.store.createRepo({
    id: `repo_callback_url_${jobCounter}`,
    userId: h.repo.user_id,
    owner: h.repo.owner,
    name: `${h.repo.name}-${jobCounter}`,
    defaultBranch: h.repo.default_branch,
    tokenEnc: h.repo.token_enc,
    permission: h.repo.permission,
    repoRole: h.repo.repo_role,
    autoMerge: h.repo.auto_merge === 1,
    roleCheckedAt: h.repo.role_checked_at,
    goal: h.repo.goal,
    autoIterate: h.repo.auto_iterate === 1,
    intervalMinutes: h.repo.interval_minutes,
    upstreamOwner: h.repo.upstream_owner,
    upstreamName: h.repo.upstream_name,
    upstreamDefaultBranch: h.repo.upstream_default_branch,
    upstreamHtmlUrl: h.repo.upstream_html_url,
    forkOwner: h.repo.fork_owner,
    forkName: h.repo.fork_name,
    forkDefaultBranch: h.repo.fork_default_branch,
    forkHtmlUrl: h.repo.fork_html_url,
    targetBranch: h.repo.target_branch,
    isFork: h.repo.is_fork === 1,
    canReview: h.repo.can_review === 1,
    canCreateIssue: h.repo.can_create_issue === 1,
  })
  h.store.createJob({
    id,
    repoId: repo.id,
    userId: h.repo.user_id,
    trigger: 'manual',
    goal: 'g',
    callbackHash: sha256Hex(secret),
    platformTokenHash: '',
    kind,
    baseBranch: 'main',
  })
  h.store.updateJob(id, { status: 'running', branch: 'fledge/job', started_at: new Date().toISOString() })
  return { id, secret }
}

function count(h: Harness, sql: string): number {
  return Number(h.store.get<{ n: number }>(sql)?.n ?? 0)
}

test('a terminal callback drops a foreign prUrl and issueUrl to null before any GitHub call', async () => {
  const h = await harness()
  try {
    const { id, secret } = runningJob(h)
    const result = await h.jobs.handleCallback(id, secret, {
      status: 'succeeded',
      prUrl: 'https://evil.example/o/r/pull/1',
      issueUrl: 'https://evil.example/o/r/issues/1',
      summary: 'done',
    })
    assert.equal(result.ok, true, result.error ?? 'no error')
    const job = h.store.getJob(id)!
    assert.equal(job.status, 'succeeded')
    assert.equal(job.pr_url, null, 'a foreign origin must not be stored')
    assert.equal(job.issue_url, null, 'a foreign origin must not be stored')
    assert.deepEqual(h.requests, [], 'a value rejected at the callback must never reach GitHub')
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM work_items'), 0, 'no work item may be created from an unplaceable link')
  } finally {
    await h.close()
  }
})

test('a terminal callback still stores and verifies a link on the repository origin', async () => {
  const h = await harness()
  try {
    const { id, secret } = runningJob(h)
    const prUrl = `${ORIGIN}/o/r/pull/12`
    const issueUrl = `${ORIGIN}/o/r/issues/7`
    const result = await h.jobs.handleCallback(id, secret, { status: 'succeeded', prUrl, issueUrl, summary: 'done' })
    assert.equal(result.ok, true, result.error ?? 'no error')
    const job = h.store.getJob(id)!
    assert.equal(job.pr_url, prUrl)
    assert.equal(job.issue_url, issueUrl)
    assert.ok(h.requests.length >= 1, 'the stored PR link still goes through verification')
  } finally {
    await h.close()
  }
})

test('look-alike and malformed links are dropped instead of stored', async () => {
  const h = await harness()
  try {
    const cases: Array<[string, string]> = [
      ['a foreign origin', 'https://evil.example/o/r/pull/1'],
      ['the right origin and another repository', `${ORIGIN}/other/repo/pull/1`],
      ['a userinfo segment in front of a foreign host', `${ORIGIN}@evil.example/o/r/pull/1`],
      ['credentials on the right host', `https://evil.example@${ORIGIN.slice('https://'.length)}/o/r/pull/1`],
      ['a non-https scheme', `http://${ORIGIN.slice('https://'.length)}/o/r/pull/1`],
      ['a path that names no pull request', `${ORIGIN}/o/r/tree/main`],
      ['a pull request path with an extra segment', `${ORIGIN}/o/r/pull/12/files`],
    ]
    for (const [label, prUrl] of cases) {
      const { id, secret } = runningJob(h)
      const result = await h.jobs.handleCallback(id, secret, { status: 'running', prUrl, summary: 'alive' })
      assert.equal(result.ok, true, `${label}: ${result.error ?? 'no error'}`)
      assert.equal(h.store.getJob(id)?.pr_url, null, `${label} must not be stored`)
    }
  } finally {
    await h.close()
  }
})

test('an issue link must name /issues/<n>, not a pull request path', async () => {
  const h = await harness()
  try {
    const pullAsIssue = runningJob(h)
    const pullResult = await h.jobs.handleCallback(pullAsIssue.id, pullAsIssue.secret, { status: 'running', issueUrl: `${ORIGIN}/o/r/pull/12` })
    assert.equal(pullResult.ok, true)
    assert.equal(h.store.getJob(pullAsIssue.id)?.issue_url, null, 'a pull request URL is not an issue URL')

    const issueAsPull = runningJob(h)
    const issueResult = await h.jobs.handleCallback(issueAsPull.id, issueAsPull.secret, { status: 'running', prUrl: `${ORIGIN}/o/r/issues/12` })
    assert.equal(issueResult.ok, true)
    assert.equal(h.store.getJob(issueAsPull.id)?.pr_url, null, 'an issue URL is not a pull request URL')
  } finally {
    await h.close()
  }
})

test('the accepted origin comes from the repository row, then the API base, never a literal host', async () => {
  // The recorded html_url wins, and the rule follows the row rather than a constant.
  const recorded = await harness({ upstreamHtmlUrl: `${ORIGIN}/o/r` })
  try {
    const own = runningJob(recorded)
    await recorded.jobs.handleCallback(own.id, own.secret, { status: 'running', prUrl: `${ORIGIN}/o/r/pull/12` })
    assert.equal(recorded.store.getJob(own.id)?.pr_url, `${ORIGIN}/o/r/pull/12`)

    const literal = runningJob(recorded)
    await recorded.jobs.handleCallback(literal.id, literal.secret, { status: 'running', prUrl: 'https://github.com/o/r/pull/12' })
    assert.equal(recorded.store.getJob(literal.id)?.pr_url, null, 'github.com is not this row\'s origin')
  } finally {
    await recorded.close()
  }

  // No html_url: the public API base maps to github.com.
  const publicInstance = await harness({ upstreamHtmlUrl: null, apiBase: 'https://api.github.com' })
  try {
    const job = runningJob(publicInstance)
    await publicInstance.jobs.handleCallback(job.id, job.secret, { status: 'running', prUrl: 'https://github.com/o/r/pull/12' })
    assert.equal(publicInstance.store.getJob(job.id)?.pr_url, 'https://github.com/o/r/pull/12')
  } finally {
    await publicInstance.close()
  }

  // No html_url on a self-hosted API base: drop the `api.` label and the path.
  const gheApi = await harness({ upstreamHtmlUrl: null, apiBase: 'https://api.ghe.example.com/api/v3' })
  try {
    const job = runningJob(gheApi)
    await gheApi.jobs.handleCallback(job.id, job.secret, { status: 'running', prUrl: `${ORIGIN}/o/r/pull/12` })
    assert.equal(gheApi.store.getJob(job.id)?.pr_url, `${ORIGIN}/o/r/pull/12`)
  } finally {
    await gheApi.close()
  }

  // Only the fork html_url is recorded.
  const forkOnly = await harness({ upstreamHtmlUrl: null, forkHtmlUrl: `${ORIGIN}/o/r`, apiBase: 'https://api.github.com' })
  try {
    const job = runningJob(forkOnly)
    await forkOnly.jobs.handleCallback(job.id, job.secret, { status: 'running', prUrl: `${ORIGIN}/o/r/pull/12` })
    assert.equal(forkOnly.store.getJob(job.id)?.pr_url, `${ORIGIN}/o/r/pull/12`)
  } finally {
    await forkOnly.close()
  }

  // Neither origin is available: every link is refused.
  const nowhere = await harness({ upstreamHtmlUrl: null, apiBase: 'not a url' })
  try {
    const job = runningJob(nowhere)
    const result = await nowhere.jobs.handleCallback(job.id, job.secret, { status: 'running', prUrl: 'https://github.com/o/r/pull/12' })
    assert.equal(result.ok, true)
    assert.equal(nowhere.store.getJob(job.id)?.pr_url, null)
  } finally {
    await nowhere.close()
  }
})

test('an absent link leaves the stored value alone while an unplaceable one resolves to null', async () => {
  const h = await harness()
  try {
    const { id, secret } = runningJob(h)
    const valid = `${ORIGIN}/o/r/pull/12`
    await h.jobs.handleCallback(id, secret, { status: 'running', prUrl: valid })
    assert.equal(h.store.getJob(id)?.pr_url, valid)

    await h.jobs.handleCallback(id, secret, { status: 'running', summary: 'alive' })
    assert.equal(h.store.getJob(id)?.pr_url, valid, 'a heartbeat without prUrl must not clear a stored link')

    const terminal = await h.jobs.handleCallback(id, secret, { status: 'succeeded', prUrl: 'https://evil.example/o/r/pull/1', summary: 'done' })
    assert.equal(terminal.ok, true)
    assert.equal(h.store.getJob(id)?.pr_url, null, 'a present but unplaceable URL resolves to null')
  } finally {
    await h.close()
  }
})

test('a review follow-up on a foreign origin is dropped and queues no job', async () => {
  const h = await harness()
  try {
    const { id, secret } = runningJob(h, 'review')
    const result = await h.jobs.handleCallback(id, secret, {
      status: 'succeeded',
      summary: 'done',
      followUps: [{ prUrl: 'https://evil.example/o/r/pull/1', branch: 'fledge/fix', headSha: 'abc123' }],
    })
    assert.equal(result.ok, true, result.error ?? 'no error')
    assert.equal(h.store.listJobsForRepo(h.repo.id, 10).length, 1, 'a foreign follow-up must not create a job')
    assert.deepEqual(h.store.listSettings('pending_followup:'), [], 'nothing is left pending')
    assert.equal(h.store.getJob(id)?.pr_url, null)
  } finally {
    await h.close()
  }
})

test('a review follow-up on the repository origin still queues one job', async () => {
  const h = await harness()
  try {
    const { id, secret } = runningJob(h, 'review')
    const prUrl = `${ORIGIN}/o/r/pull/12`
    const result = await h.jobs.handleCallback(id, secret, {
      status: 'succeeded',
      summary: 'done',
      followUps: [{ prUrl, branch: 'fledge/fix', headSha: 'abc123' }],
    })
    assert.equal(result.ok, true, result.error ?? 'no error')
    const followUp = h.store.listJobsForRepo(h.repo.id, 10).find((job) => job.trigger === 'followup')
    assert.ok(followUp !== undefined, 'a placeable follow-up still queues its job')
    assert.equal(followUp.pr_url, prUrl)
  } finally {
    await h.close()
  }
})
