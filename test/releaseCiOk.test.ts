import test from 'node:test'
import assert from 'node:assert/strict'

import { CI_OK_INTERVAL_MS, CI_OK_READS, decideDrive, decideWithCiRetry } from '../scripts/lib/release-drive.mjs'
import { latestConclusion, latestRun } from '../scripts/lib/release-state.mjs'

// #864: the daily release read `ci-ok` exactly once. A run that started while CI
// was still in flight saw `missing` and the drive turned that into `none`, so a
// green tip was refused and the slot was gone — 0.3.7 was refused this way. The
// fix keeps the two facts apart: `missing` means "no conclusion yet, wait and
// re-read on a bounded schedule", and only a concluded failure blocks at once.

const PLAN_OK = { shouldRelease: true, nextVersion: '0.3.0', reason: 'ok' }

const running = { ciOk: 'missing', ciOkRun: { id: 404, status: 'in_progress', conclusion: 'missing' } }
const greenNow = { ciOk: 'success', ciOkRun: { id: 404, status: 'completed', conclusion: 'success' } }

test('the newest ci-ok run is reported with its id and status, and a missing conclusion stays missing', () => {
  const pages = [
    [
      { id: 11, name: 'ci-ok', status: 'completed', conclusion: 'failure' },
      { id: 12, name: 'ci-ok', status: 'in_progress', conclusion: null },
      { id: 99, name: 'lint', status: 'completed', conclusion: 'success' },
    ],
  ]
  assert.deepEqual(latestRun(pages, 'ci-ok'), { id: 12, status: 'in_progress', conclusion: 'missing' })
  assert.equal(latestConclusion(pages, 'ci-ok'), 'missing', 'an unfinished run is not a green one')
  assert.deepEqual(latestRun([], 'ci-ok'), { id: 0, status: '', conclusion: 'missing' })
})

test('a ci-ok that has not concluded asks for a re-read, not for a quiet night', () => {
  const decision = decideDrive({ plan: PLAN_OK, tags: [], ...running })
  assert.equal(decision.action, 'wait-ci')
  assert.match(decision.reason, /ci-ok on main is missing/)
  assert.match(decision.reason, /run 404/)
})

test('a missing ci-ok that turns green while the drive waits still releases', async () => {
  const waits: number[] = []
  let reads = 0
  const decision = await decideWithCiRetry({
    state: { plan: PLAN_OK, tags: [], ...running },
    readCiOk: async () => {
      reads += 1
      return greenNow
    },
    wait: async (ms: number) => {
      waits.push(ms)
    },
  })
  assert.equal(decision.action, 'open-pr', `a green re-read must release, got ${JSON.stringify(decision)}`)
  assert.equal(decision.version, '0.3.0')
  assert.equal(reads, 1, 'one re-read was enough, and it happened before the decision')
  assert.deepEqual(waits, [CI_OK_INTERVAL_MS], 'the re-read waits one interval, then asks again')
})

test('the re-read stops at the bound and names what it last saw', async () => {
  const waits: number[] = []
  let reads = 0
  const decision = await decideWithCiRetry({
    state: { plan: PLAN_OK, tags: [], ...running },
    readCiOk: async () => {
      reads += 1
      return running
    },
    wait: async (ms: number) => {
      waits.push(ms)
    },
  })
  assert.equal(decision.action, 'none', 'a tip that never concludes does not release in this slot')
  assert.equal(reads, CI_OK_READS - 1, 'the first read is the one the workflow collected, so only the rest are re-reads')
  assert.equal(waits.length, CI_OK_READS - 1)
  assert.match(decision.reason, /still missing/)
  assert.match(decision.reason, /run 404/, 'the run id makes "not yet" checkable')
  assert.match(decision.reason, new RegExp(`after ${String(CI_OK_READS)} reads`), 'the reason states the bound it stopped at')
})

test('a concluded failure blocks at once and is never re-read', async () => {
  const decision = await decideWithCiRetry({
    state: { plan: PLAN_OK, tags: [], ciOk: 'failure', ciOkRun: { id: 77, status: 'completed', conclusion: 'failure' } },
    readCiOk: async () => {
      throw new Error('a red aggregate must not be re-read; the fix is a new commit, not a wait')
    },
    wait: async () => {
      throw new Error('a red aggregate must not wait')
    },
  })
  assert.equal(decision.action, 'none')
  assert.match(decision.reason, /ci-ok on main is failure/)
  assert.match(decision.reason, /run 77/)
})

test('a dry run never waits', async () => {
  let reads = 0
  const decision = await decideWithCiRetry({
    state: { plan: PLAN_OK, tags: [], dryRun: true, ...running },
    readCiOk: async () => {
      reads += 1
      return greenNow
    },
    wait: async () => {
      throw new Error('a dry run reports; it does not sit on a runner')
    },
  })
  assert.equal(decision.action, 'none')
  assert.equal(decision.wouldHave, 'wait-ci', 'the dry run says what a real run would have done')
  assert.equal(reads, 0)
})
