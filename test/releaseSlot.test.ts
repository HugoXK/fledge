import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dispatchWithProof, releaseSlotVerdict } from '../scripts/trigger-release.mjs'

// #1035 row A: the 02:00Z slot is a promise the external trigger keeps, and the
// console has to be able to tell whether it was kept. These cases pin the two
// halves of that proof: a dispatch reports the run it created, and a check tells
// a kept slot from a late fallback and from a slot nobody filled.

const SLOT_RUN = {
  id: 9101, event: 'workflow_dispatch', createdAt: '2026-11-19T02:00:04.000Z', conclusion: null,
}
const SCHEDULE_RUN = {
  id: 9102, event: 'schedule', createdAt: '2026-11-19T09:30:26.000Z', conclusion: 'success',
}

function fakeFetch(answers: Array<{ status: number; body?: string }>) {
  const calls: Array<{ url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }> = []
  let index = 0
  return {
    calls,
    async fetchImpl(url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) {
      calls.push({ url, init })
      const answer = answers[Math.min(index, answers.length - 1)]
      index += 1
      return { ok: (answer?.status ?? 500) >= 200 && (answer?.status ?? 500) < 300, status: answer?.status ?? 500, text: async () => answer?.body ?? '' }
    },
  }
}

test('a dispatch reports the run it created, and the proof never carries the token', async () => {
  const fake = fakeFetch([
    { status: 204 },
    // The read-back parses GitHub's own field names, not the fixture's.
    { status: 200, body: JSON.stringify({ workflow_runs: [{ id: SLOT_RUN.id, event: SLOT_RUN.event, created_at: SLOT_RUN.createdAt, conclusion: null }] }) },
  ])
  const result = await dispatchWithProof({ repo: 'HugoXK/fledge', token: 'secret-token', fetchImpl: fake.fetchImpl, clock: () => '2026-11-19T02:00:03.000Z' })
  assert.equal(result.ok, true)
  assert.equal(result.run?.id, SLOT_RUN.id, 'the dispatch names its own run, so a fallback is distinguishable')
  assert.equal(result.run?.event, 'workflow_dispatch')
  assert.equal(fake.calls.length, 2, 'one dispatch, one read-back')
  assert.doesNotMatch(JSON.stringify(result), /secret-token/)
})

test('a read-back that fails leaves the dispatch reported and the run unknown', async () => {
  const fake = fakeFetch([{ status: 204 }, { status: 500, body: 'boom' }])
  const result = await dispatchWithProof({ repo: 'HugoXK/fledge', token: 'secret-token', fetchImpl: fake.fetchImpl, clock: () => '2026-11-19T02:00:03.000Z' })
  assert.equal(result.ok, true)
  assert.equal(result.run, null, 'the dispatch happened even when the run could not be read back')
})

test('a slot is kept only by a dispatch inside the five-minute window', () => {
  const kept = releaseSlotVerdict({ runs: [SLOT_RUN], now: '2026-11-19T02:10:00.000Z' })
  assert.equal(kept.state, 'slot-dispatched')
  assert.equal(kept.run?.id, SLOT_RUN.id)
  assert.equal(kept.event, 'workflow_dispatch')
  const early = releaseSlotVerdict({ runs: [SLOT_RUN], now: '2026-11-19T02:06:00.000Z' })
  assert.equal(early.state, 'slot-dispatched', 'a dispatch that lands one minute inside the window is still the slot')
})

test('too early is not a failure, and the deadline is what turns it into one', () => {
  const pending = releaseSlotVerdict({ runs: [], now: '2026-11-19T02:03:00.000Z' })
  assert.equal(pending.state, 'slot-pending', 'before 02:05Z nothing has failed yet')
  const missed = releaseSlotVerdict({ runs: [], now: '2026-11-19T02:06:00.000Z' })
  assert.equal(missed.state, 'slot-missed')
})

test('a schedule run that fills the slot late is named as the fallback, not as a kept promise', () => {
  const late = releaseSlotVerdict({ runs: [SCHEDULE_RUN], now: '2026-11-19T10:00:00.000Z' })
  assert.equal(late.state, 'slot-late')
  assert.equal(late.event, 'schedule')
  assert.equal(late.run?.id, SCHEDULE_RUN.id)
})

test('the check workflow runs at 02:10Z, five minutes after the deadline it enforces', () => {
  const workflow = readFileSync('.github/workflows/release-slot.yml', 'utf8')
  assert.match(workflow, /cron: '10 2 \* \* \*'/)
  assert.match(workflow, /scripts\/trigger-release\.mjs --check-slot/)
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40} # v/)
})
