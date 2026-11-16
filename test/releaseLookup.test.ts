import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyReleaseLookup } from '../scripts/lib/release-lookup.mjs'

// #909: both release workflows read one fact — does this tag already have a
// GitHub Release? — and `gh` exits non-zero for "not found" (404) and for
// "forbidden" (403), a server error (5xx) or a dead network alike. This table is
// the whole rule: only a 404 may mean "not made yet"; everything else is
// unreadable and the caller must refuse. The table is what both step bodies are
// driven against, so a change here is a change to both workflows.

test('a successful read is the only "present"', () => {
  const result = classifyReleaseLookup({ status: 0 })
  assert.equal(result.state, 'present')
  assert.equal(result.httpStatus, 200)
})

test('a 404 is the only "absent"', () => {
  for (const stderr of [
    'gh: Not Found (HTTP 404)',
    'gh: release not found (HTTP 404)',
    'gh: HTTP 404: Not Found (https://api.github.com/repos/HugoXK/fledge/releases/tags/v0.4.0)',
  ]) {
    const result = classifyReleaseLookup({ status: 1, stderr })
    assert.equal(result.state, 'absent', stderr)
    assert.equal(result.httpStatus, 404, stderr)
  }
})

test('the status line of an `--include` response is read as a number', () => {
  assert.equal(classifyReleaseLookup({ status: 1, stdout: 'HTTP/2.0 404 Not Found\r\n' }).state, 'absent')
  assert.equal(classifyReleaseLookup({ status: 1, stdout: 'HTTP/2.0 403 Forbidden\r\n' }).state, 'unreadable')
})

test('a 403, a 5xx or an unknown failure is unreadable, never absent', () => {
  const cases: Array<[number, string]> = [
    [1, 'gh: Resource not accessible by integration (HTTP 403)'],
    [1, 'gh: Forbidden (HTTP 403)'],
    [1, 'gh: Server Error (HTTP 502)'],
    [1, 'gh: Internal Server Error (HTTP 500)'],
    [1, 'gh: API rate limit exceeded (HTTP 403)'],
    [1, 'gh: Bad credentials (HTTP 401)'],
    [1, 'gh: Not Found (HTTP 410)'],
  ]
  for (const [status, stderr] of cases) {
    const result = classifyReleaseLookup({ status, stderr })
    assert.equal(result.state, 'unreadable', stderr)
    assert.equal(result.httpStatus, /HTTP (\d{3})/.exec(stderr)?.[1] === undefined ? null : Number(/HTTP (\d{3})/.exec(stderr)?.[1]), stderr)
    assert.match(result.reason, /unreadable/, stderr)
  }
})

test('prose cannot decide: "not found" without a 404 is unreadable', () => {
  for (const stderr of [
    'gh: release not found',
    'gh: Not Found',
    '',
    'dial tcp 140.82.121.6:443: i/o timeout',
    'gh: Post "https://api.github.com/repos/HugoXK/fledge/releases": context deadline exceeded',
  ]) {
    const result = classifyReleaseLookup({ status: 1, stderr })
    assert.equal(result.state, 'unreadable', stderr)
    assert.equal(result.httpStatus, null, stderr)
  }
})

test('a non-zero exit with no observation at all is unreadable', () => {
  assert.equal(classifyReleaseLookup({}).state, 'unreadable')
  assert.equal(classifyReleaseLookup(undefined).state, 'unreadable')
  assert.equal(classifyReleaseLookup({ status: 128 }).state, 'unreadable')
})

test('a 200 document that still exited non-zero is not "present"', () => {
  // The exit status is the primary signal: `present` claims the release exists,
  // which only a zero exit supports.
  const result = classifyReleaseLookup({ status: 1, stdout: '{"tag_name":"v0.4.0"}' })
  assert.equal(result.state, 'unreadable')
})
