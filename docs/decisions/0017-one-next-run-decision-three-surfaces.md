# 0017 — one next-run decision, three surfaces

Status: **accepted** (2026-11-15)
Date: 2026-11-15
Supersedes: nothing; it applies the one-next-run rule (`10ea236622`, stated at
`docs/architecture.md`, "One next-run rule") to the third surface

## Context

Three surfaces answer "when does this repository run again?", and they have to
agree:

- the repository page's next-run line, rendered by `nextRunLine` and
  `plannedNextLine` (`src/views/pages.ts`);
- the dashboard's all-clear card, which reaches the same two renderers through
  the route's per-repository facts;
- the daily digest email, built by `buildDigest` (`src/jobs/service.ts`) and
  rendered by `src/email/templates.ts`.

The first two were brought onto one rule by two commits: `10ea236622` made the
page and the card print `nextRun`'s answer, and `f859f242` extended the rule to a
repository with a saved schedule row, whose cadence the planner
(`src/schedules/next.ts`, `nextTime`) owns. The digest was never moved. It
computed `last_run_at + min(interval_minutes, workCooldownMinutes)` for every
repository with `auto_iterate = 1`, never read the schedule row, never applied
the 15-minute floor and never consulted `repos.enabled`.

One repository therefore had two answers. A repository scheduled `0 9 * * 1-5`
in `Asia/Shanghai`, with a 1440-minute interval and its last run ten minutes ago,
was promised a run within minutes by the email and named the next weekday
morning by the page. A disabled repository with no row — a state only the
settings route can leave behind, because `/repos/:id/disable` zeroes both fields —
was told by the email that a run was coming, while the page said it would never
start.

What the email could not reach was the *choice* between the interval rule and the
planner. The instants already live in one place each (`nextRun` and `nextTime`),
but the choice lived in `src/views/pages.ts` as two non-exported helpers, and a
job module must not import the view layer.

## Decision

Add `src/lib/nextRunFor.ts` (`nextRunFor`) and let the digest answer through it.

- It returns `{ at, state }` with its own union: `NextRunState` plus
  `unknown-unreadable` and `unknown-closed`. The two planner-only answers are not
  added to `NextRunState`, because `nextRunLine` switches on that union
  exhaustively and a new member would drag a view change into this slice.
- With a schedule row it delegates to `scheduleFromRow` + `nextTime`, and answers
  `due` when the instant has passed, else `scheduled`; a row the planner refuses
  is `unknown-unreadable`, a window that has ended is `unknown-closed`. A saved
  row owns the cadence whether or not the repository is enabled, exactly as on
  the page.
- With no row it delegates to `nextRun` (`src/lib/nextRun.ts`), which owns the
  floor through `dueAfterMs` and the reasons a run will not start — disabled,
  not-ready, auto-off, active-job, idle, waiting-first-run.
- `instanceReadyFor(instanceImage, status)` carries the fallback both existing
  surfaces already apply: on a deployment with no instance image there is no
  instance to wait for.
- `buildDigest` maps `state` to its own Chinese sentence, reusing the page's
  wording where the state exists. The email owns the wording; it does not own
  the rule.

## Rejected

- **Keeping the formula in the digest.** That is the defect: a third copy of the
  rule with two guards missing.
- **Widening `NextRunState`.** `nextRunLine`'s exhaustive switch would have to
  handle the planner's two no-instant answers, turning an email fix into a view
  change.
- **Moving `nextRunLine`/`plannedNextLine` into `src/lib/`.** It re-points every
  reference in `src/views/pages.ts` and rewrites the route's `ScheduledNext`
  contract for a one-line email contradiction.

## Consequences

- The *choice* between a schedule row and the interval rule now has two
  implementations — the route's (`src/app.ts`, the dashboard and repository page
  facts) and the helper's — while the instant itself stays single-sourced in
  `nextTime`/`dueAfterMs`. That is the accepted cost of not restructuring the
  view layer in this slice; a later card can collapse the route onto the helper
  if it is ever worth the diff.
- `src/jobs` stays a caller of the rule, never an owner of it.
- The digest starts printing the page's state sentence for a no-row repository
  that will not run, instead of a formatted time. For a repository whose state is
  `due` or `scheduled` the instant does not change: the floor cannot move it,
  because both clamps already keep it at 15 minutes.
