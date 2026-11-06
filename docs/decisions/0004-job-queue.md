# 0004 — Job dispatch, idempotent callbacks and configurable concurrency

Status: proposed
Date: 2026-11-06
Owners: platform owner, maintainer

## Context

The `jobs` row is today a record, not a work item. `enqueue()` calls
`runner.run()` inline in the request path (`src/jobs/service.ts:275`, the call at
`:420`), so nothing ever dispatches a `queued` row to a worker. Concurrency is
hard-coded at 2 (`src/jobs/service.ts:368`, `:1391`, `:1393`, `:1410`) and both
of those checks are check-then-insert rather than atomic. **A queue layer is
added from zero — claim, dispatch, worker — not refactored out of an existing
queue.** That is the conclusion of this ADR, not a premise.

Separately, `handleCallback` answers a duplicate terminal callback with
`409 job already finished` (`src/jobs/service.ts:1169`, documented as the
contract in `docs/api.md:257`), carries no idempotency key (`CallbackPayload`
has no delivery id, `src/jobs/service.ts:63-75`), and separates its state check
from its side effects with two network awaits — `resolveHeadSha`
(`src/jobs/service.ts:771`) and `maybeAutoMerge` (`:745`, reached at `:1269`).
`finish()` re-reads the row (`:500`) but that only protects the row write; it
does not protect the follow-up enqueue (`:1253`), the work-item writes
(`:1256-1268`) or the merge call (`:1269`). Concurrent duplicate deliveries can
therefore run the same side effects twice.

Both changes are T3, so AGENTS.md requires the decision to be recorded before
the code. #68 implements the callback contract; #62 implements the dispatcher.

## Decision

Six decisions, one per question in #66.

### 1. State machine and terminals

Keep the seven statuses (`src/db.ts:26`): `queued`, `running`, `succeeded`,
`failed`, `cancelled`, `paused`, `quota_exhausted`. Only the `Jobs` service
writes transitions, and every write is guarded by the state it expects:
`queued → running` through the claim of §4, and `… → terminal` through
`UPDATE jobs SET … WHERE id = ? AND status IN ('queued','running')`. Terminal
states are final: `succeeded`, `failed`, `cancelled` and `quota_exhausted` are
never rewritten, and `failed → succeeded` is rejected. `paused` is already
handled this way: `resumeJob` creates a new job and cancels the parked one
(`src/jobs/service.ts:175-191`); that stays.

**No `dead_letter` status.** A dead letter is a fact about an attempt, not about
a job; the status column is user-visible, mirrored into `repos.last_status`, and
filtered by the scheduler queries. When retry lands (a follow-up on the same
dispatcher), a permanently failed job stays `failed` and gains `attempts` plus
`dead_letter_at`, not a new status value.

A terminal job keeps answering `409` for `credential` reads
(`src/jobs/service.ts:1312`, `docs/api.md:257`). Rejected: `410 Gone` or `403`.
The bridge already branches on `409` as "job finished", and switching would be a
second contract change with no operational gain — the body already states the
finish reason, so a different code buys nothing.

### 2. Idempotency key and the replay contract

**The state transition is the key.** A single conditional update inside the
existing `BEGIN IMMEDIATE` transaction (`src/db.ts:966`):

```sql
UPDATE jobs SET status = ?, finished_at = ? WHERE id = ? AND status IN ('queued','running')
```

`changes === 1` means this delivery won the transition and may run side effects;
`0` means a duplicate. To tell a benign replay from a *conflicting* report, the
winning delivery also stores `jobs.callback_fingerprint` — a SHA-256 over the
canonical JSON of the normalised terminal payload (`status`, `branch`, `prUrl`,
`issueUrl`, `reviewScore`, `evidence`, `attribution`, and for each follow-up
`prUrl` + `branch` + `headSha`). The column is additive and nullable; #68 owns
its migration.

The contract then has two distinct answers, which is what #66 asks for:

- same fingerprint on a terminal job → `200 {"ok":true,"duplicate":true}` — the
  work is already done, a retrying bridge must not see a failure;
- a *different* fingerprint on a terminal job → `409 job already finished` — the
  delivery contradicts the recorded result and a retry cannot fix it.

`404` (unknown job), `401` (bad secret), `400` (invalid status) are unchanged.

Rejected: a `callback_deliveries` table keyed by a bridge-supplied delivery id as
the *only* key — the bridge sends none today, and it still cannot stop two
different payloads from finalising the same job; a payload hash alone as the key
— it cannot distinguish a legitimate first report from a conflicting second one
without the transition; keeping `409` for everything — a retrying bridge logs a
false failure for work that succeeded and operators get paged for a no-op.

### 3. Single execution of side effects

`finish()` returns whether it actually migrated the row. `handleCallback` runs
the follow-up enqueue (`:1253`), the work-item writes (`:1256-1268`) and
`maybeAutoMerge` (`:1269`) only in the branch where the claim won. Email, the
notification webhook, `audit`, `event` and `job_events` rows written by
`finish()` are inside the same winning branch, so they are not duplicated either.

A per-job in-memory mutex spans the whole callback, including the two awaits.
Cross-process safety comes from the transition; the mutex only closes the
same-process window between the guard and the effects, which the transaction
cannot cover because the effects are I/O.

Rejected: re-checking `job.status` after each await (still a TOCTOU gap between
the check and the effect); a second "effects done" flag in the row (an extra
write per effect for no additional guarantee).

Nothing may repeat. The one deliberate exception is that `audit_log` and
`job_events` are append-only, so a replay *would* be allowed to leave a second
row; it does not, because those writes are already gated on the winning branch.

### 4. Dispatch model

`queued` becomes a real work item. A dispatcher inside `Jobs` loops
`claim → runner.run → settle`:

- **Claim** is one `BEGIN IMMEDIATE` transaction that counts active jobs and, if
  below the cap, promotes the next row with
  `UPDATE jobs SET status='running', started_at=? WHERE id=? AND status='queued'`.
  Order is the existing `priority DESC, created_at ASC` (`src/db.ts:2099`). The
  winner runs the job; a row that lost the update is simply not returned.
- **Wake-up**: `enqueue()` inserts the row and signals the dispatcher instead of
  awaiting `runner.run()`. The 60-second `tick()` (`src/jobs/service.ts:1350`,
  `setInterval` at `:1452`) tops the pool up as a safety net, so a row left
  behind by a crash is picked up on the next pass.
- **Crash recovery**: `running` rows keep the existing reaper
  (`staleRunningJobs` with `JOB_STALL_MINUTES` / `JOB_TIMEOUT_MINUTES`,
  `src/jobs/service.ts:1360-1379`) and fail with `任务超时未回报`. `queued` rows
  are **no longer failed after ten minutes**; `staleQueuedJobs(-10)`
  (`src/jobs/service.ts:1372`, `src/db.ts:2141`) is retired for `queued` and
  replaced by a long expiry `JOB_QUEUE_TTL_MINUTES` (default 1440) that fails the
  row with a `QUEUE_TTL_EXPIRED` reason instead of "任务排队超时未启动" after ten
  minutes. Waiting for a worker is normal; waiting a day is a defect.

Rejected: an external queue (Redis/Postgres) with at-least-once worker delivery
— out of scope in this slice and it brings a second datastore; a dispatcher that
runs only on the 60-second tick — every job would gain up to a minute of latency
and `enqueue` would still look synchronous while doing nothing.

Consequence to accept: `enqueue()` now returns a `queued` job rather than a
`running` one, because dispatch is asynchronous. The UI and the status page must
show `queued` as "waiting for a worker", which is what the column finally means.

### 5. Concurrency configuration

One global cap, `JOB_MAX_CONCURRENT`, read through `number('JOB_MAX_CONCURRENT',
2)` in `src/config.ts` next to `JOB_TIMEOUT_MINUTES` (`:193`), clamped to `1..32`.
The default of 2 keeps today's behaviour, so merging #62 changes nothing until
an operator raises it; 10 concurrent jobs is a configuration value, not a new
architecture.

Per-repo exclusivity stays: at most one active job per repository
(`activeJobForRepo`, `src/db.ts:2087`), independent of the global cap. SQLite has
a single writer and each repository is a separate GitHub rate-limit unit, so
parallel work on one repo is a bug, not throughput.

The four hard-coded sites (`src/jobs/service.ts:368`, `:1391`, `:1393`, `:1410`)
are replaced by the cap and by the claim transaction; `countActiveJobs()`
(`src/db.ts:2109`) remains for reporting only.

The check-then-insert race disappears because the count and the promotion happen
inside one `BEGIN IMMEDIATE` transaction. **The test has to show the race**: N
concurrent `claimNext` calls must result in exactly `JOB_MAX_CONCURRENT` claims.
A sequential test proves nothing.

### 6. Storage boundary and migration

`Store` gains `claimNextJob(nowIso, max): JobRow | undefined` (transactional
count + promote) and `finishJobIfActive(id, status, fields): boolean` (guarded
update plus fingerprint). `listQueuedJobs` (`src/db.ts:2099`) is reused; the
`Jobs` service keeps no SQL of its own. No long-running work runs inside a
transaction — `BEGIN IMMEDIATE` holds the write lock, and `runner.run()` or a
GitHub call inside it would block every other writer.

For the P2 Postgres migration (#14), `Store` is the boundary that is replaced:
`claimNextJob` becomes `SELECT … FOR UPDATE SKIP LOCKED` and the guarded update
becomes the same conditional `UPDATE … WHERE status IN (…)`. Nothing in the
`Jobs` service may depend on SQLite specifics (`changes`, `BEGIN IMMEDIATE`);
that is why the claim returns a row and the finish returns a boolean.

## Recommendation

Adopt all six as written. The transition is the idempotency key because it is the
only thing that must be true exactly once anyway; the fingerprint only separates
a replay from a conflict. A duplicate terminal callback returns `200
{"ok":true,"duplicate":true}`; `409` stays for a contradicting report. The cap
becomes `JOB_MAX_CONCURRENT` (default 2) and the check and the claim share one
`BEGIN IMMEDIATE`. Side effects run only in the winning branch, guarded by a
per-job mutex around the awaits.

## Consequences

- `docs/api.md` changes: a duplicate terminal callback is `200` with
  `{"ok":true,"duplicate":true}`, not `409`; `409` now means "your report
  contradicts the recorded result". Bridges that treated `409` as "done" keep
  working; ones that treated it as an error stop retrying a no-op.
- The dispatcher is new code: one claim/run/settle loop and a worker; `queued`
  finally means "waiting for a worker".
- `enqueue` returns before the job runs, so callers that assumed a started job
  must read the row or poll.
- Raising the cap is an ops decision. Ten concurrent jobs is a config value.
- The additive `callback_fingerprint` column is the only schema change and it is
  nullable, so old rows and old readers are unaffected.
- `docs/architecture.md` gains the queue and dispatch description; #68 adds one
  `changelog.d/<slug>.fixed.md` (or `.security.md` if the reviewer classifies the
  duplicate side effect as a vulnerability).

## Rollback

- `JOB_MAX_CONCURRENT=2` reproduces today's throughput, and
  `JOB_DISPATCH=inline` keeps the old inline `runner.run()` path behind a flag
  for one release after #62 lands, so the dispatcher can be turned off without a
  revert.
- With the dispatcher off, `queued` rows are drained by the 60-second tick
  through the inline path; no row is stranded.
- The claim reuses `jobs.status`, so no schema rollback is required. The
  fingerprint column is additive: leaving it in place is harmless, dropping it
  only loses conflict detection for replays during the rollback window.
- #67 (merge binding) is independent of this ADR and reviewed before it lands;
  the merge gate is not part of this rollback.

## Non-goals

- No retry/backoff and no dead-letter table. They are follow-ups on the same
  dispatcher and must not be smuggled into #62 or #68.
- No external queue, no multi-process workers, no outbound callback retries.
- No change to the merge conditions themselves (that is #67), and no change to
  how `base_sha` is written.
- No change to the callback payload shape beyond the duplicate answer.

## Open questions

- Should a bridge `delivery_id` be recorded anyway as an audit trail? Default:
  no, until a bridge actually sends one.
- Should the cap be per repository as well? Default: no, one global cap until
  measured; per-repo exclusivity already bounds the common case.
- Does `paused` need to be excluded from the claim? It already is: the claim only
  promotes rows whose status is `queued`.
