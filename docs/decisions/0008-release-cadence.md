# 0008 — Weekly minor, daily patch

Status: **accepted** (2026-11-10)
Date: 2026-11-10

## Context

`v0.3.0` was released on the Monday 22:30 Asia/Shanghai run. The next night the
planner still computed `0.4.0`, because `scripts/release-plan.mjs` always added
one to the minor. The branch `release/v0.4.0` was pushed, no pull request was
opened, and no release followed. The owner's rule is a weekly cadence, not a
per-night minor bump.

## Decision

The first release of an ISO week bumps the minor (`0.3.4 -> 0.4.0`). Every later
release in the same week bumps the patch (`0.4.0 -> 0.4.1`, `.2`, ...). The next
week starts with a minor again.

The week is a **UTC** week. The nightly run is 14:30 UTC and the tag is created a
few hours later, still on the same UTC day; a local-date week would move a late
Monday release into Tuesday and make the next Monday look like the same week.

The planner takes `lastTagCommittedAt` and `releaseAt` and applies the rule
through `scripts/lib/release-version.mjs`. Missing or unreadable timestamps fall
back to the minor, the first-release behaviour. The review gate computes the
expected mechanical release with the same helper, so a patch release PR keeps
the T0 exemption; a minor PR in a patch week does not.

## Rejected

- **Always patch after the first release.** It would break the weekly minor.
- **Reading the local calendar date.** The release is scheduled in UTC and a
  late Monday run must still count as Monday.
- **Letting the review gate keep the "always minor" rule.** The release PR would
  lose its mechanical exemption and need a PASS every night.

## Consequences

- `release/v0.4.0` is a stale artifact of the old rule and is deleted; the next
  run plans `release/v0.3.1`.
- The release pull request body still says "mechanical daily minor release" in
  places; the version, not that label, is authoritative.
