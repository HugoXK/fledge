import test from 'node:test'
import assert from 'node:assert/strict'
import { allowedRepoRoles, parseRepoRole, roleAllowed } from '../src/lib/repoRole.js'

test('repository roles follow GitHub permission', () => {
  assert.deepEqual(allowedRepoRoles('admin'), ['maintainer', 'developer'])
  assert.deepEqual(allowedRepoRoles('maintain'), ['maintainer', 'developer'])
  assert.deepEqual(allowedRepoRoles('write'), ['developer'])
  assert.deepEqual(allowedRepoRoles('triage'), ['developer'])
  assert.deepEqual(allowedRepoRoles('read'), ['developer'])
  assert.deepEqual(allowedRepoRoles('none'), ['developer'])
  assert.equal(roleAllowed('admin', 'maintainer'), true)
  assert.equal(roleAllowed('write', 'maintainer'), false)
  assert.equal(roleAllowed('write', 'developer'), true)
  assert.equal(parseRepoRole('maintainer'), 'maintainer')
  assert.equal(parseRepoRole('developer'), 'developer')
  assert.equal(parseRepoRole('owner'), null)
  assert.equal(parseRepoRole(''), null)
})
