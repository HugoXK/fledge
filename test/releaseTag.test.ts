import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { GithubError } from '../src/repos/github.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { compareVersions, createAnnotatedTag, hasTagTriggeredWorkflow, parseVersion, planRelease, releasePreflight, suggestHigher } from '../src/releases/release.js'
import { formBody, json, makeUser, MemoryMailer, readBody, sessionFor, startFakeServer, testConfig } from './helpers.js'

// A release request is a maintainer-supplied version and a fixed full SHA. These
// tests pin the two properties that keep it from becoming an automatic release
// bot: a version is never guessed, and a refusal happens before any write.

test('a version must be strict SemVer, and the comparison is SemVer precedence', () => {
  assert.deepEqual(parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [], build: '' })
  assert.deepEqual(parseVersion('1.2.3-beta.1+sha.abc'), { major: 1, minor: 2, patch: 3, prerelease: ['beta', '1'], build: 'sha.abc' })
  for (const bad of ['1.2', 'v1', 'release-1.2.3', '1.2.3.4', '1.2.3-', '01.2.3', '']) {
    assert.equal(parseVersion(bad), null, `${bad} is not SemVer`)
  }
  assert.ok(compareVersions('v1.10.0', 'v1.9.9') > 0)
  assert.ok(compareVersions('v1.2.3', 'v1.2.3') === 0)
  assert.ok(compareVersions('v1.2.3-beta.1', 'v1.2.3') < 0, 'a prerelease is lower than its release')
  assert.equal(suggestHigher('v1.2.3'), 'v1.2.4')
  assert.equal(suggestHigher('v1.2.3-beta.1'), 'v1.2.3')
})

const target = 'a'.repeat(40)

function tags(...entries: Array<{ name: string; ahead: number | null }>) {
  return entries.map((entry) => ({ name: entry.name, sha: 'b'.repeat(40), targetCommitsAhead: entry.ahead }))
}

test('nothing to release is refused and names the previous tag', () => {
  const result = planRelease({
    requestedVersion: 'v1.4.0',
    targetSha: target,
    tags: tags({ name: 'v1.3.0', ahead: 0 }),
    tagExists: false,
    releaseWorkflow: true,
    gateOnboarded: true,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'no_new_commits')
  assert.match(result.message, /v1\.3\.0/)
})

test('an equal or lower version is refused with a higher suggestion', () => {
  for (const requestedVersion of ['v1.3.0', 'v1.2.0']) {
    const result = planRelease({
      requestedVersion,
      targetSha: target,
      tags: tags({ name: 'v1.3.0', ahead: 4 }),
      tagExists: false,
      releaseWorkflow: true,
      gateOnboarded: true,
    })
    assert.equal(result.ok, false, requestedVersion)
    assert.equal(result.code, 'not_higher')
    assert.equal(result.suggestion, 'v1.3.1')
  }
})

test('the previous tag is the nearest reachable one by ancestry, not by name or order', () => {
  const result = planRelease({
    requestedVersion: 'v2.0.0',
    targetSha: target,
    // v9.0.0 is listed first and is not an ancestor; v1.4.0 is the reachable one.
    tags: tags({ name: 'v9.0.0', ahead: null }, { name: 'v1.4.0', ahead: 3 }),
    tagExists: false,
    releaseWorkflow: true,
    gateOnboarded: true,
  })
  assert.equal(result.ok, true)
  assert.equal(result.previousTag, 'v1.4.0')
  assert.equal(result.commitsAfter, 3)
})

test('an existing tag is refused before anything is created', () => {
  const result = planRelease({
    requestedVersion: 'v1.5.0',
    targetSha: target,
    tags: tags({ name: 'v1.4.0', ahead: 2 }),
    tagExists: true,
    releaseWorkflow: true,
    gateOnboarded: true,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'tag_exists')
})

test('a repository without a gate or a tag-triggered release workflow is refused with the exact reason', () => {
  const base = { requestedVersion: 'v1.5.0', targetSha: target, tags: tags({ name: 'v1.4.0', ahead: 2 }), tagExists: false }
  const refusal = (result: { ok: boolean }) => (result as { code?: string }).code
  assert.equal(refusal(planRelease({ ...base, releaseWorkflow: false, gateOnboarded: true })), 'missing_release_workflow')
  assert.equal(refusal(planRelease({ ...base, releaseWorkflow: true, gateOnboarded: false })), 'missing_gate')
})

test('a legal release is planned with its version, target and previous tag', () => {
  const result = planRelease({
    requestedVersion: 'v1.5.0-rc.1',
    targetSha: target,
    tags: tags({ name: 'v1.4.0', ahead: 7 }),
    tagExists: false,
    releaseWorkflow: true,
    gateOnboarded: true,
  })
  assert.equal(result.ok, true)
  assert.equal(result.version, 'v1.5.0-rc.1')
  assert.equal(result.tagName, 'v1.5.0-rc.1')
  assert.equal(result.targetSha, target)
  assert.equal(result.prerelease, true)
  assert.equal(result.previousTag, 'v1.4.0')
})

function fakeClient(overrides: Record<string, unknown> = {}) {
  const calls: string[] = []
  const client = {
    calls,
    async createAnnotatedTag(_owner: string, _name: string, input: { tag: string; target: string }) {
      calls.push(`tag:${input.tag}@${input.target}`)
      return { sha: 'c'.repeat(40) }
    },
    async createTagRef(_owner: string, _name: string, input: { ref: string; sha: string }) {
      calls.push(`ref:${input.ref}@${input.sha}`)
      if (overrides.refuse === true) return { ok: false as const, status: 422, message: 'Reference already exists' }
      return { ok: true as const }
    },
    ...overrides,
  }
  return client
}

test('tag creation writes an annotated tag object and then its ref, and a 422 is a refusal', async () => {
  const client = fakeClient()
  const plan = { ok: true as const, tagName: 'v1.5.0', version: 'v1.5.0', targetSha: target, prerelease: false, previousTag: null, commitsAfter: null, message: 'release v1.5.0' }
  const created = await createAnnotatedTag(client as never, { owner: 'acme', name: 'widget', plan })
  assert.equal(created.ok, true)
  assert.equal(created.tagObjectSha, 'c'.repeat(40))
  assert.deepEqual(client.calls, [`tag:v1.5.0@${target}`, `ref:refs/tags/v1.5.0@${'c'.repeat(40)}`])

  const refused = await createAnnotatedTag(fakeClient({ refuse: true }) as never, { owner: 'acme', name: 'widget', plan })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'tag_exists')
})

test('a non-422 ref refusal names only the HTTP status, never the upstream message', async () => {
  const plan = { ok: true as const, tagName: 'v1.5.0', version: 'v1.5.0', targetSha: target, prerelease: false, previousTag: null, commitsAfter: null, message: 'release v1.5.0' }
  const upstream = 'Protected branch update failed for refs/tags/v1.5.0'
  const client = {
    async createAnnotatedTag() { return { sha: 'c'.repeat(40) } },
    async createTagRef() { return { ok: false as const, status: 500, message: upstream } },
  }
  const created = await createAnnotatedTag(client as never, { owner: 'acme', name: 'widget', plan })
  assert.equal(created.ok, false)
  assert.equal((created as { code?: string }).code, 'tag_ref_failed')
  const message = (created as { message: string }).message
  assert.match(message, /tag reference was refused by GitHub \(HTTP 500\); nothing was moved or deleted/)
  assert.doesNotMatch(message, new RegExp(upstream))
})

test('only a tags: entry inside the on: block counts as a tag-triggered workflow', async () => {
  assert.equal(hasTagTriggeredWorkflow('on:\n  push:\n    tags: [\'v*\']\n'), true)
  assert.equal(hasTagTriggeredWorkflow('on: { push: { tags: [\'v*\'] } }\n'), true)
  assert.equal(hasTagTriggeredWorkflow('on:\n  workflow_dispatch:\n  push:\n    branches: [main]\n'), false, 'a branch filter is not a tag trigger')
  assert.equal(hasTagTriggeredWorkflow('jobs:\n  release:\n    with:\n      tags: x\n'), false, 'a tags: outside on: does not trigger')
  // A filter is a direct child of its event key. `workflow_dispatch.inputs.tags`
  // is a field name one level deeper, and reading it as a trigger would write an
  // irreversible tag whose release workflow never runs.
  assert.equal(hasTagTriggeredWorkflow('on:\n  workflow_dispatch:\n    inputs:\n      tags:\n        description: version selector\n'), false, 'workflow_dispatch.inputs.tags is not a tag trigger')
  assert.equal(hasTagTriggeredWorkflow('on: { workflow_dispatch: { inputs: { tags: { description: x } } } }\n'), false, 'the flow form of an input named tags is not a tag trigger')
  // `tags-ignore` is a tag filter too, but it cannot be judged against the
  // version about to be created, so it is not a positive answer.
  assert.equal(hasTagTriggeredWorkflow('on:\n  push:\n    tags-ignore: [\'v*-beta\']\n'), false, 'tags-ignore does not prove the tag will fire the workflow')
  assert.equal(hasTagTriggeredWorkflow('on:\n    push:\n        tags: [\'v*\']\n'), true, 'a four-space block is read at its own depth')
  assert.equal(hasTagTriggeredWorkflow('on:\n  push:\n'), true, 'a bare push has no filter, so a tag push fires it')

  const client = {
    async commitExists() { return true },
    async listTags() { return [{ name: 'v1.0.0', sha: 'b'.repeat(40) }, { name: 'nightly', sha: 'd'.repeat(40) }] },
    async compareCommits() { return { status: 'ahead', aheadBy: 5 } },
    async getRepoFile() { return 'on:\n  push:\n    tags: [\'v*\']\n' },
    async getBranchProtection() { return { protected: true, requiredChecks: ['ci-ok'], requiredApprovals: 1 } },
  }
  const plan = await releasePreflight(client, { owner: 'acme', name: 'widget', defaultBranch: 'main', requestedVersion: 'v1.1.0', targetSha: 'a'.repeat(40) })
  assert.equal(plan.ok, true)
  assert.equal(plan.previousTag, 'v1.0.0')

  const unknownTag = await releasePreflight({ ...client, async listTags() { return [{ name: 'nightly', sha: 'd'.repeat(40) }] } }, { owner: 'acme', name: 'widget', defaultBranch: 'main', requestedVersion: 'v1.1.0', targetSha: 'a'.repeat(40) })
  assert.equal(unknownTag.ok, true, 'a non-SemVer tag is never used as the previous version')
  assert.equal(unknownTag.previousTag, null)
})

test('a target SHA that is not a commit is refused by name, before any tag is written', async () => {
  const client = {
    async commitExists() { return false },
    async listTags() { return [] },
    async compareCommits() { return { status: 'ahead', aheadBy: 1 } },
    async getRepoFile() { return "on:\n  push:\n    tags: ['v*']\n" },
    async getBranchProtection() { return { protected: true, requiredChecks: ['ci-ok'], requiredApprovals: 1 } },
  }
  const plan = await releasePreflight(client, { owner: 'acme', name: 'widget', defaultBranch: 'main', requestedVersion: 'v1.4.0', targetSha: target })
  assert.equal(plan.ok, false)
  assert.equal((plan as { code?: string }).code, 'target_missing')
  assert.match((plan as { message: string }).message, /not a commit/)
})

test('a 422 from the tag-object write is a refusal value, never an exception', async () => {
  const plan = { ok: true as const, tagName: 'v1.5.0', version: 'v1.5.0', targetSha: target, prerelease: false, previousTag: null, commitsAfter: null, message: 'release v1.5.0' }
  const client = {
    async createAnnotatedTag() { throw new GithubError(422, 'Object does not exist') },
    async createTagRef() { throw new Error('the ref must not be attempted when the tag object was refused') },
  }
  const created = await createAnnotatedTag(client as never, { owner: 'acme', name: 'widget', plan })
  assert.equal(created.ok, false)
  assert.equal((created as { code?: string }).code, 'target_missing')
  assert.match((created as { message: string }).message, /not a commit/)
})

// The route is the only surface a maintainer sees. These tests post the form to
// the real app against a fake GitHub API, because the refusal text and the
// suggestion that never reached the page were invisible to a unit test.
const ROUTE_TARGET = 'a'.repeat(40)
const ROUTE_TAG_OBJECT = 'e'.repeat(40)
const ROUTE_WORKFLOW = "on:\n  push:\n    tags: ['v*']\n"

interface ReleaseRouteOptions {
  tags?: Array<{ name: string; sha: string; commit: { sha: string } }>
  tagWriteStatus?: number
  refWriteStatus?: number
  refWriteBody?: unknown
  refWriteRaw?: string
  refWriteContentType?: string
  commitStatus?: number
}

async function releaseRouteHarness(options: ReleaseRouteOptions = {}) {
  const calls: Array<{ method: string; url: string; body: Record<string, unknown> | null }> = []
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
    if (method === 'GET' && url.startsWith('/repos/o/r/commits/')) {
      return json(response, options.commitStatus ?? 200, (options.commitStatus ?? 200) === 200 ? { sha: ROUTE_TARGET } : { message: 'No commit found for SHA' })
    }
    if (method === 'GET' && url.startsWith('/repos/o/r/branches/main/protection')) {
      return json(response, 200, { required_status_checks: { contexts: ['ci-ok'] }, required_pull_request_reviews: { required_approving_review_count: 1 } })
    }
    if (method === 'GET' && url.startsWith('/repos/o/r/contents/.github/workflows/release.yml')) {
      return json(response, 200, { content: Buffer.from(ROUTE_WORKFLOW).toString('base64') })
    }
    if (method === 'GET' && url.startsWith('/repos/o/r/tags')) return json(response, 200, options.tags ?? [])
    if (method === 'GET' && url.startsWith('/repos/o/r/compare/')) return json(response, 200, { status: 'ahead', ahead_by: 3 })
    if (method === 'POST' && url === '/repos/o/r/git/tags') {
      const status = options.tagWriteStatus ?? 201
      return json(response, status, status === 201 ? { sha: ROUTE_TAG_OBJECT } : { message: 'Object does not exist' })
    }
    if (method === 'POST' && url === '/repos/o/r/git/refs') {
      const status = options.refWriteStatus ?? 201
      if (status === 201) return json(response, 201, { ref: 'refs/tags/v1.4.0' })
      if (options.refWriteRaw !== undefined) {
        response.writeHead(status, { 'content-type': options.refWriteContentType ?? 'text/plain' })
        response.end(options.refWriteRaw)
        return
      }
      return json(response, status, options.refWriteBody ?? { message: 'Reference already exists' })
    }
    return json(response, 404, { message: 'Not Found' })
  })
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: server.url } })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  const user = makeUser(store, { login: 'release-route-user', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_release_route',
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
  const post = (values: Record<string, string | number | undefined> = {}) => built.app.inject({
    method: 'POST',
    url: `/repos/${repo.id}/release`,
    headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: formBody({ csrf: session.csrf, version: 'v1.4.0', sha: ROUTE_TARGET, confirm: '1', ...values }),
  })
  return {
    built,
    store,
    repo,
    session,
    calls,
    post,
    page: async (location: string) => built.app.inject({ method: 'GET', url: location, headers: { cookie: session.cookie } }),
    close: async () => { await built.close(); await server.close() },
  }
}

test('a refusal reaches the page with a marker, the reason and the next legal version', async () => {
  const h = await releaseRouteHarness({ tags: [{ name: 'v1.5.0', sha: 'b'.repeat(40), commit: { sha: 'b'.repeat(40) } }] })
  try {
    // A marker in the query is the only honest proof that the page rendered the
    // outcome: prose assertions pass against the static copy in the card, which
    // is how an empty refusal shipped green before.
    const marker = 'REFUSAL-MARKER-9e7c'
    const direct = await h.page(`/repos/${h.repo.id}?release=1&refused=${encodeURIComponent(marker)}`)
    assert.equal(direct.statusCode, 200)
    assert.match(direct.body, /id="release-refused"/)
    assert.match(direct.body, new RegExp(marker))
    assert.match(direct.body, /没有打标签/)
    assert.match(direct.body, /No tag was created/)
    assert.doesNotMatch(direct.body, /id="release-tagged"/)

    const posted = await h.post()
    assert.equal(posted.statusCode, 302)
    const location = String(posted.headers.location)
    assert.match(location, /refused=/)
    assert.doesNotMatch(location, /tagged=/)
    assert.match(decodeURIComponent(location), /v1\.5\.1/, 'the refusal names the next legal version')
    assert.equal(h.store.listReleasesForRepo(h.repo.id).length, 0, 'a refusal writes no release row')

    const page = await h.page(location)
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /v1\.5\.1/, 'the suggestion reaches the returned HTML')
    assert.match(page.body, /is not higher than v1\.5\.0/, 'the reason reaches the returned HTML')
  } finally {
    await h.close()
  }
})

test('a 422 from the tag write is a rendered refusal and not a crash page', async () => {
  const h = await releaseRouteHarness({ tagWriteStatus: 422 })
  try {
    const posted = await h.post()
    assert.equal(posted.statusCode, 302, 'an unhandled 422 used to be a 500')
    const location = String(posted.headers.location)
    assert.match(location, /refused=/)
    assert.equal(h.store.listReleasesForRepo(h.repo.id).length, 0)
    assert.equal(h.calls.filter((call) => call.method === 'POST').length, 1, 'only the refused tag object write was attempted')

    const page = await h.page(location)
    assert.match(page.body, /id="release-refused"/)
    assert.match(page.body, /is not a commit in this repository/)
    assert.doesNotMatch(page.body, /id="release-tagged"/)
  } finally {
    await h.close()
  }
})

test('a successful tag is confirmed on the page and the ref points at the tag object', async () => {
  const h = await releaseRouteHarness()
  try {
    const posted = await h.post()
    assert.equal(posted.statusCode, 302)
    const location = String(posted.headers.location)
    assert.match(location, /tagged=v1\.4\.0/)

    const writes = h.calls.filter((call) => call.method === 'POST')
    assert.deepEqual(writes.map((call) => call.url), ['/repos/o/r/git/tags', '/repos/o/r/git/refs'])
    assert.equal(writes[1]?.body?.sha, ROUTE_TAG_OBJECT, 'refs/tags points at the annotated tag object, not the commit')
    assert.equal(writes[1]?.body?.ref, 'refs/tags/v1.4.0')

    const releases = h.store.listReleasesForRepo(h.repo.id)
    assert.equal(releases.length, 1)
    assert.equal(releases[0]?.tag_object_sha, ROUTE_TAG_OBJECT)

    const marker = 'TAGGED-MARKER-9e7c'
    const direct = await h.page(`/repos/${h.repo.id}?release=1&tagged=${encodeURIComponent(marker)}`)
    assert.match(direct.body, /id="release-tagged"/)
    assert.match(direct.body, new RegExp(marker))
    assert.match(direct.body, /已创建标签/)
    assert.match(direct.body, /Created tag/)
    assert.doesNotMatch(direct.body, /id="release-refused"/)

    // Following the real redirect confirms the tag that was created.
    const followed = await h.page(location)
    assert.match(followed.body, /id="release-tagged">[\s\S]{0,200}v1\.4\.0/, 'the success banner names the tag')
  } finally {
    await h.close()
  }
})

test('a re-tag updates the recorded row and is confirmed as an existing tag, not a refusal', async () => {
  const h = await releaseRouteHarness()
  try {
    const OLD_TARGET = 'b'.repeat(40)
    const OLD_TAG_OBJECT = 'd'.repeat(40)
    const oldAt = '2026-01-02T03:04:05.000Z'
    h.store.recordRelease({ repoId: h.repo.id, userId: h.repo.user_id, version: 'v1.4.0', tagName: 'v1.4.0', targetSha: OLD_TARGET, tagObjectSha: OLD_TAG_OBJECT, previousTag: null, actor: 'release-route-user' })
    h.store.run('UPDATE repo_releases SET created_at = ?, updated_at = ? WHERE repo_id = ? AND tag_name = ?', oldAt, oldAt, h.repo.id, 'v1.4.0')
    h.store.audit(h.repo.user_id, 'release.tagged', `${h.repo.id}: v1.4.0@${OLD_TARGET}`)

    const posted = await h.post()
    assert.equal(posted.statusCode, 302)
    const location = String(posted.headers.location)
    assert.match(location, /tagged=v1\.4\.0/)
    assert.doesNotMatch(location, /refused=/)
    assert.match(decodeURIComponent(location), /retagged=1/, 'the page distinguishes a re-tag from a created tag')

    const releases = h.store.listReleasesForRepo(h.repo.id)
    assert.equal(releases.length, 1, 'a re-tag keeps exactly one row for the tag name')
    const row = releases[0]!
    assert.equal(row.tag_name, 'v1.4.0')
    assert.equal(row.target_sha, ROUTE_TARGET)
    assert.equal(row.tag_object_sha, ROUTE_TAG_OBJECT)
    assert.equal(row.status, 'tagged')
    assert.ok(row.updated_at > oldAt, 'the row is updated after the one it replaces')
    assert.equal(row.created_at, oldAt, 'the original row is updated, not replaced')

    const page = await h.page(location)
    assert.equal(page.statusCode, 200)
    assert.doesNotMatch(page.body, /No tag was created/)
    assert.doesNotMatch(page.body, /没有打标签/)
    assert.match(page.body, /id="release-retagged"/)
    assert.match(page.body, /already existed/i)
    assert.match(page.body, /updated/i)
    assert.match(page.body, new RegExp(ROUTE_TARGET.slice(0, 12)), 'the page shows where the re-tag now points')
    assert.doesNotMatch(page.body, /id="release-refused"/)

    const audits = h.store.listAudit().filter((entry) => entry.action === 'release.tagged')
    assert.equal(audits.length, 2, 'the earlier audit row stays and the re-tag adds one')
    assert.ok(audits.some((entry) => entry.detail?.includes(OLD_TARGET)), 'the earlier release.tagged row is kept')
    assert.ok(audits.some((entry) => entry.detail?.includes(ROUTE_TARGET)), 'the new audit row names the new SHA')
  } finally {
    await h.close()
  }
})

test('a 500 from the ref write names the HTTP status and never quotes the upstream body', async () => {
  const upstream = 'Protected branch update failed for refs/tags/v1.4.0'
  const h = await releaseRouteHarness({ refWriteStatus: 500, refWriteBody: { message: upstream } })
  try {
    const posted = await h.post()
    assert.equal(posted.statusCode, 302)
    const location = decodeURIComponent(String(posted.headers.location))
    assert.match(location, /refused=/)
    assert.match(location, /tag reference was refused by GitHub \(HTTP 500\)/)
    assert.doesNotMatch(location, new RegExp(upstream))
    assert.equal(h.store.listReleasesForRepo(h.repo.id).length, 0, 'a refused ref writes no release row')

    const page = await h.page(String(posted.headers.location))
    assert.match(page.body, /tag reference was refused by GitHub \(HTTP 500\)/)
    assert.doesNotMatch(page.body, new RegExp(upstream))
  } finally {
    await h.close()
  }
})

test('a non-JSON 403 from the ref write still produces the fixed sentence and no body excerpt', async () => {
  const upstream = 'PROXY-BODY-9e7c-must-not-render'
  const h = await releaseRouteHarness({ refWriteStatus: 403, refWriteRaw: `<html><body>${upstream}</body></html>`, refWriteContentType: 'text/html' })
  try {
    const posted = await h.post()
    assert.equal(posted.statusCode, 302)
    const location = decodeURIComponent(String(posted.headers.location))
    assert.match(location, /tag reference was refused by GitHub \(HTTP 403\)/)
    assert.doesNotMatch(location, new RegExp(upstream))

    const page = await h.page(String(posted.headers.location))
    assert.match(page.body, /tag reference was refused by GitHub \(HTTP 403\)/)
    assert.doesNotMatch(page.body, new RegExp(upstream))
  } finally {
    await h.close()
  }
})

test('a 422 from the ref write stays the tag_exists sentence, not the fixed ref refusal', async () => {
  const h = await releaseRouteHarness({ refWriteStatus: 422 })
  try {
    const posted = await h.post()
    assert.equal(posted.statusCode, 302)
    const location = decodeURIComponent(String(posted.headers.location))
    assert.match(location, /tag v1\.4\.0 already exists; nothing was moved or deleted/)
    assert.doesNotMatch(location, /tag reference was refused by GitHub/)
    assert.equal(h.store.listReleasesForRepo(h.repo.id).length, 0)
  } finally {
    await h.close()
  }
})
