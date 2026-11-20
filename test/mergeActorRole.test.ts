import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import type { BuiltApp } from '../src/app.js'
import { Store } from '../src/db.js'
import type { JobRow, RepoRow, UserRow } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import type { Runner } from '../src/jobs/runner.js'
import { encryptSecret, sha256Hex } from '../src/lib/secrets.js'
import { formBody, json, makeTerminalJob, makeUser, MemoryMailer, sessionFor, startFakeServer, testConfig } from './helpers.js'

// #1132: who may press merge is the actor's role, not the connection's
// `repo_role`. An invited developer on a maintainer connection could merge (one
// PR or ten at once), and the owner of a `developer`/NULL connection was refused
// a merge their upstream accepts. These cases pin both directions on both human
// entries; the automatic path keeps the connection's role and is a control.
//
// At the pin cases 1, 2, 3, 7 and 8 fail; 4, 5, 6 and 9 must pass before and
// after the fix.

const SHA_TIP = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const SHA_OLD = '00112233445566778899aabbccddeeff00112233'
const PR_URL = 'https://github.example/o/r/pull/9'

const VERIFICATION = JSON.stringify({
  ok: true,
  checkedAt: '2026-11-16T09:00:00.000Z',
  sha: SHA_TIP,
  prState: 'open',
  draft: false,
  mergeableState: 'clean',
  checks: { total: 2, green: 2, failing: [], pending: [] },
  combinedStatus: 'success',
  reviews: { changesRequested: false, approvals: 1 },
  testEvidence: { state: 'verified', claimed: true, greenChecks: ['tests'], failingChecks: [] },
  reasons: [],
})
const GUARD_OK = JSON.stringify({ ok: true, checkedFiles: 0, reportedFiles: 0, files: [], violations: [], allow: [], deny: [], truncated: false })

interface Fake {
  url: string
  merges: string[]
  requests: string[]
  close: () => Promise<void>
}

async function fakeGithub(): Promise<Fake> {
  const merges: string[] = []
  const requests: string[] = []
  const server = await startFakeServer((request, response) => {
    const method = request.method ?? 'GET'
    const url = request.url ?? ''
    requests.push(`${method} ${url}`)
    const pull = '/repos/o/r/pulls/9'
    if (method === 'GET' && url === pull) {
      json(response, 200, {
        number: 9,
        html_url: PR_URL,
        title: 'fix',
        state: 'open',
        head: { ref: 'fledge/fix', sha: SHA_TIP },
        base: { ref: 'main' },
        mergeable: true,
        mergeable_state: 'clean',
        draft: false,
        merged: false,
      })
      return
    }
    if (method === 'GET' && url === `/repos/o/r/commits/${SHA_TIP}/check-runs?per_page=100`) {
      json(response, 200, { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] })
      return
    }
    if (method === 'GET' && url === `/repos/o/r/commits/${SHA_TIP}/status`) {
      json(response, 200, { state: 'success', statuses: [] })
      return
    }
    if (method === 'GET' && url === `${pull}/reviews?per_page=100`) {
      json(response, 200, [])
      return
    }
    if (method === 'GET' && url === `${pull}/files?per_page=100&page=1`) {
      json(response, 200, [{ filename: 'src/app.ts', status: 'modified', additions: 3, deletions: 1 }])
      return
    }
    if (method === 'GET' && url === '/repos/o/r/branches/main/protection') {
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

interface Fixture {
  built: BuiltApp
  store: Store
  owner: UserRow
  member: UserRow
  repo: RepoRow
  job: JobRow
  github: Fake
  close: () => Promise<void>
}

async function fixture(options: {
  connectionRole: 'maintainer' | 'developer' | null
  memberRole?: 'developer' | 'viewer'
  slug: string
  jobs?: Array<{ id: string; status: 'succeeded' | 'failed'; prUrl: string }>
}): Promise<Fixture> {
  const github = await fakeGithub()
  const store = new Store(':memory:')
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: github.url } })
  const owner = makeUser(store, { login: `${options.slug}-owner`, status: 'approved' })
  const member = makeUser(store, { login: `${options.slug}-member`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_${options.slug}`,
    userId: owner.id,
    owner: 'o',
    name: 'r',
    defaultBranch: 'main',
    tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey),
    permission: 'admin',
    repoRole: options.connectionRole,
    roleCheckedAt: new Date().toISOString(),
    autoMerge: true,
    requireProtection: true,
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
    upstreamHtmlUrl: 'https://github.example/o/r',
    forkHtmlUrl: 'https://github.example/o/r',
  })
  if (options.memberRole !== undefined) {
    store.addRepoMember({ repoId: repo.id, userId: member.id, role: options.memberRole, grantedBy: owner.id })
  }
  const job = makeTerminalJob(store, {
    id: `job_${options.slug}`,
    repoId: repo.id,
    userId: owner.id,
    trigger: 'manual',
    goal: 'g',
    callbackHash: sha256Hex(`cb-${options.slug}`),
    platformTokenHash: '',
    kind: 'iterate',
    baseBranch: 'main',
    baseSha: SHA_OLD,
  })
  store.updateJob(job.id, {
    status: 'succeeded',
    branch: 'fledge/fix',
    pr_url: PR_URL,
    verification_json: VERIFICATION,
    path_guard_json: GUARD_OK,
  })
  for (const entry of options.jobs ?? []) {
    const extra = store.createJob({
      id: entry.id,
      repoId: repo.id,
      userId: owner.id,
      trigger: 'manual',
      goal: 'g',
      callbackHash: sha256Hex(`cb-${entry.id}`),
      platformTokenHash: '',
      kind: 'iterate',
      baseBranch: 'main',
      baseSha: SHA_OLD,
    })
    store.updateJob(extra.id, { status: entry.status, branch: 'fledge/fix', pr_url: entry.prUrl })
  }
  const runner: Runner = new MockRunner()
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner, startScheduler: false })
  return {
    built,
    store,
    owner,
    member,
    repo,
    job: store.getJob(job.id)!,
    github,
    close: async () => { await built.close(); await github.close() },
  }
}

function auditOf(store: Store, action: string): Array<{ action: string }> {
  return store.all<{ action: string }>('SELECT action FROM audit_log WHERE action = ?', action)
}

async function getPage(s: Fixture, user: UserRow, url: string): Promise<string> {
  const { cookie } = sessionFor(s.built, user)
  const response = await s.built.app.inject({ method: 'GET', url, headers: { cookie: `${cookie}; fledge_lang=en` } })
  assert.equal(response.statusCode, 200, `${url} must render for ${user.login}`)
  return response.body
}

async function postForm(s: Fixture, user: UserRow, url: string): Promise<{ statusCode: number; location: string }> {
  const { cookie, csrf } = sessionFor(s.built, user)
  const response = await s.built.app.inject({
    method: 'POST',
    url,
    headers: { cookie: `${cookie}; fledge_lang=en`, 'content-type': 'application/x-www-form-urlencoded' },
    payload: formBody({ csrf }),
  })
  return { statusCode: response.statusCode, location: String(response.headers.location ?? '') }
}

test('case 1: an invited developer sees no single-merge control and their POST merges nothing', async () => {
  const s = await fixture({ connectionRole: 'maintainer', memberRole: 'developer', slug: 'single-over' })
  try {
    const page = await getPage(s, s.member, `/repos/${s.repo.id}/jobs/${s.job.id}`)
    assert.doesNotMatch(page, /\/jobs\/[^"]*\/merge"/, 'a developer member must not see the merge form')
    assert.match(page, /data-merge-reason="not-maintainer"/, 'the card must say why the control is absent')
    assert.match(page, /Only a maintainer can merge; your role is developer\./)
    const posted = await postForm(s, s.member, `/repos/${s.repo.id}/jobs/${s.job.id}/merge`)
    assert.equal(posted.statusCode, 302)
    assert.equal(s.github.merges.length, 0, 'a developer member must never reach the merge call')
    assert.equal(auditOf(s.store, 'job.manually_merged').length, 0)
    assert.equal(auditOf(s.store, 'job.merged').length, 0)
  } finally {
    await s.close()
  }
})

test('case 2: the owner of a developer connection sees the single-merge control and merges', async () => {
  const s = await fixture({ connectionRole: 'developer', slug: 'single-under' })
  try {
    const page = await getPage(s, s.owner, `/repos/${s.repo.id}/jobs/${s.job.id}`)
    assert.match(page, new RegExp(`/repos/${s.repo.id}/jobs/${s.job.id}/merge"`), 'the owner must see the merge form')
    assert.doesNotMatch(page, /data-merge-reason="not-maintainer"/)
    const posted = await postForm(s, s.owner, `/repos/${s.repo.id}/jobs/${s.job.id}/merge`)
    assert.equal(posted.statusCode, 302)
    assert.equal(s.github.merges.length, 1, 'the owner pressed merge on a connection they own')
    assert.equal(auditOf(s.store, 'job.manually_merged').length, 1)
  } finally {
    await s.close()
  }
})

test('case 3: the owner of a NULL connection sees the single-merge control and merges', async () => {
  const s = await fixture({ connectionRole: null, slug: 'single-null' })
  try {
    const page = await getPage(s, s.owner, `/repos/${s.repo.id}/jobs/${s.job.id}`)
    assert.match(page, new RegExp(`/repos/${s.repo.id}/jobs/${s.job.id}/merge"`), 'a never-chosen role must not refuse the owner')
    const posted = await postForm(s, s.owner, `/repos/${s.repo.id}/jobs/${s.job.id}/merge`)
    assert.equal(posted.statusCode, 302)
    assert.equal(s.github.merges.length, 1)
  } finally {
    await s.close()
  }
})

test('case 4: the owner of a maintainer connection still merges', async () => {
  const s = await fixture({ connectionRole: 'maintainer', slug: 'single-keep' })
  try {
    const page = await getPage(s, s.owner, `/repos/${s.repo.id}/jobs/${s.job.id}`)
    assert.match(page, new RegExp(`/repos/${s.repo.id}/jobs/${s.job.id}/merge"`))
    await postForm(s, s.owner, `/repos/${s.repo.id}/jobs/${s.job.id}/merge`)
    assert.equal(s.github.merges.length, 1)
  } finally {
    await s.close()
  }
})

test('case 5: the automatic path keeps the connection role', async () => {
  const s = await fixture({ connectionRole: 'developer', slug: 'auto-keep' })
  try {
    const jobs = s.built.jobs as unknown as {
      tryMerge: (job: JobRow, prUrl: string, manual: boolean) => Promise<{ ok: boolean; message?: string }>
    }
    const result = await jobs.tryMerge(s.job, PR_URL, false)
    assert.equal(result.ok, false)
    assert.equal(result.message, '只有 maintainer 可以合并。')
    assert.equal(s.github.merges.length, 0)
  } finally {
    await s.close()
  }
})

test('case 6: a viewer member is still refused, with the route sentence', async () => {
  const s = await fixture({ connectionRole: 'maintainer', memberRole: 'viewer', slug: 'single-viewer' })
  try {
    const { cookie, csrf } = sessionFor(s.built, s.member)
    const response = await s.built.app.inject({
      method: 'POST',
      url: `/repos/${s.repo.id}/jobs/${s.job.id}/merge`,
      headers: { cookie: `${cookie}; fledge_lang=en`, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf }),
    })
    assert.equal(response.statusCode, 403)
    assert.match(response.body, /A read-only member cannot change this repository\./)
    assert.equal(s.github.merges.length, 0)
  } finally {
    await s.close()
  }
})

test('case 7: an invited developer sees no bulk-merge control and their POST merges nothing', async () => {
  const s = await fixture({ connectionRole: 'maintainer', memberRole: 'developer', slug: 'bulk-over' })
  try {
    const page = await getPage(s, s.member, `/repos/${s.repo.id}`)
    assert.doesNotMatch(page, new RegExp(`action="/repos/${s.repo.id}/delivery/merge-clean"`), 'a developer member must not see the bulk form')
    assert.match(page, /data-bulk-merge="not-maintainer"/, 'the bulk control needs a reason hook')
    assert.match(page, /Only a maintainer can merge clean pull requests\./)
    const posted = await postForm(s, s.member, `/repos/${s.repo.id}/delivery/merge-clean`)
    assert.equal(posted.statusCode, 302)
    assert.equal(s.github.merges.length, 0, 'a developer member must never merge the clean set')
    assert.equal(auditOf(s.store, 'delivery.merge_clean').length, 0)
  } finally {
    await s.close()
  }
})

test('case 8: the owner of a developer connection sees the bulk control and merges the clean set', async () => {
  const s = await fixture({ connectionRole: 'developer', slug: 'bulk-under' })
  try {
    const page = await getPage(s, s.owner, `/repos/${s.repo.id}`)
    assert.match(page, new RegExp(`action="/repos/${s.repo.id}/delivery/merge-clean"`), 'the owner must see the bulk form')
    assert.doesNotMatch(page, /data-bulk-merge="not-maintainer"/)
    const posted = await postForm(s, s.owner, `/repos/${s.repo.id}/delivery/merge-clean`)
    assert.equal(posted.statusCode, 302)
    assert.equal(s.github.merges.length, 1)
    assert.equal(auditOf(s.store, 'delivery.merge_clean').length, 1)
  } finally {
    await s.close()
  }
})

test('case 9: the bulk loop still refuses a viewer and still skips a non-succeeded job', async () => {
  const viewer = await fixture({ connectionRole: 'maintainer', memberRole: 'viewer', slug: 'bulk-viewer' })
  try {
    const { cookie, csrf } = sessionFor(viewer.built, viewer.member)
    const response = await viewer.built.app.inject({
      method: 'POST',
      url: `/repos/${viewer.repo.id}/delivery/merge-clean`,
      headers: { cookie: `${cookie}; fledge_lang=en`, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf }),
    })
    assert.equal(response.statusCode, 403)
    assert.match(response.body, /A read-only member cannot change this repository\./)
    assert.equal(viewer.github.merges.length, 0)
  } finally {
    await viewer.close()
  }

  const stale = await fixture({
    connectionRole: 'maintainer',
    slug: 'bulk-stale',
    jobs: [{ id: 'job_bulk_stale_failed', status: 'failed', prUrl: 'https://github.example/o/r/pull/10' }],
  })
  try {
    const result = await stale.built.jobs.mergeCleanPrs(stale.repo.id)
    assert.ok(!result.merged.includes('job_bulk_stale_failed'), 'a failed job must never be merged')
    assert.ok(result.skipped.some((entry) => entry.jobId === 'job_bulk_stale_failed' && entry.reason === 'job-state'))
    assert.deepEqual(stale.github.merges, ["/repos/o/r/pulls/9/merge"], 'only the succeeded job merges')
  } finally {
    await stale.close()
  }
})
