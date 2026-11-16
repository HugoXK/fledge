import test from 'node:test'
import assert from 'node:assert/strict'
import { countCommitKinds, latestTagOf, previewRelease, previewAndDispatch } from '../src/lib/releaseDispatch.js'
import type { ReleaseDispatchOptions } from '../src/lib/releaseDispatch.js'

const MAIN = 'a'.repeat(40)
const TAG_SHA = 'b'.repeat(40)
const base64 = (value: string): string => Buffer.from(value).toString('base64')

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function fakeFetch(overrides: { ci?: string; pulls?: unknown[]; fragments?: number } = {}): { fetch: typeof globalThis.fetch; calls: Array<{ url: string; method: string; body: string }> } {
  const calls: Array<{ url: string; method: string; body: string }> = []
  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    calls.push({ url, method: String(init?.method ?? 'GET'), body: String(init?.body ?? '') })
    if (url.endsWith('/repos/o/r/commits/main')) return json({ sha: MAIN, commit: { committer: { date: '2026-11-16T07:00:00Z' } } })
    if (url.endsWith('/repos/o/r/git/matching-refs/tags/v')) return json([{ ref: 'refs/tags/v0.4.0' }])
    if (url.endsWith('/repos/o/r/commits/v0.4.0')) return json({ sha: TAG_SHA, commit: { committer: { date: '2026-11-16T01:20:00Z' } } })
    if (url.includes('/repos/o/r/compare/v0.4.0...')) {
      const messages = [
        'fix(a): one (#1)',
        'fix(b): two (#2)',
        'fix(c): three (#3)',
        'fix(d): four (#4)',
        'fix(e): five (#5)',
        'fix(f): six (#6)',
        'feat(a): one (#7)',
        'feat(b): two (#8)',
        'feat(c): three (#9)',
        'feat(d): four (#10)',
        'feat(e): five (#11)',
        'docs: one (#12)',
      ]
      return json({ total_commits: messages.length, commits: messages.map((message) => ({ commit: { message } })) })
    }
    if (url.includes('/repos/o/r/contents/package.json')) return json({ encoding: 'base64', content: base64(JSON.stringify({ version: '0.4.0' })) })
    if (url.includes('/repos/o/r/contents/changelog.d')) {
      const count = overrides.fragments ?? 2
      return json(Array.from({ length: count }, (_, index) => ({ name: `f${index}.fixed.md`, type: 'file' })).concat([{ name: 'README.md', type: 'file' }]))
    }
    if (url.includes('/repos/o/r/commits/') && url.includes('/check-runs')) {
      return json({ check_runs: [{ id: 3, name: 'ci-ok', status: 'completed', conclusion: overrides.ci ?? 'success' }] })
    }
    if (url.includes('/repos/o/r/pulls?state=open')) return json(overrides.pulls ?? [])
    if (url.includes('/repos/o/r/git/ref/heads/release/v0.4.1')) return new Response('', { status: 404 })
    if (url.includes('/repos/o/r/actions/workflows/daily-release.yml/dispatches')) return new Response('', { status: 202 })
    throw new Error(`unexpected fetch ${url}`)
  }
  return { fetch: fetcher as typeof globalThis.fetch, calls }
}

function options(fetch: typeof globalThis.fetch): ReleaseDispatchOptions {
  return {
    fetch,
    token: 'test-token',
    repo: 'o/r',
    workflow: 'daily-release.yml',
    ref: 'main',
    now: Date.parse('2026-11-16T07:30:00Z'),
  }
}

test('counts conventional commit kinds and picks the highest semver tag', () => {
  assert.deepEqual(countCommitKinds(['fix: a', 'feat(x): b', 'docs: c']), { fixes: 1, features: 1, others: 1 })
  assert.equal(latestTagOf(['v0.9.0', 'v0.10.0', 'not-a-tag', 'v0.3.9']), 'v0.10.0')
})

test('preview reads the current state and is eligible when the rule is met', async () => {
  const fake = fakeFetch()
  const preview = await previewRelease(options(fake.fetch))
  assert.equal(preview.mainSha, MAIN)
  assert.equal(preview.latestTag, 'v0.4.0')
  assert.equal(preview.nextVersion, '0.4.1')
  assert.equal(preview.aheadCommits, 12)
  assert.equal(preview.fixes, 6)
  assert.equal(preview.features, 5)
  assert.equal(preview.fragments, 2)
  assert.equal(preview.ciOk, 'success')
  assert.equal(preview.openReleasePr, null)
  assert.equal(preview.eligible, true)
  assert.equal(preview.reason, '')
})

test('preview names the real blocker when a release is not eligible', async () => {
  const fake = fakeFetch({ ci: 'failure' })
  const preview = await previewRelease(options(fake.fetch))
  assert.equal(preview.eligible, false)
  assert.match(preview.reason, /ci-ok-failure/)
})

test('a release PR, missing fragments or an existing tag each block the action', async () => {
  const open = fakeFetch({ pulls: [{ number: 9, title: 'release: v0.4.1', html_url: 'https://github.com/o/r/pull/9', head: { sha: 'c'.repeat(40), ref: 'release/v0.4.1' } }] })
  assert.match((await previewRelease(options(open.fetch))).reason, /open-release-pr/)
  const empty = fakeFetch({ fragments: 0 })
  assert.match((await previewRelease(options(empty.fetch))).reason, /no-fragments/)
})

test('previewAndDispatch posts dry_run=false only after a fresh eligible preview', async () => {
  const fake = fakeFetch()
  const { preview, result } = await previewAndDispatch(options(fake.fetch))
  assert.equal(preview.nextVersion, '0.4.1')
  assert.equal(result.ok, true)
  const dispatch = fake.calls.find((call) => call.url.includes('/actions/workflows/daily-release.yml/dispatches'))
  assert.ok(dispatch, 'the dispatch request was made')
  assert.equal(dispatch?.method, 'POST')
  assert.deepEqual(JSON.parse(dispatch?.body ?? '{}'), { ref: 'main', inputs: { dry_run: 'false' } })
})

test('previewAndDispatch refuses before writing when the preview is not eligible', async () => {
  const fake = fakeFetch({ ci: 'failure' })
  await assert.rejects(previewAndDispatch(options(fake.fetch)), /release preview refused/)
  assert.equal(fake.calls.some((call) => call.method === 'POST' && call.url.includes('/dispatches')), false)
})
