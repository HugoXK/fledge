import test from 'node:test'
import assert from 'node:assert/strict'
import { plan } from '../scripts/lib/release-tag.mjs'
import type { ReleaseTagPr } from '../scripts/lib/release-tag.mjs'

const SHA = '9d13c1f5a3b6e8d2c40f7a1b5e9d3c6a8f2b4d70'
const OTHER = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d'

function releasePr(overrides: Partial<ReleaseTagPr> = {}): ReleaseTagPr {
  return {
    number: 186,
    title: 'release: v0.4.0',
    merged_at: '2026-11-10T03:00:00Z',
    merge_commit_sha: SHA,
    head: { ref: 'release/v0.4.0' },
    ...overrides,
  }
}

test('the squash of a merged mechanical release is the one commit that is tagged', () => {
  const result = plan({ pulls: [releasePr()], tags: ['v0.3.0'], packageVersion: '0.4.0', sha: SHA })
  assert.deepEqual(result, {
    tag: 'v0.4.0',
    sha: SHA,
    action: 'create',
    reason: result.reason,
  })
  assert.match(result.reason, /#186/)
})

test('an unrelated push is skipped with its reason, not tagged on a guess', () => {
  const unrelated = releasePr({ title: 'fix: something else', merged_at: '2026-11-10T03:00:00Z' })
  const result = plan({ pulls: [unrelated], tags: ['v0.3.0'], packageVersion: '0.4.0', sha: SHA })
  assert.equal(result.action, 'skip')
  assert.equal(result.tag, 'v0.4.0', 'the version is readable, so the refusal names it')
  assert.match(result.reason, /no merged pull request/)
})

test('a version that cannot be read from the commit is refused', () => {
  for (const version of ['', '0.4', 'v0.4.0', 'next']) {
    const result = plan({ pulls: [releasePr()], tags: [], packageVersion: version, sha: SHA })
    assert.equal(result.action, 'skip', version)
    assert.equal(result.tag, null)
    assert.match(result.reason, /no readable version/)
  }
})

test('an existing tag is never recreated', () => {
  const result = plan({ pulls: [releasePr()], tags: ['v0.3.0', 'v0.4.0'], packageVersion: '0.4.0', sha: SHA })
  assert.equal(result.action, 'skip')
  assert.equal(result.tag, 'v0.4.0')
  assert.match(result.reason, /already exists/)
})

test('a short or unreadable sha is refused, never resolved', () => {
  for (const sha of ['', '9d13c1f', SHA.slice(0, 7), 'HEAD']) {
    const result = plan({ pulls: [releasePr()], tags: [], packageVersion: '0.4.0', sha })
    assert.equal(result.action, 'skip', sha)
    assert.match(result.reason, /40-character sha/)
  }
})

test('the tagged commit must be the squash of the release pull request', () => {
  const elsewhere = plan({ pulls: [releasePr({ merge_commit_sha: OTHER })], tags: [], packageVersion: '0.4.0', sha: SHA })
  assert.equal(elsewhere.action, 'skip')
  assert.match(elsewhere.reason, /not the squash commit/)

  const noSha = plan({ pulls: [releasePr({ merge_commit_sha: null })], tags: [], packageVersion: '0.4.0', sha: SHA })
  assert.equal(noSha.action, 'skip')
  assert.match(noSha.reason, /no merge commit sha/)
})

test('the release pull request must come from release/v<version>', () => {
  for (const ref of [null, 'feat/something', 'release/v0.5.0']) {
    const result = plan({ pulls: [releasePr({ head: { ref } })], tags: [], packageVersion: '0.4.0', sha: SHA })
    assert.equal(result.action, 'skip', String(ref))
    assert.match(result.reason, /release\/v0\.4\.0/)
  }
})

test('an unmerged pull request with the release title is not a release', () => {
  const result = plan({ pulls: [releasePr({ merged_at: null })], tags: [], packageVersion: '0.4.0', sha: SHA })
  assert.equal(result.action, 'skip')
  assert.match(result.reason, /not merged/)
})

test('two claims on the same version are refused rather than picked between', () => {
  const result = plan({
    pulls: [releasePr(), releasePr({ number: 999 })],
    tags: [],
    packageVersion: '0.4.0',
    sha: SHA,
  })
  assert.equal(result.action, 'skip')
  assert.match(result.reason, /not choosing one/)
})

test('a missing or non-array pulls payload never reads as a release', () => {
  for (const pulls of [undefined, null, {}, 'merged']) {
    const result = plan({ pulls: pulls as never, tags: [], packageVersion: '0.4.0', sha: SHA })
    assert.equal(result.action, 'skip', String(pulls))
  }
})
