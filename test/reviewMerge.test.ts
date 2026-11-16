import test from 'node:test'
import assert from 'node:assert/strict'
import { Store, type JobRow } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { localizeMessage } from '../src/i18n.js'
import { reviewMergeView } from '../src/lib/verification.js'
import { jobPage, repoPage } from '../src/views/pages.js'
import { json, makeUser, MemoryMailer, startFakeServer, testConfig } from './helpers.js'

// #264: the review -> merge step is one card with one action. The pure part
// decides the state and the action; the page renders it; the merge path
// refuses a PASS taken at an older tip and says so.

const HEAD = 'a'.repeat(40)

function verificationJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ok: true,
    checkedAt: '2026-11-16T00:00:00.000Z',
    sha: HEAD,
    prState: 'open',
    draft: false,
    mergeableState: 'clean',
    checks: { total: 3, green: 3, failing: [], pending: [] },
    combinedStatus: 'success',
    reviews: { changesRequested: false, approvals: 1 },
    testEvidence: { state: 'verified', claimed: true, greenChecks: ['test (22)'], failingChecks: [] },
    reasons: [],
    ...over,
  })
}

const GUARD_OK = JSON.stringify({
  ok: true,
  checkedAt: '2026-11-16T00:00:00.000Z',
  allow: [],
  deny: ['src/'],
  files: ['README.md'],
  violations: [],
})

const GUARD_BLOCKED = JSON.stringify({
  ok: false,
  checkedAt: '2026-11-16T00:00:00.000Z',
  allow: [],
  deny: ['src/'],
  files: ['src/config.ts'],
  violations: [{ file: 'src/config.ts', reason: 'denied' }],
})

function jobFixture(over: Partial<JobRow> = {}): JobRow {
  return {
    pr_url: 'https://github.com/o/r/pull/1',
    pr_state: 'open',
    status: 'succeeded',
    path_guard_json: GUARD_OK,
    verification_json: verificationJson(),
    ...over,
  } as JobRow
}

test('the review/merge view names every state and its one action', () => {
  const view = (over: Partial<JobRow> = {}, maintainer = true, headSha?: string) =>
    reviewMergeView({ job: jobFixture(over), maintainer, ...(headSha === undefined ? {} : { headSha }) })

  assert.deepEqual([view({ pr_url: null }).state, view({ pr_url: null }).action], ['no-pr', 'none'])
  assert.deepEqual([view({ pr_state: 'merged' }).state, view({ pr_state: 'merged' }).action], ['merged', 'none'])
  assert.deepEqual([view({ pr_state: 'closed' }).state, view({ pr_state: 'closed' }).action], ['closed', 'none'])
  assert.deepEqual([view({ pr_url: null, status: 'running' }).state, view({ pr_url: null, status: 'running' }).action], ['running', 'none'])
  assert.deepEqual([view({ pr_url: null, status: 'queued' }).state, view({ pr_url: null, status: 'queued' }).action], ['running', 'none'])
  assert.deepEqual([view({ verification_json: null }).state, view({ verification_json: null }).action], ['unverified', 'recheck'])

  const ready = view()
  assert.equal(ready.state, 'ready')
  assert.equal(ready.action, 'merge')
  // A non-maintainer gets the review action, never the merge control.
  assert.equal(view({}, false).state, 'ready')
  assert.equal(view({}, false).action, 'review')

  assert.deepEqual([view({ verification_json: null }).state, view({ verification_json: null }).action], ['unverified', 'recheck'])
  assert.deepEqual([view({ verification_json: verificationJson({ draft: true }) }).state], ['draft'])
  assert.deepEqual([view({ path_guard_json: GUARD_BLOCKED }).state], ['path-guard'])
  assert.deepEqual([view({ verification_json: verificationJson({ checks: { total: 3, green: 1, failing: [], pending: ['ci'] } }) }).state], ['checks-pending'])
  assert.deepEqual([view({ verification_json: verificationJson({ checks: { total: 3, green: 2, failing: ['ci'], pending: [] } }) }).state], ['checks-blocked'])
  assert.deepEqual([view({ verification_json: verificationJson({ reviews: { changesRequested: true, approvals: 0 } }) }).state], ['changes-requested'])
  assert.deepEqual([view({ verification_json: verificationJson({ mergeableState: 'behind' }) }).state], ['base-moved'])
  assert.deepEqual([view({ verification_json: verificationJson({ ok: false, reasons: ['Commit status is failure.'] }) }).state], ['blocked'])

  // A PASS at an older tip is its own state and never offers the merge action.
  const stale = view({}, true, 'b'.repeat(40))
  assert.equal(stale.state, 'stale-pass')
  assert.equal(stale.action, 'recheck')
  assert.match(stale.reasons.join(' '), new RegExp(HEAD.slice(0, 12)))
  assert.match(stale.reasons.join(' '), /b{12}/)
})

test('the job page answers the review/merge state once, with one action before the evidence', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'review-merge-page', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_review_merge', userId: user.id, owner: 'o', name: 'rm', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const job = store.createJob({ id: 'job_review_merge', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob(job.id, { status: 'succeeded', pr_url: 'https://github.com/o/rm/pull/3', pr_state: 'open', verification_json: verificationJson(), path_guard_json: GUARD_OK })
    const ready = jobPage({ config, locale: 'en', viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' }, repo, job: store.getJob(job.id)!, merge: { revision: 1, idempotencyKey: 'k1' } })

    assert.match(ready, /id="review-merge"/)
    assert.match(ready, /Review and merge/)
    assert.equal(ready.split(`/jobs/${job.id}/merge`).length - 1, 1, 'exactly one merge control')
    // The action is in the DOM before the evidence list, so a 360px screen
    // reaches it without scrolling past the evidence.
    assert.ok(ready.indexOf('id="review-merge-actions"') < ready.indexOf('id="review-merge-evidence"'))
    assert.ok(ready.indexOf('id="review-merge-actions"') < ready.indexOf('/jobs/' + job.id + '/merge'))
    assert.match(ready, /Evidence passed/)
    assert.match(ready, new RegExp(`Evidence passed at .{0,40}${HEAD.slice(0, 12)}`))

    // A failing check names the state and never offers the merge control.
    store.updateJob(job.id, { verification_json: verificationJson({ ok: false, checks: { total: 3, green: 2, failing: ['ci'], pending: [] }, reasons: ['Failing checks: ci'] }) })
    const blocked = jobPage({ config, locale: 'en', viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' }, repo, job: store.getJob(job.id)!, merge: { revision: 1, idempotencyKey: 'k2' } })
    assert.match(blocked, /Blocked: failing checks/)
    assert.match(blocked, /Fix findings first/)
    assert.equal(blocked.split(`/jobs/${job.id}/merge`).length - 1, 0)

    // A moved base is its own named state with its own sentence.
    store.updateJob(job.id, { verification_json: verificationJson({ mergeableState: 'behind' }) })
    const moved = jobPage({ config, locale: 'en', viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' }, repo, job: store.getJob(job.id)!, merge: { revision: 1, idempotencyKey: 'k3' } })
    assert.match(moved, /Blocked: base moved/)
    assert.match(moved, /rebase/i)

    // A reviewer without maintainer never gets a merge control from this card.
    const reader = makeUser(store, { login: 'review-merge-reader', status: 'approved' })
    const reviewerRepo = { ...store.getRepo(repo.id)!, repo_role: 'developer' as const }
    store.updateJob(job.id, { verification_json: verificationJson(), path_guard_json: GUARD_OK })
    const readOnly = jobPage({ config, locale: 'en', viewer: { user: store.userById(reader.id)!, csrfToken: 'csrf' }, repo: reviewerRepo, job: store.getJob(job.id)!, merge: { revision: 1, idempotencyKey: 'k4' } })
    assert.equal(readOnly.split(`/jobs/${job.id}/merge`).length - 1, 0)
    assert.match(readOnly, /Review PR/)

    // Both languages render the same card and the same single action.
    const zh = jobPage({ config, locale: 'zh', viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' }, repo, job: store.getJob(job.id)!, merge: { revision: 1, idempotencyKey: 'k5' } })
    assert.match(zh, /审查与合并/)
    assert.match(zh, /证据通过/)
  } finally {
    store.close()
  }
})

test('the repository table links to the card instead of carrying its own merge control', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'review-merge-table', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_review_merge_table', userId: user.id, owner: 'o', name: 'rmt', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const job = store.createJob({ id: 'job_review_merge_table', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob(job.id, { status: 'succeeded', pr_url: 'https://github.com/o/rmt/pull/8', pr_state: 'open', verification_json: verificationJson(), path_guard_json: GUARD_OK })
    const page = repoPage({ config, locale: 'en', viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' }, repo, jobs: [store.getJob(job.id)!], prJobs: [store.getJob(job.id)!] })
    assert.equal(page.split(`/jobs/${job.id}/merge`).length - 1, 0, 'the table must not carry a second merge control')
    assert.match(page, new RegExp(`/repos/${repo.id}/jobs/${job.id}#review-merge`))
  } finally {
    store.close()
  }
})

type FakeMerge = { merges: string[]; headSha: string; mergeableState: string }

async function mergeFixture(over: Partial<FakeMerge> = {}): Promise<{
  jobs: Jobs
  store: Store
  job: JobRow
  repo: ReturnType<Store['createRepo']>
  merges: string[]
  close: () => Promise<void>
}> {
  const state: FakeMerge = { merges: [], headSha: HEAD, mergeableState: 'clean', ...over }
  const github = await startFakeServer((request, response) => {
    const method = request.method ?? 'GET'
    const url = request.url ?? ''
    if (method === 'GET' && url === '/repos/o/r/pulls/1') {
      json(response, 200, { number: 1, html_url: 'https://github.com/o/r/pull/1', title: 'fix', state: 'open', head: { ref: 'fledge/fix', sha: state.headSha }, base: { ref: 'main' }, mergeable: true, mergeable_state: state.mergeableState, draft: false, merged: false })
      return
    }
    if (method === 'GET' && url === `/repos/o/r/commits/${state.headSha}/check-runs?per_page=100`) {
      json(response, 200, { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] })
      return
    }
    if (method === 'GET' && url === `/repos/o/r/commits/${state.headSha}/status`) {
      json(response, 200, { state: 'success', statuses: [] })
      return
    }
    if (method === 'GET' && url === '/repos/o/r/pulls/1/files?per_page=100') {
      json(response, 200, [{ filename: 'README.md' }])
      return
    }
    if (method === 'GET' && url === '/repos/o/r/pulls/1/reviews?per_page=100') {
      json(response, 200, [])
      return
    }
    if (method === 'PUT' && url === '/repos/o/r/pulls/1/merge') {
      state.merges.push(url)
      json(response, 200, { merged: true, sha: 'def' })
      return
    }
    if (method === 'POST' && url === '/repos/o/r/issues/1/comments') {
      json(response, 200, {})
      return
    }
    json(response, 404, { message: 'Not Found' })
  })
  const baseConfig = testConfig()
  const config = testConfig({ github: { ...baseConfig.github, apiBase: github.url } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  const user = makeUser(store, { login: `merge-fixture-${Math.random()}.user`, status: 'approved' })
  const repo = store.createRepo({ id: `repo_merge_fixture_${Math.random().toString(36).slice(2)}`, userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', roleCheckedAt: new Date().toISOString(), upstreamHtmlUrl: 'https://github.com/o/r', forkHtmlUrl: 'https://github.com/o/r', goal: '', autoIterate: false, intervalMinutes: 1440 })
  const job = store.createJob({ id: `job_merge_fixture_${Math.random().toString(36).slice(2)}`, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
  store.updateJob(job.id, { status: 'succeeded', branch: 'fledge/fix', pr_url: 'https://github.com/o/r/pull/1', pr_state: 'open', verification_json: verificationJson(), path_guard_json: GUARD_OK })
  return { jobs, store, job: store.getJob(job.id)!, repo, merges: state.merges, close: async () => { store.close(); await github.close() } }
}

test('a PASS taken at an older tip is refused and explained', async () => {
  const fixture = await mergeFixture({ headSha: 'b'.repeat(40) })
  try {
    const result = await fixture.jobs.manualMerge(fixture.repo, fixture.job)
    assert.equal(result.ok, false)
    assert.match(result.message ?? '', /重新核实/)
    assert.match(result.message ?? '', /a{12}/)
    assert.match(result.message ?? '', /b{12}/)
    // The refusal is readable in the console's own language, with both tips.
    const english = localizeMessage('en', result.message ?? '') ?? ''
    assert.match(english, /stale/i)
    assert.match(english, /re-check/i)
    assert.match(english, /a{12}/)
    assert.equal(fixture.merges.length, 0, 'a stale PASS must never reach the merge call')
  } finally {
    await fixture.close()
  }
})

test('a base that moved after verification is refused and explained', async () => {
  const fixture = await mergeFixture({ headSha: HEAD, mergeableState: 'behind' })
  try {
    const result = await fixture.jobs.manualMerge(fixture.repo, fixture.job)
    assert.equal(result.ok, false)
    assert.match(result.message ?? '', /behind/)
    assert.match(result.message ?? '', /rebase/i)
    assert.equal(fixture.merges.length, 0)
  } finally {
    await fixture.close()
  }
})
