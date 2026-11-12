# 0011 — the release routine writes the README status line

Status: **accepted** (2026-11-12)
Date: 2026-11-12
Supersedes: the T1 boundary recorded with `#263` and the assertion it left in
`test/readmeStatus.test.ts`

## Context

`#263` kept the two READMEs out of the mechanical release surface on purpose: the
routine wrote the version fields and the changelog, a person wrote the status
line, and `test/readmeStatus.test.ts` failed loudly when the two disagreed. That
was the right call while the status line was also a hand-written summary of the
release.

It stopped being a summary. The line carries the version and the date, both of
which the routine already knows, and the check that guards it runs in
`npm run check` — so every mechanical release pull request was red by
construction: it bumped `package.json`, and `README.md:32` / `README.zh.md:30`
still named the previous release. `#347` (`v0.3.2`) reproduced it exactly, twice
(`test (22)` and `test (24)`), and the owner had to rescue that release by hand
([decisions/0010](0010-v0.3.2-release-rescue.md)). A routine whose output cannot
pass its own suite is not a cadence; it is a nightly red.

## Decision

The release routine writes the status line. Six sites move together, and the
shape check is what keeps the surface closed:

1. `scripts/lib/mechanical-release.mjs` — `README.md` and `README.zh.md` join
   `MECHANICAL_PATHS`.
2. `scripts/changelog.mjs` — `bumpVersions()` writes the line into both READMEs,
   taking the version **from the `package.json` it just wrote** and the date from
   the release it was given. It refuses the run, with the file named, when a
   README has no status line it can write.
3. `scripts/lib/mechanical-release.mjs` — `mechanicalDiffShape()` accepts exactly
   one replaced status line per README: same line, same words, the version at the
   identity's version, the brackets and the date in their places. Any other hunk
   in either file, a second status block, a date-only change or a status line that
   reads differently fails the shape and the PR stays T3.
4. `scripts/release-open.mjs` — `SURFACE_PATHS` carries both READMEs, so the tree
   the opener judges holds the files the routine writes.
5. `.github/workflows/daily-release.yml` — the staging line adds both READMEs;
   without it the edits would never be committed.
6. `test/releaseOpen.test.ts` and `test/readmeStatus.test.ts` — the surface pin
   moves, and the assertion that the READMEs are *not* mechanical is inverted into
   the narrower one that their status line is the only mechanical part.

The strict assertions that each status line names the version in `package.json`
and that the two agree with each other are untouched. They are the reason the
line cannot drift, and they now pass on the mechanical tree instead of failing on
it.

## Rejected

- **A human edit on every release pull request.** It is what `#263` assumed and
  what `#347` needed; it makes the release depend on someone noticing a red PR at
  14:30 UTC, and the owner has already paid for that once.
- **A separate generator script that edits the READMEs after `bumpVersions()`.**
  A second writer is a second place for the version literal to live; the routine
  reads back the file it just wrote instead.
- **Widening the surface without the shape check.** `README.md` is user-facing
  prose. Allowing it into the T0 exemption without bounding the hunk would let a
  release-named branch rewrite any part of the guide with no PASS.
- **Relaxing `test/readmeStatus.test.ts` to accept a stale line.** The check is
  the reason the drift is visible at all.

## Consequences

- A nightly mechanical release now produces a tree that passes `npm run check`,
  which is the precondition for the cadence at all.
- A README edit that is not the status line still needs its own PR and its review;
  the shape check refuses it inside a release diff.
- A release routine run outside the workflow (the documented manual invocation)
  writes the same two lines, so the two paths cannot disagree.
