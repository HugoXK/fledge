import assert from 'node:assert/strict'
import test from 'node:test'
import { Store } from '../src/db.js'
import { makeUser } from './helpers.js'

// #369: the bundle is a fact about the job record, so the first half of the red
// test reads the row a job leaves behind. It imports nothing from the new module
// on purpose: it has to run on the tree before the change and fail on the
// assertion, not on a missing import.

function fixture(store: Store, name = 'bundle'): { userId: string; repoId: string } {
  const user = makeUser(store, { login: `${name}-owner`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_${name}`, userId: user.id, owner: 'o', name, defaultBranch: 'main',
    tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
  })
  return { userId: user.id, repoId: repo.id }
}

const HASH = 'b'.repeat(64)

test('a job records the context bundle it was created under', () => {
  const store = new Store(':memory:')
  const { userId, repoId } = fixture(store)
  const job = store.createJob({
    id: 'job_bundle_1', repoId, userId, trigger: 'manual', goal: 'fix the job page',
    callbackHash: 'cbh', platformTokenHash: '',
    contextBundle: { hash: HASH, json: '{"version":1}' },
  })
  assert.equal(job.context_bundle_hash, HASH)
  assert.equal(job.context_bundle_json, '{"version":1}')
  // A job that was created without a bundle is a record with nothing to verify,
  // never a record that silently claims to have been verified.
  const other = fixture(store, 'bundle-plain')
  const plain = store.createJob({
    id: 'job_bundle_2', repoId: other.repoId, userId: other.userId, trigger: 'manual', goal: 'no bundle',
    callbackHash: 'cbh2', platformTokenHash: '',
  })
  assert.equal(plain.context_bundle_hash, null)
  store.close()
})

test('the bundle state is written back on the job it belongs to', () => {
  const store = new Store(':memory:')
  const { userId, repoId } = fixture(store)
  const job = store.createJob({
    id: 'job_bundle_3', repoId, userId, trigger: 'manual', goal: 'g',
    callbackHash: 'cbh3', platformTokenHash: '',
    contextBundle: { hash: HASH, json: '{"version":1}' },
  })
  assert.equal(job.context_bundle_state, null)
  store.updateJob(job.id, { context_bundle_state: 'mismatch' })
  assert.equal(store.getJob(job.id)?.context_bundle_state, 'mismatch')
  store.close()
})
