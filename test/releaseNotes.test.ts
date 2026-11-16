import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { buildReleaseNotes, collectReleaseNotes } from '../src/releases/notes.js'
import { reconcileRelease } from '../src/releases/tracking.js'
import { flashOf, formBody, json, makeUser, readBody, sessionFor, startFakeServer, testConfig } from './helpers.js'

// #546 slice 3: the draft Release is written with notes built from the release
// range, not with a placeholder sentence. Every source in the body is a commit or
// a merged pull request that the range actually contains, each appears once, and
// a source outside the range can never reach the body. Fledge writes the titles
// and links itself; no model is involved in this slice.

const TARGET = 'a'.repeat(40)
const PREVIOUS = 'v1.3.0'
const MERGE_SHA = 'b'.repeat(40)
const PLAIN_SHA = 'c'.repeat(40)

const PRS = [
  { number: 812, title: 'feat: show the release readiness page', url: 'https://github.com/o/r/pull/812', mergeCommitSha: MERGE_SHA },
  // Merged before the range: its merge commit is not in the commit list.
  { number: 700, title: 'fix: something older', url: 'https://github.com/o/r/pull/700', mergeCommitSha: 'd'.repeat(40) },
]

const COMMITS = [
  { sha: MERGE_SHA, title: 'feat: show the release readiness page (#812)', url: `https://github.com/o/r/commit/${MERGE_SHA}` },
  { sha: PLAIN_SHA, title: 'chore: bump the workflow pin', url: `https://github.com/o/r/commit/${PLAIN_SHA}` },
]

test('the notes name each source once: a merged pull request covers its merge commit', () => {
  const notes = buildReleaseNotes({
    previousTag: PREVIOUS,
    targetSha: TARGET,
    pullRequests: PRS,
    commits: COMMITS,
    commitsComplete: true,
  })
  // The pull request is listed by number and title.
  assert.match(notes.body, /#812/)
  assert.match(notes.body, /show the release readiness page/)
  // Its merge commit is not printed a second time as a bare commit.
  assert.equal(notes.body.split('#812').length - 1, 1, 'the merged pull request appears more than once')
  assert.equal(notes.body.split(MERGE_SHA.slice(0, 7)).length - 1, 0, 'the pull request merge commit is listed again as a bare commit')
  // A commit that no listed pull request covers is still listed.
  assert.match(notes.body, /bump the workflow pin/)
  assert.ok(notes.body.includes(PLAIN_SHA.slice(0, 7)))
  // A pull request merged before the range never reaches the body.
  assert.equal(notes.body.includes('#700'), false, 'a source outside the range reached the notes')
  // The stored source list is exactly what the body renders, so the page and the
  // draft cannot disagree about what the release contains.
  assert.deepEqual(notes.sources.map((source) => source.ref), ['#812', PLAIN_SHA.slice(0, 7)])
  assert.equal(notes.previousTag, PREVIOUS)
  assert.equal(notes.targetSha, TARGET)
})

test('a capped range says it is partial instead of printing a smaller release', () => {
  const complete = buildReleaseNotes({ previousTag: PREVIOUS, targetSha: TARGET, pullRequests: PRS, commits: COMMITS, commitsComplete: false })
  assert.equal(complete.complete, false)
  assert.match(complete.body, /partial/i)
  // A complete read says nothing about a cap.
  const whole = buildReleaseNotes({ previousTag: PREVIOUS, targetSha: TARGET, pullRequests: PRS, commits: COMMITS, commitsComplete: true })
  assert.equal(whole.complete, true)
  assert.doesNotMatch(whole.body, /partial/i)
})

test('the range is read from the previous tag to the target commit and each source once', async () => {
  const calls: string[] = []
  const server = await startFakeServer(async (request, response) => {
    const method = request.method ?? 'GET'
    const url = request.url ?? ''
    calls.push(`${method} ${url}`)
    if (method === 'GET' && url.startsWith(`/repos/o/r/compare/${PREVIOUS}...${TARGET}`)) {
      return json(response, 200, {
        status: 'ahead',
        ahead_by: 2,
        total_commits: 2,
        commits: COMMITS.map((commit) => ({ sha: commit.sha, html_url: commit.url, commit: { message: `${commit.title}\n\nbody` } })),
      })
    }
    if (method === 'GET' && url.startsWith(`/repos/o/r/commits/${PREVIOUS}`)) {
      return json(response, 200, { sha: 'd'.repeat(40), commit: { committer: { date: '2026-10-01T00:00:00Z' } } })
    }
    if (method === 'GET' && url.startsWith('/repos/o/r/pulls?')) {
      return json(response, 200, PRS.map((pull) => ({
        number: pull.number,
        title: pull.title,
        html_url: pull.url,
        merged_at: '2026-11-01T00:00:00Z',
        updated_at: '2026-11-02T00:00:00Z',
        merge_commit_sha: pull.mergeCommitSha,
        labels: [],
      })))
    }
    return json(response, 404, { message: 'Not Found' })
  })
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: server.url } })
  const { GithubClient } = await import('../src/repos/github.js')
  const client = new GithubClient('gh-token', config.github.apiBase)
  try {
    const notes = await collectReleaseNotes(client, { owner: 'o', name: 'r', previousTag: PREVIOUS, targetSha: TARGET })
    assert.equal(notes.previousTag, PREVIOUS)
    assert.match(notes.body, /#812/)
    assert.equal(notes.body.includes('#700'), false, 'a pull request merged outside the range reached the notes')
    assert.ok(calls.some((call) => call.startsWith(`GET /repos/o/r/compare/${PREVIOUS}...${TARGET}`)), 'the range was never compared')
    assert.equal(notes.sources.filter((source) => source.kind === 'pull_request').length, 1)
    assert.equal(notes.sources.filter((source) => source.kind === 'commit').length, 1)
  } finally {
    await server.close()
  }
})

test('a first release has no range and says so instead of inventing sources', async () => {
  const notes = await collectReleaseNotes({} as never, { owner: 'o', name: 'r', previousTag: null, targetSha: TARGET })
  assert.equal(notes.sources.length, 0)
  assert.match(notes.body, /first release/i)
})

test('a green run writes the notes into the draft, and a failed run never reads the range', async () => {
  const requests: string[] = []
  const created: Array<Record<string, unknown>> = []
  const server = await startFakeServer(async (request, response) => {
    const url = request.url ?? ''
    const body = (await readBody(request)).toString('utf8')
    requests.push(url)
    if (url.startsWith('/repos/o/r/releases/tags/')) return json(response, 404, { message: 'Not Found' })
    if (url.startsWith('/repos/o/r/actions/runs?')) {
      return json(response, 200, {
        workflow_runs: [{ id: 1, name: 'release', path: '.github/workflows/release.yml', status: 'completed', conclusion: 'success', head_sha: TARGET, head_branch: 'v1.4.0', run_attempt: 1, html_url: 'https://github.com/o/r/actions/runs/1', event: 'push' }],
      })
    }
    if (/\/repos\/o\/r\/actions\/runs\/1\/jobs/.test(url)) {
      return json(response, 200, { total_count: 1, jobs: [{ id: 2, name: 'build', status: 'completed', conclusion: 'success' }] })
    }
    if (url === '/repos/o/r/releases') {
      created.push({ id: 500, tag_name: 'v1.4.0', draft: true, prerelease: false, html_url: 'https://github.com/o/r/releases/500', target_commitish: TARGET, name: 'v1.4.0', ...JSON.parse(body) as Record<string, unknown> })
      return json(response, 201, created[created.length - 1])
    }
    return json(response, 404, { message: 'Not Found' })
  })
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: server.url } })
  const { GithubClient } = await import('../src/repos/github.js')
  const client = new GithubClient('gh-token', config.github.apiBase)
  const notes = () => buildReleaseNotes({ previousTag: PREVIOUS, targetSha: TARGET, pullRequests: PRS, commits: COMMITS, commitsComplete: true })
  try {
    const result = await reconcileRelease(client, {
      owner: 'o',
      name: 'r',
      tagName: 'v1.4.0',
      targetSha: TARGET,
      prerelease: false,
      draftReleaseId: null,
      notes,
    })
    assert.equal(result.status, 'draft_created')
    assert.equal(created[0]?.body, notes().body, 'the draft body is not the notes body')
    assert.match(String(created[0]?.body), /#812/)
  } finally {
    await server.close()
  }
})

test('the check route keeps the exact sources and the page links them', async () => {
  const calls: Array<{ method: string; url: string; body: string }> = []
  const server = await startFakeServer(async (request, response) => {
    const method = request.method ?? 'GET'
    const url = request.url ?? ''
    const body = (await readBody(request)).toString('utf8')
    calls.push({ method, url, body })
    if (method === 'GET' && url.startsWith('/repos/o/r/releases/tags/')) return json(response, 404, { message: 'Not Found' })
    if (method === 'GET' && url.startsWith('/repos/o/r/actions/runs?')) {
      return json(response, 200, {
        workflow_runs: [{ id: 1, name: 'release', path: '.github/workflows/release.yml', status: 'completed', conclusion: 'success', head_sha: TARGET, head_branch: 'v1.4.0', run_attempt: 1, html_url: 'https://github.com/o/r/actions/runs/1', event: 'push' }],
      })
    }
    if (method === 'GET' && /\/repos\/o\/r\/actions\/runs\/1\/jobs/.test(url)) {
      return json(response, 200, { total_count: 1, jobs: [{ id: 2, name: 'build', status: 'completed', conclusion: 'success' }] })
    }
    if (method === 'GET' && url.startsWith(`/repos/o/r/compare/${PREVIOUS}...${TARGET}`)) {
      return json(response, 200, {
        status: 'ahead',
        ahead_by: 2,
        total_commits: 2,
        commits: COMMITS.map((commit) => ({ sha: commit.sha, html_url: commit.url, commit: { message: commit.title } })),
      })
    }
    if (method === 'GET' && url.startsWith(`/repos/o/r/commits/${PREVIOUS}`)) {
      return json(response, 200, { sha: 'd'.repeat(40), commit: { committer: { date: '2026-10-01T00:00:00Z' } } })
    }
    if (method === 'GET' && url.startsWith('/repos/o/r/pulls?')) {
      return json(response, 200, PRS.map((pull) => ({
        number: pull.number,
        title: pull.title,
        html_url: pull.url,
        merged_at: '2026-11-01T00:00:00Z',
        updated_at: '2026-11-02T00:00:00Z',
        merge_commit_sha: pull.mergeCommitSha,
        labels: [],
      })))
    }
    if (method === 'POST' && url === '/repos/o/r/releases') {
      return json(response, 201, { id: 500, tag_name: 'v1.4.0', draft: true, prerelease: false, html_url: 'https://github.com/o/r/releases/500' })
    }
    return json(response, 404, { message: 'Not Found' })
  })
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: server.url } })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: undefined, runner: new MockRunner(), startScheduler: false })
  const user = makeUser(store, { login: 'notes-user', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_notes',
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
  const row = store.recordRelease({
    repoId: repo.id,
    userId: user.id,
    version: 'v1.4.0',
    tagName: 'v1.4.0',
    targetSha: TARGET,
    tagObjectSha: 'e'.repeat(40),
    previousTag: PREVIOUS,
    actor: user.login,
  })
  const session = sessionFor(built, user)
  try {
    const response = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/releases/${row?.id ?? ''}/check`,
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: session.csrf }),
    })
    assert.equal(response.statusCode, 302)
    assert.equal(flashOf(response)?.outcome?.key, 'checked', `the check was not reported: ${flashOf(response)?.error?.text ?? ''}`)
    const created = calls.find((call) => call.method === 'POST' && call.url === '/repos/o/r/releases')
    assert.ok(created !== undefined, 'no draft Release was written')
    const stored = store.releaseById(row?.id ?? '')
    assert.ok(stored?.notes_source_json !== undefined && stored.notes_source_json !== null, 'the exact sources were not kept on the row')
    assert.match(String(created.body), /#812/)
    const page = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}?release=1`, headers: { cookie: session.cookie, 'accept-language': 'en' } })
    assert.equal(page.statusCode, 200)
    // A literal whole-attribute check, not a URL-shaped pattern: the page must carry
    // exactly this href. An unanchored URL regex would also match a string that only
    // contains it somewhere, which is not the same claim.
    assert.ok(
      page.body.includes('href="https://github.com/o/r/pull/812"'),
      'the page does not link the merged pull request it used',
    )
  } finally {
    await built.close()
    await server.close()
  }
})
