import test from 'node:test'
import assert from 'node:assert/strict'
import { checkPathGuard, matchesPath, splitPathPatterns } from '../src/lib/pathGuard.js'

test('path patterns split on commas and newlines and match prefixes', () => {
  assert.deepEqual(splitPathPatterns('src/, docs/*.md\n.github/'), ['src/', 'docs/*.md', '.github/'])
  assert.equal(matchesPath('src/app.ts', 'src/'), true)
  assert.equal(matchesPath('src/app.ts', 'src'), true)
  assert.equal(matchesPath('docs/guide.md', 'docs/*.md'), true)
  assert.equal(matchesPath('docs/guide.md', 'docs/*.txt'), false)
  assert.equal(matchesPath('deploy/x.yml', 'deploy/'), true)
})

test('deny wins and allow is enforced when present', () => {
  const denied = checkPathGuard(['src/a.ts', '.github/workflows/ci.yml'], 'src/', '.github/')
  assert.equal(denied.ok, false)
  assert.deepEqual(denied.violations, [{ file: '.github/workflows/ci.yml', reason: 'denied' }])

  const notAllowed = checkPathGuard(['src/a.ts', 'README.md'], 'src/', '')
  assert.equal(notAllowed.ok, false)
  assert.deepEqual(notAllowed.violations, [{ file: 'README.md', reason: 'not_allowed' }])

  const open = checkPathGuard(['anything/at/all.ts'], '', '')
  assert.equal(open.ok, true)
  assert.deepEqual(open.violations, [])
})
