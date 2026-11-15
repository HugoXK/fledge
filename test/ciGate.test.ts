import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { reportCiGate } from '../src/lib/ciGate.js'
import { json, makeUser, MemoryMailer, sessionFor, startFakeServer, testConfig } from './helpers.js'

const RECENT = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()

function workflow(trigger: string, run: string): string {
  return `name: ci\non:\n  ${trigger}\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${run}\n`
}

test('a repository whose CI does not gate a merge is reported as gaps, with the file as evidence', () => {
  const report = reportCiGate({
    repo: 'o/r',
    defaultBranch: 'main',
    workflows: [{ path: '.github/workflows/ci.yml', content: workflow('push:', 'npm run lint') }],
    gate: { protected: false, requiredChecks: [] },
    mergedPulls: [{ number: 4, mergedAt: RECENT, conclusions: [] }],
  })
  assert.equal(report.verdict, 'gaps')
  const byId = new Map(report.findings.map((finding) => [finding.id, finding]))
  assert.equal(byId.get('pull-request-trigger')?.state, 'gap')
  assert.equal(byId.get('test-on-pull-request')?.state, 'gap')
  assert.equal(byId.get('required-check')?.state, 'gap')
  assert.equal(byId.get('merged-without-check')?.state, 'gap')
  assert.ok(byId.get('pull-request-trigger')?.evidence.includes('.github/workflows/ci.yml'), 'the gap must name the file that was read')
})

test('a pull-request workflow that runs the tests, with a required check, is gated', () => {
  const report = reportCiGate({
    repo: 'o/r',
    defaultBranch: 'main',
    workflows: [{ path: '.github/workflows/ci.yml', content: workflow('pull_request:', 'npm test') }],
    gate: { protected: true, requiredChecks: ['ci'] },
    mergedPulls: [{ number: 4, mergedAt: RECENT, conclusions: ['success'] }],
  })
  assert.equal(report.verdict, 'gated')
  assert.equal(report.findings.every((finding) => finding.state === 'ok'), true)
})

test('an unreadable protection endpoint is unknown, never gated', () => {
  const report = reportCiGate({
    repo: 'o/r',
    defaultBranch: 'main',
    workflows: [{ path: '.github/workflows/ci.yml', content: workflow('pull_request:', 'npm test') }],
    gate: null,
    mergedPulls: [],
  })
  assert.equal(report.verdict, 'unknown')
  assert.equal(report.findings.find((finding) => finding.id === 'required-check')?.state, 'unknown')
})

// The console route: at live main there is no answer at all, so this is the red
// half. The fake GitHub below serves exactly the three reads the route makes.
async function withCiGateRepo(
  facts: { protection: boolean; trigger: string },
  run: (built: Awaited<ReturnType<typeof buildApp>>, cookie: string, url: string) => Promise<void>,
): Promise<void> {
  const content = Buffer.from(workflow(facts.trigger, 'npm test')).toString('base64')
  const server = await startFakeServer((request, response) => {
    const url = request.url ?? ''
    if (url === '/repos/o/r/contents/.github/workflows?ref=main') {
      json(response, 200, [{ name: 'ci.yml', type: 'file', path: '.github/workflows/ci.yml' }])
      return
    }
    if (url === '/repos/o/r/contents/.github/workflows/ci.yml?ref=main') {
      json(response, 200, { type: 'file', name: 'ci.yml', path: '.github/workflows/ci.yml', sha: 'b', size: 120, content, encoding: 'base64' })
      return
    }
    if (url === '/repos/o/r/branches/main/protection') {
      if (!facts.protection) {
        json(response, 404, { message: 'Branch not protected' })
        return
      }
      json(response, 200, { required_status_checks: { contexts: ['ci'] }, required_pull_request_reviews: { required_approving_review_count: 1 } })
      return
    }
    if (url.startsWith('/repos/o/r/pulls?')) {
      json(response, 200, [{ number: 7, html_url: 'https://github.example/o/r/pull/7', title: 'fix', head: { ref: 'fix' }, base: { ref: 'main' }, merged_at: RECENT, merge_commit_sha: 'sha7' }])
      return
    }
    if (url === '/repos/o/r/commits/sha7/check-runs?per_page=100') {
      json(response, 200, { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] })
      return
    }
    json(response, 404, { message: `unexpected ${url}` })
  })
  try {
    const config = testConfig({ github: { clientId: 'client', clientSecret: 'secret', scopes: 'repo', adminLogin: 'admin', apiBase: server.url, oauthTokenUrl: `${server.url}/login/oauth/access_token`, requestsPerMinute: 120 } })
    const store = new Store(':memory:')
    const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
    try {
      const user = makeUser(store, { login: 'owner', status: 'approved' })
      const repo = store.createRepo({
        id: 'repo_gate', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main',
        tokenEnc: encryptSecret('token', config.tokenEncryptionKey), permission: 'admin',
        repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
      })
      const { cookie } = sessionFor(built, user)
      await run(built, cookie, `/repos/${repo.id}/ci-gate`)
    } finally {
      await built.close()
    }
  } finally {
    await server.close()
  }
}

test('the console answers whether the repository CI gates a merge', async () => {
  await withCiGateRepo({ protection: true, trigger: 'pull_request:' }, async (built, cookie, url) => {
    const response = await built.app.inject({ method: 'GET', url, headers: { cookie } })
    assert.equal(response.statusCode, 200, `the CI gate page answered ${response.statusCode}`)
    assert.match(response.body, /data-ci-gate-verdict="gated"/)
    assert.match(response.body, /\.github\/workflows\/ci\.yml/, 'the page must quote the workflow file it read')
  })
})

test('the console names the gap when the branch is not protected', async () => {
  await withCiGateRepo({ protection: false, trigger: 'pull_request:' }, async (built, cookie, url) => {
    const response = await built.app.inject({ method: 'GET', url, headers: { cookie } })
    assert.equal(response.statusCode, 200)
    assert.match(response.body, /data-ci-gate-verdict="gaps"/)
    assert.match(response.body, /data-ci-gate-finding="required-check"[^>]*data-ci-gate-state="gap"/)
    assert.match(response.body, /no branch protection/)
  })
})
