import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { planRelease, releaseRefusals } from '../src/releases/release.js'
import { flashOf, formBody, json, makeUser, readBody, sessionFor, startFakeServer, testConfig } from './helpers.js'

// #546 slice 2: the tag action behind the readiness page. The page is a
// prediction and the tag route is the authority, so the write path re-reads the
// default branch immediately before it writes and refuses when the head moved.
// A tag is never moved or deleted: a stale target costs a version, not a retry.
//
// Slice boundary: this route creates the annotated tag and nothing else. No
// Release object, no draft notes — those are slice 3.

const HEAD = 'a'.repeat(40)
const MOVED = 'b'.repeat(40)
const TAG_SHA = 'c'.repeat(40)
const TAG_DATE = '2026-11-01T00:00:00Z'
const TAG_OBJECT = 'e'.repeat(40)

interface HarnessOptions {
  headNow?: string
  tags?: Array<{ name: string; sha: string; commit: { sha: string } }>
  protection?: boolean
  refStatus?: number
}

async function harness(options: HarnessOptions = {}) {
  const calls: Array<{ method: string; url: string; body: string }> = []
  const server = await startFakeServer(async (request, response) => {
    const method = request.method ?? 'GET'
    const url = request.url ?? ''
    const body = (await readBody(request)).toString('utf8')
    calls.push({ method, url, body })
    if (method === 'GET' && url.startsWith('/repos/o/r/branches/main/protection')) {
      return options.protection === false
        ? json(response, 404, { message: 'Branch not protected' })
        : json(response, 200, { required_status_checks: { contexts: ['ci-ok'] }, required_pull_request_reviews: { required_approving_review_count: 1 } })
    }
    if (method === 'GET' && url.startsWith('/repos/o/r/branches/main')) {
      return json(response, 200, { name: 'main', commit: { sha: options.headNow ?? HEAD } })
    }
    if (method === 'GET' && url.startsWith('/repos/o/r/contents/changelog.d')) {
      return json(response, 200, [])
    }
    if (method === 'GET' && url.startsWith('/repos/o/r/contents/.github/workflows/release.yml')) {
      return json(response, 200, { content: Buffer.from("on:\n  push:\n    tags: ['v*']\n").toString('base64') })
    }
    if (method === 'GET' && url.startsWith('/repos/o/r/tags')) {
      return json(response, 200, options.tags ?? [{ name: 'v1.3.0', sha: TAG_SHA, commit: { sha: TAG_SHA } }])
    }
    if (method === 'GET' && url.startsWith('/repos/o/r/compare/')) {
      return json(response, 200, { status: 'ahead', ahead_by: 3 })
    }
    if (method === 'GET' && url.startsWith('/repos/o/r/commits/')) {
      return json(response, 200, { sha: TAG_SHA, commit: { committer: { date: TAG_DATE } } })
    }
    if (method === 'GET' && url.startsWith('/repos/o/r/pulls?')) {
      return json(response, 200, [])
    }
    if (method === 'POST' && url === '/repos/o/r/git/tags') {
      return json(response, 201, { sha: TAG_OBJECT })
    }
    if (method === 'POST' && url === '/repos/o/r/git/refs') {
      const status = options.refStatus ?? 201
      return status === 201
        ? json(response, 201, { ref: 'refs/tags/v1.4.0' })
        : json(response, status, { message: 'Resource not accessible by integration' })
    }
    if (method === 'POST' && url === '/repos/o/r/releases') {
      return json(response, 201, { id: 99, draft: true })
    }
    return json(response, 404, { message: 'Not Found' })
  })
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: server.url } })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: undefined, runner: new MockRunner(), startScheduler: false })
  const user = makeUser(store, { login: 'tag-page-user', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_tag_page',
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
  const page = (location: string, cookie?: string) => built.app.inject({ method: 'GET', url: location, headers: { cookie: cookie === undefined ? session.cookie : `${session.cookie}; ${cookie}`, 'accept-language': 'en' } })
  const submit = (values: Record<string, string> = {}) => built.app.inject({
    method: 'POST',
    url: `/repos/${repo.id}/release-readiness/tag`,
    headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: formBody({ csrf: session.csrf, version: 'v1.4.0', head: HEAD, confirm: '1', ...values }),
  })
  const writes = () => calls.filter((call) => call.method === 'POST')
  return { built, store, repo, session, calls, writes, page, submit, close: async () => { await built.close(); await server.close() } }
}

test('the readiness page offers the tag form with the head it showed, and a blocked repository offers none', async () => {
  const ready = await harness()
  try {
    const response = await ready.page(`/repos/${ready.repo.id}/release-readiness`)
    assert.equal(response.statusCode, 200)
    assert.match(response.body, new RegExp(`action="/repos/${ready.repo.id}/release-readiness/tag"`), 'the ready page has no tag action')
    assert.match(response.body, new RegExp(`name="head" value="${HEAD}"`), 'the form does not carry the head the page showed')
    assert.match(response.body, /name="csrf" value="[^"]+"/, 'the form has no CSRF field')
  } finally {
    await ready.close()
  }
  const blocked = await harness({ protection: false })
  try {
    const response = await blocked.page(`/repos/${blocked.repo.id}/release-readiness`)
    assert.equal(response.statusCode, 200)
    assert.match(response.body, /data-readiness-blocker/)
    assert.doesNotMatch(response.body, /release-readiness\/tag" method="post"/i, 'a blocked repository still offers the tag form')
  } finally {
    await blocked.close()
  }
})

test('a branch that moved after the page was read is refused, names both SHAs, and writes nothing', async () => {
  const h = await harness({ headNow: MOVED })
  try {
    const response = await h.submit()
    assert.equal(response.statusCode, 302)
    const flash = flashOf(response)
    assert.ok(flash?.error !== undefined, 'the refusal was not delivered as one flash message')
    const message = flash.error.text
    assert.match(message, /moved/, `the refusal does not name a moved branch: ${message}`)
    assert.ok(message.includes(HEAD), `the refusal does not name the SHA the page showed: ${message}`)
    assert.ok(message.includes(MOVED), `the refusal does not name the current head: ${message}`)
    // Parity with the shared table: an inlined copy of the sentence would drift
    // from the one the table exports, so the route must produce that exact string.
    assert.equal(message, releaseRefusals.branchMoved(HEAD, MOVED))
    assert.deepEqual(h.writes(), [], 'a refused tag still wrote to GitHub')
    assert.equal(h.store.releaseByTag(h.repo.id, 'v1.4.0'), undefined, 'a refused tag recorded a release row')
  } finally {
    await h.close()
  }
})

test('a head that still matches creates the annotated tag and no Release', async () => {
  const h = await harness()
  try {
    const response = await h.submit()
    assert.equal(response.statusCode, 302)
    const flash = flashOf(response)
    assert.ok(flash?.notice !== undefined, 'the created tag was not reported as one notice')
    assert.match(flash.notice.text, /v1\.4\.0/)
    const tagWrite = h.writes().find((call) => call.url === '/repos/o/r/git/tags')
    assert.ok(tagWrite !== undefined, 'the tag object was never written')
    assert.ok(tagWrite.body.includes(HEAD), `the tag object does not target the head the page showed: ${tagWrite.body}`)
    assert.ok(h.writes().some((call) => call.url === '/repos/o/r/git/refs'), 'the tag ref was never written')
    assert.equal(h.writes().some((call) => call.url === '/repos/o/r/releases'), false, 'slice 2 must not create a Release')
    assert.equal(h.calls.some((call) => call.url.startsWith('/repos/o/r/actions/runs')), false, 'slice 2 must not track or prepare a release run')
    assert.ok(h.store.releaseByTag(h.repo.id, 'v1.4.0') !== undefined, 'the created tag was not recorded')
  } finally {
    await h.close()
  }
})

test('a refused ref write names the permission it needs and moves nothing', async () => {
  for (const status of [403, 404]) {
    const h = await harness({ refStatus: status })
    try {
      const response = await h.submit()
      assert.equal(response.statusCode, 302)
      const flash = flashOf(response)
      assert.ok(flash?.error !== undefined, 'the refused write was not reported as one message')
      assert.match(flash.error.text, /Contents: write/, `the refusal does not name the permission: ${flash.error.text}`)
      assert.match(flash.error.text, new RegExp(`HTTP ${status}`))
      assert.equal(flash.error.text, releaseRefusals.tagScopeMissing(status))
      assert.equal(h.store.releaseByTag(h.repo.id, 'v1.4.0'), undefined, 'a refused write recorded a release row')
    } finally {
      await h.close()
    }
  }
})

test('a 404 does not claim a missing permission it cannot prove', async () => {
  const h = await harness({ refStatus: 404 })
  try {
    const response = await h.submit()
    const message = flashOf(response)?.error?.text ?? ''
    // The App being removed from a repository is also a 404; the sentence names
    // both possibilities instead of asserting the one it cannot see.
    assert.match(message, /cannot see this repository/)
    assert.match(message, /still installed/)
  } finally {
    await h.close()
  }
})

test('an existing tag is refused in the plan words, before any write', async () => {
  const h = await harness({ tags: [{ name: 'v1.4.0', sha: TAG_SHA, commit: { sha: TAG_SHA } }] })
  try {
    const expected = planRelease({ requestedVersion: 'v1.4.0', targetSha: HEAD, tags: [{ name: 'v1.4.0', sha: TAG_SHA, targetCommitsAhead: 3 }], tagExists: true, releaseWorkflow: true, gateOnboarded: true })
    assert.equal(expected.ok, false)
    const response = await h.submit()
    assert.equal(response.statusCode, 302)
    const flash = flashOf(response)
    assert.ok(flash?.error !== undefined)
    assert.ok(flash.error.text.includes((expected as { message: string }).message), `the page does not carry the plan's refusal: ${flash.error.text}`)
    assert.deepEqual(h.writes(), [], 'an existing tag still reached a GitHub write')
  } finally {
    await h.close()
  }
})
