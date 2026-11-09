import test from 'node:test'
import assert from 'node:assert/strict'
import { findDuplicatePullRequest, issueNumberFromText } from '../src/lib/duplicates.js'

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
