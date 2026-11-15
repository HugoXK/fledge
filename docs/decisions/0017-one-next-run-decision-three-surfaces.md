# 0017 — one next-run decision, three surfaces

Status: **accepted** (2026-11-15)
Date: 2026-11-15
Supersedes: nothing; it applies the one-next-run rule to the daily digest

## Context

The repository page and the dashboard already print one next-run time per
repository. The rule that picks it is decided by the repository, not by the
surface: a repository with a saved schedule row is answered by the planner
(`src/schedules/next.ts`, `nextTime`), and a repository without one is answered
by the legacy interval rule (`src/lib/nextRun.ts`, `nextRun`, through
`dueAfterMs`).

The daily digest was the third surface and the only one outside that rule.
`buildDigest` (`src/jobs/service.ts`) computed `last_run_at + min(interval,
workCooldownMinutes)` for every `auto_iterate = 1` repository. It never read
`store.scheduleForRepo()`, `repos.enabled` or the interval floor, so a cron
repository got a different time in the email, and a disabled repository was
promised a run the page said would never start. The digest cannot import the
view helpers that make this choice in `src/views/pages.ts`.

## Decision

Add `src/lib/nextRunFor.ts` and use it from `buildDigest`:

- `nextRunFor` takes the `RepoRow`, the optional `ScheduleRow`, open-work,
  active-job and instance-ready facts, plus the work cooldown.
- A saved row is answered by `scheduleFromRow` + `nextTime`; a row the planner
  cannot read answers `unknown-unreadable`, and a closed window answers
  `unknown-closed`. The state for a live instant is `due` when it is at or
  before `now`, otherwise `scheduled`, exactly as the page renders it.
- A repository without a row delegates to `nextRun`, so the interval instant,
  the disabled/not-ready/auto-off/active-job/idle/waiting-first-run states and
  the 15-minute floor stay in one place.
- The digest maps those states to its own Chinese sentences. It does not import
  `src/views/**`; only the wording is duplicated, because the email is a
  Chinese-only surface today.

The instance-ready fallback stays in the caller: `config.flybot.instanceImage
=== '' ? true : instance?.status === 'ready'`, the same guard the page and
dashboard use, so a deployment with no FlyBot image never prints "not ready".

## Rejected

- Keeping the formula in `buildDigest`: it is a second implementation of the
  rule, and the page already proves the failure mode.
- Widening `NextRunState` with the two planner answers: `nextRunLine` switches on
  that union exhaustively, so a new member would drag a view change into this
  slice.
- Moving `nextRunLine`/`plannedNextLine` out of `src/views/pages.ts`: that
  re-points every view reference and the route's `ScheduledNext` contract for a
  one-line email contradiction.

## Consequences

- The choice between a saved row and the interval rule now lives in the route
  (for the two existing surfaces) and in `nextRunFor` (for the digest). The
  instant itself remains single-sourced in `nextTime`/`dueAfterMs`; a later card
  can collapse the route onto the helper if the view-layer refactor is worth it.
- The digest now prints the page's state sentences for disabled,
  not-ready, auto-off, active-job, idle and never-run repositories, and the
  planner instant for a scheduled repository — including a disabled repository
  that has a saved row, where the row decides the cadence on both surfaces.
- `src/jobs/` remains a caller of the rule, never its owner.

## Amendment — #723 (2026-11-15)

`enabled` answers before the saved row does, here and on every surface. The
worker only considers `enabled = 1 AND auto_iterate = 1` (`src/db.ts`,
`listAutoRepos`) and a manual start on a paused repository is refused with
`REPO_DISABLED` (`src/jobs/service.ts`), so a paused repository must not be
promised a run even when it keeps its schedule row. The Consequences sentence
that let a disabled repository with a saved row follow the row's cadence is
therefore superseded: the page route withholds the row's answer for a paused
repository and `nextRunFor` returns `disabled` before it reads the row, so the
page, the dashboard and the digest keep one sentence.
