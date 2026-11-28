import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { makeUser } from './helpers.js'
import { automationHealth, recordLeaseHealth } from '../src/jobs/automationHealth.js'
import { metricsSnapshot, resetMetrics } from '../src/lib/metrics.js'

function fixture(store: Store, name: string) {
  const user = makeUser(store, { login: `${name}-owner`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_${name}`,
    userId: user.id,
    owner: 'octo',
    name,
    defaultBranch: 'main',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  return { user, repo }
}

test('the oldest live lease is read from the attempt, with its repo and expiry', () => {
  const store = new Store(':memory:')
  try {
    const { user, repo } = fixture(store, 'live')
    const job = store.createJob({
      id: 'job_live',
      repoId: repo.id,
      userId: user.id,
      trigger: 'schedule',
      goal: 'g',
      callbackHash: 'cb_live',
      platformTokenHash: '',
      kind: 'iterate',
      createdAt: '2026-11-23T10:00:00.000Z',
    })
    const attempt = store.startJobAttempt(job.id, 'worker:1', 300_000)
    assert.ok(attempt)
    store.run('UPDATE jobs SET started_at = ?, lease_until = ? WHERE id = ?', '2026-11-23T10:00:00.000Z', '2026-11-23T10:05:00.000Z', job.id)
    store.run('UPDATE job_attempts SET started_at = ? WHERE job_id = ?', '2026-11-23T10:00:00.000Z', job.id)

    assert.equal(store.oldestLiveLease()?.job_id, job.id)
    assert.equal(store.oldestLiveLease()?.owner, 'octo')
    assert.equal(store.oldestLiveLease()?.name, 'live')
    assert.equal(store.oldestLiveLease()?.since, '2026-11-23T10:00:00.000Z')

    const summary = automationHealth(store, Date.parse('2026-11-23T10:02:00.000Z'))
    assert.deepEqual(summary.lease, {
      jobId: job.id,
      kind: 'iterate',
      repo: 'octo/live',
      ageSeconds: 120,
      expiresInSeconds: 180,
    })
    assert.equal(summary.lastReaped, null)
  } finally {
    store.close()
  }
})

test('the last reaped lease is the newest terminal reaped attempt', () => {
  const store = new Store(':memory:')
  try {
    const { user, repo } = fixture(store, 'reaped')
    const job = store.createJob({
      id: 'job_reaped',
      repoId: repo.id,
      userId: user.id,
      trigger: 'schedule',
      goal: 'g',
      callbackHash: 'cb_reaped',
      platformTokenHash: '',
      kind: 'review',
    })
    const attempt = store.startJobAttempt(job.id, 'worker:1', 300_000)
    assert.ok(attempt)
    const claimed = store.claimJobTerminal(
      job.id,
      'failed',
      null,
      { error: 'lease expired', finished_at: '2026-11-23T10:06:00.000Z' },
      { epoch: attempt.epoch, outcome: 'reaped', error: 'lease expired' },
    )
    assert.equal(claimed, true)
    // The attempt's terminal time is written by `claimJobTerminal`; pin it so
    // the card's age is deterministic rather than reading the wall clock.
    store.run('UPDATE job_attempts SET finished_at = ? WHERE job_id = ?', '2026-11-23T10:06:00.000Z', job.id)

    const reaped = store.lastReapedLease()
    assert.equal(reaped?.job_id, job.id)
    assert.equal(reaped?.kind, 'review')
    assert.equal(reaped?.at, '2026-11-23T10:06:00.000Z')
    assert.equal(reaped?.owner, 'octo')
    assert.equal(reaped?.name, 'reaped')

    const summary = automationHealth(store, Date.parse('2026-11-23T10:08:00.000Z'))
    assert.deepEqual(summary.lastReaped, {
      jobId: job.id,
      kind: 'review',
      repo: 'octo/reaped',
      ageSeconds: 120,
    })
    assert.equal(summary.lease, null)
  } finally {
    store.close()
  }
})

test('the lease gauge is set from the oldest start and removed when none is live', () => {
  resetMetrics()
  const now = Date.parse('2026-11-23T10:02:00.000Z')
  recordLeaseHealth({ oldestSince: Date.parse('2026-11-23T10:00:00.000Z'), now })
  const gauge = metricsSnapshot().gauges.find((entry) => entry.name === 'fledge_job_lease_age_seconds')
  assert.ok(gauge)
  assert.equal(gauge.value, 120)

  recordLeaseHealth({ oldestSince: null, now })
  assert.equal(metricsSnapshot().gauges.some((entry) => entry.name === 'fledge_job_lease_age_seconds'), false)
})
