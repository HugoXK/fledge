import test from 'node:test'
import assert from 'node:assert/strict'
import { findDuplicatePullRequest, issueNumberFromText } from '../src/lib/duplicates.js'

test('issue references and duplicate pull requests are detected', () => {
  assert.equal(issueNumberFromText('Fix https://github.com/o/r/issues/42 please'), 42)
  assert.equal(issueNumberFromText('See #17'), 17)
  assert.equal(issueNumberFromText('no issue here'), null)
  const pulls = [
    { number: 1, url: 'https://github.com/o/r/pull/1', title: 'Other', body: '', head: 'fledge/a', base: 'main' },
    { number: 2, url: 'https://github.com/o/r/pull/2', title: 'Fix #42', body: '', head: 'fledge/b', base: 'main' },
  ]
  assert.equal(findDuplicatePullRequest(42, pulls)?.number, 2)
  assert.equal(findDuplicatePullRequest(99, pulls), null)
})
