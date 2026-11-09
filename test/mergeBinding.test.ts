import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import type { RepoRow } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import type { Runner } from '../src/jobs/runner.js'
import { encryptSecret, sha256Hex } from '../src/lib/secrets.js'
import { json, makeUser, MemoryMailer, startFakeServer, testConfig } from './helpers.js'

interface FakePr {
  number: number
  headRef: string
  baseRef: string
  headSha: string
}

interface FakeGithub {
  url: string
  merges: string[]
  requests: string[]
  close: () => Promise<void>
}

// A green PR on o/r whose head branch and sha the caller chooses. Every request
// is recorded so a test can assert that a rejected URL never reached GitHub.
async function fakeGithub(pr: FakePr): Promise<FakeGithub> {
  const merges: string[] = []
  const requests: string[] = []
  const server = await startFakeServer((request, response) => {
    const method = request.method ?? 'GET'
    const url = request.url ?? ''
    requests.push(`${method} ${url}`)
    const pull = `/repos/o/r/pulls/${pr.number}`
    if (method === 'GET' && url === pull) {
      json(response, 200, {
        number: pr.number,
        html_url: `https://github.example/o/r/pull/${pr.number}`,
        title: 'fix',
        state: 'open',
        head: { ref: pr.headRef, sha: pr.headSha },
        base: { ref: pr.baseRef },
        mergeable: true,
        mergeable_state: 'clean',
        draft: false,
        merged: false,
      })
      return
    }
    if (method === 'GET' && url === `/repos/o/r/commits/${pr.headSha}/check-runs?per_page=100`) {
      json(response, 200, { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] })
      return
    }
    if (method === 'GET' && url === `/repos/o/r/commits/${pr.headSha}/status`) {
      json(response, 200, { state: 'success', statuses: [] })
      return
    }
    if (method === 'GET' && url === `${pull}/reviews?per_page=100`) {
      json(response, 200, [])
      return
    }
    if (method === 'GET' && url === `/repos/o/r/branches/${pr.baseRef}/protection`) {
      json(response, 200, { required_status_checks: { contexts: ['ci'] }, required_pull_request_reviews: { required_approving_review_count: 0 } })
      return
    }
    if (method === 'PUT' && url === `${pull}/merge`) {
      merges.push(url)
      json(response, 200, { merged: true, sha: 'mergedsha' })
      return
    }
    json(response, 404, { message: 'Not Found' })
  })
  return { url: server.url, merges, requests, close: server.close }
}

function auditOf(store: Store, action: string): Array<{ action: string; detail: string }> {
  return store.all<{ action: string; detail: string }>('SELECT action, detail FROM audit_log WHERE action = ?', action)
}

interface Setup {
  store: Store
  jobs: Jobs
  repo: RepoRow
  apiBase: string
  close: () => Promise<void>
}

async function setup(options: {
  apiBase: string
  slug: string
  upstreamHtmlUrl?: string | null
  forkHtmlUrl?: string | null
}): Promise<Setup> {
  const store = new Store(':memory:')
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: options.apiBase } })
  const runner: Runner = { name: 'noop', async run() { return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  const user = makeUser(store, { login: `${options.slug}-user`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_${options.slug}`,
    userId: user.id,
    owner: 'o',
    name: 'r',
    defaultBranch: 'main',
    tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey),
    permission: 'admin',
    repoRole: 'maintainer',
    autoMerge: true,
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
    upstreamHtmlUrl: options.upstreamHtmlUrl === undefined ? 'https://github.example/o/r' : options.upstreamHtmlUrl,
    forkHtmlUrl: options.forkHtmlUrl === undefined ? 'https://github.example/o/r' : options.forkHtmlUrl,
  })
  return { store, jobs, repo, apiBase: options.apiBase, close: async () => { store.close() } }
}

function startJob(store: Store, repo: RepoRow, id: string, secret: string, branch: string): void {
  store.createJob({
    id,
    repoId: repo.id,
    userId: repo.user_id,
    trigger: 'manual',
    goal: 'g',
    callbackHash: sha256Hex(secret),
    platformTokenHash: '',
    kind: 'iterate',
    baseBranch: 'main',
    baseSha: null,
  })
  store.updateJob(id, { status: 'running', branch, started_at: new Date().toISOString() })
}

test('a callback cannot auto-merge a pull request whose head is another job branch', async () => {
  const github = await fakeGithub({ number: 12, headRef: 'fledge/job-b', baseRef: 'main', headSha: 'shab' })
  const s = await setup({ apiBase: github.url, slug: 'binding' })
  try {
    const secret = 'binding-secret'
    startJob(s.store, s.repo, 'job_a', secret, 'fledge/job-a')

    const result = await s.jobs.handleCallback('job_a', secret, { status: 'succeeded', prUrl: 'https://github.example/o/r/pull/12', summary: 'done' })
    assert.equal(result.ok, true)
    assert.equal(github.merges.length, 0, 'a PR from another branch must not be merged')
    const skipped = auditOf(s.store, 'job.merge_skipped')
    assert.equal(skipped.length, 1, 'the skip must be audited')
    assert.match(String(skipped[0]!.detail), /head/)
    assert.equal(s.store.getJob('job_a')?.status, 'succeeded')
    assert.notEqual(s.store.getJob('job_a')?.pr_state, 'merged')
  } finally {
    await s.close()
    await github.close()
  }
})

test('a prUrl from another host is rejected before any GitHub call', async () => {
  const github = await fakeGithub({ number: 12, headRef: 'fledge/job-a', baseRef: 'main', headSha: 'shaa' })
  const s = await setup({ apiBase: github.url, slug: 'host' })
  try {
    const secret = 'host-secret'
    startJob(s.store, s.repo, 'job_host', secret, 'fledge/job-a')
    // A row written before the callback filter can still hold a foreign URL, so
    // seed it directly: the merge path must keep refusing such a value.
    s.store.updateJob('job_host', { pr_url: 'https://evil.example/o/r/pull/12' })

    const result = await s.jobs.handleCallback('job_host', secret, { status: 'succeeded', summary: 'done' })
    assert.equal(result.ok, true)
    assert.equal(github.merges.length, 0)
    assert.deepEqual(github.requests, [], 'a foreign host must be rejected before any GitHub call')
    const skipped = auditOf(s.store, 'job.merge_skipped')
    assert.equal(skipped.length, 1)
    assert.match(String(skipped[0]!.detail), /host/)
  } finally {
    await s.close()
    await github.close()
  }
})

test('a prUrl that only looks like the repository host is rejected before any GitHub call', async () => {
  const github = await fakeGithub({ number: 12, headRef: 'fledge/job-a', baseRef: 'main', headSha: 'shaa' })
  const s = await setup({ apiBase: github.url, slug: 'lookalike' })
  try {
    // The repository origin here is https://github.example. Each row is a URL
    // that a prefix, suffix or substring comparison would mistake for it.
    const hostile = [
      'https://evil.example@github.example/o/r/pull/12', // credentials on the right host
      'https://github.example@evil.example/o/r/pull/12', // userinfo swallows the host
      'https://github.example.evil.example/o/r/pull/12', // our host as a suffix
      'https://evil.example/github.example/o/r/pull/12', // our host inside the path
      'https://github.example:8443/o/r/pull/12', // unexpected port
    ]
    for (const [index, prUrl] of hostile.entries()) {
      const id = `job_lookalike_${index}`
      const secret = `lookalike-secret-${index}`
      startJob(s.store, s.repo, id, secret, 'fledge/job-a')
      // A row written before the callback filter can still hold this URL; seed
      // it directly to prove the merge path keeps refusing it.
      s.store.updateJob(id, { pr_url: prUrl })
      const result = await s.jobs.handleCallback(id, secret, { status: 'succeeded', summary: 'done' })
      assert.equal(result.ok, true, `${prUrl} must still finish the job`)
      assert.notEqual(s.store.getJob(id)?.pr_state, 'merged', `${prUrl} must not merge`)
    }
    assert.equal(github.merges.length, 0)
    assert.deepEqual(github.requests, [], 'no look-alike URL may reach GitHub')
    assert.equal(auditOf(s.store, 'job.merge_skipped').length, hostile.length, 'every rejection is audited')
  } finally {
    await s.close()
    await github.close()
  }
})

test('a pull request that belongs to the job still merges exactly once', async () => {
  const github = await fakeGithub({ number: 12, headRef: 'fledge/job-a', baseRef: 'main', headSha: 'shaa' })
  const s = await setup({ apiBase: github.url, slug: 'own' })
  try {
    const secret = 'own-secret'
    startJob(s.store, s.repo, 'job_own', secret, 'fledge/job-a')

    await s.jobs.handleCallback('job_own', secret, { status: 'succeeded', prUrl: 'https://github.example/o/r/pull/12', summary: 'done' })
    assert.equal(github.merges.length, 1, "the job's own green PR must still merge")
    assert.equal(s.store.getJob('job_own')?.pr_state, 'merged')
    assert.equal(auditOf(s.store, 'job.merge_skipped').length, 0)
  } finally {
    await s.close()
    await github.close()
  }
})

test('one job secret cannot drive another job callback or credential', async () => {
  const s = await setup({ apiBase: 'http://127.0.0.1:9', slug: 'secret-scope' })
  try {
    const secretA = 'secret-a'
    const secretB = 'secret-b'
    s.store.createJob({ id: 'job_scope_a', repoId: s.repo.id, userId: s.repo.user_id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(secretA), platformTokenHash: '', kind: 'iterate' })
    s.store.createJob({ id: 'job_scope_b', repoId: s.repo.id, userId: s.repo.user_id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(secretB), platformTokenHash: '', kind: 'iterate' })

    const callback = await s.jobs.handleCallback('job_scope_b', secretA, { status: 'succeeded' })
    assert.equal(callback.ok, false)
    assert.equal(callback.status, 401)
    const credential = await s.jobs.credential('job_scope_b', secretA)
    assert.equal(credential.ok, false)
    assert.equal(credential.status, 401)
    assert.equal(s.store.getJob('job_scope_b')?.status, 'queued')
  } finally {
    await s.close()
  }
})

test('a succeeded callback cannot flip a failed job back', async () => {
  const github = await fakeGithub({ number: 12, headRef: 'fledge/job-a', baseRef: 'main', headSha: 'shaa' })
  const s = await setup({ apiBase: github.url, slug: 'flip' })
  try {
    const secret = 'flip-secret'
    s.store.createJob({ id: 'job_flip', repoId: s.repo.id, userId: s.repo.user_id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    s.store.updateJob('job_flip', { status: 'failed', branch: 'fledge/job-a', finished_at: new Date().toISOString() })

    const result = await s.jobs.handleCallback('job_flip', secret, { status: 'succeeded', prUrl: 'https://github.example/o/r/pull/12', summary: 'done' })
    assert.equal(result.ok, false)
    assert.equal(s.store.getJob('job_flip')?.status, 'failed')
    assert.equal(github.merges.length, 0)
  } finally {
    await s.close()
    await github.close()
  }
})

test('replaying the same succeeded callback merges at most once', async () => {
  const github = await fakeGithub({ number: 12, headRef: 'fledge/job-a', baseRef: 'main', headSha: 'shaa' })
  const s = await setup({ apiBase: github.url, slug: 'replay' })
  try {
    const secret = 'replay-secret'
    startJob(s.store, s.repo, 'job_replay', secret, 'fledge/job-a')

    const payload = { status: 'succeeded' as const, prUrl: 'https://github.example/o/r/pull/12', summary: 'done' }
    await s.jobs.handleCallback('job_replay', secret, payload)
    await s.jobs.handleCallback('job_replay', secret, payload)
    assert.equal(github.merges.length, 1, 'a replayed callback must not merge a second time')
  } finally {
    await s.close()
    await github.close()
  }
})

test('the host and the repository path must both match', async () => {
  const github = await fakeGithub({ number: 12, headRef: 'fledge/job-a', baseRef: 'main', headSha: 'shaa' })
  const s = await setup({ apiBase: github.url, slug: 'origin' })
  try {
    const secret = 'origin-secret'
    startJob(s.store, s.repo, 'job_origin', secret, 'fledge/job-a')

    // Same host, another repository: the number belongs to a different repo.
    // Seed the row directly because the callback filter would drop the value.
    s.store.updateJob('job_origin', { pr_url: 'https://github.example/other/repo/pull/1' })
    const otherRepo = await s.jobs.handleCallback('job_origin', secret, { status: 'succeeded', summary: 'done' })
    assert.equal(otherRepo.ok, true)
    assert.equal(github.merges.length, 0)
    assert.deepEqual(github.requests, [], 'a foreign repository path must be rejected before any GitHub call')
    const otherAudit = auditOf(s.store, 'job.merge_skipped')
    assert.equal(otherAudit.length, 1)
    assert.match(String(otherAudit[0]!.detail), /repository|owner|path/)
  } finally {
    await s.close()
    await github.close()
  }
})

test('a pull request on a self-hosted host still merges when it belongs to the job', async () => {
  const github = await fakeGithub({ number: 12, headRef: 'fledge/job-a', baseRef: 'main', headSha: 'shaa' })
  const s = await setup({ apiBase: github.url, slug: 'ghe', upstreamHtmlUrl: 'https://ghe.example.com/o/r', forkHtmlUrl: 'https://ghe.example.com/o/r' })
  try {
    const secret = 'ghe-secret'
    startJob(s.store, s.repo, 'job_ghe', secret, 'fledge/job-a')

    await s.jobs.handleCallback('job_ghe', secret, { status: 'succeeded', prUrl: 'https://ghe.example.com/o/r/pull/12', summary: 'done' })
    assert.equal(github.merges.length, 1, 'a GHE-shaped html_url must not kill a normal merge')
    assert.equal(s.store.getJob('job_ghe')?.pr_state, 'merged')
  } finally {
    await s.close()
    await github.close()
  }
})

test('an unparseable API base with no recorded html_url fails closed', async () => {
  const github = await fakeGithub({ number: 12, headRef: 'fledge/job-a', baseRef: 'main', headSha: 'shaa' })
  const s = await setup({ apiBase: 'not a url', slug: 'closed', upstreamHtmlUrl: null, forkHtmlUrl: null })
  try {
    const secret = 'closed-secret'
    startJob(s.store, s.repo, 'job_closed', secret, 'fledge/job-a')
    // Seed the row directly: the callback filter refuses a value it cannot place,
    // and the merge path must also refuse this row from before the fix.
    s.store.updateJob('job_closed', { pr_url: `${github.url.replace('http:', 'https:')}/o/r/pull/12` })

    const result = await s.jobs.handleCallback('job_closed', secret, { status: 'succeeded', summary: 'done' })
    assert.equal(result.ok, true)
    assert.equal(github.merges.length, 0)
    assert.deepEqual(github.requests, [], 'an unknown origin must be rejected before any GitHub call')
    const skipped = auditOf(s.store, 'job.merge_skipped')
    assert.equal(skipped.length, 1)
    assert.match(String(skipped[0]!.detail), /origin|host|url/i)
  } finally {
    await s.close()
    await github.close()
  }
})

test('a pull request whose base is not the job base branch is not merged', async () => {
  const github = await fakeGithub({ number: 12, headRef: 'fledge/job-a', baseRef: 'develop', headSha: 'shaa' })
  const s = await setup({ apiBase: github.url, slug: 'base' })
  try {
    const secret = 'base-secret'
    startJob(s.store, s.repo, 'job_base', secret, 'fledge/job-a')

    await s.jobs.handleCallback('job_base', secret, { status: 'succeeded', prUrl: 'https://github.example/o/r/pull/12', summary: 'done' })
    assert.equal(github.merges.length, 0, 'a PR against another base branch must not be merged')
    const skipped = auditOf(s.store, 'job.merge_skipped')
    assert.equal(skipped.length, 1)
    assert.match(String(skipped[0]!.detail), /base/)
  } finally {
    await s.close()
    await github.close()
  }
})

test('the expected PR origin is derived from html_url, else from the API base', async () => {
  const { prOrigin } = await import('../src/jobs/prUrl.js')

  // The recorded html_url wins, and a self-hosted host is not rewritten.
  assert.equal(prOrigin({ upstream_html_url: 'https://ghe.example.com/o/r', fork_html_url: null }, 'https://api.github.com'), 'https://ghe.example.com')
  // The fork html_url is the fallback when upstream is NULL.
  assert.equal(prOrigin({ upstream_html_url: null, fork_html_url: 'https://ghe.example.com/o/r' }, 'https://api.example'), 'https://ghe.example.com')
  // No html_url: derive from the API base, strip the `api.` label, ignore /api/v3.
  assert.equal(prOrigin({ upstream_html_url: null, fork_html_url: null }, 'https://api.ghe.example.com/api/v3'), 'https://ghe.example.com')
  assert.equal(prOrigin({ upstream_html_url: null, fork_html_url: null }, 'https://api.github.com'), 'https://github.com')
  // An API base with no `api.` label keeps its host as recorded.
  assert.equal(prOrigin({ upstream_html_url: null, fork_html_url: null }, 'https://ghe.example.com/api/v3'), 'https://ghe.example.com')
  // An empty string is not a recorded URL.
  assert.equal(prOrigin({ upstream_html_url: '', fork_html_url: '' }, 'https://api.ghe.example.com'), 'https://ghe.example.com')
  // Unparseable input fails closed.
  assert.equal(prOrigin({ upstream_html_url: null, fork_html_url: null }, 'not a url'), undefined)
})
