# 0024 — Release slot moves to 10:00 Asia/Shanghai

Status: **accepted** (2026-11-16)
Date: 2026-11-16

## Context

The daily release slot was 22:30 Asia/Shanghai (14:30 UTC), with a 23:30
catch-up. On the night of 2026-11-15 the planner wanted `0.3.7`, but the release
drive refused to push because the latest `ci-ok` on `main` was not green. A
release that depends on a same-night green gate leaves no room to repair and
retry before the owner wakes up.

The owner asked for the slot at **10:00 Asia/Shanghai** every day, so a red gate
has the working day to be fixed and the release still lands before the day is
over.

## Decision

The two scheduled slots are `02:00Z` (10:00 Asia/Shanghai) and `03:00Z` (11:00
Asia/Shanghai) as the catch-up. The external trigger runs at `02:00Z`. The
at-most-once boundary in `scripts/lib/release-trigger.mjs` is `02:00Z`.

The weekly cadence from [0008](0008-release-cadence.md) is unchanged: the first
release of a UTC week bumps the minor, later releases in the same week bump the
patch. 02:00 UTC is still Monday in UTC, so a Monday 10:00 Asia/Shanghai run is
the first release of the UTC week and gets the minor bump.

## Rejected

- **Keeping 22:30 and retrying after a red gate.** It is what left `0.3.7`
  unreleased overnight; the retry would still have to happen in the owner's
  night.
- **A local-time week boundary.** The release and the tag are UTC events; the
  weekly rule stays on UTC so a late tag cannot move the next Monday.
- **Changing only the cron.** The catch-up slot, the boundary constant, the
  external trigger, the tests and the docs all encode the old time; a cron-only
  change would leave a second and third source disagreeing with the schedule.

## Consequences

- `scripts/lib/release-trigger.mjs`, `test/releaseTrigger.test.ts`,
  `test/dailyRelease.test.ts`, `docs/autonomous-dev.md`, `docs/deploy.md`,
  `deploy/release-trigger.cron.example`, `README.md` and `README.zh.md` name the
  new time.
- An owner who installs the external trigger moves its cron line to `0 2 * * *`.
