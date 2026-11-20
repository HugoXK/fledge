import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { validateBaseline } from '../scripts/lib/codeql-alerts.mjs'

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
  // The optional hint carries the absolute deadline the module computed, so an
  // implementation that has to page the API can stop inside the same bound.
  analysisFor: (sha: string, hint?: { deadline?: number }) => Promise<Analysis | null>
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

interface ApiOptions {
  api: (path: string) => Promise<unknown>
  repo: string
  sha: string
  now?: () => number
  deadline?: number
  perPage?: number
  maxPages?: number
}

interface Lib {
  codeqlRequired: (input: CodeqlRequiredInput, lookups: Lookups, clock: Clock) => Promise<Verdict>
  shaForEvent: (input: { eventName: string; sha: string; payload: Record<string, unknown> }) => string | null
  analysisFromApi: (options: ApiOptions) => Promise<Analysis | null>
  DEFAULT_WAIT_MS: number
  DEFAULT_POLL_MS: number
  MAX_FALLBACK_PAGES: number
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


test('the live CodeQL baseline is well-formed, owned and unexpired', () => {
  const baseline = JSON.parse(readFileSync(new URL('../.github/agent/codeql-baseline.json', import.meta.url), 'utf8'))
  const checked = validateBaseline(baseline, Date.now())
  assert.deepEqual(checked.errors, [], 'the recorded baseline must pass its own reader')
  assert.equal(checked.entries.filter((entry) => entry.dismissed === true).length, 3, 'the three dismissed results keep their record')
  assert.equal(checked.entries.filter((entry) => entry.dismissed !== true).length, 4, 'the four open results stay open')
})

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
  // #640: the decision script runs from the base branch tree, so a pull request
  // cannot edit the code that reads its own analysis.
  assert.match(job, /run: node base\/scripts\/codeql-required\.mjs/, 'the job must run the base branch copy of the decision script')
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
  conclusion: string | null
  status?: string
  pull_requests?: { head: { sha: string } }[]
}

interface WorkflowRun {
  head_sha: string
  conclusion: string | null
  status?: string
  pull_requests?: { head: { sha: string } }[]
}

// #422: `analysisFor` matched a run whose `pull_requests[].head.sha` was the
// commit under test. GitHub fills that field from the pull request's *current*
// head, so every superseded run of the same pull request claimed to be about the
// newest tip, and a stale failure answered a commit whose own analysis was still
// running. The lists below are the shape the API returns — newest run first — and
// the ordering is not the bug: the predicate is. Each case is its own test so
// the base can be read per case rather than stopping at the first failure.
const TIP = 'd'.repeat(40)
const OLDER = 'e'.repeat(40)
const supersededFailure: WorkflowRun = {
  head_sha: OLDER,
  status: 'completed',
  conclusion: 'failure',
  pull_requests: [{ head: { sha: TIP } }],
}
const exactSuccess: WorkflowRun = { head_sha: TIP, status: 'completed', conclusion: 'success' }

async function matcher(): Promise<(runs: WorkflowRun[], sha: string) => Analysis | null> {
  const { analysisFor } = (await import(libUrl)) as unknown as {
    analysisFor: (runs: WorkflowRun[], sha: string) => Analysis | null
  }
  return analysisFor
}

test('the CodeQL matcher answers the tip from its own run, not from a superseded one that advertises it', async () => {
  // The measured #404 case: the newest completed run analysed an older commit
  // and failed, while the tip's own analysis has already concluded success.
  const analysisFor = await matcher()
  assert.deepEqual(analysisFor([supersededFailure, exactSuccess], TIP), { conclusion: 'success' })
})

test('the CodeQL matcher stays pending when only a superseded run exists', async () => {
  // No analysis of this commit yet: the gate must wait, never adopt another
  // commit's conclusion. Adopting it is the false red the card measured.
  const analysisFor = await matcher()
  assert.equal(analysisFor([supersededFailure], TIP), null)
})

test('the CodeQL matcher takes the first exact match when two disagree', async () => {
  // The API returns newest first and `.find()` keeps that order; this pins the
  // ordering so a later refactor cannot silently flip the verdict.
  const analysisFor = await matcher()
  assert.deepEqual(analysisFor([{ head_sha: TIP, status: 'completed', conclusion: 'failure' }, exactSuccess], TIP), { conclusion: 'failure' })
})

test('the CodeQL matcher still answers a lone exact match', async () => {
  // The control: a matcher that never matched would satisfy the two cases above
  // while reddening every pull request.
  const analysisFor = await matcher()
  assert.deepEqual(analysisFor([exactSuccess], TIP), { conclusion: 'success' })
})

test('the CLI delegates the match to the lib and carries no live-head arm', () => {
  const cli = readFileSync(codeqlCliPath, 'utf8')
  assert.match(cli, /import \{[^}]*analysisFromApi[^}]*\} from '\.\/lib\/codeql-required\.mjs'/, 'the lookup lives in the lib, where the suite can drive it against a fake API')
  assert.doesNotMatch(cli, /pull_requests/, 'a live pull request head is not an input to the matcher')
})

// #585: the gate asked for a *window* of newest runs and looked for the commit
// inside it. On a busy repository the commit's own run fell outside that page,
// so a green analysis read as "no analysis", the job polled its full ten
// minutes, and `ci-ok` reddened a mergeable pull request. The fix is to ask for
// the commit (`?head_sha=…`) and keep the exact predicate; these cases pin the
// request shape, the pending case, and the bounded fallback that must never
// adopt a neighbouring commit's run.
interface ApiPage {
  total_count?: number
  workflow_runs?: WorkflowRun[]
}

interface Api {
  (path: string): Promise<ApiPage>
}

function urlOf(path: string): URL {
  return new URL(path, 'https://api.github.com')
}

function param(path: string, name: string): string | null {
  return urlOf(path).searchParams.get(name)
}

// A fake GitHub that records every request path, so a case can assert *how* the
// commit was asked for and not only what the answer was.
function recordingApi(respond: (path: string) => ApiPage): { api: Api; paths: string[] } {
  const paths: string[] = []
  return {
    api: async (path: string) => {
      paths.push(path)
      return respond(path)
    },
    paths,
  }
}

const OTHER = 'b'.repeat(40)

// A full page of runs for other commits, in the API's newest-first order.
function windowOf(count: number): WorkflowRun[] {
  return Array.from({ length: count }, (_, index) => ({
    head_sha: `${OTHER.slice(0, 34)}${String(index).padStart(6, '0')}`,
    status: 'completed',
    conclusion: 'success',
  }))
}

test('the analysis lookup asks for the commit, not for a window of newest runs', async () => {
  const { analysisFromApi } = await lib()
  const { api, paths } = recordingApi((path) =>
    param(path, 'head_sha') === TIP ? { total_count: 1, workflow_runs: [exactSuccess] } : { total_count: 878, workflow_runs: windowOf(100) },
  )
  const analysis = await analysisFromApi({ api, repo: 'HugoXK/fledge', sha: TIP })
  assert.deepEqual(analysis, { conclusion: 'success' }, 'a concluded analysis for this commit answers it')
  assert.equal(paths.length, 1, 'one filtered request answers it; scanning a newest-runs window is the defect')
  assert.equal(param(paths[0]!, 'head_sha'), TIP, 'the commit under test has to be in the query, or the page is a window it can fall out of')
  // #1032: completion is decided on the run itself, so the request must not ask
  // GitHub's status index to filter. That index has answered `total_count: 0`
  // for commits whose completed run it happily returns without the parameter.
  assert.equal(param(paths[0]!, 'status'), null, 'the request must not depend on the status-filtered index')
})

test('a commit whose run is outside the newest page still answers from its own sha', async () => {
  // The measured #532 shape: run 43463845160 is pull_request/success for
  // 34dc6c7f…, `?head_sha=` answers total_count 1, and the unfiltered window is
  // 878 runs whose newest 100 do not contain it.
  const { analysisFromApi } = await lib()
  const measured = '34dc6c7fd8ce02a25c714122332138171d0952e2'
  const { api, paths } = recordingApi((path) =>
    param(path, 'head_sha') === measured
      ? { total_count: 1, workflow_runs: [{ head_sha: measured, status: 'completed', conclusion: 'success' }] }
      : { total_count: 878, workflow_runs: windowOf(100) },
  )
  const analysis = await analysisFromApi({ api, repo: 'HugoXK/fledge', sha: measured })
  assert.deepEqual(analysis, { conclusion: 'success' }, 'a green analysis must not read as absent because the repository is busy')
  assert.equal(paths.length, 1, 'the answer is one request away when the query names the commit')
})

// #1032: GitHub's status index has answered `total_count: 0` for commits whose
// completed analysis exists and is returned without the filter — measured on two
// live `main` commits, both re-probed long after their runs had concluded. A gate
// that trusts that index waits out its ten minutes and reddens a green analysis,
// so the request stops asking for the filtered collection and completion is
// decided on the run itself.
const completedForTip: WorkflowRun = { head_sha: TIP, status: 'completed', conclusion: 'success' }

test('a status index that answers zero does not hide the commit\'s completed analysis', async () => {
  const { analysisFromApi } = await lib()
  const { api, paths } = recordingApi((path) =>
    param(path, 'status') === 'completed'
      ? { total_count: 0, workflow_runs: [] }
      : { total_count: 1, workflow_runs: [completedForTip] },
  )
  const analysis = await analysisFromApi({ api, repo: 'HugoXK/fledge', sha: TIP })
  assert.deepEqual(analysis, { conclusion: 'success' }, 'the filtered index answering zero is not evidence that no analysis concluded')
  assert.equal(paths.length, 1, 'the commit is in the query, so one request answers it')
})

test('the gate answers green in one poll instead of spending the wait on a filtered zero', async () => {
  const { analysisFromApi, codeqlRequired } = await lib()
  const clock = fakeClock()
  const { api } = recordingApi((path) =>
    param(path, 'status') === 'completed'
      ? { total_count: 0, workflow_runs: [] }
      : { total_count: 1, workflow_runs: [completedForTip] },
  )
  const lookups: Lookups = {
    analysisFor: async (asked, hint) =>
      analysisFromApi({
        api,
        repo: 'HugoXK/fledge',
        sha: asked,
        ...(hint?.deadline === undefined ? {} : { deadline: hint.deadline }),
      }),
  }
  const verdict = await codeqlRequired({ eventName: 'push', sha: TIP, payload: {}, waitMs: 600_000, pollMs: 20_000 }, lookups, clock)
  assert.equal(verdict.ok, true, verdict.reason)
  assert.equal(verdict.polls, 1, 'a concluded analysis is the first poll\'s answer, not the last one')
  assert.deepEqual(clock.slept, [], 'a verdict on the first answer must not sleep first')
})

test('a run of this commit that has not concluded stays pending', async () => {
  const { analysisFromApi } = await lib()
  const { api } = recordingApi(() => ({
    total_count: 1,
    workflow_runs: [{ head_sha: TIP, status: 'in_progress', conclusion: null }],
  }))
  const analysis = await analysisFromApi({ api, repo: 'HugoXK/fledge', sha: TIP })
  assert.equal(analysis, null, 'a queued or in-progress run is not a verdict, whatever the request asks the API')
})

test('the local filter, not the query, is what excludes a run that has not concluded', async () => {
  const { analysisFromApi } = await lib()
  const { api, paths } = recordingApi(() => ({
    total_count: 2,
    workflow_runs: [{ head_sha: TIP, status: 'in_progress', conclusion: null }, completedForTip],
  }))
  const analysis = await analysisFromApi({ api, repo: 'HugoXK/fledge', sha: TIP })
  assert.deepEqual(analysis, { conclusion: 'success' }, 'the concluded run of this commit answers even when a newer one is still running')
  assert.equal(param(paths[0]!, 'status'), null, 'completion is a local decision, so the request carries no status parameter')
})

test('a commit with more runs than the probe page still reaches its completed run', async () => {
  // Twelve runs of one commit: the ten newest are still queued and the two
  // oldest concluded. A probe page of ten cannot see the answer, so the lookup
  // has to page inside that commit's own history instead of answering null.
  const { analysisFromApi } = await lib()
  const runs: WorkflowRun[] = [
    ...Array.from({ length: 10 }, () => ({ head_sha: TIP, status: 'in_progress', conclusion: null })),
    completedForTip,
    { head_sha: TIP, status: 'completed', conclusion: 'failure' },
  ]
  const { api, paths } = recordingApi((path) => {
    const page = Number(param(path, 'page') ?? '1')
    const perPage = Number(param(path, 'per_page') ?? '30')
    const start = (page - 1) * perPage
    return { total_count: runs.length, workflow_runs: runs.slice(start, start + perPage) }
  })
  const analysis = await analysisFromApi({ api, repo: 'HugoXK/fledge', sha: TIP })
  assert.deepEqual(analysis, { conclusion: 'success' }, 'a page of still-running jobs must not hide the concluded run behind it')
  assert.ok(paths.length <= 1 + 10, `the page walk is bounded, made ${String(paths.length)} request(s)`)
})

test('a commit with no completed analysis stays pending and starts no page scan', async () => {
  const { analysisFromApi } = await lib()
  const { api, paths } = recordingApi(() => ({ total_count: 0, workflow_runs: [] }))
  const analysis = await analysisFromApi({ api, repo: 'HugoXK/fledge', sha: TIP })
  assert.equal(analysis, null, 'an analysis that has not concluded is pending, and the caller owns the wait')
  assert.equal(paths.length, 1, 'no analysis means nothing to page through; scanning here would be ten minutes of requests')
})

test('a neighbouring run that advertises this commit never answers for it', async () => {
  // #422's regression guard: every superseded run of a pull request carries the
  // current tip in `pull_requests[].head.sha`. Adopting one is a verdict on
  // another commit's analysis.
  const { analysisFromApi } = await lib()
  const neighbour: WorkflowRun = { head_sha: OTHER, status: 'completed', conclusion: 'failure', pull_requests: [{ head: { sha: TIP } }] }
  const { api, paths } = recordingApi(() => ({ total_count: 878, workflow_runs: [neighbour, ...windowOf(99)] }))
  const analysis = await analysisFromApi({ api, repo: 'HugoXK/fledge', sha: TIP })
  assert.equal(analysis, null, 'no run analysed this commit, so the gate must stay pending rather than adopt a neighbour')
  assert.ok(paths.length <= 1 + 10, `a filter the API ignores must be paged a bounded number of times, made ${String(paths.length)} request(s)`)
})

test('a lookup that ignores the sha filter is paged, and the fallback finds the commit', async () => {
  // Some deployments drop an unknown query parameter and answer the unfiltered
  // list. The fallback may then scan pages, but only within the caller's budget.
  const { analysisFromApi, MAX_FALLBACK_PAGES } = await lib()
  const answer = (path: string): ApiPage => {
    const page = Number(param(path, 'page') ?? '1')
    if (page === 3) return { total_count: 878, workflow_runs: [exactSuccess] }
    return { total_count: 878, workflow_runs: windowOf(100) }
  }
  const { api, paths } = recordingApi(answer)
  const analysis = await analysisFromApi({ api, repo: 'HugoXK/fledge', sha: TIP })
  assert.deepEqual(analysis, { conclusion: 'success' }, 'the fallback has to find the run it was paged for')
  assert.ok(paths.length <= 1 + MAX_FALLBACK_PAGES, `the scan stops at the page cap, made ${String(paths.length)} request(s)`)
})

test('the fallback scan stops at the caller deadline instead of scanning a huge window', async () => {
  const { analysisFromApi } = await lib()
  let elapsed = 0
  const now = (): number => (elapsed += 1_000)
  const { api, paths } = recordingApi(() => ({ total_count: 878, workflow_runs: windowOf(100) }))
  const analysis = await analysisFromApi({ api, repo: 'HugoXK/fledge', sha: TIP, now, deadline: 1_500, maxPages: 50 })
  assert.equal(analysis, null, 'a run that never appears must not be invented')
  assert.ok(paths.length <= 3, `the scan is bounded by the deadline, made ${String(paths.length)} request(s)`)
})

test('each poll hands the lookup its deadline so a fallback scan cannot outlive the bound', async () => {
  const { codeqlRequired } = await lib()
  const clock = fakeClock()
  const seen: (number | undefined)[] = []
  const lookups: Lookups = {
    analysisFor: async (_sha, hint) => {
      seen.push(hint?.deadline)
      return null
    },
  }
  await codeqlRequired({ eventName: 'push', sha: SHA, payload: {}, waitMs: 100, pollMs: 10 }, lookups, clock)
  assert.ok(seen.length > 1, 'the absent-analysis case still polls inside the bound')
  assert.equal(seen[0], 100, 'the first poll carries the absolute deadline the module computed')
  assert.ok(seen.every((deadline) => deadline === 100), 'every poll inside one run carries the same deadline')
})

// #752: `codeql.yml` filters its own trigger (`paths-ignore`). A pull request
// whose every changed path is ignored gets no analysis at all, and the gate then
// sat on its ten-minute bound and reddened `ci-ok` for a run that was never meant
// to exist. The decision belongs here, where it can be driven without Actions;
// the ignore list itself belongs in the workflow file, because a copy of it in
// this module would drift from the workflow it describes.
interface ChangeInventory {
  paths: string[]
  patterns: string[]
}

interface InventoryLookups extends Lookups {
  changeInventory?: () => Promise<ChangeInventory | null>
}

interface IgnoreLib {
  pathsIgnoreFromWorkflow: (text: string) => string[]
  matchesIgnoredPath: (path: string, patterns: string[]) => boolean
  onlyIgnoredPaths: (paths: string[], patterns: string[]) => boolean
  changedPathsFromApi: (options: {
    api: (path: string) => Promise<unknown>
    repo: string
    base: string
    head: string
    maxPages?: number
    perPage?: number
  }) => Promise<string[] | null>
  changeInventory: (options: {
    api: (path: string) => Promise<unknown>
    repo: string
    base: string
    head: string
    maxPages?: number
    perPage?: number
  }) => Promise<ChangeInventory | null>
  MAX_COMPARE_PAGES: number
}

async function ignoreLib(): Promise<IgnoreLib> {
  return (await import(libUrl)) as unknown as IgnoreLib
}

const REAL_IGNORE = ['docs/**', '**/*.md', 'LICENSE', 'deploy/**', 'Dockerfile']

test('an ignored-only change set answers instead of waiting out the bound', async () => {
  const { codeqlRequired } = await lib()
  const clock = fakeClock()
  let polled = 0
  const lookups: InventoryLookups = {
    analysisFor: async () => {
      polled += 1
      return null
    },
    changeInventory: async () => ({ paths: ['AGENTS.md', 'docs/deploy.md'], patterns: REAL_IGNORE }),
  }
  const result = await codeqlRequired({ eventName: 'pull_request', sha: SHA, payload: {} }, lookups, clock)
  assert.equal(result.ok, true, `an ignored-only diff cannot produce an analysis: ${result.reason}`)
  assert.equal(result.polls, 0, 'the answer is reached before the first poll, not after the bound')
  assert.equal(polled, 0, 'the gate must not even look for an analysis it knows cannot exist')
  assert.equal(clock.slept.length, 0, 'ten minutes of sleeping is the defect this card removes')
  assert.match(result.reason, /ignore/i, 'the summary has to say why no analysis was expected')
  assert.match(result.reason, new RegExp(SHA))
})

test('the control: one analysed path in the change set and the gate waits as before', async () => {
  const { codeqlRequired } = await lib()
  const clock = fakeClock()
  const lookups: InventoryLookups = {
    analysisFor: async () => null,
    changeInventory: async () => ({ paths: ['AGENTS.md', 'src/app.ts'], patterns: REAL_IGNORE }),
  }
  const result = await codeqlRequired({ eventName: 'pull_request', sha: SHA, payload: {}, waitMs: 100, pollMs: 10 }, lookups, clock)
  assert.equal(result.ok, false, 'a change CodeQL does analyse must not be excused by the ignored paths beside it')
  assert.ok(clock.slept.length > 0, 'the gate still waits inside its bound for a real analysis')
})

test('an inventory that cannot be read, or is empty, does not shrink the gate', async () => {
  const { codeqlRequired } = await lib()
  const unanswered: InventoryLookups = {
    analysisFor: async () => null,
    changeInventory: async () => null,
  }
  const unreadable = await codeqlRequired({ eventName: 'pull_request', sha: SHA, payload: {}, waitMs: 100, pollMs: 10 }, unanswered, fakeClock())
  assert.equal(unreadable.ok, false, 'an unreadable change set is not an ignored one')

  const empty: InventoryLookups = {
    analysisFor: async () => null,
    changeInventory: async () => ({ paths: [], patterns: REAL_IGNORE }),
  }
  const nothing = await codeqlRequired({ eventName: 'pull_request', sha: SHA, payload: {}, waitMs: 100, pollMs: 10 }, empty, fakeClock())
  assert.equal(nothing.ok, false, 'an empty list must not read as "everything is ignored"')

  const thrower: InventoryLookups = {
    analysisFor: async () => null,
    changeInventory: async () => {
      throw new Error('GitHub 502 compare')
    },
  }
  const failed = await codeqlRequired({ eventName: 'pull_request', sha: SHA, payload: {}, waitMs: 100, pollMs: 10 }, thrower, fakeClock())
  assert.equal(failed.ok, false, 'a failed inventory read falls back to the wait; it must not become a pass')
})

test('a push is not excused by the pull request ignore list', async () => {
  const { codeqlRequired } = await lib()
  const clock = fakeClock()
  const lookups: InventoryLookups = {
    analysisFor: async () => null,
    changeInventory: async () => ({ paths: ['AGENTS.md'], patterns: REAL_IGNORE }),
  }
  const result = await codeqlRequired({ eventName: 'push', sha: SHA, payload: {}, waitMs: 100, pollMs: 10 }, lookups, clock)
  assert.equal(result.ok, false, 'codeql.yml runs unfiltered on a push, so an analysis must exist there')
  assert.ok(clock.slept.length > 0)
})

test('the ignore list is read from the workflow file, not copied into the code', async () => {
  const { pathsIgnoreFromWorkflow, matchesIgnoredPath, onlyIgnoredPaths } = await ignoreLib()
  const onDisk = pathsIgnoreFromWorkflow(readFileSync(codeqlWorkflowPath, 'utf8'))
  assert.deepEqual(onDisk, REAL_IGNORE, 'the gate has to read the policy the workflow states')

  // A different file, to prove this is a reader and not a constant matched back.
  const other = pathsIgnoreFromWorkflow(
    ['on:', '  pull_request:', '    paths-ignore:', "      - 'only/this/**'", "      - '*.txt'", '  push:', '    branches: [main]', ''].join('\n'),
  )
  assert.deepEqual(other, ['only/this/**', '*.txt'], 'a list the module does not know must come through unchanged')

  assert.equal(matchesIgnoredPath('AGENTS.md', REAL_IGNORE), true, '**/*.md matches at the repository root')
  assert.equal(matchesIgnoredPath('docs/a/b.md', REAL_IGNORE), true)
  assert.equal(matchesIgnoredPath('deploy/nginx.conf', REAL_IGNORE), true)
  assert.equal(matchesIgnoredPath('Dockerfile', REAL_IGNORE), true)
  assert.equal(matchesIgnoredPath('src/app.ts', REAL_IGNORE), false)
  assert.equal(matchesIgnoredPath('AGENTS.txt', REAL_IGNORE), false)
  assert.equal(onlyIgnoredPaths(['AGENTS.md', 'docs/x.md'], REAL_IGNORE), true)
  assert.equal(onlyIgnoredPaths(['AGENTS.md', 'src/x.ts'], REAL_IGNORE), false)
})

test('the change set comes from the compare API, and a truncated answer is not a pass', async () => {
  const { changedPathsFromApi, MAX_COMPARE_PAGES } = await ignoreLib()
  const asked: string[] = []
  const api = async (path: string): Promise<unknown> => {
    asked.push(path)
    return { files: [{ filename: 'AGENTS.md' }, { filename: 'docs/deploy.md' }], total_commits: 1 }
  }
  const paths = await changedPathsFromApi({ api, repo: 'HugoXK/fledge', base: 'b'.repeat(40), head: 'h'.repeat(40) })
  assert.deepEqual(paths, ['AGENTS.md', 'docs/deploy.md'])
  assert.match(asked[0] ?? '', /\/compare\/b{40}\.\.\.h{40}/, 'the compare endpoint names both commits')

  // A page that fills the cap could be the first page of a longer diff; saying
  // "ignored" about the files it happened to return would shrink the gate.
  const full = Array.from({ length: 100 }, (_value, index) => ({ filename: `docs/${String(index)}.md` }))
  let calls = 0
  const truncated = async (): Promise<unknown> => {
    calls += 1
    return { files: full, total_commits: 500 }
  }
  const answer = await changedPathsFromApi({ api: truncated, repo: 'HugoXK/fledge', base: 'b'.repeat(40), head: 'h'.repeat(40), perPage: 100 })
  assert.equal(answer, null, 'an answer that could be incomplete is not an ignored-only change set')
  assert.equal(calls, MAX_COMPARE_PAGES, 'the compare is paged to the cap and then refused')
})

test('the CLI reads the ignore list from the base commit and carries no copy of it', () => {
  const cli = readFileSync(codeqlCliPath, 'utf8')
  assert.match(cli, /pathsIgnoreFromWorkflow|changeInventory/, 'the ignore list has to come through the lib')
  assert.doesNotMatch(cli, /docs\/\*\*/, 'a copied ignore list drifts from codeql.yml and cannot be reviewed with it')
  assert.match(cli, /changeInventory:/, 'the job has to ask the lib for the change set')
})
