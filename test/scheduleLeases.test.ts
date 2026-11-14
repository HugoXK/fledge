import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { makeUser } from './helpers.js'

// #544 slice 3B-B2: the lease half. B1 gave a decided instant a row and made
// `(schedule_id, logical_time, timing_revision)` its identity. This slice adds
// the three questions a second worker forces:
//
//   - can two workers claim the same instant? Only one may hold a live lease.
//   - what happens when the holder dies? The lease expires and the *same* row is
//     claimable again, with the attempt counted.
//   - what happens when the slow holder comes back? Its result is rejected,
//     because the row's `lease_token` is no longer the one it was given.
//
// The token comparison is the whole mechanism: `attempts` only counts, it never
// decides, and a terminal row (`dispatched` / `skipped`) is never re-claimable
// however old its lease looks.

const T0 = Date.parse('2026-01-01T00:00:00Z')
const LEASE_MS = 30_000

function harness(name: string): { store: Store; repoId: string; scheduleId: string } {
  const store = new Store(':memory:')
  const user = makeUser(store, { login: `${name}-user`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_${name}`, userId: user.id, owner: 'o', name,
    defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
    repoRole: 'developer', goal: 'fix bugs', autoIterate: true, intervalMinutes: 1440,
  })
  const schedule = store.saveSchedule({ id: `sch_${name}`, repoId: repo.id, kind: 'interval', everyMs: 15 * 60_000 })
  return { store, repoId: repo.id, scheduleId: schedule.id }
}

function claim(h: { store: Store; repoId: string; scheduleId: string }, token: string, now: number, logicalTime = T0) {
  return h.store.claimScheduleOccurrence({
    id: `occ_${token}`,
    scheduleId: h.scheduleId,
    repoId: h.repoId,
    logicalTime,
    timingRevision: 1,
    leaseToken: token,
    leaseMs: LEASE_MS,
    now,
  })
}

test('the occurrence row carries attempts and a lease, at user_version 38', () => {
  const store = new Store(':memory:')
  try {
    const version = store.get<{ user_version: number }>('PRAGMA user_version')
    assert.equal(Number(version?.user_version), 38, 'the lease columns move the refusal boundary from 37 to 38')

    const columns = store.all<{ name: string }>('PRAGMA table_info(schedule_occurrences)').map((column) => column.name)
    for (const column of ['attempts', 'lease_token', 'lease_expires_at']) {
      assert.equal(columns.includes(column), true, `schedule_occurrences must have ${column}`)
    }
  } finally {
    store.close()
  }
})

test('a live lease cannot be claimed by a second worker', () => {
  const h = harness('lease-live')
  try {
    const first = claim(h, 'tok_a', T0)
    assert.equal(first.claimed, true)
    assert.equal(first.row.state, 'claimed')
    assert.equal(first.row.attempts, 1)
    assert.equal(first.row.lease_token, 'tok_a')
    assert.equal(first.row.lease_expires_at, T0 + LEASE_MS)

    // One second before the lease runs out it is still live.
    const second = claim(h, 'tok_b', T0 + LEASE_MS - 1)
    assert.equal(second.claimed, false)
    assert.equal(second.reason, 'leased')
    assert.equal(second.row.lease_token, 'tok_a', 'the holder keeps the lease')
    assert.equal(second.row.attempts, 1, 'a refused claim is not an attempt')
    assert.equal(h.store.listScheduleOccurrences(h.repoId).length, 1)
  } finally {
    h.store.close()
  }
})

test('an expired lease is recovered under the same occurrence id', () => {
  const h = harness('lease-expired')
  try {
    const first = claim(h, 'tok_a', T0)
    const second = claim(h, 'tok_b', T0 + LEASE_MS + 1)

    assert.equal(second.claimed, true)
    assert.equal(second.row.id, first.row.id, 'recovery reuses the row, it does not fork the instant')
    assert.equal(second.row.attempts, 2, 'recovery is the second attempt at the same instant')
    assert.equal(second.row.lease_token, 'tok_b')
    assert.equal(second.row.lease_expires_at, T0 + LEASE_MS + 1 + LEASE_MS)
    assert.equal(h.store.listScheduleOccurrences(h.repoId).length, 1)
  } finally {
    h.store.close()
  }
})

test('a settled row records its outcome and holds no lease', () => {
  const h = harness('lease-settle')
  try {
    claim(h, 'tok_a', T0)
    const settled = h.store.settleScheduleOccurrence({
      scheduleId: h.scheduleId, logicalTime: T0, timingRevision: 1,
      leaseToken: 'tok_a', state: 'dispatched', jobId: 'job_1',
      dispatchedAt: T0 + 500, lagMs: 500, missed: 0, now: T0 + 500,
    })
    assert.equal(settled.settled, true)
    assert.equal(settled.row.state, 'dispatched')
    assert.equal(settled.row.job_id, 'job_1')
    assert.equal(settled.row.lease_token, null, 'a settled row is nobody\'s to hold')
    assert.equal(settled.row.lease_expires_at, null)
    assert.equal(settled.row.attempts, 1)
  } finally {
    h.store.close()
  }
})

test('a stale worker cannot commit a result at a lease it no longer holds', () => {
  const h = harness('lease-stale')
  try {
    claim(h, 'tok_a', T0)
    // A's lease expires, B takes over the same instant.
    claim(h, 'tok_b', T0 + LEASE_MS + 1)

    // A comes back and tries to write what it did. It lost the lease, so its
    // result must not land: the row is B's now.
    const stale = h.store.settleScheduleOccurrence({
      scheduleId: h.scheduleId, logicalTime: T0, timingRevision: 1,
      leaseToken: 'tok_a', state: 'dispatched', jobId: 'job_stale', now: T0 + LEASE_MS + 2,
    })
    assert.equal(stale.settled, false)
    assert.equal(stale.reason, 'stale-lease')
    assert.equal(stale.row.state, 'claimed', 'A cannot settle a row B holds')
    assert.equal(stale.row.job_id, null)
    assert.equal(stale.row.lease_token, 'tok_b')

    // B's own result does land.
    const current = h.store.settleScheduleOccurrence({
      scheduleId: h.scheduleId, logicalTime: T0, timingRevision: 1,
      leaseToken: 'tok_b', state: 'skipped', reason: 'active-job', now: T0 + LEASE_MS + 3,
    })
    assert.equal(current.settled, true)
    assert.equal(current.row.state, 'skipped')
    assert.equal(current.row.reason, 'active-job')

    // And once settled, it is not claimable at all, however the lease looks.
    const after = claim(h, 'tok_c', T0 + LEASE_MS + 4)
    assert.equal(after.claimed, false)
    assert.equal(after.reason, 'settled')
    assert.equal(after.row.attempts, 2, 'a settled row is never a third attempt')
  } finally {
    h.store.close()
  }
})

test('the sweep frees only leases that have expired, and the freed row is claimable again', () => {
  const h = harness('lease-sweep')
  try {
    claim(h, 'tok_a', T0, T0)
    // B claims a later instant 20s in, so its lease outlives A's.
    claim(h, 'tok_b', T0 + 20_000, T0 + 60_000)

    // Only A's lease is expired at this instant.
    const swept = h.store.sweepScheduleLeases(T0 + LEASE_MS + 1)
    assert.equal(swept.freed, 1)
    assert.deepEqual(swept.ids, [`occ_tok_a`])

    const a = h.store.findScheduleOccurrence(h.scheduleId, T0, 1)
    assert.equal(a?.state, 'expired')
    assert.equal(a?.reason, 'lease-expired')
    assert.equal(a?.lease_token, null, 'a swept row holds no lease')
    assert.equal(a?.lease_expires_at, null)

    const b = h.store.findScheduleOccurrence(h.scheduleId, T0 + 60_000, 1)
    assert.equal(b?.state, 'claimed', 'a live lease is not swept')
    assert.equal(b?.lease_token, 'tok_b')

    // The recovered instant is claimable again under its own id, as a third attempt.
    const again = claim(h, 'tok_d', T0 + LEASE_MS + 2)
    assert.equal(again.claimed, true)
    assert.equal(again.row.id, 'occ_tok_a')
    assert.equal(again.row.attempts, 2)
    assert.equal(again.row.state, 'claimed')

    // Sweeping twice does not invent a second recovery.
    const twice = h.store.sweepScheduleLeases(T0 + LEASE_MS + 2)
    assert.equal(twice.freed, 0)
    assert.deepEqual(twice.ids, [])
  } finally {
    h.store.close()
  }
})

test('a claim is one transaction: the loser of a race sees the winner\'s row, not a second one', () => {
  const h = harness('lease-race')
  try {
    // Both workers reach the instant with the same `now`; the store must decide
    // one winner and hand the loser that same row.
    const first = claim(h, 'tok_a', T0)
    const second = claim(h, 'tok_b', T0)
    assert.equal(first.claimed, true)
    assert.equal(second.claimed, false)
    assert.equal(second.row.id, first.row.id)
    assert.equal(h.store.listScheduleOccurrences(h.repoId).length, 1)
    assert.equal(h.store.scheduleLeaseHeld(h.scheduleId, T0, 1, T0), true, 'the winner\'s lease is readable')
  } finally {
    h.store.close()
  }
})
