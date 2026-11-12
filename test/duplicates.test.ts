import test from 'node:test'
import assert from 'node:assert/strict'
import { duplicateOutcome, findDuplicatePullRequest, issueNumberFromText } from '../src/lib/duplicates.js'

function pull(number: number, fields: { title?: string; body?: string; head?: string } = {}) {
  return {
    number,
    url: `https://github.com/o/dup/pull/${number}`,
    title: fields.title ?? '',
    body: fields.body ?? '',
    head: fields.head ?? `fledge/pull-${number}`,
    base: 'main',
  }
}

test('issue references are read from the goal text', () => {
  assert.equal(issueNumberFromText('Fix https://github.com/o/r/issues/42 please'), 42)
  assert.equal(issueNumberFromText('See #17'), 17)
  assert.equal(issueNumberFromText('no issue here'), null)
})

test('issue references can be scoped to one repository', () => {
  assert.equal(issueNumberFromText('Blocked by other/repo#42', 'o/dup'), null)
  assert.equal(issueNumberFromText('See https://github.com/other/repo/issues/42', 'o/dup'), null)
  assert.equal(issueNumberFromText('Fix https://github.com/o/dup/issues/42', 'o/dup'), 42)
  assert.equal(issueNumberFromText('Follow-up to #42', 'o/dup'), 42)
})

test('duplicate pull requests are detected inside the target repository', () => {
  const pulls = [pull(1, { title: 'Other' }), pull(2, { title: 'Fix #42' })]
  assert.equal(findDuplicatePullRequest(42, 'o/dup', pulls)?.number, 2)
  assert.equal(findDuplicatePullRequest(99, 'o/dup', pulls), null)
})

test('a path that names the target repository still counts as a reference', () => {
  assert.equal(issueNumberFromText('HugoXK/fledge #42', 'HugoXK/fledge'), 42)
  assert.equal(issueNumberFromText('HugoXK/fledge#42', 'HugoXK/fledge'), 42)
  assert.equal(issueNumberFromText('hugoxk/fledge#42', 'HugoXK/fledge'), 42)
  assert.equal(issueNumberFromText('and/or #42'), 42)
  const pulls = [pull(7, { title: 'HugoXK/fledge #42' })]
  assert.equal(findDuplicatePullRequest(42, 'HugoXK/fledge', pulls)?.number, 7)
})

test('a repository path before the reference marks it cross-repository even with a space', () => {
  assert.equal(issueNumberFromText('Blocked by other/repo #42', 'o/dup'), null)
  assert.equal(issueNumberFromText('Upstream https://github.com/other/repo #42', 'o/dup'), null)
  const pulls = [pull(6, { title: 'Blocked by other/repo #42' })]
  assert.equal(findDuplicatePullRequest(42, 'o/dup', pulls), null)
  assert.equal(issueNumberFromText('Follow-up to #42', 'o/dup'), 42)
})

test('cross-repository references do not count as duplicates', () => {
  const pulls = [
    pull(3, { title: 'Blocked by other/repo#42' }),
    pull(4, { body: 'Upstream: https://github.com/other/repo/issues/42' }),
    pull(5, { body: 'Fixes https://github.com/o/dup/issues/42' }),
  ]
  assert.equal(findDuplicatePullRequest(42, 'o/dup', pulls)?.number, 5)
})

test('the target repository is matched case-insensitively in an /issues URL', () => {
  // #113 review: GitHub paths are case-insensitive, so a link written in a
  // different case is the same issue and must not open a second PR.
  assert.equal(issueNumberFromText('Fix https://github.com/hugoxk/fledge/issues/42', 'HugoXK/fledge'), 42)
  assert.equal(issueNumberFromText('Fixes https://github.com/HUGOxK/FLEDGE/issues/42', 'HugoXK/fledge'), 42)
  const pulls = [pull(8, { body: 'Fixes https://github.com/hugoxk/fledge/issues/42' })]
  assert.equal(findDuplicatePullRequest(42, 'HugoXK/fledge', pulls)?.number, 8)
})

test('a long slash-less body cannot stall the event loop', () => {
  // #113 review F1: the repository-path pattern backtracked quadratically on a
  // slash-less run, once per `#N`, over bodies stored whole (up to 65,536 chars)
  // and called synchronously over up to 300 pull requests. 65,538 chars measured
  // 5,942 ms, which blocks the single-process app on every iterate dispatch.
  const body = `${'a'.repeat(65_000)} #1`
  const started = performance.now()
  assert.equal(issueNumberFromText(body, 'o/dup'), 1)
  const elapsed = performance.now() - started
  assert.ok(elapsed < 500, `took ${elapsed.toFixed(0)} ms; a quadratic path match blocks the whole app`)
})

test('a body with many issue references cannot stall the event loop', () => {
  // #113 review at 6cd761d: bounding the path scan fixed one slash-less run, but
  // every `#N` still copied its whole prefix, so the cost was O(references x
  // length): 21,845 references inside a 65,535-char body (the GitHub body cap)
  // measured 4,481 ms in one synchronous call, over up to 300 open pull requests.
  const body = ' #1'.repeat(21_845)
  assert.equal(body.length, 65_535)
  const pulls = [pull(3, { body })]
  const started = performance.now()
  assert.equal(findDuplicatePullRequest(999, 'o/dup', pulls), null)
  const elapsed = performance.now() - started
  assert.ok(elapsed < 500, `took ${elapsed.toFixed(0)} ms; per-reference prefix copies block the whole app`)
})

test('a path ending in a separator is not a repository reference', () => {
  assert.equal(issueNumberFromText('see other/repo/ #42', 'o/dup'), 42)
  assert.equal(issueNumberFromText('see other/repo/#42', 'o/dup'), 42)
})

function mergedPull(number: number, fields: { title?: string; body?: string; head?: string; mergeCommitSha?: string | null } = {}) {
  return {
    ...pull(number, fields),
    mergedAt: '2026-11-09T10:00:00Z',
    mergeCommitSha: fields.mergeCommitSha ?? `sha-merge-${number}`,
  }
}

test('a duplicate is either work in flight or work that already landed, and the two are not confused', async () => {
  // #174: a re-run of already-fixed work used to be refused exactly like a genuine
  // duplicate, so a maintainer could not tell "someone is on it" from "it is in".
  const open = [pull(9, { body: 'Fixes https://github.com/o/dup/issues/42' })]
  const mergedNotAsked = async () => {
    throw new Error('the merged read must not run when an open pull request already matches')
  }
  const issueNotAsked = async () => {
    throw new Error('the issue read must not run when an open pull request already matches')
  }
  assert.deepEqual(await duplicateOutcome(42, 'o/dup', open, mergedNotAsked, issueNotAsked), {
    kind: 'open-pr',
    url: 'https://github.com/o/dup/pull/9',
  })

  const merged = [mergedPull(7, { body: 'Closes #42', mergeCommitSha: 'merge-sha-7' })]
  assert.deepEqual(await duplicateOutcome(42, 'o/dup', [], async () => merged, async () => true), {
    kind: 'already-fixed',
    url: 'https://github.com/o/dup/pull/7',
    mergeCommitSha: 'merge-sha-7',
    mergedAt: '2026-11-09T10:00:00Z',
  })

  assert.equal(await duplicateOutcome(42, 'o/dup', [], async () => [mergedPull(8, { body: 'Unrelated work' })], async () => true), null)
})

test('a merged pull request that only mentions the issue is no proof, while the issue is open', async () => {
  // #174 review at fe217420: the merged list was matched with the same reference
  // matcher as open work, which accepts a mention in the title, body or branch
  // name. A merged `Follow-up to #42` therefore told the maintainer "already
  // merged upstream" about an issue nobody had fixed. Only a closed issue makes
  // the merged reference the fix.
  const mention = [mergedPull(7, { title: 'Follow-up to #42', body: 'This does not close #42' })]
  assert.equal(
    await duplicateOutcome(42, 'o/dup', [], async () => mention, async () => false),
    null,
    'a mention of an open issue was reported as the fix',
  )
  assert.deepEqual(
    await duplicateOutcome(42, 'o/dup', [], async () => mention, async () => true),
    { kind: 'already-fixed', url: 'https://github.com/o/dup/pull/7', mergeCommitSha: 'sha-merge-7', mergedAt: '2026-11-09T10:00:00Z' },
    'a closed issue plus a merged reference is the fix',
  )
})

test('the issue is only read when a merged pull request actually matched', async () => {
  let asked = 0
  const confirm = async () => {
    asked += 1
    return true
  }
  await duplicateOutcome(42, 'o/dup', [pull(9, { body: 'Fixes #42' })], async () => [mergedPull(7, { body: 'Closes #42' })], confirm)
  assert.equal(asked, 0, 'work in flight still paid for the issue read')
  await duplicateOutcome(42, 'o/dup', [], async () => [mergedPull(8, { body: 'Unrelated' })], confirm)
  assert.equal(asked, 0, 'no merged match still paid for the issue read')
  await duplicateOutcome(42, 'o/dup', [], async () => [mergedPull(7, { body: 'Closes #42' })], confirm)
  assert.equal(asked, 1, 'the merged match did not confirm the issue state')
})
