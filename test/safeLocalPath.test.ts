import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp, safeLocalPath } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { MemoryMailer, testConfig } from './helpers.js'

// `..` and `.` are folded away by the URL parser, so these three inputs are
// ordinary paths before parsing and `//host` after it. The live `/lang/:locale`
// route used to redirect to the folded value.
const FOLDED = ['/..//evil.com', '/.//evil.com', '/..\\/evil.com']

test('a next path that only becomes protocol-relative after normalisation falls back', () => {
  for (const value of FOLDED) {
    assert.equal(safeLocalPath(value, '/'), '/', `${value} must fall back`)
  }
})

test('a next path that is already protocol-relative or an absolute URL falls back', () => {
  // The query layer decodes once, so these are the values the helper really
  // sees; the percent-encoded spellings are what an attacker sends.
  const encoded = ['//evil.com', '///evil.com', '/\t/evil.com', '/%2f%2fevil.com', '/%5c%5cevil.com']
  const hostile = [...encoded.map((value) => decodeURIComponent(value)), 'https://evil.com/apply', 'evil.com', '']
  for (const value of hostile) {
    assert.equal(safeLocalPath(value, '/'), '/', `${JSON.stringify(value)} must fall back`)
  }
})

test('a legitimate local path keeps its query and hash', () => {
  assert.equal(safeLocalPath('/../ok', '/'), '/ok')
  assert.equal(safeLocalPath('/apply?x=1#y', '/'), '/apply?x=1#y')
  assert.equal(safeLocalPath('/dashboard', '/'), '/dashboard')
})

test('the language route redirects a folded next value to the fallback, not to another host', async () => {
  const store = new Store(':memory:')
  const built = await buildApp({ config: testConfig(), store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const hostile = await built.app.inject({ method: 'GET', url: '/lang/en?next=%2F..%2F%2Fevil.com' })
    assert.equal(hostile.statusCode, 302)
    assert.equal(hostile.headers.location, '/', `Location must be the fallback, got ${String(hostile.headers.location)}`)

    const legit = await built.app.inject({ method: 'GET', url: '/lang/en?next=%2Fapply' })
    assert.equal(legit.statusCode, 302)
    assert.equal(legit.headers.location, '/apply')
  } finally {
    await built.close()
  }
})
