# 0023 — concurrency is one job per repository; the lease belongs to the work item

Status: **accepted** (owner, 2026-11-15)
Date: 2026-11-15
Decision owner: HugoXK
Depends on: [0022](0022-auto-work-dispatch.md)
Supersedes: nothing; it settles #806 and defers role lanes until the FlyBot
bridge exposes a supported multi-session and claim contract

## Context

#806 asks whether a repository may run more than one work job at a time and, if
so, how a role or idle lane claims the next item without two jobs colliding. It
assumes the platform has no claim primitive. That is only partly true.

What already exists on `main`:

- **One active job per repository is already structural, not just a check.**
  `activeJobForRepo()` (`src/db.ts:5488`) is called before every enqueue, and the
  partial unique index `jobs_one_active_per_repo` (`src/db.ts:2154`) makes a
  second active row for one repository impossible even under a race.
- **A job already has a worker lease.** Queue dispatch writes `lease_owner` and
  `lease_until` before starting a worker (`src/jobs/service.ts:3444`), renews it
  with `startLeaseHeartbeat()` (`:3510`), and the reaper fails a job whose lease
  expires (`expiredLeaseJobs()`, `src/db.ts:5571`; `releaseJobLease()` at
  `:5567`). This is a lease on the *worker*, not on the work item.
- **A scheduled occurrence already has a claim lease.**
  `claimScheduleOccurrence()` (`src/db.ts:4860`) claims one logical instant in a
  single transaction with a token and an expiry, so two workers cannot dispatch
  the same window; a lapsed claim is recovered under the same row and its
  `attempts` count is preserved.
- **A work item exists with a state machine.** `work_items`
  (`src/db.ts:1362`) carries `state`, `job_id`, `assignee_user_id`, `pr_url` and
  `pr_state`; `WORK_ITEM_TRANSITIONS` (`src/lib/workItems.ts`) is the only list
  of allowed moves.
- **Per-role activity is already observable.** `teamState()`
  (`src/flybot/instances.ts:742`) reads DSH `state` and returns, per role,
  `activity` (including `idle`), `calls`, `since`, `tool`, `step` and
  `lastActivityAt`. Fledge does not need a new "is this role idle?" endpoint to
  see idle capacity inside one repository.
- **A job routes to one role session.** `enqueue()` chooses the session by kind:
  `review` → Reviewer, `scope` → Product, `verify` → Test, everything else →
  Chief (falling back to Lead) (`src/jobs/service.ts:1127-1142`). The bridge
  `POST /run` accepts one `sessionId` and returns `202` once DSH accepts the
  message (`bridge/README.md`).

What does **not** exist: a lease on the work item itself, and any evidence that
DSH supports two concurrent jobs in one repository without one session
disturbing another. The missing primitive is therefore the work-item lease, not
per-role concurrency.

## Decision

### 1. Concurrency: one active job per repository in this phase

Keep `activeJobForRepo()` and `jobs_one_active_per_repo`. A repository runs one
job at a time. A job may use several roles internally (the stage chain in 0022);
that is not concurrency.

Role lanes are not enabled. Do not add a per-role concurrency flag before the
bridge contract in §5 exists and a work-item lease enforces the claim.

### 2. The unit is the work item, not the role lane

A role is a stage of one job, not an independent unit of work. A future lane
model is one job per **work item**, with the job's `kind` naming the stage
(`scope`, `iterate`, `verify`, `review`). Two jobs never run for the same work
item, and two work items never share a branch or a PR.

This keeps the existing rules intact: one issue → one branch → one PR, and a
review only after the PR is ready at a head SHA.

### 3. A work-item lease is the missing claim

Add a lease to the work item, modelled on `claimScheduleOccurrence()`:

- fields: `lease_owner`, `lease_expires_at`, `heartbeat_at`, `attempts`;
- claim is a conditional update inside the existing `BEGIN IMMEDIATE`
  transaction, of the form
  `UPDATE work_items SET lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1 WHERE id = ? AND state NOT IN ('merged','closed') AND (lease_expires_at IS NULL OR lease_expires_at < ?)`;
- a live lease refuses the claim; a lapsed lease is recoverable under the same
  row, so `attempts` records how many workers held the item;
- release happens on a terminal callback, cancel, or the stall/lease sweep,
  exactly where `releaseJobLease()` runs today;
- expiry is `runner.timeoutMinutes` plus a grace period, not a new config
  number, so the job deadline and the item lease cannot disagree.

The lease is the **item-level** guard across jobs. It does not replace the job
lease (the worker's heartbeat) or the schedule-occurrence lease (the window).
The three answer three different questions: may this item be picked up, is this
worker alive, and has this instant been decided.

### 4. Conflict rules

- One branch and one PR per work item; a second branch is a defect, not a lane.
- No two developers on one item; the lease makes the second claim lose.
- Review only after `pr_ready`, and a review at a head SHA is not repeated at
  the same SHA.
- A new head SHA supersedes an in-flight review; the old review's result is
  history, not a second conclusion.
- No two jobs mutate the same branch. A `followup` inherits the item's branch;
  it never forks a second one.
- `merged` and `closed` are terminal and cannot be re-leased.

### 5. What the bridge must provide before role lanes

Phase 1 needs no new bridge endpoint: `teamState()` already answers "is this
role idle?" inside one instance. Before two jobs may run in one repository, the
bridge must acknowledge and support:

1. **Concurrent sessions, explicitly.** Either a capability response that says
   two jobs may run in this instance, or an explicit "serialized" answer that
   Fledge records and obeys. Silence is not consent.
2. **Send isolation.** A `POST /run` for one role must not cancel, redirect or
   interleave with a running turn in another session, and a failure in one job
   must not fail the other.
3. **Callback identity.** A callback must identify job and work item, so a
   duplicate delivery cannot settle the wrong item. `handleCallback` already
   carries the job id in the path; the work item is on the job row, and that
   binding stays.

A role-status endpoint is not required for phase 1. It is required only if lanes
ever span instances or hosts.

### 6. Limits and backpressure

- per repository: one concurrent job now, more only after §5;
- per platform: `PLATFORM_MAX_ACTIVE_JOBS` and, under `QUEUE_DISPATCH`,
  `QUEUE_MAX_DEPTH` / `QUEUE_MAX_PER_USER`;
- per user: the queue limit and quota;
- failure isolation: one job's failure releases only its own item lease and
  triggers the retry/backoff path in 0022; it does not drain another lane.

### 7. Rollout order

1. Event-driven single-job dispatch (0022, #801).
2. Opt-in discovery promotion with cap and dedupe (#803).
3. Dispatch and queue metrics (#807).
4. Work-item lease and claim (this document, no lane).
5. Role lanes behind a flag, only after §5 is implemented and tested.
6. Cross-repository or global queue, if ever.

Each step keeps `jobs_one_active_per_repo` in place. A lane feature that cannot
be expressed without removing that index is out of scope.

## Explicit "not now"

- No per-role concurrency flag before the work-item lease exists.
- No auto-scaling of lanes.
- No bridge contract change before §5 is agreed.
- No second job for one work item.
- No lane UI (matrix of roles × jobs).

## UI constraint

If a queue or lane state is shown, the Work page uses one short queue line and
one row per work item, consistent with the existing page. The repository anchors
(`#work`, `#board`, `#overview`, `#team`, `#settings`, `#danger`) and the
single next-run vocabulary in `docs/decisions/0017` stay. Do not introduce a
second scheduling vocabulary or a table of tiny role cells.

## Consequences

- The claim primitive is added where it is missing (the work item), not where
  one already exists (the worker and the schedule instant).
- Nothing changes for a repository today: one job at a time, the same stage
  chain and the same merge gate.
- A stuck work item becomes visible through `attempts` and an expired lease
  instead of blocking the backlog silently.
- Risk is T3 because the lease and any lane rollout touch `src/jobs/`,
  `src/db.ts` and `bridge/`; this document alone is a docs change.
