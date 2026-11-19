import test from 'node:test'
import assert from 'node:assert/strict'
import { TEST_RUN_HISTORY, Store } from '../src/db.js'
import { quarantineTests } from '../src/lib/verification.js'

const run = (name: string, passed: boolean): { name: string; passed: boolean } => ({ name, passed })

test('a test that alternates pass/fail across three runs is quarantined', () => {
  const ledger = quarantineTests([
    run('flaky', true), run('flaky', false), run('flaky', true),
    run('steady', true), run('steady', true), run('steady', true),
  ])
  assert.deepEqual(ledger.map((entry) => [entry.name, entry.state, entry.runs, entry.alternations]), [
    ['flaky', 'quarantined', 3, 2],
    ['steady', 'stable', 3, 0],
  ])
})

test('a one-off failure is not a quarantine', () => {
  const [single] = quarantineTests([run('once', false)])
  assert.equal(single?.state, 'insufficient-evidence')
  assert.equal(single?.alternations, 0)

  const [oneOfThree] = quarantineTests([run('mostly', true), run('mostly', true), run('mostly', false)])
  assert.equal(oneOfThree?.state, 'stable', 'one flip in three runs is below the threshold')
  assert.equal(oneOfThree?.alternations, 1)
})

test('the ledger groups runs by test name in first-seen order', () => {
  const ledger = quarantineTests([
    run('b', true), run('a', false), run('b', true), run('a', true),
  ])
  assert.deepEqual(ledger.map((entry) => entry.name), ['b', 'a'])
  assert.deepEqual(ledger.map((entry) => entry.runs), [2, 2])
})

// #378: the ledger the rule reads. A re-check of the same job at the same tip is
// not a second run, and the history stays bounded per repository and test name.
test('the store records one run per job and tip, and keeps the newest runs per name', () => {
  const store = new Store(':memory:')
  try {
    const sha = (index: number): string => index.toString(16).padStart(40, '0')
    for (let index = 0; index < 14; index += 1) {
      store.recordTestRuns('repo_ledger', `job_${String(index)}`, sha(index), [{ name: 'test (22)', passed: index % 2 === 0 }])
    }
    // 14 runs were written and the window is 12, so the two oldest are gone and
    // the newest twelve are read oldest-first (job_2 passed … job_13 failed).
    const before = store.testRunHistory('repo_ledger')
    assert.equal(before.length, TEST_RUN_HISTORY, 'the history is capped at the window the writer keeps')
    assert.deepEqual(before.map((entry) => entry.passed), [true, false, true, false, true, false, true, false, true, false, true, false])

    // A re-check of a job at the same tip is not a second run.
    store.recordTestRuns('repo_ledger', 'job_13', sha(13), [{ name: 'test (22)', passed: true }])
    assert.deepEqual(store.testRunHistory('repo_ledger').map((entry) => entry.passed), before.map((entry) => entry.passed), 'a re-check adds no run')
    assert.deepEqual(store.testRunHistory('repo_other'), [], 'the ledger is per repository')
  } finally {
    store.close()
  }
})

// #378: a push re-verifies the same job at the new head sha (`reconcilePr` takes
// the newest job for the pull request and verifies it at the new tip), so that
// run has to reach the ledger. With the job as the whole key it was dropped and
// the first completed result stayed frozen, which made an alternation inside one
// pull request impossible to see.
test('a re-check at a new head sha is a second run of the same job', () => {
  const store = new Store(':memory:')
  try {
    const first = '1'.repeat(40)
    const second = '2'.repeat(40)
    const third = '3'.repeat(40)
    store.recordTestRuns('repo_ledger', 'job_one', first, [{ name: 'test (22)', passed: false }])
    store.recordTestRuns('repo_ledger', 'job_one', second, [{ name: 'test (22)', passed: true }])
    store.recordTestRuns('repo_ledger', 'job_one', third, [{ name: 'test (22)', passed: false }])
    assert.deepEqual(store.testRunHistory('repo_ledger').map((entry) => entry.passed), [false, true, false], 'one job, three tips, three runs')
    assert.equal(quarantineTests(store.testRunHistory('repo_ledger'))[0]?.state, 'quarantined', 'the alternation is visible, so the test is quarantined')

    store.recordTestRuns('repo_ledger', 'job_one', third, [{ name: 'test (22)', passed: false }])
    assert.equal(store.testRunHistory('repo_ledger').length, 3, 'the same job at the same tip is still recorded once')

    store.recordTestRuns('repo_ledger', 'job_two', second, [{ name: 'test (22)', passed: true }])
    assert.equal(store.testRunHistory('repo_ledger').length, 4, 'another job at the same tip is its own run')
  } finally {
    store.close()
  }
})
