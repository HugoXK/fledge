import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import type { Runner } from '../src/jobs/runner.js'
import { checkPathGuard, matchesPath, splitPathPatterns } from '../src/lib/pathGuard.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { GithubClient } from '../src/repos/github.js'
import { jobPage } from '../src/views/pages.js'
import { localizeNotification } from '../src/i18n.js'
import { json, makeUser, MemoryMailer, startFakeServer, testConfig } from './helpers.js'

test('path patterns split on commas and newlines and match prefixes', () => {
  assert.deepEqual(splitPathPatterns('src/, docs/*.md\n.github/'), ['src/', 'docs/*.md', '.github/'])
  assert.equal(matchesPath('src/app.ts', 'src/'), true)
  assert.equal(matchesPath('src/app.ts', 'src'), true)
  assert.equal(matchesPath('docs/guide.md', 'docs/*.md'), true)
  assert.equal(matchesPath('docs/guide.md', 'docs/*.txt'), false)
  assert.equal(matchesPath('deploy/x.yml', 'deploy/'), true)
})

test('deny wins and allow is enforced when present', () => {
  const denied = checkPathGuard(['src/a.ts', '.github/workflows/ci.yml'], 'src/', '.github/')
  assert.equal(denied.ok, false)
  assert.deepEqual(denied.violations, [{ file: '.github/workflows/ci.yml', reason: 'denied' }])

  const notAllowed = checkPathGuard(['src/a.ts', 'README.md'], 'src/', '')
  assert.equal(notAllowed.ok, false)
  assert.deepEqual(notAllowed.violations, [{ file: 'README.md', reason: 'not_allowed' }])

  const open = checkPathGuard(['anything/at/all.ts'], '', '')
  assert.equal(open.ok, true)
  assert.deepEqual(open.violations, [])
})

test('the file list reports itself incomplete when the page cap cuts it off', async () => {
  const github = await startFakeServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake')
    if (url.pathname === '/repos/o/r/pulls/9/files') {
      const page = Number(url.searchParams.get('page') ?? '1')
      return json(response, 200, Array.from({ length: 100 }, (_, index) => ({ filename: `page-${page}/file-${index}.ts`, status: 'modified', additions: 1, deletions: 0 })))
    }
    return json(response, 404, { message: 'Not Found' })
  })
  try {
    const client = new GithubClient('token', github.url)
    const capped = await client.listPullRequestFiles('o', 'r', 9, 1000, 2)
    assert.equal(capped.files.length, 200, 'the client stops at the page cap')
    assert.equal(capped.complete, false, 'a list cut by the page cap is not complete')
    const finished = await client.listPullRequestFiles('o', 'r', 9, 200, 2)
    assert.equal(finished.files.length, 200)
    assert.equal(finished.complete, true, 'a list that reached the reported count is complete')
  } finally {
    await github.close()
  }
})

test('a change list longer than the fetch cap is never reported as within the allowed paths', async () => {
  const pageFiles = (page: number) => {
    if (page <= 10) return Array.from({ length: 100 }, (_, index) => ({ filename: `src/allowed/page-${page}/file-${index}.ts`, status: 'modified', additions: 1, deletions: 0 }))
    if (page === 11) {
      return [
        ...Array.from({ length: 99 }, (_, index) => ({ filename: `src/allowed/page-11/file-${index}.ts`, status: 'modified', additions: 1, deletions: 0 })),
        { filename: 'src/secret.ts', status: 'added', additions: 1, deletions: 0 },
      ]
    }
    return []
  }
  const github = await startFakeServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake')
    if (url.pathname === '/repos/o/r/pulls/9/files') return json(response, 200, pageFiles(Number(url.searchParams.get('page') ?? '1')))
    if (url.pathname === '/repos/o/r/pulls/9/reviews') return json(response, 200, [])
    if (url.pathname === '/repos/o/r/commits/sha9/check-runs') return json(response, 200, { check_runs: [{ name: 'ci-ok', status: 'completed', conclusion: 'success' }] })
    if (url.pathname === '/repos/o/r/commits/sha9/status') return json(response, 200, { state: 'success', statuses: [] })
    if (url.pathname === '/repos/o/r/pulls/9') {
      return json(response, 200, { number: 9, html_url: 'https://github.com/o/r/pull/9', title: 'a large change', state: 'open', head: { ref: 'fledge/big', sha: 'sha9' }, base: { ref: 'main' }, mergeable: true, mergeable_state: 'clean', draft: false, merged: false, changed_files: 1100 })
    }
    return json(response, 404, { message: 'Not Found' })
  })
  const config = testConfig({ github: { ...testConfig().github, apiBase: github.url } })
  const store = new Store(':memory:')
  const runner: Runner = { name: 'noop', async run() { return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'path-guard-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_path_guard_big', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', roleCheckedAt: new Date().toISOString(), upstreamHtmlUrl: 'https://github.com', goal: '', autoIterate: false, intervalMinutes: 1440, denyPaths: 'src/secret.ts' })
    const job = store.createJob({ id: 'job_path_guard_big', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob(job.id, { status: 'succeeded', branch: 'fledge/big', pr_url: 'https://github.com/o/r/pull/9' })
    const result = await jobs.recheck(job.id)
    const guard = JSON.parse(store.getJob(job.id)?.path_guard_json ?? '{}') as { ok?: boolean; checkedFiles?: number; reportedFiles?: number; violations?: Array<{ file: string }> }
    assert.equal(guard.ok, false, 'a denied file beyond the first 1,000 entries must block the merge')
    assert.equal(guard.checkedFiles, 1100)
    assert.equal(guard.reportedFiles, 1100)
    assert.deepEqual(guard.violations?.map((violation) => violation.file), ['src/secret.ts'])
    assert.equal(result.ok, false)
    const page = jobPage({ config, locale: 'en', viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' }, repo, job: store.getJob(job.id)! })
    assert.doesNotMatch(page, /All changed files are within the allowed paths/)
    assert.match(page, /src\/secret\.ts/)
  } finally {
    store.close()
    await github.close()
  }
})

test('a list that hits the hard cap is refused and the page shows examined-versus-reported', () => {
  const truncated = checkPathGuard(['src/a.ts'], '', '', '2026-01-01T00:00:00.000Z', 1100)
  assert.equal(truncated.ok, false, 'an incomplete list is never ok')
  assert.equal(truncated.truncated, true)
  assert.equal(truncated.checkedFiles, 1)
  assert.equal(truncated.reportedFiles, 1100)
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'path-guard-page', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_path_guard_page', userId: user.id, owner: 'o', name: 'pg', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const job = store.createJob({ id: 'job_path_guard_page', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    store.updateJob(job.id, { path_guard_json: JSON.stringify(truncated) })
    const page = jobPage({ config, locale: 'en', viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' }, repo, job: store.getJob(job.id)! })
    assert.doesNotMatch(page, /All changed files are within the allowed paths/)
    assert.match(page, /Checked 1 \/ 1,100 reported files/)
  } finally {
    store.close()
  }
})

test('an incomplete change list is announced as a truncation, not as a protected path', async () => {
  const github = await startFakeServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake')
    if (url.pathname === '/repos/o/r/pulls/9/files') {
      const page = Number(url.searchParams.get('page') ?? '1')
      if (page > 31) return json(response, 200, [])
      return json(response, 200, Array.from({ length: 100 }, (_, index) => ({ filename: `src/f/page-${page}/file-${index}.ts`, status: 'modified', additions: 1, deletions: 0 })))
    }
    if (url.pathname === '/repos/o/r/pulls/9/reviews') return json(response, 200, [])
    if (url.pathname === '/repos/o/r/commits/sha9/check-runs') return json(response, 200, { check_runs: [{ name: 'ci-ok', status: 'completed', conclusion: 'success' }] })
    if (url.pathname === '/repos/o/r/commits/sha9/status') return json(response, 200, { state: 'success', statuses: [] })
    if (url.pathname === '/repos/o/r/pulls/9') {
      return json(response, 200, { number: 9, html_url: 'https://github.com/o/r/pull/9', title: 'a huge change', state: 'open', head: { ref: 'fledge/huge', sha: 'sha9' }, base: { ref: 'main' }, mergeable: true, mergeable_state: 'clean', draft: false, merged: false, changed_files: 3100 })
    }
    return json(response, 404, { message: 'Not Found' })
  })
  const config = testConfig({ github: { ...testConfig().github, apiBase: github.url } })
  const store = new Store(':memory:')
  const runner: Runner = { name: 'noop', async run() { return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'path-guard-notify', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_path_guard_notify', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', roleCheckedAt: new Date().toISOString(), upstreamHtmlUrl: 'https://github.com', goal: '', autoIterate: false, intervalMinutes: 1440, denyPaths: 'src/secret.ts' })
    const job = store.createJob({ id: 'job_path_guard_notify', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob(job.id, { status: 'succeeded', branch: 'fledge/huge', pr_url: 'https://github.com/o/r/pull/9' })
    const result = await jobs.recheck(job.id)
    assert.equal(result.ok, false, 'a list the client could not finish must refuse the change')
    const message = store.listNotifications(user.id)[0]?.message ?? ''
    assert.match(message, /不完整/, `the notification names the truncation: ${message}`)
    assert.doesNotMatch(message, /改动了受保护路径/, `the notification must not accuse a protected path: ${message}`)
    assert.match(localizeNotification('en', message), /incomplete/i, 'the English render carries the truncation too')
  } finally {
    store.close()
    await github.close()
  }
})

test('a capped list with no reported count is refused, not cleared', async () => {
  const github = await startFakeServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake')
    if (url.pathname === '/repos/o/r/pulls/9/files') {
      const page = Number(url.searchParams.get('page') ?? '1')
      return json(response, 200, Array.from({ length: 100 }, (_, index) => ({ filename: `src/f/page-${page}/file-${index}.ts`, status: 'modified', additions: 1, deletions: 0 })))
    }
    if (url.pathname === '/repos/o/r/pulls/9/reviews') return json(response, 200, [])
    if (url.pathname === '/repos/o/r/commits/sha9/check-runs') return json(response, 200, { check_runs: [{ name: 'ci-ok', status: 'completed', conclusion: 'success' }] })
    if (url.pathname === '/repos/o/r/commits/sha9/status') return json(response, 200, { state: 'success', statuses: [] })
    if (url.pathname === '/repos/o/r/pulls/9') {
      // No changed_files: GitHub did not report a count, so the client's own
      // `complete` flag is the only evidence about the list.
      return json(response, 200, { number: 9, html_url: 'https://github.com/o/r/pull/9', title: 'a huge change', state: 'open', head: { ref: 'fledge/huge', sha: 'sha9' }, base: { ref: 'main' }, mergeable: true, mergeable_state: 'clean', draft: false, merged: false })
    }
    return json(response, 404, { message: 'Not Found' })
  })
  const config = testConfig({ github: { ...testConfig().github, apiBase: github.url } })
  const store = new Store(':memory:')
  const runner: Runner = { name: 'noop', async run() { return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'path-guard-unknown', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_path_guard_unknown', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', roleCheckedAt: new Date().toISOString(), upstreamHtmlUrl: 'https://github.com', goal: '', autoIterate: false, intervalMinutes: 1440, denyPaths: 'src/secret.ts' })
    const job = store.createJob({ id: 'job_path_guard_unknown', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob(job.id, { status: 'succeeded', branch: 'fledge/huge', pr_url: 'https://github.com/o/r/pull/9' })
    const result = await jobs.recheck(job.id)
    const guard = JSON.parse(store.getJob(job.id)?.path_guard_json ?? '{}') as { ok?: boolean; truncated?: boolean; checkedFiles?: number }
    assert.equal(guard.checkedFiles, 3000, 'the client stops at its page cap')
    assert.equal(guard.truncated, true, 'an unfinished list is a truncation even when the PR reports no count')
    assert.equal(guard.ok, false, 'an unfinished list is never an all-clear')
    assert.equal(result.ok, false)
  } finally {
    store.close()
    await github.close()
  }
})
