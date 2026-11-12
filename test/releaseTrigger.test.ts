import test from 'node:test'
import assert from 'node:assert/strict'
import { decideTrigger, latestBoundary, BOUNDARY } from '../scripts/lib/release-trigger.mjs'
import type { TriggerInput } from '../scripts/lib/release-trigger.mjs'

// #315: the nightly release had one dependable delivery path, `on.schedule`, and
// GitHub delivered it once in 68 runs — 6h27m late. The rule now runs on a push
// to `main`, and this predicate is the whole policy: a slot ships at most once,
// the marker is remote state (the tag and the `release/v<next>` branch), and a
// dropped slot is caught up by the next push rather than costing a whole day.
//
// Every case below fails on the pre-#315 tree, where the module does not exist
// and the `release` job's `if:` refuses a push outright.

const boundary = '2026-11-12T14:30:00.000Z'

function base(over: Partial<TriggerInput> = {}): TriggerInput {
  return {
    event: 'push',
    now: '2026-11-12T15:00:00Z',
    tags: ['v0.3.1'],
    branches: ['main', 'dev1/315-release-trigger'],
    openReleasePullRequests: [],
    nextVersion: '0.3.2',
    lastTagCommittedAt: '2026-11-11T15:00:00Z',
    guardsPass: true,
    guardReason: 'ok',
    ...over,
  }
}

test('the boundary is 14:30Z of the same UTC day, and yesterday before it', () => {
  assert.equal(latestBoundary('2026-11-12T15:00:00Z'), boundary)
  assert.equal(latestBoundary('2026-11-12T14:29:59Z'), '2026-11-11T14:30:00.000Z')
  assert.equal(latestBoundary('2026-11-12T14:30:00Z'), boundary)
  assert.equal(BOUNDARY, '14:30Z')
  assert.equal(latestBoundary('not a date'), null, 'an unreadable clock has no boundary and never plans')
})

test('case 1: a push after the boundary with an older tag and nothing in flight plans', () => {
  const decision = decideTrigger(base())
  assert.equal(decision.plan, true)
  assert.equal(decision.catchUp, false)
  assert.match(decision.reason, /^slot-open/)
  assert.match(decision.reason, new RegExp(boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('case 2: an existing release/v0.3.2 branch blocks the night and names it', () => {
  const decision = decideTrigger(base({ branches: ['main', 'release/v0.3.2'] }))
  assert.equal(decision.plan, false)
  assert.match(decision.reason, /^branch-exists/)
  assert.match(decision.reason, /release\/v0\.3\.2/)
})

test('case 2b: a branch for another version does not block this night', () => {
  const decision = decideTrigger(base({ branches: ['main', 'release/v0.4.0'] }))
  assert.equal(decision.plan, true)
})

test('case 3: an open release pull request blocks the night and names it', () => {
  const decision = decideTrigger(base({ openReleasePullRequests: [{ number: 42, branch: 'release/v0.3.2' }] }))
  assert.equal(decision.plan, false)
  assert.match(decision.reason, /^open-pr/)
  assert.match(decision.reason, /#42/)
})

test('case 4: a tag newer than the boundary means the slot already shipped', () => {
  const decision = decideTrigger(base({ lastTagCommittedAt: '2026-11-12T15:05:00Z' }))
  assert.equal(decision.plan, false)
  assert.match(decision.reason, /^slot-shipped/)
})

test('case 5: a push before today\'s boundary catches up a dropped slot', () => {
  const decision = decideTrigger(base({ now: '2026-11-12T10:00:00Z', lastTagCommittedAt: '2026-11-10T16:00:00Z' }))
  assert.equal(decision.plan, true)
  assert.equal(decision.catchUp, true)
  assert.match(decision.reason, /^catch-up/)
})

test('case 5b: a morning push after the previous slot shipped is quiet, not a catch-up', () => {
  const decision = decideTrigger(base({ now: '2026-11-12T10:00:00Z', lastTagCommittedAt: '2026-11-11T16:00:00Z' }))
  assert.equal(decision.plan, false)
  assert.equal(decision.catchUp, false)
  assert.match(decision.reason, /^slot-shipped/)
})

test('case 6: schedule plans on the same state, and not when the branch exists', () => {
  assert.equal(decideTrigger(base({ event: 'schedule' })).plan, true)
  const blocked = decideTrigger(base({ event: 'schedule', branches: ['release/v0.3.2'] }))
  assert.equal(blocked.plan, false)
  assert.match(blocked.reason, /release\/v0\.3\.2/)
})

test('case 7: a planner guard refuses the night and the reason names the guard', () => {
  const decision = decideTrigger(base({ guardsPass: false, guardReason: 'not-enough-prs; 9 merged since v0.3.1' }))
  assert.equal(decision.plan, false)
  assert.match(decision.reason, /^guard: not-enough-prs/)
  assert.match(decision.reason, /9 merged since v0\.3\.1/)
})

test('the tag of the next version already existing blocks the night, whatever the clock says', () => {
  const decision = decideTrigger(base({ tags: ['v0.3.1', 'v0.3.2'] }))
  assert.equal(decision.plan, false)
  assert.match(decision.reason, /^tag-exists: v0\.3\.2/)
})

test('an unknown event never plans', () => {
  const decision = decideTrigger(base({ event: 'workflow_run' }))
  assert.equal(decision.plan, false)
  assert.match(decision.reason, /^unknown-event/)
})

test('a manual dispatch is evaluated like a schedule, so the summary can say what the night would do', () => {
  assert.equal(decideTrigger(base({ event: 'workflow_dispatch' })).plan, true)
})

test('an unreadable tag time fails closed: a slot that cannot be judged does not ship', () => {
  const decision = decideTrigger(base({ lastTagCommittedAt: 'yesterday-ish' }))
  assert.equal(decision.plan, false)
  assert.match(decision.reason, /^invalid-tag-time/)
})

test('no tag yet is not an unreadable tag: a first release plans when the guards pass', () => {
  const decision = decideTrigger(base({ lastTagCommittedAt: '', tags: [] }))
  assert.equal(decision.plan, true)
})

test('the branch, the pull request and the tag each outrank the clock, so the reason names the real blocker', () => {
  const blocked = decideTrigger(base({ lastTagCommittedAt: '2026-11-12T15:05:00Z', branches: ['release/v0.3.2'] }))
  assert.match(blocked.reason, /^branch-exists/)
})
