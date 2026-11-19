import assert from 'node:assert/strict'
import test from 'node:test'
import { ACTION_KINDS, actionIdFor, projectJobAction, projectLegacyNotice, sanitizeActionSentence } from '../src/lib/actionsNeeded.js'

// #633 first slice: the projection is a pure mapping from a job's state or an
// existing notice kind onto the six action kinds. It writes nothing, so the
// whole matrix is asserted without a store, a mailer or a clock.

test('the action vocabulary is closed to the six kinds', () => {
  assert.deepEqual([...ACTION_KINDS], ['question', 'plan', 'review', 'failed', 'release', 'quota'])
})

test('a successful job with nothing to decide projects no action', () => {
  assert.equal(projectJobAction({ id: 'job_ok', repoId: 'repo_1', kind: 'iterate', status: 'succeeded', prUrl: null }), null)
})

test('a status-only change projects no action', () => {
  for (const status of ['queued', 'running', 'dispatched', 'cancelled', 'canceled', 'paused']) {
    assert.equal(projectJobAction({ id: 'job_s', repoId: 'repo_1', kind: 'iterate', status, prUrl: null }), null, status)
  }
})

test('a failed job projects exactly one failed action with a stable id', () => {
  const facts = { id: 'job_failed', repoId: 'repo_1', kind: 'iterate', status: 'failed', prUrl: null }
  const action = projectJobAction(facts)
  assert.ok(action !== null)
  assert.equal(action.kind, 'failed')
  assert.equal(action.id, actionIdFor('failed', 'repo_1', 'job_failed'))
  assert.match(action.id, /^act_[0-9a-f]{12}$/)
  assert.equal(action.urgent, true)
  assert.equal(projectJobAction({ ...facts })?.id, action.id, 'the same failure projects the same id, so it dedupes')
})

test('a succeeded job with an open pull request projects a review action', () => {
  const action = projectJobAction({ id: 'job_pr', repoId: 'repo_1', kind: 'iterate', status: 'succeeded', prUrl: 'https://github.com/o/r/pull/7' })
  assert.ok(action !== null)
  assert.equal(action.kind, 'review')
  assert.equal(action.href, 'https://github.com/o/r/pull/7')
  assert.equal(action.urgent, false)
})

test('the tree’s team and ops notice kinds map into the six, they are not new kinds', () => {
  assert.equal(projectLegacyNotice('team', 'repo_1', 'lead-only question')?.kind, 'review')
  assert.equal(projectLegacyNotice('ops', 'repo_1', 'bridge down')?.kind, 'failed')
  assert.equal(projectLegacyNotice('job', 'repo_1', 'x'), null, 'a plain job notice is not an action by itself')
})

test('an action id is deterministic, kind-scoped and URL-safe', () => {
  assert.equal(actionIdFor('failed', 'repo_1', 'job_1'), actionIdFor('failed', 'repo_1', 'job_1'))
  assert.notEqual(actionIdFor('failed', 'repo_1', 'job_1'), actionIdFor('review', 'repo_1', 'job_1'))
  assert.notEqual(actionIdFor('failed', 'repo_1', 'job_1'), actionIdFor('failed', 'repo_2', 'job_1'))
  assert.match(actionIdFor('question', 'repo_1', 'q_1'), /^act_[0-9a-f]{12}$/)
})

test('a sentence cannot carry a token, an address, a file path or an internal code', () => {
  const dirty = `失败：ghp_${'a'.repeat(36)} owner@example.com at handler (src/jobs/service.ts:12:3) ENOENT BRIDGE_ERROR TypeError: boom`
  const clean = sanitizeActionSentence(dirty)
  assert.doesNotMatch(clean, /ghp_|owner@example\.com|src\/jobs|ENOENT|BRIDGE_ERROR|TypeError/)
  assert.ok(clean.trim().length > 0, 'the redaction leaves a sentence a person can read')
})
