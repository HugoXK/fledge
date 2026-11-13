# Auto-iterate continuity — from hourly isolated jobs to one carried work item

Status: Phase 1 implemented in #238; phases 2-3 proposed.
Scope: `src/jobs/service.ts`, `bridge/flybot-bridge.mjs`,
`src/flybot/instances.ts`, the `jobs`/`repos`/`work_items` tables, and the Fledge
team prompt.

## 1. The measured problem

DigitalMate has `auto_iterate=1`, `interval_minutes=60`. The scheduler enqueues
an `iterate` job whenever `last_run_at + interval` has passed and no job for the
repo is active (`src/jobs/service.ts:1450`, `:1875`, `:1891`). The job's prompt
is built from `repo.goal` plus generic rules (`src/jobs/service.ts:378`,
`bridge/flybot-bridge.mjs:128`); it does **not** carry the previous job's
summary, the open Fledge PRs/issues, or the work item the previous job started.

Measured on the live DigitalMate repo (last 7 days, Fledge DB):

- 22 scheduled jobs; 17 succeeded, 5 failed.
- 14 produced an issue or PR; 8 produced nothing (zero-output or failed).
- 2026-11-04 hourly runs each produced a separate a11y/bilingual issue+PR
  (#550/#551, #558/#559, #561/#562, #449/#563, #567/#568). There is no merge or
  follow-up step, so the PRs accumulated.
- 2026-11-10 07:59Z scheduled job produced an inventory issue and overwrote
  `#1037`, undoing a manual edit made minutes earlier. Its summary is
  "存量清账（issues-only，本轮 0 分支 0 PR 0 push）" — no product change.

The user's observation is correct: **each run is isolated, and the effect is
poor**. The model is not the only cause; the job contract and scheduler are.

## 2. Root causes

1. **No cross-job state.** The only continuity field is `jobs.checkpoint`,
   which exists to resume the *same* job (`src/jobs/service.ts:214`). A new
   scheduled job starts from `repo.goal` only. `buildText` has no
   "last run produced / still open / do not duplicate" block.
2. **No work-item identity.** `jobs.work_item_id` exists, but scheduled
   `iterate` jobs are enqueued with no work item (`src/jobs/service.ts:1875`),
   so nothing tells the next run which issue/PR to continue.
3. **The scheduler does not look at open work.** It enqueues `iterate`
   regardless of how many Fledge PRs are open. There is no `review`/`followup`
   preference and no cap on open work.
4. **Interval is a wall clock, not a completion signal.** Jobs take 20–90
   minutes; the interval is 60. `activeJobForRepo` prevents overlap, but the
   next job starts immediately after the previous one, with no consolidation.
5. **No output taxonomy.** A run that creates a meta/inventory issue looks like
   success; a zero-output run is indistinguishable from a productive one until
   someone reads the summary. Nothing rejects "盘点/清账/reconcile" work.

## 3. Goals and non-goals

Goals:

- Every scheduled job knows what the previous run did and what is still open.
- A work item is carried across jobs until it is merged/closed or explicitly
  abandoned.
- The scheduler prefers finishing/reviewing existing work over starting new
  work, **without ever skipping a due repository** (#219).
- A run cannot silently produce a meta/inventory issue.
- Operators can see per-run continuity and output category.

Non-goals:

- A full Temporal-style workflow engine.
- Changing the FlyBot/DSH model or the team roles.
- Auto-merging without the existing review/check gates.
- Cross-repo scheduling in this design.

## 4. Proposed design

### 4.1 Persisted run digest

After each job finishes, write a `RunDigest` (new `jobs.continuity_json` or a
`team_run_digests` table):

```json
{
  "schema_version": 1,
  "job_id": "job_...",
  "kind": "iterate",
  "status": "succeeded",
  "started_at": "...",
  "finished_at": "...",
  "summary": "one line",
  "issue_url": "...",
  "pr_url": "...",
  "work_item_id": "wi_...",
  "output_kind": "issue"
}
```

Phase 1 stores exactly these fields. `decisions`, `next_actions` and
`open_work` counts are Phase 2 additions.

The digest is written in `finish()` (`src/jobs/service.ts:573`) from the values
the job already returns (`summary`, `branch`, `prUrl`, `issueUrl`, `error`,
`attribution`). No new model call.

### 4.2 Team state aggregation

Before enqueuing a job, build a compact `TeamState` for the repo:

- the last 3 `RunDigest` rows;
- up to 4 open work items (state, priority, issue URL, PR URL, title);
- the active `work_item_id` (if any);
- counts and the last zero-output/failure streak.

Phase 1 sources this from the local `jobs` and `work_items` tables, so a tick
makes no GitHub call. Phase 2 may add open GitHub PRs/issues that have no local
row and cache them for a few minutes to avoid rate limits.

### 4.3 Scheduler policy

Replace the fixed "if due, enqueue iterate" rule with a pure decision function:

```ts
type NextJob =
  | { kind: 'followup'; workItemId: string; prUrl?: string }
  | { kind: 'review'; prUrl: string }
  | { kind: 'triage' }
  | { kind: 'iterate'; workItemId?: string }
  | { kind: 'none'; reason: string }

function decide(repo, state, now): NextJob
```

Rules, in order:

1. If an open work item exists, `followup` it (same branch/PR if present). This is
   a preference, not a lock: the function never returns `none` just because work
   is open.
2. If that item has an open Fledge PR and a maintainer reviewer is due, `review`
   it. When the review interval has not elapsed, fall back to `followup` rather
   than skipping the repo.
3. Else if `state.openIssues > repo.openIssueCap` → `triage` (close/split
   stale issues; no new feature work).
4. Else if `state.zeroOutputStreak >= 2` or `state.failures >= 2` → `none` with
   exponential backoff (do not burn quota).
5. Else → `none` with reason `idle`. No open work is a valid state: the scheduler
   creates no issue or PR. Phase 2 may add a separate, slower planning session
   that proposes a concrete backlog item; it must not turn the idle tick into a
   generic `iterate`.

The scheduler still respects `activeJobForRepo`, quotas, and the repo role. A
work item that is carried forever is bounded in Phase 2 by `attempts` plus an
`abandoned` state.

### 4.4 Prompt: a bounded carry-over block

Extend `buildText(job)` with a `CARRY-OVER` section, after `Goal:`:

```
[Carry-over - auto-generated state, not a new goal]
Continue the open work item when one exists; do not create a duplicate issue/PR.
Do not create inventory, backlog, or "存量/盘点/清账/reconcile" issues.
Recent runs:
- 2026-11-10T07:59 iterate succeeded: 存量清账 ... [issue link]
Open work:
- wi_446 state=pr_ready priority=1 issue=... pr=... title=...
```

Rules:

- Hard cap 3200 characters; drop oldest first; one line per run/item.
- The block is data, not a new goal; `Goal:` remains the source of intent.
- If there is open work, the prompt says "continue this item; do not create a
  duplicate issue/PR".
- If the job is `review`, the review rules already say "review only; do not
  modify code or create new work".

### 4.5 Work-item state machine

`work_items` already exists (`src/db.ts`), with the shipped vocabulary
`proposed → triaged → assigned → in_progress → pr_ready → in_review →
changes_requested → approved → merged/closed`. Phase 2 **extends** that table
with `branch`, `attempts` and `last_job_id`; it does not add a second table or a
parallel state vocabulary.

```sql
ALTER TABLE work_items ADD COLUMN branch TEXT;
ALTER TABLE work_items ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE work_items ADD COLUMN last_job_id TEXT;
```

Every `iterate` job creates or selects one work item. Every `followup` job
inherits it and adds `attempts`. Terminal states are `merged`, `closed` and the
new `abandoned`. The scheduler still starts a due `iterate` when no work is
open; a work item is a preference, never a lock.

### 4.6 Interval and backoff

- Replace `due = now >= last_run + interval` with:
  `now >= last_run + max(interval, last_duration * 1.5) + cooldown`.
- Add ±10% jitter.
- On zero-output/failure, double the effective interval up to a cap (e.g., 6h).
- On a merged PR or a closed issue, reset the backoff.
- Keep the manual "run now" path unchanged.

### 4.7 Output taxonomy and meta guard

Classify each run's output in `finish()`:

- `issue` (new issue created), `pr` (new/updated PR), `review` (comment/review),
  `zero` (no branch/PR/issue), `duplicate`, `meta`, `failed`.

If the run's reported summary matches
`存量|盘点|清账|清帐|reconcile|inventory|audit the backlog`, mark it `meta`: do
not count it as productive, close its tracking row, and notify the owner. The
classification reads the **result**, never the goal: the goal now carries the
carry-over block that names the forbidden words, so reading it would mark every
scheduled issue as meta. The prompt also explicitly forbids meta/inventory
issues; this is the server-side backstop. Phase 2 should also read the created
issue's title when the runner reports it.

### 4.8 Observability

Add per-run fields to the job record:

- `output_kind`, `continuity_used` (bool), `carry_over_items` (count),
  `duplicate_hits`, `open_work_before/after`.

Expose:

- `fledge_job_output_total{kind,output}` (Phase 1);
- `fledge_meta_issue_total{kind}` (Phase 1);
- `continuity_carry_over_total`;
- `open_work_items{repo}`;
- `zero_output_streak{repo}`.

### 4.9 Migration

1. Add nullable columns `jobs.continuity_json`, `jobs.output_kind` and
   `jobs.continuity_used`; no backfill required (Phase 1).
2. Extend the existing `work_items` table; do not create a second one (Phase 2).
3. Backfill `work_items` lazily from the first scheduled job per repo.
4. Keep the old scheduler behind a flag for one release; Phase 1 does not.

## 5. Rollout

Phase 1 (implemented in #238):

- Inject the last 3 run digests and open work items into the scheduled goal
  (reusing the existing `jobs` and `work_items` tables; no GitHub list call).
- If open work exists, enqueue `followup`/`review` instead of a fresh `iterate`;
  a review that is not due falls back to `followup`. With no open work, return
  `idle` and create no job/issue/PR.
- Use the short global work cooldown (`WORK_SESSION_COOLDOWN_MINUTES`, default
  15 minutes); the per-repository interval is only an upper bound on the idle
  check. Back off after two unproductive runs.
- Persist `jobs.continuity_json`, `jobs.output_kind` and `jobs.continuity_used`;
  add the "no meta issue" prompt rule and the result-based backstop.

Deliberately smaller than the first draft: the default interval is unchanged,
Phase 1 reuses the local work items instead of listing GitHub PRs, and a meta run
closes its tracking row rather than inventing a new work-item state.

Phase 2 (1–2 weeks):

- Extend the existing `work_items` table; carry `work_item_id` and `attempts`
  across jobs; add `abandoned`; implement the full `decide()` policy with tests.
- Add the idle `discover` session: at the repository interval it may create one
  concrete issue and no PR; an empty result is zero output.

Phase 3:

- Add continuity metrics/dashboard, per-repo caps, and a manual "continue this
  item" control.

## 6. Tests

- `decide()` unit tests: open work → followup; maintainer PR and review due →
  review; review not due → followup, never `none`; zero-output streak → none
  (backoff); empty → iterate.
- `buildText()` snapshot: carry-over is bounded, includes the last summaries and
  open work, and never exceeds the goal limit.
- Work-item transitions stay on the shipped vocabulary; an open item changes the
  next job kind but never blocks a due repo.
- Meta guard: a run whose result is "存量清账" is classified `meta`, closes its
  tracking row, and does not count as productive. A normal issue with a
  carry-over goal is **not** meta.
- Idempotency: retrying a job does not create a second issue/PR for the same
  work item.
- Integration: fake GitHub + temp SQLite; assert the second scheduled run
  follows up the first PR instead of creating a new one.

## 7. Risks

| risk | mitigation |
|---|---|
| Stale carry-over misleads the model | timestamp every digest; cap to last 3; mark stale > 7 days |
| GitHub API rate limits | cache open PR/issue lists; use the local `jobs` table first |
| Work item stuck forever | `attempts` cap + `abandoned` state + needs-human notification |
| Meta guard false positives | match only titles; log the rejected title; owner can override |
| Backoff hides a real outage | expose `zero_output_streak`; manual run bypasses backoff |
