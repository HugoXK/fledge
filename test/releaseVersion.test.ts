import test from 'node:test'
import assert from 'node:assert/strict'
import { nextReleaseVersion, weekKey } from '../scripts/lib/release-version.mjs'

test('the same ISO week bumps the patch', () => {
  const next = nextReleaseVersion({
    packageVersion: '0.3.0',
    lastTagCommittedAt: '2026-11-09T16:23:33Z',
    releaseAt: '2026-11-10T14:30:00Z',
  })
  assert.equal(next.version, '0.3.1')
  assert.equal(next.bump, 'patch')
  assert.equal(next.known, true)
})

test('a new ISO week bumps the minor', () => {
  const next = nextReleaseVersion({
    packageVersion: '0.3.1',
    lastTagCommittedAt: '2026-11-10T16:00:00Z',
    releaseAt: '2026-11-16T14:30:00Z',
  })
  assert.equal(next.version, '0.4.0')
  assert.equal(next.bump, 'minor')
  assert.equal(next.known, true)
})

test('the Monday after a Sunday-night tag is a new week', () => {
  const next = nextReleaseVersion({
    packageVersion: '0.3.4',
    lastTagCommittedAt: '2026-11-15T16:00:00Z',
    releaseAt: '2026-11-16T14:30:00Z',
  })
  assert.equal(next.version, '0.4.0')
  assert.equal(next.bump, 'minor')
})

test('missing or unreadable times fall back to the minor', () => {
  assert.deepEqual(nextReleaseVersion({ packageVersion: '1.2.3' }), { version: '1.3.0', bump: 'minor', known: false })
  assert.deepEqual(
    nextReleaseVersion({ packageVersion: '1.2.3', lastTagCommittedAt: 'nope', releaseAt: '2026-11-10T14:30:00Z' }),
    { version: '1.3.0', bump: 'minor', known: false },
  )
})

test('an unparsable package version returns no version', () => {
  assert.deepEqual(nextReleaseVersion({ packageVersion: '1.2' }), { version: '', bump: '', known: false })
})

test('weekKey is the Monday of the UTC week', () => {
  assert.equal(weekKey('2026-11-09T23:59:59Z'), '2026-11-09')
  assert.equal(weekKey('2026-11-10T00:00:00Z'), '2026-11-09')
  assert.equal(weekKey('2026-11-15T23:59:59Z'), '2026-11-09')
  assert.equal(weekKey('2026-11-16T00:00:00Z'), '2026-11-16')
  assert.equal(weekKey('bad'), '')
})
