# 0006 — One definition of "standing" for the required `review-gate` check

Status: **accepted** (implemented in the same pull request as #179)
Date: 2026-11-10

## Context

`#175` failed the required `review-gate` check at `2026-11-09T17:56:42Z`, the
Reviewer's PASS landed, and a second evaluation of the same sha went green at
`18:03:46Z`. The merge API still answered `Required status check "review-gate" is
failing`, twice, with the sha pinned; GraphQL agreed at the same moment
(`mergeStateStatus: BLOCKED`). The repair step ran four seconds later and said
`nothing to do — no failed review-gate at this SHA`. What cleared it was
re-running the failing workflow run by hand.

Two definitions of "standing" were in play and neither was written down. The
planner used "the newest check run of a name", which said green; the merge gate
used something else, which said red. The planner also only re-ran
`run_attempt == 1` runs, and the failed run had already been re-run by hand, so
the run that owned the red check was not even reachable. `docs/autonomous-dev.md`
described the planner's model, not the merge gate's.

## Decision

**Standing is per check suite.** A `review-gate` check run belongs to the check
suite of the workflow run that produced it. The newest attempt stands inside a
suite, and every suite at the sha counts. A re-run replaces the check run inside
its own suite, so a conclusion a re-run superseded is history; a second workflow
run at the same sha opens a new suite and leaves the earlier suite's conclusion
where it is, so a newer green suite never retires an older red one.

This definition is used in exactly two places and there is no second version:
`scripts/lib/gate-repair.mjs` (`standingChecks`, `repairPlan`) and
`docs/autonomous-dev.md` §"A verdict only paints the check that sits at the head
SHA".

Three consequences follow from it:

1. The repair step reads check runs with `filter=all`. `filter=latest` returns
   only the newest check run per name, which is precisely the view that hid the
   failing suite in `#175`.
2. A PASS repairs every failed `Review gate` run at the sha whose own
   `review-gate` job failed, because re-running that run is the only action that
   replaces the check run inside the red suite. Re-running a run of another
   workflow, or starting a new run, opens a new suite and leaves the red standing.
3. A run is repairable while `run_attempt <= MAX_REPAIR_ATTEMPT` (2). A run that a
   person already re-ran by hand sat on attempt 2 — the state a PASS usually
   arrives into — so attempt 1 only is too narrow. The cap is the loop bound:
   every re-run strictly raises `run_attempt`, so one failed run is re-run
   automatically **twice at most** — 1 → 2 for the first repair, 2 → 3 for the
   second — and once it stands above the cap, a red it still owns is reported as
   blocked on a new commit instead of being re-run again. Posting the same PASS
   twice is therefore not a no-op: the second trigger re-runs the run the first one
   left on attempt 2, and only the third trigger, with the run on attempt 3, is the
   one that reports blocked. The **rejection** path is the idempotent one: it
   repaints a green run, and a repeated rejection finds the red it just painted and
   writes nothing.

## Rejected

- **Keep name-collapse and `filter=latest`.** This is the model that failed: it
  reported green while the merge gate refused, and the only recovery was a human
  step that `docs/autonomous-dev.md` did not document.
- **`concurrency` on the gate workflow as the fix.** Grouping can prevent two
  evaluations starting together, but the failing evaluation here had already
  *completed* at `17:56:42Z`; no concurrency group can retroactively supersede a
  completed run. Grouping may still be worth having for the future-duplicate
  case, as its own change with its own test.
- **Drop `review-gate` from the required checks, `continue-on-error`, or let the
  repair or a merge queue ignore the rollup.** These remove the gate instead of
  repairing it.
- **Re-run without an attempt cap.** Every trigger would re-run the same failing
  run forever; the cap is what makes the repair terminate, after at most two
  automatic re-runs of one run (1 → 2 → 3).
- **Act only on attempt-1 runs (the status quo).** It makes a run unreachable at
  exactly the moment a verdict needs it, and the hand re-run becomes permanent
  procedure.

## Rollback

Revert the pull request. The planner returns to attempt-1-only and name-collapse,
and a red suite behind a newer green one again needs a hand re-run; nothing else
changes. There is no schema, config, credential or stored-data change, so the
revert is complete on its own.

## Non-goals

- No change to what counts as a verdict, the review policy, the required check
  list, or the workflow triggers.
- No merge-queue behaviour, no bypass, no change to the merge conditions.
- No new stored state: the decision is derived from the API's check runs and
  workflow runs on every evaluation.
