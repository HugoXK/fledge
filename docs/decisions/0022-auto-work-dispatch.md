# 0022 — auto-work dispatch: event-driven stages, a short work cooldown, opt-in discovery promotion

Status: **accepted** (owner, 2026-11-15)
Date: 2026-11-15
Decision owner: HugoXK
Supersedes: nothing; it settles #800 and reconciles #801, #803 and #807 with the
scheduler that already exists on `main`

## Context

#800 asks six questions and assumes the platform still dispatches work from a
set of independent wall-clock timers. That premise is out of date. The scheduler
on `main` already has the decision function and the stage chain that #800 was
written to introduce:

- `decideNextJob()` (`src/jobs/continuity.ts:290`) returns `discover`,
  `followup`, `review` or `none`, in that order of precedence, from open work
  items, a work cooldown, a failure streak and a review window.
- `tickOnce()` (`src/jobs/service.ts:3570`) runs every 60 seconds
  (`start()` at `:4005`). It calls `decideNextJob()` and enqueues exactly one
  stage per repository, guarded by `activeJobForRepo()` and `atCapacity()`.
- A successful job already chains the next stage: `autoQueueNextStage()`
  (`:2528`) queues `verify` when the repository uses the stage gate, then
  `autoQueueReview()` (`:2555`) queues `review`.
- A failed job already backs off: `retryDecision()` (`src/lib/retry.ts`) retries
  a transient failure at 1 minute, then 2 minutes, capped at 30 minutes and at
  two attempts; `isDue()` multiplies the work cooldown by `2^(streak-1)` up to
  4 for a streak of two or more; three consecutive failures pause auto-iteration
  (`checkRepeatedFailures()`, `src/jobs/service.ts`).
- Discovery is already its own cadence and issue-only:
  `MIN_DISCOVERY_INTERVAL_MINUTES = 60` (`continuity.ts:286`),
  `discoverDue()` (`service.ts:3805`), and a discovery callback that carries a
  branch or PR is refused with `DISCOVERY_PR_FORBIDDEN` (`service.ts:3078`).
- Queue dispatch, job leases and admission limits exist for the optional worker
  pool: `QUEUE_DISPATCH`, `QUEUE_MAX_DEPTH`, `QUEUE_MAX_PER_USER`, job
  `lease_owner`/`lease_until`, `renewJobLease()`, `expiredLeaseJobs()` and
  `claimScheduleOccurrence()`.
- Work items and their state machine exist (`src/db.ts:1362`,
  `src/lib/workItems.ts`), and stage outcomes update them.

What is still wrong or undecided is smaller than #800 assumes:

1. A **successful** work job still waits the 15-minute
   `WORK_SESSION_COOLDOWN_MINUTES` (`src/config.ts:359`) before the next work
   item, even when the backlog is non-empty. #801 is the delta.
2. A **discovered** issue is promoted to a work item unconditionally today:
   `syncWorkItemForJob()` (`service.ts:1327`) creates a row for any succeeded job
   that returns an `issueUrl`. #800/#803 ask for an explicit opt-in with a cap.
3. There are no dispatch metrics: `idle_with_work`, dispatch latency, blocked
   cooldown, queue depth and failure backoff are not exposed. #807 is the delta.
4. Per-role concurrency is not defined. It is deferred by [0023](0023-per-role-concurrency-and-leases.md).

The decision below therefore records the model `main` already implements, makes
the two remaining behaviour decisions explicit, and reconciles the follow-up
cards instead of asking for a second scheduler.

## Decision

### 1. Work dispatch is event-driven, with a short cooldown

A finished work job is the event that makes the next work item due. After a
**successful** job, the next ready work item is dispatched on the next tick
(≤ 60 seconds); the success cooldown is removed. This is the decision; the code
change is #801.

The cooldown is not removed for a failure. A failed or zero-output job keeps the
existing `retryDecision()` backoff, the `isDue()` failure multiplier and the
three-failure auto-pause. A manual "run now" bypasses both, as it does today.

The repository interval remains an upper bound for a repository with no open
work item: it bounds discovery, not work. With a saved schedule row, the row is
the only cadence gate (`src/schedules/next.ts`, `planTick()`).

### 2. Discovery is a separate, slower cadence and never replaces work

Discovery stays issue-only and runs at `max(60, interval_minutes)` from the
`discover:<repo>` timestamp. `decideNextJob()` never returns `discover` while a
work item is open; it returns `followup` or `review` first. The callback boundary
(`DISCOVERY_PR_FORBIDDEN`) stays the enforcement; the prompt is not the guard.

A repository with an empty backlog may therefore run one discovery session per
discovery interval and must not create a pull request. This is already the
behaviour; this decision keeps it and forbids a second discovery cadence on a
separate timer.

### 3. Review is queue-driven first, interval second

When an open work item has a PR and the reviewer is enabled and due,
`decideNextJob()` returns `review` for that work item. That event path wins over
the repository review interval. `dueReview()` remains a fallback sweep for a
maintainer repository with a Fledge PR that has no active job and no other work
item driving it.

Two review jobs are never created for the same PR at the same head SHA. A new
head SHA supersedes an in-flight review (the existing head-supersede rule), and
a review that is not due never blocks a due repository: it becomes a `followup`
on the same PR (`decideNextJob()`).

### 4. Concurrency is one active job per repository

`activeJobForRepo()` plus the partial unique index
`jobs_one_active_per_repo` (`src/db.ts:2154`) keep one active job per repository.
`QUEUE_DISPATCH` is a worker pool for jobs across repositories, not a licence to
run two jobs in one repository. Role lanes and work-item leases are #806/0023;
they are not enabled by this decision.

### 5. Discovery-to-work-item promotion is opt-in, default off

A discovered issue becomes a work item only when the owner enables
`AUTO_PROMOTE_DISCOVERY` for the repository. The default is **off**. When it is
on:

- at most one `proposed` work item is created per issue URL (dedupe by URL);
- a daily cap bounds promotions, and the skip reason is recorded;
- promotion creates no branch and no PR, and it never enables auto-merge;
- triage's explicit `triage.next` proposal continues to use the same work-item
  path; this decision does not remove it.

The current unconditional `syncWorkItemForJob()` promotion of a discovery
`issueUrl` is therefore a defect against this decision, not a feature. #803 owns
the flag, the cap and the dedupe, and its red test must show that a discovered
issue with the flag off leaves the backlog unchanged.

Consent is per repository and off by default because promotion turns a
read-only discovery run into work the team will pick up without a person asking.

### 6. Backpressure is capacity, not a wall clock

The brakes are, in order: quota (`QUOTA_EXHAUSTED`), `PLATFORM_MAX_ACTIVE_JOBS`,
the queue limits (`QUEUE_MAX_DEPTH`, `QUEUE_MAX_PER_USER`) when dispatch is
queued, GitHub rate limits, and the review queue. A fixed timer is not a brake.
When capacity is available and a work item is ready, dispatch happens on the
next tick; when the platform is at capacity, nothing is enqueued and the existing
counter records the refusal.

## Reconciled follow-up cards

| Card | State under this decision |
|---|---|
| #801 — dispatch immediately after success | Keep. This decision removes the success cooldown; keep failure backoff and the active-job guard. Its premise about a 15-minute `WORK_SESSION_COOLDOWN_MINUTES` is correct. |
| #803 — promote a discovery issue | Keep, with a correction: the code already promotes unconditionally, so the card must add the opt-in flag, the daily cap and the dedupe, and its red test must prove the default-off path changes nothing. |
| #807 — queue and dispatch metrics | Keep. `idle_with_work`, `dispatch_latency_ms`, `cooldown_blocked`, `queue_depth`, `active_jobs` and `failure_backoff` are the counters this model needs. |
| #806 / 0023 — per-role concurrency and leases | Depends on this decision. It is not a scheduler rewrite; it is a new concurrency unit on top of the single-job guard. |

## Rejected

- **Add a second scheduler for work, discovery and review.** Rejected: the
  single `decideNextJob()` already orders the stages, and a second scheduler is
  how two jobs start for one repository.
- **Remove failure backoff with the success cooldown.** Rejected: a transient
  bridge or model failure would immediately re-run the same failing work and
  burn quota; the failure path is the one place a delay is useful.
- **Promote discovery by default.** Rejected on consent: a read-only run must
  not silently create work the owner did not ask for.
- **Treat the repository interval as the work cadence.** Rejected: it is a
  fallback bound for an empty backlog and for discovery, not the work dispatch
  signal. `docs/decisions/0017` already makes the page, dashboard and digest
  print one next-run answer.

## Consequences and rollback

- The next work item starts within one tick of a success. The repository page
  must show the queue and the dispatch reason, not imply the interval is the
  work interval; `docs/decisions/0017` keeps the anchors and the single
  next-run sentence.
- `WORK_SESSION_COOLDOWN_MINUTES` remains a documented spacing control: raising
  it restores a deliberate gap without code. `QUEUE_DISPATCH=false` keeps the
  inline dispatch path.
- `AUTO_PROMOTE_DISCOVERY` defaulting off means an idle repository with no work
  items keeps discovering (slowly) and does not build an invisible backlog.
- No auto-merge rule changes in this decision. A promoted work item still goes
  through plan/scope/verify/review and the normal merge gate.
- Risk is T3 because the follow-up cards touch `src/jobs/`; this document alone
  is a docs change.
