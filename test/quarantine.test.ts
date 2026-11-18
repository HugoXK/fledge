import test from 'node:test'
import assert from 'node:assert/strict'
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
