import test from 'node:test'
import assert from 'node:assert/strict'
import { freshnessRefusal, GATE_PATHS, parseGateChange } from '../scripts/lib/ci-freshness.mjs'

// #1338: a green may not be counted when it was produced before the gate that
// would have failed it. The comparison is one pure function so the sweep and its
// test share it; the recorded #1249 case is the shape this must refuse.

const STALE = {
  checkName: 'ci-ok',
  startedAt: '2026-11-23T08:34:56Z',
  base: { commit: '93307f5b7c2b0a5b9a4d3f2e1c0b9a8f7e6d5c4b', at: '2026-11-24T14:45:35Z', path: 'test/archBoundaries.test.ts' },
}

test('a check that started before the base gate change is refused with the three facts', () => {
  const refusal = freshnessRefusal(STALE)
  assert.equal(
    refusal,
    'freshness: ci-ok started 2026-11-23T08:34:56Z, before 93307f5b added test/archBoundaries.test.ts on 2026-11-24T14:45:35Z',
  )
})

test('a check that started after the base gate change is not refused', () => {
  assert.equal(freshnessRefusal({ ...STALE, startedAt: '2026-11-25T09:00:00Z' }), null)
  assert.equal(freshnessRefusal({ ...STALE, startedAt: '2026-11-24T14:45:35Z' }), null, 'the boundary is inclusive: same instant is fresh')
})

test('#1249 with no push to the head is refused: the ci-ok aggregate started 2026-11-23T08:38:07Z', () => {
  const refusal = freshnessRefusal({ ...STALE, startedAt: '2026-11-23T08:38:07Z' })
  assert.match(refusal ?? '', /^freshness: ci-ok started 2026-11-23T08:38:07Z, before 93307f5b added test\/archBoundaries\.test\.ts on 2026-11-24T14:45:35Z$/)
})

test('a check with no started_at is refused instead of assumed fresh', () => {
  const refusal = freshnessRefusal({ ...STALE, startedAt: undefined })
  assert.match(refusal ?? '', /^freshness: ci-ok has no started_at/)
  assert.match(freshnessRefusal({ ...STALE, startedAt: 'not-a-date' }) ?? '', /^freshness: ci-ok has no started_at/)
})

test('an unreadable or unresolvable base gate change is refused instead of assumed fresh', () => {
  assert.match(freshnessRefusal({ ...STALE, base: null }) ?? '', /^freshness: the base gate change cannot be resolved/)
  assert.match(freshnessRefusal({ ...STALE, base: { error: 'HTTP 500' } }) ?? '', /^freshness: the base gate change cannot be read \(HTTP 500\)/)
})

test('the gate paths cover the ratchet, the policy and the publisher', () => {
  for (const path of ['test/archBoundaries.test.ts', 'scripts/lib/arch-boundaries.mjs', 'scripts/ci-ok.mjs', '.github/workflows/ci.yml', '.github/agent/risk-rules.json']) {
    assert.ok(GATE_PATHS.includes(path), path)
  }
})

test('the git log line of the gate change resolves to its commit, instant and file', () => {
  const log = '93307f5b7c2b0a5b9a4d3f2e1c0b9a8f7e6d5c4b\n2026-11-24T14:45:35Z\ntest(arch): add import-boundary and file-size gates (#1228) (#1246)\n\ntest/archBoundaries.test.ts\nscripts/lib/arch-boundaries.mjs\n'
  assert.deepEqual(parseGateChange(log), {
    commit: '93307f5b7c2b0a5b9a4d3f2e1c0b9a8f7e6d5c4b',
    at: '2026-11-24T14:45:35Z',
    path: 'test/archBoundaries.test.ts',
  })
  assert.equal(parseGateChange(''), null)
})

test('the published payload carries the exact refusal line under the current policy', async () => {
  const { freshnessPayload } = await import('../scripts/lib/ci-freshness.mjs')
  const refusal = freshnessRefusal(STALE)
  assert.ok(refusal !== null, 'the recorded case is stale')
  const payload = freshnessPayload({ headSha: '4ea3de4435050335476729246c45e2dc3acc4a9e', policy: { text: 'policy: required=abc gate=' + 'a'.repeat(40) }, refusal })
  assert.equal(payload.name, 'ci-ok')
  assert.equal(payload.conclusion, 'failure')
  assert.match(payload.output.summary, /policy: required=abc gate=a{40}/)
  assert.ok(payload.output.summary.includes(refusal), 'the summary carries the exact line')
  assert.match(payload.output.summary, /reason: stale-freshness/)
})
