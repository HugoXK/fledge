import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { makeUser } from './helpers.js'
import type { ReleaseAnalysisJob } from '../src/releases/analysis.js'

// The module under test is loaded inside each test that needs it. A static
// import makes a missing or broken module fail the whole file, which hides the
// route's own behaviour from a red run; loading it per test keeps the route
// test able to fail the way a maintainer would see it.
const analysisModule = () => import('../src/releases/analysis.js')

// #546 slice 4: the optional run analysis. These tests pin the properties the
// issue asks for, not the shape of the implementation: a read-only token that is
// always revoked, a redacted excerpt that can never be split into a fragment, an
// exact line range, and no effect on release state.

const OWNER = 'acme'
const NAME = 'widget'
const RUN_ID = 4242
const ATTEMPT = 1

const SECRET = `ghp_${'A'.repeat(30)}`

function logOf(lines: string[]): string {
  return `${lines.join('\n')}\n`
}

function failedRun() {
  return { id: RUN_ID, attempt: ATTEMPT, status: 'completed', conclusion: 'failure' }
}

interface Minted {
  token: string
  revoked: number
}

function tokenSource(minted: Minted) {
  return async () => ({
    token: 'ghs_read_only',
    revoke: async () => {
      minted.revoked += 1
      return true
    },
  })
}

function jobsClient(input: {
  jobs?: Array<{ id: number; name: string; status: string; conclusion: string | null; htmlUrl: string }>
  log?: string
  onLog?: () => never
}) {
  const calls: string[] = []
  return {
    calls,
    client: () => ({
      async listWorkflowJobs(owner: string, name: string, runId: number) {
        calls.push(`jobs:${owner}/${name}/${String(runId)}`)
        return input.jobs ?? []
      },
      async getJobLog(owner: string, name: string, jobId: number) {
        calls.push(`log:${owner}/${name}/${String(jobId)}`)
        if (input.onLog !== undefined) input.onLog()
        return input.log ?? ''
      },
    }),
  }
}

function failedJob(id = 7, name = 'release') {
  return { id, name, status: 'completed', conclusion: 'failure', htmlUrl: `https://github.com/acme/widget/actions/runs/${String(RUN_ID)}/job/${String(id)}` }
}

test('the analysis token is least-privilege and always revoked after the read', async () => {
  const { ANALYSIS_TOKEN_PERMISSIONS, analyzeReleaseRun, mintAnalysisToken } = await analysisModule()

  const minted: Minted = { token: '', revoked: 0 }
  const seen: Array<Record<string, 'read'>> = []
  const repo = { installation_id: 11 }
  const app = {
    configured: true,
    async ephemeralToken(_id: number, permissions: Record<string, 'read'>) {
      seen.push(permissions)
      return 'ghs_read_only'
    },
    async revokeToken() {
      minted.revoked += 1
      return true
    },
  }
  const mint = await mintAnalysisToken(repo, app)
  assert.deepEqual(seen[0], ANALYSIS_TOKEN_PERMISSIONS, 'the token is minted with exactly the read permissions the analysis needs')
  assert.deepEqual(ANALYSIS_TOKEN_PERMISSIONS, { actions: 'read', contents: 'read' })
  assert.equal(mint.token, 'ghs_read_only')
  await mint.revoke()
  assert.equal(minted.revoked, 1)

  const fake = jobsClient({ jobs: [failedJob()], log: logOf(['one', 'two']) })
  const result = await analyzeReleaseRun({
    owner: OWNER,
    name: NAME,
    run: failedRun(),
    mint: tokenSource(minted),
    client: fake.client,
  })
  assert.equal(result.ok, true)
  assert.equal(result.tokenRevoked, true)
  assert.equal(minted.revoked, 2, 'the analysis revokes the token it minted')
})

test('a token is revoked even when the log read throws, and the refusal carries no log text', async () => {
  const { analyzeReleaseRun } = await analysisModule()

  const minted: Minted = { token: '', revoked: 0 }
  const fake = jobsClient({ jobs: [failedJob()], onLog: () => { throw new Error('GitHub answered 502 for the log') } })
  const result = await analyzeReleaseRun({
    owner: OWNER,
    name: NAME,
    run: failedRun(),
    mint: tokenSource(minted),
    client: fake.client,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'log_unreadable')
  assert.equal(result.tokenRevoked, true)
  assert.equal(minted.revoked, 1)
  assert.match(result.message, /502/)
})

test('a running or green run is refused before any token is minted', async () => {
  const { analyzeReleaseRun } = await analysisModule()

  let minted = 0
  for (const run of [
    { id: RUN_ID, attempt: ATTEMPT, status: 'in_progress', conclusion: null },
    { id: RUN_ID, attempt: ATTEMPT, status: 'completed', conclusion: 'success' },
    { id: RUN_ID, attempt: ATTEMPT, status: 'completed', conclusion: 'skipped' },
  ]) {
    const result = await analyzeReleaseRun({
      owner: OWNER,
      name: NAME,
      run,
      mint: async () => {
        minted += 1
        return { token: 'never', revoke: async () => true }
      },
      client: jobsClient({ jobs: [] }).client,
    })
    assert.equal(result.ok, false, `${run.status}/${String(run.conclusion)}`)
    assert.equal(result.code, 'run_not_failed')
  }
  assert.equal(minted, 0, 'a run that did not fail costs no token')
})

test('the excerpt is redacted before it is cut, keeps its exact line range, and never carries a fragment', async () => {
  const { analyzeReleaseRun } = await analysisModule()

  const before = Array.from({ length: 60 }, (_, index) => `line ${String(index + 1)} ordinary output`)
  const secretLine = `token ${SECRET} leaked by a step`
  const lines = [...before, secretLine, 'Error: the release step failed', '##[error] exit code 1']
  const minted: Minted = { token: '', revoked: 0 }
  const fake = jobsClient({ jobs: [failedJob()], log: logOf(lines) })
  const result = await analyzeReleaseRun({
    owner: OWNER,
    name: NAME,
    run: failedRun(),
    mint: tokenSource(minted),
    client: fake.client,
  })
  assert.equal(result.ok, true)
  const job = result.jobs[0] as ReleaseAnalysisJob
  assert.equal(job.totalLines, lines.length)
  assert.equal(job.lineEnd, lines.length, 'the range ends at the last log line')
  assert.equal(job.lineEnd - job.lineStart + 1, job.excerpt.split('\n').length, 'the range has exactly the lines the excerpt keeps')
  assert.ok(!job.excerpt.includes(SECRET), 'the token never reaches the excerpt')
  assert.ok(!job.excerpt.includes(SECRET.slice(0, 20)), 'not even a fragment of it survives the cut')
  assert.match(job.excerpt, /\[redacted-github-token\]/)
  assert.match(job.excerpt, /release step failed/)
  assert.equal(job.url, failedJob().htmlUrl)
})

test('only failed jobs are analysed, and at most the two newest', async () => {
  const { analyzeReleaseRun } = await analysisModule()

  const minted: Minted = { token: '', revoked: 0 }
  const jobs = [
    { id: 1, name: 'build', status: 'completed', conclusion: 'success', htmlUrl: 'https://github.com/acme/widget/actions/runs/4242/job/1' },
    { id: 2, name: 'test', status: 'completed', conclusion: 'failure', htmlUrl: 'https://github.com/acme/widget/actions/runs/4242/job/2' },
    { id: 3, name: 'publish', status: 'completed', conclusion: 'timed_out', htmlUrl: 'https://github.com/acme/widget/actions/runs/4242/job/3' },
    { id: 4, name: 'sign', status: 'completed', conclusion: 'cancelled', htmlUrl: 'https://github.com/acme/widget/actions/runs/4242/job/4' },
    { id: 5, name: 'notify', status: 'completed', conclusion: 'skipped', htmlUrl: 'https://github.com/acme/widget/actions/runs/4242/job/5' },
  ]
  const fake = jobsClient({ jobs, log: logOf(['a', 'b']) })
  const result = await analyzeReleaseRun({
    owner: OWNER,
    name: NAME,
    run: failedRun(),
    mint: tokenSource(minted),
    client: fake.client,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.jobs.map((job) => job.jobId), [2, 3], 'skipped and green jobs are not analysed, and the list is bounded')
  assert.equal(fake.calls.filter((call) => call.startsWith('log:')).length, 2)
})

test('storing an analysis never decides release state', () => {
  const store = new Store(':memory:')
  const user = makeUser(store, { login: 'analysis-user', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_analysis',
    userId: user.id,
    owner: 'acme',
    name: 'widget',
    defaultBranch: 'main',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole: 'maintainer',
    autoMerge: false,
    roleCheckedAt: new Date().toISOString(),
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  const release = store.recordRelease({
    repoId: repo.id,
    userId: user.id,
    version: 'v1.4.0',
    tagName: 'v1.4.0',
    targetSha: 'a'.repeat(40),
    tagObjectSha: 'e'.repeat(40),
    previousTag: 'v1.3.0',
    actor: 'analysis-user',
  })
  assert.ok(release !== undefined)
  store.updateReleaseTracking(release.id, {
    status: 'run_failed',
    runId: String(RUN_ID),
    runAttempt: ATTEMPT,
    conclusion: 'failure',
    workflowName: 'release',
    draftReleaseId: null,
    draftUrl: null,
    externalReleaseId: null,
    lastCheckedAt: new Date().toISOString(),
  })
  const analysis = JSON.stringify({ runId: RUN_ID, attempt: ATTEMPT, tokenRevoked: true, jobs: [{ jobId: 7 }] })
  store.updateReleaseAnalysis(release.id, analysis)
  const stored = store.releaseById(release.id)
  assert.equal(stored?.status, 'run_failed', 'the analysis does not turn a failure into a success or a draft')
  assert.equal(stored?.conclusion, 'failure')
  assert.equal(stored?.draft_release_id, null, 'an analysis never creates a Release')
  assert.equal(stored?.analysis_json, analysis)
  store.close()
})

// The route is the only surface a maintainer sees, and two refusals have to be
// true there rather than only in the module: a user token is never widened into
// a log read, and a release with no recorded run never spends a request.
test('the analysis route refuses without an installation and never falls back to a writable token', async () => {
  const { buildApp } = await import('../src/app.js')
  const { MockRunner } = await import('../src/jobs/mock.js')
  const { encryptSecret } = await import('../src/lib/secrets.js')
  const { MemoryMailer, flashOf, formBody, sessionFor, testConfig } = await import('./helpers.js')
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  const user = makeUser(store, { login: 'analysis-route-user', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_analysis_route',
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
  })
  const session = sessionFor(built, user)
  const recorded = store.recordRelease({
    repoId: repo.id,
    userId: user.id,
    version: 'v1.0.0',
    tagName: 'v1.0.0',
    targetSha: 'a'.repeat(40),
    tagObjectSha: 'e'.repeat(40),
    previousTag: null,
    actor: 'analysis-route-user',
  })
  if (recorded === undefined) throw new Error('the release row must exist for this test')
  const release = recorded
  const post = (releaseId: string) => built.app.inject({
    method: 'POST',
    url: `/repos/${repo.id}/releases/${releaseId}/analyze`,
    headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: formBody({ csrf: session.csrf }),
  })

  const noRun = await post(release.id)
  assert.equal(noRun.statusCode, 302)
  // The app moves `error=` out of Location into a one-shot flash cookie, so the
  // assertion reads the banner the maintainer actually sees.
  assert.match(flashOf(noRun)?.error?.text ?? '', /检查工作流|check the workflow/i)

  store.updateReleaseTracking(release.id, {
    status: 'run_failed',
    runId: '4242',
    runAttempt: 1,
    conclusion: 'failure',
    workflowName: 'release',
    draftReleaseId: null,
    draftUrl: null,
    externalReleaseId: null,
    lastCheckedAt: new Date().toISOString(),
  })
  const noInstallation = await post(release.id)
  assert.equal(noInstallation.statusCode, 302)
  const refused = flashOf(noInstallation)?.error?.text ?? ''
  assert.match(refused, /ANALYSIS_READ_ONLY_TOKEN/)
  assert.match(refused, /read-only/)
  assert.equal(store.releaseById(release.id)?.analysis_json, null, 'a refusal stores no analysis')
  assert.equal(store.releaseById(release.id)?.status, 'run_failed', 'a refusal changes no release state')
  await built.close()
})

// The column is additive on purpose: a database written by the 45 build has
// release rows and no analysis, and an upgrade must keep those rows readable
// rather than requiring a fresh database. This is the migration half of the
// schema bump, tested at a real 45 file.
test('a database written at schema 45 gains the analysis column and keeps its release rows', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'fledge-analysis-migrate-'))
  const path = join(dir, 'fledge.db')
  try {
    const store = new Store(path)
    const user = makeUser(store, { login: 'analysis-migrate', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_analysis_migrate', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const created = store.recordRelease({ repoId: repo.id, userId: user.id, version: 'v1.0.0', tagName: 'v1.0.0', targetSha: 'a'.repeat(40), tagObjectSha: 'e'.repeat(40), previousTag: null, actor: 'analysis-migrate' })
    if (created === undefined) throw new Error('the release row must exist for this test')
    const release = created
    // The 45 shape predates the column: dropping it is how this file becomes a
    // database the previous release wrote.
    store.db.exec('ALTER TABLE repo_releases DROP COLUMN analysis_json')
    store.db.exec('PRAGMA user_version = 45;')
    store.close()

    const upgraded = new Store(path)
    const version = upgraded.get<{ user_version: number }>('PRAGMA user_version')?.user_version
    assert.equal(version, 46)
    const columns = upgraded.all<{ name: string }>('PRAGMA table_info(repo_releases)').map((row) => row.name)
    assert.ok(columns.includes('analysis_json'), 'the upgrade adds the column')
    const kept = upgraded.releaseById(release.id)
    assert.equal(kept?.tag_name, 'v1.0.0', 'the existing release row survives the upgrade')
    assert.equal(kept?.analysis_json, null, 'a release with no analysis reads back as none, not as an error')
    upgraded.updateReleaseAnalysis(release.id, '{"jobs":[]}')
    assert.equal(upgraded.releaseById(release.id)?.analysis_json, '{"jobs":[]}')
    upgraded.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
