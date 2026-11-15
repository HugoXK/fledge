import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { planRelease } from '../src/releases/release.js'
import { featureReason, readReleaseReadiness, releaseReadiness } from '../src/releases/readiness.js'
import { json, makeUser, readBody, sessionFor, startFakeServer, testConfig } from './helpers.js'

// #546 slice 1: the read-only release-readiness answer. A maintainer should be
// able to ask "is there anything to release here, and if not, why" without
// submitting a version and a SHA first. The page reads; it never writes.

const HEAD = 'a'.repeat(40)
const TAG_SHA = 'c'.repeat(40)
const TAG_DATE = '2026-11-01T00:00:00Z'

function pull(number: number, title: string, labels: string[], mergedAt: string) {
  return { number, title, url: `https://github.com/o/r/pull/${number}`, labels, mergedAt }
}

const facts = {
  defaultBranch: 'main',
  headSha: HEAD,
  latestTag: { name: 'v1.3.0', sha: TAG_SHA, committedAt: TAG_DATE },
  commitsSince: 7,
  mergedSince: [
    pull(11, 'feat: add the release readiness card', [], '2026-11-04T00:00:00Z'),
    pull(12, 'fix: keep the dialog closed', [], '2026-11-03T00:00:00Z'),
    pull(13, 'Give the settings card an operator disclosure', ['enhancement'], '2026-11-02T00:00:00Z'),
    pull(14, 'fix(gate): name the refusal', ['bug'], '2026-11-02T00:00:00Z'),
  ],
  mergedSinceComplete: true,
  fragments: ['500-readiness.fixed.md', '501-dialog.added.md'],
  gateOnboarded: true,
  releaseWorkflow: true,
}

test('a feature is a labelled enhancement, else a feat title prefix, and neither is guessed', () => {
  assert.equal(featureReason({ title: 'feat: add the card', labels: [] }), 'title')
  assert.equal(featureReason({ title: 'feat(views): add the card', labels: [] }), 'title')
  assert.equal(featureReason({ title: 'Give the card a disclosure', labels: ['enhancement'] }), 'label')
  assert.equal(featureReason({ title: 'Give the card a disclosure', labels: ['Feature'] }), 'label')
  assert.equal(featureReason({ title: 'fix: close the dialog', labels: ['bug'] }), null)
  assert.equal(featureReason({ title: 'chore: bump deps', labels: [] }), null)
})

test('the readiness answer counts commits, merged pull requests, features and fragments', () => {
  const view = releaseReadiness(facts)
  assert.equal(view.ready, true)
  assert.equal(view.refusal, null)
  assert.deepEqual(view.latestTag, facts.latestTag)
  assert.equal(view.commitsSince, 7)
  assert.equal(view.mergedPrs, 4)
  assert.equal(view.featurePrs, 2)
  assert.equal(view.changelogFragment, true)
  assert.deepEqual(view.fragments, ['500-readiness.fixed.md', '501-dialog.added.md'])
})

test('a repository with no tag is releasable, and says there is no tag rather than zero commits', () => {
  const view = releaseReadiness({ ...facts, latestTag: null, commitsSince: null, mergedSince: [], fragments: [] })
  assert.equal(view.ready, true)
  assert.equal(view.latestTag, null)
  assert.equal(view.commitsSince, null)
  assert.equal(view.mergedPrs, 0)
  assert.equal(view.featurePrs, 0)
  assert.equal(view.changelogFragment, false)
})

// The page and the tag route must not be able to disagree about why a release
// would not go ahead. Each blocker is asserted to be the same string planRelease
// returns for the same facts, not a retyped copy.
test('every blocker is the same string the release route refuses with', () => {
  const base = { requestedVersion: 'v1.4.0', targetSha: HEAD, tagExists: false }
  const gate = planRelease({ ...base, tags: [], releaseWorkflow: true, gateOnboarded: false })
  const workflow = planRelease({ ...base, tags: [], releaseWorkflow: false, gateOnboarded: true })
  const nothing = planRelease({ ...base, tags: [{ name: 'v1.3.0', sha: TAG_SHA, targetCommitsAhead: 0 }], releaseWorkflow: true, gateOnboarded: true })
  assert.equal(gate.ok, false)
  assert.equal(workflow.ok, false)
  assert.equal(nothing.ok, false)

  const noGate = releaseReadiness({ ...facts, gateOnboarded: false })
  const noWorkflow = releaseReadiness({ ...facts, releaseWorkflow: false })
  const noCommits = releaseReadiness({ ...facts, commitsSince: 0 })

  assert.equal(noGate.ready, false)
  assert.equal(noGate.refusal?.code, 'missing_gate')
  assert.equal(noGate.refusal?.message, (gate as { message: string }).message)
  assert.equal(noWorkflow.refusal?.code, 'missing_release_workflow')
  assert.equal(noWorkflow.refusal?.message, (workflow as { message: string }).message)
  assert.equal(noCommits.refusal?.code, 'no_new_commits')
  assert.equal(noCommits.refusal?.message, (nothing as { message: string }).message)
})

// The probe budget is bounded, so running out of it is "no answer", never the
// claim that a repository has no previous tag.
test('an undetermined previous tag is no answer, not a first release', async () => {
  const tags = Array.from({ length: 12 }, (_, index) => ({ name: `v1.${index}.0`, sha: 'd'.repeat(40) }))
  const client = {
    async getBranch() { return { name: 'main', sha: HEAD } },
    async listTags() { return tags },
    async compareCommits() { return { status: 'diverged', aheadBy: 0 } },
  }
  const view = await readReleaseReadiness(client as never, { owner: 'o', name: 'r', defaultBranch: 'main' })
  assert.equal(view, null)
})

test('an incomplete merged-pull-request read is reported as incomplete, never as a smaller count', () => {
  const view = releaseReadiness({ ...facts, mergedSinceComplete: false })
  assert.equal(view.mergedPrsComplete, false)
})

// The route is what a maintainer sees. It is rendered against a fake GitHub API
// because the fields the page prints are the whole slice.
interface ReadinessOptions {
  tags?: Array<{ name: string; sha: string; commit: { sha: string } }>
  protection?: boolean
  workflow?: string | null
  aheadBy?: number
  pulls?: Array<Record<string, unknown>>
  headFiles?: Array<Record<string, unknown>>
  tagFiles?: Array<Record<string, unknown>>
}

async function readinessHarness(options: ReadinessOptions = {}) {
  const calls: Array<{ method: string; url: string }> = []
  const server = await startFakeServer(async (request, response) => {
    const method = request.method ?? 'GET'
    const url = request.url ?? ''
    await readBody(request)
    calls.push({ method, url })
    if (method === 'GET' && url.startsWith('/repos/o/r/branches/main/protection')) {
      return options.protection === false
        ? json(response, 404, { message: 'Branch not protected' })
        : json(response, 200, { required_status_checks: { contexts: ['ci-ok'] }, required_pull_request_reviews: { required_approving_review_count: 1 } })
    }
    if (method === 'GET' && url.startsWith('/repos/o/r/branches/main')) {
      return json(response, 200, { name: 'main', commit: { sha: HEAD } })
    }
    if (method === 'GET' && url.startsWith('/repos/o/r/contents/changelog.d')) {
      const atHead = url.includes(`ref=${HEAD}`)
      return json(response, 200, atHead ? (options.headFiles ?? []) : (options.tagFiles ?? []))
    }
    if (method === 'GET' && url.startsWith('/repos/o/r/contents/.github/workflows/release.yml')) {
      const text = options.workflow === undefined ? "on:\n  push:\n    tags: ['v*']\n" : options.workflow
      return text === null ? json(response, 404, { message: 'Not Found' }) : json(response, 200, { content: Buffer.from(text).toString('base64') })
    }
    if (method === 'GET' && url.startsWith('/repos/o/r/tags')) {
      return json(response, 200, options.tags ?? [{ name: 'v1.3.0', sha: TAG_SHA, commit: { sha: TAG_SHA } }])
    }
    if (method === 'GET' && url.startsWith('/repos/o/r/compare/')) {
      return json(response, 200, { status: 'ahead', ahead_by: options.aheadBy ?? 7 })
    }
    if (method === 'GET' && url.startsWith(`/repos/o/r/commits/`)) {
      return json(response, 200, { sha: TAG_SHA, commit: { committer: { date: TAG_DATE } } })
    }
    if (method === 'GET' && url.startsWith('/repos/o/r/pulls?')) {
      return json(response, 200, options.pulls ?? [])
    }
    return json(response, 404, { message: 'Not Found' })
  })
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: server.url } })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: undefined, runner: new MockRunner(), startScheduler: false })
  const user = makeUser(store, { login: 'readiness-user', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_readiness',
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
  const page = (location: string) => built.app.inject({ method: 'GET', url: location, headers: { cookie: session.cookie, 'accept-language': 'en' } })
  return { built, store, repo, session, calls, page, close: async () => { await built.close(); await server.close() } }
}

test('the repository page offers the readiness view', async () => {
  const h = await readinessHarness()
  try {
    const response = await h.page(`/repos/${h.repo.id}?release=1`)
    assert.equal(response.statusCode, 200)
    assert.match(response.body, new RegExp(`href="/repos/${h.repo.id}/release-readiness"`))
  } finally {
    await h.close()
  }
})

test('the readiness page names the tag, the commits, the merged pull requests, the features and the fragments', async () => {
  const h = await readinessHarness({
    pulls: [
      { number: 11, title: 'feat: add the readiness card', html_url: 'https://github.com/o/r/pull/11', labels: [], merged_at: '2026-11-04T00:00:00Z' },
      { number: 12, title: 'fix: keep the dialog closed', html_url: 'https://github.com/o/r/pull/12', labels: [], merged_at: '2026-11-03T00:00:00Z' },
      { number: 13, title: 'Give the settings card a disclosure', html_url: 'https://github.com/o/r/pull/13', labels: [{ name: 'enhancement' }], merged_at: '2026-11-02T00:00:00Z' },
      { number: 9, title: 'fix: before the tag', html_url: 'https://github.com/o/r/pull/9', labels: [], merged_at: '2026-10-01T00:00:00Z' },
    ],
    headFiles: [
      { name: '500-readiness.fixed.md', type: 'file', path: 'changelog.d/500-readiness.fixed.md', sha: '1'.repeat(40) },
      { name: '501-dialog.added.md', type: 'file', path: 'changelog.d/501-dialog.added.md', sha: '2'.repeat(40) },
      { name: '400-old.fixed.md', type: 'file', path: 'changelog.d/400-old.fixed.md', sha: '3'.repeat(40) },
    ],
    tagFiles: [
      { name: '400-old.fixed.md', type: 'file', path: 'changelog.d/400-old.fixed.md', sha: '3'.repeat(40) },
    ],
  })
  try {
    const response = await h.page(`/repos/${h.repo.id}/release-readiness`)
    assert.equal(response.statusCode, 200)
    const body = response.body
    assert.match(body, /data-release-readiness/, 'the card is not on the page')
    assert.match(body, /v1\.3\.0/)
    assert.match(body, /7 commits since v1\.3\.0/, 'the commit count is not on the page')
    assert.match(body, /3 pull requests merged since v1\.3\.0, 2 of them features/, 'the merged count is not on the page')
    assert.match(body, /500-readiness\.fixed\.md/)
    assert.match(body, /501-dialog\.added\.md/)
    assert.doesNotMatch(body, /400-old\.fixed\.md/, 'a fragment from before the tag was counted')
    assert.match(body, /data-readiness-ready/, 'a releasable repository was not marked ready')
    // Read-only: the page must not have written anything to GitHub.
    const writes = h.calls.filter((call) => call.method !== 'GET')
    assert.deepEqual(writes, [], 'the readiness page issued a write')
  } finally {
    await h.close()
  }
})

test('a repository that would be refused shows the same words the release route refuses with', async () => {
  const h = await readinessHarness({ protection: false })
  try {
    const response = await h.page(`/repos/${h.repo.id}/release-readiness`)
    assert.equal(response.statusCode, 200)
    const expected = planRelease({ requestedVersion: 'v1.4.0', targetSha: HEAD, tags: [], tagExists: false, releaseWorkflow: true, gateOnboarded: false })
    assert.equal(expected.ok, false)
    const message = (expected as { message: string }).message
    assert.ok(response.body.includes(message), `the page does not carry the refusal verbatim: ${message}`)
    assert.match(response.body, /data-readiness-blocker/)
    assert.doesNotMatch(response.body, /data-readiness-ready/)
  } finally {
    await h.close()
  }
})

test('nothing to release is a refusal, not a ready page', async () => {
  const h = await readinessHarness({ aheadBy: 0 })
  try {
    const response = await h.page(`/repos/${h.repo.id}/release-readiness`)
    assert.equal(response.statusCode, 200)
    const expected = planRelease({ requestedVersion: 'v1.4.0', targetSha: HEAD, tags: [{ name: 'v1.3.0', sha: TAG_SHA, targetCommitsAhead: 0 }], tagExists: false, releaseWorkflow: true, gateOnboarded: true })
    assert.equal(expected.ok, false)
    assert.ok(response.body.includes((expected as { message: string }).message))
    assert.doesNotMatch(response.body, /data-readiness-ready/)
  } finally {
    await h.close()
  }
})
