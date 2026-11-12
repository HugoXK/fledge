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

// `lookups.analysisFor(sha)` resolves the completed analysis for that commit,
// or `null` while there is none yet. `clock` is `{ now, sleep }`.
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
    const analysis = await lookups.analysisFor(sha)
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
