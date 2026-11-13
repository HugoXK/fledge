# 0013 — one table decides which `settings` prefixes retention reclaims

Status: **accepted** (2026-11-12)
Date: 2026-11-12
Supersedes: nothing; completes the retention introduced with `pruneOldData()`

## Context

`pruneOldData()` reclaims age-based `settings` rows because most of them are
idempotency markers: a reminder sent, a digest sent, an OAuth state spent. It
held that list twice — once as a hard-coded `LIKE` chain in the `SELECT`, once as
a `prefix → cutoff` array consulted after the read. A key in the second list but
not the first was never read, so it was never deleted, and nothing failed when
the two copies drifted.

They had drifted. `expirePlans()` writes one `plan_reminded:<job>` row before a
plan's deadline and one `plan_expired:<job>` row at it, only so a second tick is
a no-op, and neither prefix was in the `SELECT`. One row per unapproved plan
therefore stayed in `settings` forever, while the job row that gave it meaning
was deleted at 365 days. That is the exact path retention exists to bound, and
the table is the one retained per-job record with no UI symptom.

The same drift had already produced `merge_reconcile:` in the cutoff array and
out of the `SELECT`, but that one is deliberate in effect: those rows, like
`retry_pending:` and `pending_followup:`, are reclaimed when the job they name is
gone (`reconcileOrphans`), because `merge_reconcile:` also throttles the merge
pass and its age is not a retention signal.

## Decision

1. One table, `SETTINGS_RETENTION`, of `prefix → days`, feeds both halves: the
   `SELECT` is built from its prefixes and the cutoff is looked up in it. A
   prefix can no longer half-exist.
2. `plan_reminded:` and `plan_expired:` join it at 365 days, the same window the
   job row gets. The value is the write time, which is at or after the job's
   `finished_at`, so a marker outlives every read that can still consult it
   (`expirePlans` stops looking at a plan once it expires).
3. `merge_reconcile:`, `retry_pending:` and `pending_followup:` stay out of the
   table, with the reason recorded beside it: their lifecycle is the job, not the
   clock.

## Rejected

- **Adding the two prefixes to both lists.** It fixes today's symptom and keeps
  the two copies that caused it; the next prefix has the same chance to land in
  one list only.
- **One `DELETE` for the plan prefixes in a second function.** A second writer
  with its own cutoff is a third copy of the mapping.
- **Age-pruning `merge_reconcile:`.** It would reset the merge-pass throttle on a
  long-lived job and change merge behaviour, not storage.
- **Pruning a marker whose job still exists.** The set is chosen by age like every
  other row here; a live plan's marker is newer than the cutoff by construction.

## Consequences

- `data/fledge.db` stops growing by one `plan_expired:` and one `plan_reminded:`
  row per unapproved plan.
- Adding a retention prefix is one line in one table; a prefix added only to a
  cutoff list is no longer expressible, which is why the exclusion of the
  job-scoped prefixes is written down rather than implied.
- No schema change and no migration: rows already on disk are reclaimed by the
  next prune, because the cutoff is evaluated from the value each row stores.
