// #304: a red CodeQL analysis blocked nothing. `analyze` lives in its own
// workflow, so `ci-ok` in `ci.yml` could not aggregate its conclusion and no
// required context named the job: a pull request could add a high result and
// merge with every required check green.
//
// This module is the decision, kept away from the workflow so the suite can
// drive every outcome without Actions: the analysis lookup and the clock are
// injected. Two parts of it are the difference between a gate and a queue-wide
// block — reading the commit the analysis actually ran on, and waiting for a
// slow analysis instead of calling it red on the first poll.

export const DEFAULT_WAIT_MS = 10 * 60 * 1000
export const DEFAULT_POLL_MS = 20 * 1000

// #585: the gate used to read one unfiltered page of the workflow's completed
// runs and look for the commit inside it. A busy repository starts more runs
// than that page holds, so a commit whose analysis concluded success could be
// absent from the page, and the job spent its full ten minutes then reddened
// `ci-ok` on a green analysis (measured on #532: 878 completed runs, the commit's
// own run invisible at `per_page=20` and at `per_page=100`). The query now names
// the commit, which is a lookup and not a race against the repository's activity.
export const CODEQL_WORKFLOW = 'codeql.yml'

// `?head_sha=` answers every completed run of one commit, so one short page is
// the whole answer; the cap only guards against a pathological re-run history.
export const PROBE_PER_PAGE = 10

// The fallback scan exists for an API that ignores an unknown query parameter
// and keeps answering the unfiltered list. It is bounded twice — by a page cap
// and by the caller's deadline — because the window it walks is unbounded.
export const RUNS_PER_PAGE = 100
export const MAX_FALLBACK_PAGES = 10

// Which commit's analysis answers this event.
//
// `push` and `workflow_dispatch` gate the commit they run on. A `merge_group`
// run has a synthetic merge commit that nothing analyzes — `codeql.yml` has no
// `merge_group:` trigger, so waiting on `merge_group.head_sha` would block every
// queue entry — so it reads the queued pull request's head instead, the commit
// that pull request's own run analyzed.
//
// `pull_request` reads the event payload's head, not `GITHUB_SHA`: on that event
// `GITHUB_SHA` is the `refs/pull/N/merge` commit while the analysis run reports
// the pull request head (the checks API attaches the run to that same head), so
// reading `GITHUB_SHA` there would wait ten minutes and then fail every pull
// request. The fallback only covers an event payload that carries no head, where
// the two are the same value anyway.
//
// `schedule` has nothing to gate: the weekly analysis observes `main`.
export function shaForEvent({ eventName, sha, payload }) {
  const event = payload ?? {}
  if (eventName === 'schedule') return null
  if (eventName === 'merge_group') return event.merge_group?.pull_requests?.[0]?.head_sha ?? null
  if (eventName === 'pull_request') return event.pull_request?.head?.sha ?? sha ?? null
  return sha ?? null
}

// Which completed analysis answers a commit (#422).
//
// Only `head_sha` counts. `pull_requests[].head.sha` is filled from the pull
// request's *current* head, not from the commit the run analysed, so every
// superseded run of a pull request claims to be about the newest tip: a stale
// failure then answers a commit whose own analysis is still running, and the
// required check flaps on ordering luck. The verdict for a commit must come from
// the run that actually analysed that commit.
//
// The list is the API's newest-first order and `.find()` takes the first match.
// That ordering is not the defect and is deliberately unchanged: with an exact
// predicate a tip whose own analysis has not finished yields no match, so the
// existing poll keeps the check pending instead of red or green on another
// commit's conclusion.
export function analysisFor(runs, sha) {
  const list = Array.isArray(runs) ? runs : []
  const match = list.find((run) => run?.head_sha === sha)
  if (match === undefined) return null
  return { conclusion: String(match.conclusion ?? '') }
}

// The request that answers "did this commit's analysis conclude?": the commit is
// named in the query, so the page is a lookup and not a window the commit can
// fall out of (#585). `page` and `per_page` are explicit so the fallback scan
// below reads the same collection the window used to.
export function runsPath({ repo, sha, page = 1, perPage = PROBE_PER_PAGE }) {
  const query = new URLSearchParams({
    head_sha: sha,
    status: 'completed',
    per_page: String(perPage),
    page: String(page),
  })
  return `/repos/${repo}/actions/workflows/${CODEQL_WORKFLOW}/runs?${query.toString()}`
}

function pageOf(payload) {
  const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : []
  const total = typeof payload?.total_count === 'number' ? payload.total_count : runs.length
  return { runs, totalCount: total }
}

// `lookups.analysisFor(sha, { deadline })` resolves the completed analysis for
// that commit, or `null` while there is none yet. `clock` is `{ now, sleep }`.
export async function analysisFromApi(options) {
  const api = options.api
  const repo = String(options.repo ?? '')
  const sha = String(options.sha ?? '')
  const now = options.now ?? (() => Date.now())
  const deadline = Number.isFinite(options.deadline) ? options.deadline : Number.POSITIVE_INFINITY
  const perPage = Number.isFinite(options.perPage) ? options.perPage : RUNS_PER_PAGE
  const maxPages = Number.isFinite(options.maxPages) ? options.maxPages : MAX_FALLBACK_PAGES

  const probe = pageOf(await api(runsPath({ repo, sha, page: 1, perPage: PROBE_PER_PAGE })))
  const answer = analysisFor(probe.runs, sha)
  if (answer !== null) return answer

  // No run at all for this commit: the analysis has not concluded, and the
  // caller's poll is the wait. Paging here would spend the whole budget on a
  // repository's unrelated activity.
  if (probe.totalCount === 0 || probe.runs.length === 0) return null

  // Runs came back and none of them analysed this commit, so the API answered
  // unfiltered. Walk the same collection the old window read, stopping at the
  // page cap and at the deadline.
  for (let page = 1; page <= maxPages; page += 1) {
    if (now() >= deadline) return null
    const window = pageOf(await api(runsPath({ repo, sha, page, perPage })))
    const found = analysisFor(window.runs, sha)
    if (found !== null) return found
    if (window.runs.length < perPage) return null
  }
  return null
}

export async function codeqlRequired(input, lookups, clock) {
  const eventName = String(input?.eventName ?? '')
  const waitMs = Number.isFinite(input?.waitMs) ? input.waitMs : DEFAULT_WAIT_MS
  const pollMs = Number.isFinite(input?.pollMs) ? input.pollMs : DEFAULT_POLL_MS

  if (eventName === 'schedule') {
    return { ok: true, reason: 'schedule: the weekly analysis observes, it does not gate a merge', sha: null, polls: 0 }
  }

  const sha = shaForEvent(input)
  if (sha === null || sha === '') {
    return { ok: false, reason: `no commit to gate: a ${eventName === '' ? 'unknown' : eventName} event carries no sha`, sha: null, polls: 0 }
  }

  const deadline = clock.now() + waitMs
  let polls = 0
  for (;;) {
    polls += 1
    // The deadline travels with the lookup: an implementation that has to page
    // the API must not spend more than the wait this module already promised.
    const analysis = await lookups.analysisFor(sha, { deadline })
    if (analysis !== null && analysis !== undefined) {
      const conclusion = String(analysis.conclusion ?? '')
      if (conclusion === 'success') return { ok: true, reason: `the CodeQL analysis for ${sha} concluded success`, sha, polls }
      return { ok: false, reason: `the CodeQL analysis for ${sha} concluded ${conclusion === '' ? 'without a conclusion' : conclusion}, so a merge must not proceed`, sha, polls }
    }
    // An analysis that has not started yet is not a red one: failing here would
    // red every pull request whose job is still queued behind the runner.
    const remaining = deadline - clock.now()
    if (remaining <= 0) break
    await clock.sleep(Math.min(pollMs, remaining))
  }
  return {
    ok: false,
    reason: `no completed CodeQL analysis for ${sha} after ${String(Math.round(waitMs / 1000))} second(s), so a merge cannot be gated on it`,
    sha,
    polls,
  }
}
