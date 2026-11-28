# 0030 — the arch size re-record: three entries raised to their measured size, and those numbers are ceilings

Status: **accepted** — the route word is the Lead's on [`#1309`](https://github.com/HugoXK/fledge/issues/1309#issuecomment-7156200538) with the Chief's approval (2026-11-25), and the re-record is implemented and landed by [`#1314`](https://github.com/HugoXK/fledge/pull/1314) at `85299d7fda48a9f9f28354b6641bdc9ad29c2185` (2026-11-27T09:20:43Z)
Date: 2026-11-28
Decision owner: Fledge Platform Lead; written by Fledge Platform Dev-3
Settles: [`#1309`](https://github.com/HugoXK/fledge/issues/1309) — the stale entries — and record 3 of [`#1315`](https://github.com/HugoXK/fledge/issues/1315): the rule that tells an approved re-record from a silent raise
Pin: `14d835abcda38fcb9f90ebfc82ef6d241551835c` — every number below was measured there with the gate's own counting rule

## Context

`scripts/arch-boundaries.mjs` fails a source file above 1,200 lines unless the
file predates the limit and is recorded in `scripts/lib/arch-grandfather.json` at
its measured size. The rule is a ratchet: a recorded entry may not grow, and once
a file is at or below the limit its entry must be deleted. `#1228` introduced the
gate and the file, and `#1246` landed it.

Three entries had been recorded below the size of the tree. `main` was therefore
red: the gate printed `grandfathered-growth` for `src/app.ts`, `src/views/pages.ts`
and `src/db.ts` and exited 1 with `arch: 3 violation(s)`. The cause was growth
after the baseline was recorded, not a counting disagreement — `#1288`'s squash
alone is the `src/db.ts` move.

The numbers are the gate's own, not another tool's: `lineCount` at
`scripts/lib/arch-boundaries.mjs:157-160` counts `split('\n').length` minus a
trailing newline, so a different byte stream measured with `wc -l` would not
reproduce them.

## Decision

**1. Three entries are re-recorded, each to the size measured at the pin.**

| file | recorded at the pin | measured at `14d835ab` | cause |
|---|---|---|---|
| `src/app.ts` | 7471 | **7489** (+18) | growth after the baseline was sampled |
| `src/views/pages.ts` | 6234 | **6250** (+16) | growth after the baseline was sampled |
| `src/db.ts` | 8722 | **8757** (+35) | the `#1233`/`#1288` squash |

**2. The other two entries are untouched, because they do not violate.**
`src/jobs/service.ts` stays at 5518 and `src/repos/github.ts` at 1335: neither is
above its record, so neither is part of this re-record.

**3. The three new numbers are ceilings, not a new normal.** Growth beyond a
recorded number is a new violation. The fix for it is splitting the file, never
raising the entry again. This is what makes the re-record a one-time calibration
rather than a quiet widening of the limit.

**4. A later re-record is a named, reviewable act, not an edit.** It must (a)
measure the file at a named commit with `lineCount`, (b) be approved in a
decision record such as this one, (c) be named in the pull request that makes the
change, and (d) leave the new number as the ceiling under rule 3. Growth with no
such record is a silent raise and must be read as a violation.

## Why not the alternatives

- **Leaving the entries unfixed** keeps `main` red: the gate is right about the
  measurements, and a red gate that everyone learns to ignore is the failure mode
  the ratchet exists to prevent.
- **Raising the 1,200-line limit** moves the rule to fit the files; the
  grandfather file exists precisely so the limit does not have to move for files
  that predate it.
- **Editing the entries with no record** would make this re-record
  indistinguishable from the silent raise rule 4 refuses. The record is the
  difference.

## Carrier and state

The one-file change is `scripts/lib/arch-grandfather.json`, carried by `#1309` in
PR `#1314`, squash `85299d7fda48a9f9f28354b6641bdc9ad29c2185`. At the pin the
file still held the old numbers (7471 / 8722 / 6234); after that merge it holds
7489 / 8757 / 6250 for the three re-recorded files and still 5518 / 1335 for the
two untouched ones.

The prose rule lands with [`#1315`](https://github.com/HugoXK/fledge/issues/1315)
in `docs/code-standards.md`, beside the bullet that documents
`scripts/lib/arch-grandfather.json`, and is consistent with the comment at
`scripts/lib/arch-boundaries.mjs:8-10`.
