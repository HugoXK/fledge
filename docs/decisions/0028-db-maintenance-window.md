# 0028 — database maintenance: a dry run that executes nothing, a real run gated on a fresh copy, and a refusal instead of a wait

Status: **accepted** (implemented in the same pull request as [`#1261`](https://github.com/HugoXK/fledge/issues/1261))
Date: 2026-11-23
Decision owner: Fledge Platform Dev-1
Settles: [`#1261`](https://github.com/HugoXK/fledge/issues/1261), which supersedes the CLI slice `#1232` specified. It records the four policy choices that card left to the build: what "fresh" means, what a busy database gets, what the dry run promises, and who schedules it.
Pin: `0debe8c6054f87ffa235225606f0f88ca20087c8` — every `file:line` here resolves at it.

## Context

The file had no supported maintenance path. `scripts/` holds a backup writer, a
retention preview, a restore drill and a previous-release restore, and
`docs/deploy.md` §7 documents all of them — but nothing reclaims space. An
operator who deletes jobs, events or artifacts can take a copy and cannot plan
or run `VACUUM` or `ANALYZE` on the live file, so deleted data stays reachable on
the free list and the planner keeps statistics that describe rows nobody has.

The obvious tool is two lines and three hazards, and each hazard is a decision
someone would otherwise re-derive differently next quarter:

- **`VACUUM` is irreversible on the file it rewrites.** If the last good copy is
  missing or truncated, the maintenance run is the moment the instance loses its
  data and its backup in the same minute.
- **A locked database is not an error you want a cron job to sit on.** SQLite's
  default busy behaviour is to wait; a maintenance run that waits forever behind
  a stuck writer is indistinguishable from a hung host.
- **"The dry run wrote nothing" is a claim, and `PRAGMA optimize` falsifies it.**
  It writes a `sqlite_stat1` row (probed on `#1232`: absent → 1). A tool that
  promises a dry run and runs `optimize` anyway has a broken promise and a green
  test that only compared file bytes on a WAL database.

## Decision

Four choices, in the order the tool has to make them.

**1. A dry run plans and never executes.** It opens the database read-only — the
handle, not only the code path, has no write permission — and prints three
steps: `PRAGMA wal_checkpoint(TRUNCATE)`, `ANALYZE`, `VACUUM`. `PRAGMA optimize`
is not among them and is not run on any path. "Wrote nothing" is asserted as
four counters (per-table `COUNT(*)`, `freelist_count`, `page_count`, the
`sqlite_stat1` row count) plus the absence of an `audit_log` row and a
`-journal` file. It is deliberately **not** a byte comparison: the database is
WAL (`src/db.ts:2860`), so any connection may create or update the `-shm`
shared-memory index without writing a page, and a byte test would fail a correct
run.

**2. "Fresh" means newest, intact and inside the window, judged by
`readBackupStatus`.** A real run needs `--backup <file>`, and the file must be the
newest copy that function reports, carry `manifest: 'matches'` (size and sha256
both agree with the sidecar the writer leaves), and be younger than
`--expected-hours`, whose default is `DEFAULT_EXPECTED_HOURS = 26`
(`src/lib/backupStatus.ts:9`), the same number `/admin` uses for `stale`
(`:286`). The window is a parameter and `readBackupStatus` takes an injectable
`now` (`:232-243`), so the suite pins the age without waiting or touching a
clock. The CLI does not reimplement the judgement: one function decides what
"fresh" means for the console and the tool, so they cannot disagree.

One part of the judgement is not that function's to make. It compares a copy's
bytes only while the copy is at most `SHA256_MAX_BYTES` (4 MiB,
`src/lib/backupStatus.ts:17`), because `/admin` must not read a large copy on a
render path; above the cap it reports `not-checked` with the size already agreed,
which the host's 235 MB copy always is. Reading that state as "not intact" made
every real run refuse a copy the instance already had (`#1264`). So the tool
hashes the named copy itself, streamed, and compares it against the same manifest
sidecar — once per run, only after the copy is the newest and inside the window,
and never when the report already says `matches`. The cap stays where it is: it
is a render-path budget, not a statement about what counts as a good copy. A
missing, `differs` or unreadable manifest still refuses, and the refusal names
which of the three checks failed.

**3. A busy database is refused, not waited on, and the refusal writes
nothing.** The tool sets `PRAGMA busy_timeout = 5000` on its own connection —
the app's value (`src/db.ts:2862`), repeated because a pragma does not travel to
a new process — then takes and releases the write lock (`BEGIN IMMEDIATE` /
`ROLLBACK`) before running any step. On `SQLITE_BUSY` it exits `3` with the
`db-busy` sentence. The probe exists because `VACUUM` cannot run inside a
transaction and the steps cannot be wrapped: without it, `ANALYZE` could land and
`VACUUM` fail, which is a partial maintenance. A refusal is `3`; a usage error
stays `2` (`scripts/retention.mjs:24`) and an unexpected failure `1`.

**4. The team ships the schedule, the owner installs it.**
`deploy/db-maintenance.cron.example` is a sample with its preconditions in
comments: a trustworthy host clock (the instance's clock has never been
synchronised, `#1256`), a running backup schedule, and a run from the checkout so
the TypeScript loader is present. Deploying it is the owner's decision, not a
maintenance routine's — a host schedule is production. The tool itself never
schedules anything.

A real run records exactly one `audit_log` row (`action db.maintenance`,
`user_id NULL`) after the steps, with the before and after counters and the
report path in `detail`. `NULL` is the point: this is not a user action and the
per-user counts filter on that column (`src/db.ts:3821`).

## Consequences

- The report is written for every run that reaches a decision, refusals
  included, to `data/db-maintenance.json` (overridable with `--report`). "Nothing
  was written" always means the database, never the report. A usage error writes
  none, and neither does a database that cannot be opened at all — the first never
  named a run, the second has no counters to record.
- The tool runs through `tsx` (`npm run db:maintenance`), the way
  `npm run role:set:dev` already does, because it imports the TypeScript
  `readBackupStatus`. An operator on a checkout with `npm ci` has it; a container
  image pruned of development dependencies does not, and the runbook says to run
  it from the host.
- `VACUUM` on WAL is not a file-shrink promise. The acceptance asserts
  `freelist_count` and `page_count`, and the documentation says the byte size may
  not move.
- The tool has no UI face: the admin panel stays with `#1231`, and this change
  touches neither `src/views/` nor `src/app.ts`.
- If the policy later wants a shorter or longer window, it is
  `--expected-hours` on the schedule, or `DEFAULT_EXPECTED_HOURS` for every
  caller — not a second definition of "fresh" inside this script.
