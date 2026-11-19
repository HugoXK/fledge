import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertShadowHost,
  compareVersions,
  loadFixtureSet,
  renderShadowRecord,
  runShadow,
  type ShadowAttempt,
  type ShadowFixture,
  type ShadowHost,
  type ShadowRecordedAttempt,
  type ShadowVersion,
} from '../src/lib/evaluation.js'
import { createMockShadowHost } from '../src/jobs/shadow.js'

// #372: the held-out harness. These tests pin the four properties the card asks
// for — a fixture produces a shadow pull request that is never merged, a version
// comparison carries an interval, a task every version solves is labelled, and a
// run without fixtures fails closed — plus the boundary that makes the harness
// safe to run: no live repository and no live token can reach it.

const root = fileURLToPath(new URL('..', import.meta.url))
const fixturePath = join(root, 'test/fixtures/shadow/holdout.json')

function fixtureSet() {
  return loadFixtureSet(readFileSync(fixturePath, 'utf8'))
}

/** A loop that answers per fixture and version, so a comparison is meaningful. */
function scriptedHost(answers: Record<string, Partial<ShadowAttempt>>): ShadowHost {
  return {
    name: 'scripted',
    signature: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    capabilities: { push: false, merge: false, liveAccess: false, tokens: false },
    run({ fixture, version }) {
      const answer = answers[`${version.id}/${fixture.id}`] ?? {}
      return {
        pullRequest: 'https://github.com/HugoXK/fledge/pull/1',
        merged: false,
        reviewScore: 90,
        verificationJson: JSON.stringify({ ok: true }),
        costUsd: 0.4,
        durationMs: 60_000,
        ...answer,
      }
    },
  }
}

const VERSIONS: ShadowVersion[] = [
  { id: 'playbook-a', playbook: 'a' },
  { id: 'playbook-b', playbook: 'b' },
]

test('a fixture produces a shadow pull request that is never merged', async () => {
  const set = fixtureSet()
  assert.ok(set.fixtures.length > 0)
  const recorded: ShadowRecordedAttempt[] = []
  const host = createMockShadowHost()
  const run = await runShadow(set, VERSIONS, host, {
    onAttempt: ({ fixture, version, attempt }) => {
      recorded.push({ fixtureId: fixture.id, version: version.id, ...attempt })
    },
  })
  assert.equal(run.ok, true)
  if (!run.ok) return
  assert.equal(recorded.length, set.fixtures.length * VERSIONS.length)
  for (const task of run.report.tasks) {
    assert.equal(task.merged, false, 'the harness must record that no shadow pull request was merged')
    assert.match(String(task.pullRequest), /^https:\/\/github\.com\/HugoXK\/fledge\/pull\/\d+$/)
  }
  assert.deepEqual(
    [...new Set(run.report.tasks.map((task) => task.fixtureId))].sort(),
    set.fixtures.map((fixture) => fixture.id).sort(),
  )
  // The record the recorder writes is the record `--attempts` reads back.
  const written = JSON.parse(renderShadowRecord({ host: { name: host.name, signature: host.signature }, attempts: recorded })) as {
    host: { name: string; signature: string }
    attempts: ShadowRecordedAttempt[]
  }
  assert.equal(written.host.signature, host.signature)
  assert.match(written.host.signature, /^sha256:[0-9a-f]{64}$/)
  assert.deepEqual(
    written.attempts.map((attempt) => `${attempt.version}/${attempt.fixtureId}`).sort(),
    run.report.tasks.map((task) => `${task.version}/${task.fixtureId}`).sort(),
  )
})

test('a version comparison shows a difference and a confidence interval', async () => {
  const set = fixtureSet()
  const [first, second] = set.fixtures
  assert.ok(first !== undefined && second !== undefined)
  const host = scriptedHost({
    // playbook-b fails two of the four; playbook-a fails none.
    [`playbook-b/${first.id}`]: { pullRequest: null, reviewScore: null, verificationJson: null, costUsd: 0 },
    [`playbook-b/${second.id}`]: { pullRequest: null, reviewScore: null, verificationJson: null, costUsd: 0 },
  })
  const run = await runShadow(set, VERSIONS, host)
  assert.equal(run.ok, true)
  const comparison = run.report.comparisons.find((entry) => entry.baseline === 'playbook-a' && entry.candidate === 'playbook-b')
  assert.ok(comparison !== undefined, 'the report compares the baseline with the candidate')
  assert.ok(comparison.delta > 0, 'the candidate is worse here, so the delta is not zero')
  assert.ok(comparison.interval[0] < comparison.delta && comparison.delta < comparison.interval[1])
  assert.ok(comparison.interval[0] <= 0 && comparison.interval[1] >= 0, 'four tasks cannot establish a difference')
  assert.equal(comparison.differs, false)
})

test('a task every version solves is labelled saturated', async () => {
  const set = fixtureSet()
  const run = await runShadow(set, VERSIONS, scriptedHost({}))
  assert.equal(run.ok, true)
  assert.deepEqual(
    run.report.saturated.map((entry) => entry.fixtureId).sort(),
    set.fixtures.map((fixture) => fixture.id).sort(),
  )
})

test('a run with no fixtures fails closed with a readable reason', async () => {
  const set = { ...fixtureSet(), fixtures: [] }
  const run = await runShadow(set, VERSIONS, scriptedHost({}))
  assert.equal(run.ok, false)
  if (run.ok) return
  assert.equal(run.code, 'NO_FIXTURES')
  assert.match(run.detail, /empty/i)
})

test('a loop that merges is refused instead of recorded as success', async () => {
  const set = fixtureSet()
  const base = scriptedHost({})
  const merging: ShadowHost = {
    ...base,
    run: async (input) => ({ ...(await base.run(input)), merged: true }),
  }
  const refused = await runShadow(set, VERSIONS, merging)
  assert.equal(refused.ok, false)
  if (!refused.ok) assert.equal(refused.code, 'MERGE_ATTEMPTED')
})

test('a host that could push, merge or read a live token is refused before any run', () => {
  const live: ShadowHost = {
    name: 'live',
    signature: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    capabilities: { push: true, merge: false, liveAccess: false, tokens: false },
    run: () => ({ pullRequest: null, merged: false, reviewScore: null, verificationJson: null, costUsd: 0, durationMs: 0 }),
  }
  const verdict = assertShadowHost(live)
  assert.equal(verdict.ok, false)
  if (!verdict.ok) assert.equal(verdict.code, 'LIVE_HOST')

  const unsigned: ShadowHost = { ...live, capabilities: { push: false, merge: false, liveAccess: false, tokens: false }, signature: '' }
  const unsignedVerdict = assertShadowHost(unsigned)
  assert.equal(unsignedVerdict.ok, false)
  if (!unsignedVerdict.ok) assert.equal(unsignedVerdict.code, 'UNSIGNED_HOST')
})

test('a fixture naming a live repository, or an unredacted set, is refused', async () => {
  const base = fixtureSet()
  const live = { ...base, fixtures: [{ ...(base.fixtures[0] as ShadowFixture), repository: { ...(base.fixtures[0] as ShadowFixture).repository, origin: 'live' as const } }] }
  const liveRun = await runShadow(live, VERSIONS, scriptedHost({}))
  assert.equal(liveRun.ok, false)
  if (!liveRun.ok) assert.equal(liveRun.code, 'LIVE_REPOSITORY')

  const unredacted = { ...base, redacted: false as unknown as true }
  const unredactedRun = await runShadow(unredacted, VERSIONS, scriptedHost({}))
  assert.equal(unredactedRun.ok, false)
  if (!unredactedRun.ok) assert.equal(unredactedRun.code, 'UNREDACTED_FIXTURES')
})

test('malformed fixture text is refused with a named code', () => {
  assert.throws(() => loadFixtureSet('{not json'), /MALFORMED_FIXTURES/)
})

test('the report carries no token-shaped string', async () => {
  const run = await runShadow(fixtureSet(), VERSIONS, scriptedHost({}))
  assert.equal(run.ok, true)
  if (!run.ok) return
  assert.doesNotMatch(JSON.stringify(run.report), /gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}/)
})

test('compareVersions reports an interval that excludes zero when every shared task differs', () => {
  const comparison = compareVersions(
    { version: 'a', results: [
      { fixtureId: 't1', success: true },
      { fixtureId: 't2', success: true },
    ] },
    { version: 'b', results: [
      { fixtureId: 't1', success: false },
      { fixtureId: 't2', success: false },
    ] },
  )
  assert.equal(comparison.baseline, 'a')
  assert.equal(comparison.candidate, 'b')
  assert.equal(comparison.delta, 1)
  assert.equal(comparison.sharedTasks, 2)
  assert.ok(comparison.interval[0] > 0 && comparison.interval[1] <= 1, 'the interval excludes zero')
  assert.equal(comparison.differs, true)
})
