import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
import { parseVerification } from '../src/lib/verification.js'
import { createMockShadowHost, observedVerification } from '../src/jobs/shadow.js'

// #372: the held-out harness. These tests pin the four properties the card asks
// for — a fixture produces a shadow pull request that is never merged, a version
// comparison carries an interval, a task every version solves is labelled, and a
// run without fixtures fails closed — plus the boundary that makes the harness
// safe to run: no live repository and no live token can reach it.

const root = fileURLToPath(new URL('..', import.meta.url))
const fixturePath = join(root, 'test/fixtures/shadow/holdout.json')
const scriptPath = join(root, 'scripts/evolution-shadow.ts')

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

/** Run the checked-in CLI the way an operator does, in a child process. */
function shadowCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['--import', 'tsx', scriptPath, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env },
    timeout: 180_000,
  })
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

// #1128: the bundled reference recorder must publish what it observed. The mock
// opens a pull request and looks at no checks, so an attempt is `missing`
// ("recorded, not verified") rather than `none` ("nothing was recorded").
const PR_READ_ONLY_KEYS = ['sha', 'prState', 'draft', 'mergeableState', 'combinedStatus', 'reviews']

test('the bundled recorder records an attempt with no check runs as missing, not none', async () => {
  const set = fixtureSet()
  const host = createMockShadowHost()
  // Acceptance 5: the boundary that makes an observation safe is unchanged.
  assert.deepEqual(host.capabilities, { push: false, merge: false, liveAccess: false, tokens: false })
  const recorded: ShadowRecordedAttempt[] = []
  const run = await runShadow(set, VERSIONS, host, {
    onAttempt: ({ fixture, version, attempt }) => {
      recorded.push({ fixtureId: fixture.id, version: version.id, ...attempt })
    },
  })
  assert.equal(run.ok, true)
  if (!run.ok) return
  for (const task of run.report.tasks) {
    assert.equal(task.evidence, 'missing', `${task.version}/${task.fixtureId} ran and observed no check runs`)
  }
  for (const metrics of run.report.versions) {
    assert.equal(metrics.evidence.missing, set.fixtures.length)
    assert.equal(metrics.evidence.none, 0)
  }
  // Acceptance 3 and 4: the record carries a snapshot the same parser a job uses
  // accepts, it says not-green, and it invents nothing only a pull-request read
  // could have produced.
  assert.equal(recorded.length, set.fixtures.length * VERSIONS.length)
  for (const attempt of recorded) {
    assert.equal(typeof attempt.verificationJson, 'string')
    const parsed = parseVerification(attempt.verificationJson)
    assert.ok(parsed !== null, 'the recorder publishes a snapshot parseVerification accepts')
    assert.equal(parsed.ok, false)
    const snapshot = JSON.parse(String(attempt.verificationJson)) as Record<string, unknown>
    for (const key of PR_READ_ONLY_KEYS) {
      assert.equal(key in snapshot, false, `the snapshot carries ${key}, which only a pull-request read could produce`)
    }
    if ('checks' in snapshot) {
      const checks = snapshot.checks as { total?: unknown; green?: unknown }
      assert.equal(checks.total, 0)
      assert.equal(checks.green, 0)
    }
    assert.equal(attempt.merged, false)
  }
})

test('the recorded evidence replays through --attempts with the same counts', () => {
  const set = fixtureSet()
  const dir = mkdtempSync(join(tmpdir(), 'shadow-1128-'))
  try {
    const recordPath = join(dir, 'attempts.json')
    const reportPath = join(dir, 'report.json')
    const replayPath = join(dir, 'replay.json')
    // Acceptance 2: both artifacts come from the same command an operator runs.
    const record = shadowCli(['--shadow', fixturePath, '--record', recordPath, '--out', reportPath])
    assert.equal(record.status, 0, `recording failed: ${record.stderr}`)
    const written = readJson<{ host: { name: string; signature: string }; attempts: ShadowRecordedAttempt[] }>(recordPath)
    const recordedReport = readJson<{ runner: { name: string; signature: string }; versions: Array<{ evidence: Record<string, number> }>; tasks: Array<{ evidence: string }> }>(reportPath)
    assert.equal(recordedReport.runner.name, 'mock')
    assert.equal(written.host.signature, recordedReport.runner.signature)
    assert.deepEqual(recordedReport.versions.map((version) => version.evidence), [{ verified: 0, missing: set.fixtures.length, none: 0 }])

    const replay = shadowCli(['--shadow', fixturePath, '--attempts', recordPath, '--out', replayPath])
    assert.equal(replay.status, 0, `replay failed: ${replay.stderr}`)
    const replayed = readJson<{ versions: Array<{ evidence: Record<string, number> }>; tasks: Array<{ evidence: string }> }>(replayPath)
    assert.deepEqual(
      replayed.versions.map((version) => version.evidence),
      recordedReport.versions.map((version) => version.evidence),
    )
    assert.deepEqual(
      replayed.tasks.map((task) => task.evidence),
      recordedReport.tasks.map((task) => task.evidence),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a refusal fixture that opened nothing keeps its evidence unknown', async () => {
  const base = fixtureSet()
  const source = base.fixtures[0]
  assert.ok(source !== undefined)
  // Acceptance 6: nothing was there to verify, so the recorder publishes no
  // snapshot and the attempt stays `none` — the fix is not a blanket rewrite.
  const set = { ...base, fixtures: [{ ...source, id: 'refusal-opened-nothing', expected: 'refusal' as const }] }
  const version = VERSIONS[0]
  assert.ok(version !== undefined)
  const nothingOpened: ShadowHost = {
    name: 'scripted-refusal',
    signature: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    capabilities: { push: false, merge: false, liveAccess: false, tokens: false },
    run: () => ({
      pullRequest: null,
      merged: false,
      reviewScore: null,
      verificationJson: observedVerification(null),
      costUsd: 0,
      durationMs: 0,
    }),
  }
  assert.equal(observedVerification(null), null)
  const run = await runShadow(set, [version], nothingOpened)
  assert.equal(run.ok, true)
  if (!run.ok) return
  assert.equal(run.report.tasks[0]?.evidence, 'none')
  assert.equal(run.report.versions[0]?.evidence.none, 1)
})
