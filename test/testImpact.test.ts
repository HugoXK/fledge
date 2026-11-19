import test from 'node:test'
import assert from 'node:assert/strict'
import { selectTests } from '../src/lib/testImpact.js'

// #378: the red half — this file cannot load at the tip this branch starts from,
// because `selectTests` does not exist there yet.

test('a change to src/foo.ts selects test/foo.test.ts and its direct importer and does not run the whole suite', () => {
  const impact = selectTests({
    changed: ['src/foo.ts'],
    testFiles: ['test/bar.test.ts', 'test/foo.test.ts', 'test/unrelated.test.ts'],
    imports: { 'test/bar.test.ts': ['src/foo.ts'], 'test/unrelated.test.ts': ['src/other.ts'] },
  })
  assert.equal(impact.state, 'mapped')
  assert.deepEqual(impact.selected, [
    { path: 'test/bar.test.ts', reason: 'importer' },
    { path: 'test/foo.test.ts', reason: 'convention' },
  ])
  assert.equal(impact.selected.some((entry) => entry.path === 'test/unrelated.test.ts'), false, 'an unrelated test is not selected')
  assert.equal(impact.truncated, false)
})

test('a change with no mapped test falls back and says no impact map', () => {
  const impact = selectTests({ changed: ['docs/readme.md'], testFiles: ['test/foo.test.ts'], imports: {} })
  assert.equal(impact.state, 'no impact map')
  assert.deepEqual(impact.selected, [])
})

test('a changed test file selects itself directly, and a convention hit outranks an importer', () => {
  const direct = selectTests({ changed: ['test/foo.test.ts'], testFiles: ['test/foo.test.ts'], imports: {} })
  assert.deepEqual(direct.selected, [{ path: 'test/foo.test.ts', reason: 'direct' }])

  const both = selectTests({
    changed: ['src/foo.ts'],
    testFiles: ['test/foo.test.ts'],
    imports: { 'test/foo.test.ts': ['src/foo.ts'] },
  })
  assert.deepEqual(both.selected, [{ path: 'test/foo.test.ts', reason: 'convention' }], 'a path is reported once, under its strongest reason')
})

test('the selection is bounded and says it was cut', () => {
  const testFiles = Array.from({ length: 40 }, (_, index) => `test/t${String(index).padStart(2, '0')}.test.ts`)
  const changed = Array.from({ length: 40 }, (_, index) => `src/t${String(index).padStart(2, '0')}.ts`)
  const impact = selectTests({ changed, testFiles, imports: {}, limit: 10 })
  assert.equal(impact.selected.length, 10)
  assert.equal(impact.truncated, true)
  assert.equal(impact.limit, 10)
})

test('a repo mapping names dependents that naming convention cannot find', () => {
  const impact = selectTests({
    changed: ['src/db.ts'],
    testFiles: ['test/db.test.ts', 'test/jobs.test.ts'],
    imports: { 'test/jobs.test.ts': ['src/jobs/service.ts', 'src/db.ts'] },
  })
  assert.deepEqual(impact.selected, [
    { path: 'test/db.test.ts', reason: 'convention' },
    { path: 'test/jobs.test.ts', reason: 'importer' },
  ])
})
