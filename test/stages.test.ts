import test from 'node:test'
import assert from 'node:assert/strict'
import { checkStage, parseStageMode } from '../src/lib/stages.js'

test('stage modes parse and enforced iterate jobs need scope, tests and Dev/Test roles', () => {
  assert.equal(parseStageMode('enforced'), 'enforced')
  assert.equal(parseStageMode('shadow'), 'shadow')
  assert.equal(parseStageMode('off'), 'off')
  assert.equal(parseStageMode('nope'), null)

  const missing = checkStage('enforced', 'iterate', null, null)
  assert.equal(missing.ok, false)
  assert.ok(missing.errors.length >= 4)

  const leadOnly = checkStage('enforced', 'iterate', {
    scope: 'scope',
    acceptance: 'acceptance',
    testRed: 'red',
    testGreen: 'green',
  }, { implementedBy: 'Lead', testedBy: 'Lead' })
  assert.equal(leadOnly.ok, false)

  const full = checkStage('enforced', 'iterate', {
    scope: 'scope',
    acceptance: 'acceptance',
    testRed: 'red',
    testGreen: 'green',
  }, { implementedBy: 'Dev-1', testedBy: 'Test' })
  assert.equal(full.ok, true)
})

test('enforced review jobs need a Reviewer and a score', () => {
  assert.equal(checkStage('enforced', 'review', null, { reviewedBy: 'Reviewer' }, 80).ok, true)
  assert.equal(checkStage('enforced', 'review', null, { reviewedBy: 'Lead' }, 80).ok, false)
  assert.equal(checkStage('enforced', 'review', null, { reviewedBy: 'Reviewer' }, undefined).ok, false)
})

test('off and plan jobs are never blocked', () => {
  assert.equal(checkStage('off', 'iterate', null, null).ok, true)
  assert.equal(checkStage('enforced', 'plan', null, null).ok, true)
})
