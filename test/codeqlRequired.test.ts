import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// #304: a red CodeQL analysis blocked nothing. `analyze` lives in its own
// workflow (`codeql.yml`), so `ci-ok` in `ci.yml` could never aggregate its
// conclusion, and no required context named the job — a pull request could add a
// high result and merge with every required check green.
//
// The decision is a function, not a workflow: `codeqlRequired(input, lookups,
// clock)`. The lookups and the clock are injected, so these tests drive every
// outcome without Actions and without sleeping. The two disagree in one place
// and it matters: reading the wrong commit turns a gate into a queue-wide block,
// which is why the `merge_group` and the still-running cases come first.

const ciWorkflowPath = fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url))
const codeqlWorkflowPath = fileURLToPath(new URL('../.github/workflows/codeql.yml', import.meta.url))
const libUrl = new URL('../scripts/lib/codeql-required.mjs', import.meta.url).href
const codeqlCliPath = fileURLToPath(new URL('../scripts/codeql-required.mjs', import.meta.url))

interface Analysis {
  conclusion: string
}

interface Lookups {
  analysisFor: (sha: string) => Promise<Analysis | null>
}

interface Clock {
  now: () => number
  sleep: (ms: number) => Promise<void>
}

interface Verdict {
  ok: boolean
  reason: string
  sha: string | null
  polls: number
}

interface CodeqlRequiredInput {
  eventName: string
  sha: string
  payload: Record<string, unknown>
  waitMs?: number
  pollMs?: number
}

interface Lib {
  codeqlRequired: (input: CodeqlRequiredInput, lookups: Lookups, clock: Clock) => Promise<Verdict>
  shaForEvent: (input: { eventName: string; sha: string; payload: Record<string, unknown> }) => string | null
  DEFAULT_WAIT_MS: number
  DEFAULT_POLL_MS: number
}

// A dynamic import on purpose: this file has to be readable and runnable before
// the module exists, so the red is a named failing test rather than a crash.
async function lib(): Promise<Lib> {
  return (await import(libUrl)) as Lib
}

// A clock whose `sleep` only moves time forward. The bounded wait is proved by
// arithmetic, so ten minutes of waiting costs nothing here.
function fakeClock(): Clock & { slept: number[] } {
  let now = 0
  const slept: number[] = []
  return {
    now: () => now,
    sleep: async (ms: number) => {
      slept.push(ms)
      now += ms
    },
    slept,
  }
}

const SHA = 'a'.repeat(40)

test('a merge group reads the queued pull request head, never the synthetic merge commit', async () => {
  const { codeqlRequired } = await lib()
  const synthetic = 'f'.repeat(40)
  const queued = 'c'.repeat(40)
  const asked: string[] = []
  const lookups: Lookups = {
    analysisFor: async (sha) => {
      asked.push(sha)
      // Only the queued head was ever analyzed: `codeql.yml` has no
      // `merge_group:` trigger, so the synthetic commit has no run at all.
      return sha === queued ? { conclusion: 'success' } : null
    },
  }
  const clock = fakeClock()
  const result = await codeqlRequired(
    {
      eventName: 'merge_group',
      sha: synthetic,
      payload: { merge_group: { head_sha: synthetic, pull_requests: [{ head_sha: queued }] } },
    },
    lookups,
    clock,
  )
  assert.equal(result.ok, true, `a green queued head must pass: ${result.reason}`)
  assert.deepEqual(asked, [queued], 'the lookup must be asked for pull_requests[0].head_sha, the commit its own pull request run analyzed')
  assert.ok(!asked.includes(synthetic), 'waiting on the synthetic merge commit blocks every queue entry, because nothing analyzes it')
})

test('an analysis still running at the first poll does not fail, and one that lands green inside the bound passes', async () => {
  const { codeqlRequired } = await lib()
  let calls = 0
  const lookups: Lookups = {
    analysisFor: async () => {
      calls += 1
      // Not complete for the first three polls, then green.
      return calls < 4 ? null : { conclusion: 'success' }
    },
  }
  const clock = fakeClock()
  const result = await codeqlRequired({ eventName: 'pull_request', sha: SHA, payload: {} }, lookups, clock)
  assert.equal(result.ok, true, `an analysis that completes inside the bound must pass: ${result.reason}`)
  assert.equal(calls, 4, 'the first poll must not be a verdict; a slow analysis is not a red one')
  const waited: number = clock.slept.reduce((total, ms) => total + ms, 0)
  assert.ok(waited > 0 && waited < 600_000, `the pass must land inside the bound, waited ${String(waited)}ms`)
})

test('an absent analysis fails only after the bounded wait, and the wait is bounded', async () => {
  const { codeqlRequired, DEFAULT_WAIT_MS, DEFAULT_POLL_MS } = await lib()
  const clock = fakeClock()
  const lookups: Lookups = { analysisFor: async () => null }
  const result = await codeqlRequired({ eventName: 'push', sha: SHA, payload: {} }, lookups, clock)
  assert.equal(result.ok, false, 'an analysis that never arrives must not pass the required check')
  assert.equal(DEFAULT_WAIT_MS, 10 * 60 * 1000, 'the card fixes the bound at ten minutes')
  assert.equal(DEFAULT_POLL_MS, 20 * 1000, 'the card fixes the interval at twenty seconds')
  const waited: number = clock.slept.reduce((total, ms) => total + ms, 0)
  assert.equal(waited, DEFAULT_WAIT_MS, 'the wait stops at the bound instead of polling forever')
  assert.equal(waited / DEFAULT_POLL_MS, 30, 'thirty intervals of twenty seconds is ten minutes')
  assert.ok(clock.slept.length > 1, 'failing on the first poll would red every pull request whose analysis has not started yet')
  assert.match(result.reason, new RegExp(SHA), 'the reason must name the commit so a maintainer can find the run')
})

test('a red analysis fails the required check and names the commit and the conclusion', async () => {
  const { codeqlRequired } = await lib()
  const asked: string[] = []
  const lookups: Lookups = {
    analysisFor: async (sha) => {
      asked.push(sha)
      return { conclusion: 'failure' }
    },
  }
  const clock = fakeClock()
  const result = await codeqlRequired({ eventName: 'pull_request', sha: SHA, payload: {} }, lookups, clock)
  assert.equal(result.ok, false, 'a red analysis must not pass the required check')
  assert.match(result.reason, new RegExp(SHA), 'the reason must name the commit')
  assert.match(result.reason, /failure/, 'the reason must name the conclusion the analysis reached')
  assert.deepEqual(asked, [SHA], 'the sha the lookup was called with is the one under test')
  assert.equal(clock.slept.length, 0, 'an answer is a verdict; there is nothing to wait for')
})

test('a scheduled analysis observes and does not gate a merge', async () => {
  const { codeqlRequired } = await lib()
  let called = false
  const lookups: Lookups = {
    analysisFor: async () => {
      called = true
      return null
    },
  }
  const result = await codeqlRequired({ eventName: 'schedule', sha: '', payload: {} }, lookups, fakeClock())
  assert.equal(result.ok, true, 'the weekly analysis runs on main with nothing to gate')
  assert.equal(called, false, 'a scheduled run has no merge to hold; it must not wait on a lookup')
  assert.match(result.reason, /schedule/i, 'the summary has to say why it did nothing')
})

test('the commit read is decided by the event', async () => {
  const { shaForEvent } = await lib()
  const head = 'h'.repeat(40)
  const merge = 'm'.repeat(40)
  const synthetic = 'f'.repeat(40)
  assert.equal(shaForEvent({ eventName: 'push', sha: head, payload: {} }), head)
  assert.equal(shaForEvent({ eventName: 'workflow_dispatch', sha: head, payload: {} }), head)
  assert.equal(
    shaForEvent({ eventName: 'pull_request', sha: merge, payload: { pull_request: { head: { sha: head } } } }),
    head,
    'a pull request run reports the head its own analysis ran on; GITHUB_SHA there is the refs/pull/N/merge commit',
  )
  assert.equal(
    shaForEvent({ eventName: 'merge_group', sha: synthetic, payload: { merge_group: { head_sha: synthetic, pull_requests: [{ head_sha: head }] } } }),
    head,
    'the queued pull request head is the analyzed commit, not the synthetic one',
  )
  assert.equal(shaForEvent({ eventName: 'schedule', sha: head, payload: {} }), null)
})

test('codeql-required is in ci-ok needs, is never skippable, and adds no merge_group trigger to the analysis', async () => {
  const ciOk = (await import('../scripts/ci-ok.mjs')) as { REQUIRED_JOBS: string[]; SKIPPABLE_ON: Record<string, string[]> }
  assert.ok(ciOk.REQUIRED_JOBS.includes('codeql-required'), 'the aggregate gate has to require the CodeQL verdict')
  assert.equal(
    ciOk.SKIPPABLE_ON['codeql-required'],
    undefined,
    'a gate skipped on the only event that merges is vacuous; the job itself exits 0 on schedule and says why',
  )

  const ci = readFileSync(ciWorkflowPath, 'utf8')
  const start = ci.indexOf('\n  ci-ok:')
  assert.ok(start !== -1, 'ci.yml must declare the ci-ok job')
  const needs = /needs:\s*\[([^\]]*)\]/.exec(ci.slice(start))
  assert.ok(needs !== null, 'the ci-ok job must declare needs as an inline list so it can be read here')
  const listed = needs[1]!.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
  assert.ok(listed.includes('codeql-required'), `ci-ok needs must include codeql-required, found ${listed.join(', ')}`)

  const jobStart = ci.indexOf('\n  codeql-required:')
  assert.ok(jobStart !== -1, 'ci.yml must declare the codeql-required job')
  const job = ci.slice(jobStart, ci.indexOf('\n  ci-ok:', jobStart))
  assert.match(job, /run: node scripts\/codeql-required\.mjs/, 'the job must run the decision script')
  assert.match(job, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/, 'a step inherits no token, so the lookup needs one mapped the way review-gate.yml maps it')
  assert.match(job, /actions: read/, 'reading this repository\'s workflow runs needs actions: read, and a job-level block replaces the workflow set')

  assert.doesNotMatch(
    readFileSync(codeqlWorkflowPath, 'utf8'),
    /^  merge_group:$/m,
    'running the analysis on a synthetic commit nobody ships doubles the minutes for no extra evidence',
  )
})

interface WorkflowRun {
  head_sha: string
  conclusion: string
  pull_requests?: { head: { sha: string } }[]
}

// #422: `analysisFor` matched a run whose `pull_requests[].head.sha` was the
// commit under test. GitHub fills that field from the pull request's *current*
// head, so every superseded run of the same pull request claimed to be about the
// newest tip, and a stale failure answered a commit whose own analysis was still
// running. The list below is the shape the API returns — newest run first — and
// the ordering is not the bug: the predicate is.
test('the analysis matcher answers only the commit the run actually analysed', async () => {
  const { analysisFor } = (await import(libUrl)) as unknown as {
    analysisFor: (runs: WorkflowRun[], sha: string) => Analysis | null
  }
  const tip = 'd'.repeat(40)
  const older = 'e'.repeat(40)
  const supersededFailure: WorkflowRun = {
    head_sha: older,
    conclusion: 'failure',
    pull_requests: [{ head: { sha: tip } }],
  }
  const exactSuccess: WorkflowRun = { head_sha: tip, conclusion: 'success' }

  // 1. the measured #404 case: the newest completed run is the superseded
  // failure, and the tip's own analysis has already concluded success. Today the
  // live-head arm selects the failure.
  assert.deepEqual(analysisFor([supersededFailure, exactSuccess], tip), { conclusion: 'success' })
  // 2. superseded only: no analysis yet, so the gate stays pending. Adopting the
  // other commit's conclusion is the false red the card measured.
  assert.equal(analysisFor([supersededFailure], tip), null)
  // 3. two exact matches that disagree: the first (newest) wins, exactly as the
  // API order already gives it. This pins the ordering so a later refactor
  // cannot silently flip it.
  assert.deepEqual(analysisFor([{ head_sha: tip, conclusion: 'failure' }, exactSuccess], tip), { conclusion: 'failure' })
  // 4. the control: a matcher that never matched would satisfy 1 and 2 while
  // reddening every pull request.
  assert.deepEqual(analysisFor([exactSuccess], tip), { conclusion: 'success' })
})

test('the CLI delegates the match to the lib and carries no live-head arm', () => {
  const cli = readFileSync(codeqlCliPath, 'utf8')
  assert.match(cli, /import \{[^}]*analysisFor[^}]*\} from '\.\/lib\/codeql-required\.mjs'/, 'the matcher lives in the lib, where the suite can drive it')
  assert.doesNotMatch(cli, /pull_requests/, 'a live pull request head is not an input to the matcher')
})
