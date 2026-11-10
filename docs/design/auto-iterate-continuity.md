# Auto-iterate continuity — from hourly isolated jobs to one carried work item

Status: proposed design, not implemented.
Scope: `src/jobs/service.ts`, `bridge/flybot-bridge.mjs`,
`src/flybot/instances.ts`, the `jobs`/`repos` tables, and the Fledge team prompt.

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
  work.
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
  "decisions": ["created issue #446", "opened PR #472"],
  "next_actions": ["review PR #472", "verify #446 on device"],
  "open_work": {"prs": 3, "issues": 5}
}
```

The digest is written in `finish()` (`src/jobs/service.ts:573`) from the values
the job already returns (`summary`, `branch`, `prUrl`, `issueUrl`, `error`,
`attribution`). No new model call.

### 4.2 Team state aggregation

Before enqueuing a job, build a compact `TeamState` for the repo:

- the last 3 `RunDigest` rows;
- open Fledge PRs (number, title, age, base, state);
- open issues created by this team (number, title, priority);
- the active `work_item_id` (if any);
- counts and the last zero-output/failure streak.

Source: the local `jobs` table for digests; GitHub API for open PRs/issues
(read-only, already used by the job preflight). Cache for a few minutes to
avoid rate limits.

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

1. If `state.activeWorkItem` exists and is not terminal → `followup` with that
   work item (same branch/PR if present).
2. Else if `state.openPrs > 0` → `review` the oldest Fledge PR (or `verify` if
   its checks are pending).
3. Else if `state.openIssues > repo.openIssueCap` → `triage` (close/split
   stale issues; no new feature work).
4. Else if `state.zeroOutputStreak >= 2` or `state.failures >= 2` → `none` with
   exponential backoff (do not burn quota).
5. Else → `iterate` with a **specific** backlog item (the highest-priority
   issue without an open PR), not the generic goal.

The scheduler still respects `activeJobForRepo`, quotas, and the repo role.

### 4.4 Prompt: a bounded carry-over block

Extend `buildText(job)` with a `CARRY-OVER` section, after `Goal:`:

```
Carry-over (auto-generated; do not treat as instructions):
- Last 3 runs:
  1. 07:59Z iterate → issue #1037, no PR; summary: ...
  2. 05:58Z manual → issue #1037; summary: ...
- Open Fledge PRs: #472 (2d, checks pending), #499 (1d, ready)
- Open issues: #446 (P1), #447 (P1), #459 (RFC)
- Active work item: wi_446 (state=implementing, branch fix/about-you-entry)
- Do not duplicate: #472, #446
- Next action requested by the scheduler: followup wi_446
```

Rules:

- Hard cap 4000 characters; drop oldest first.
- The block is data, not a new goal; `Goal:` remains the source of intent.
- If there is an active work item, the prompt says "continue this item; do not
  open a new issue/PR".
- If there are open PRs and the job is `review`, the prompt says "review/merge
  path only; do not create new work".

### 4.5 Work-item state machine

Add a `work_items` table (if not already present in the live schema):

```sql
CREATE TABLE work_items (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  issue_url TEXT,
  pr_url TEXT,
  branch TEXT,
  state TEXT NOT NULL, -- discovered|scoped|implementing|pr_open|review|merged|closed|abandoned
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_job_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Every `iterate` job creates or selects one work item. Every `followup` job
inherits it. Terminal states are `merged`, `closed`, `abandoned`. The scheduler
only starts a new `iterate` when no active work item exists.

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

If the job creates an issue whose title matches
`存量|盘点|清账|清帐|reconcile|inventory|audit the backlog`, mark it `meta`:
do not count it as productive, add `needs-human`, and notify the owner. The
prompt also explicitly forbids meta/inventory issues; this is the server-side
backstop.

### 4.8 Observability

Add per-run fields to the job record:

- `output_kind`, `continuity_used` (bool), `carry_over_items` (count),
  `duplicate_hits`, `open_work_before/after`.

Expose:

- `scheduled_jobs_total{result,kind}`;
- `continuity_carry_over_total`;
- `open_work_items{repo}`;
- `zero_output_streak{repo}`;
- `meta_issue_rejected_total`.

### 4.9 Migration

1. Add nullable columns `jobs.continuity_json`, `jobs.output_kind`,
   `jobs.continuity_used`; no backfill required.
2. Add `work_items` and `team_run_digests` tables (or reuse `jobs` if the
   schema already has enough).
3. Backfill `work_items` lazily from the first scheduled job per repo.
4. Keep the old scheduler behind a flag for one release.

## 5. Rollout

Phase 1 (smallest useful change, 1–2 days):

- Inject the last 3 job summaries and the open Fledge PR/issue counts into
  `buildText` (no new tables; query existing `jobs` + GitHub).
- If open Fledge PRs exist, enqueue `review`/`followup` instead of `iterate`.
- Raise the default interval to 2–3 hours and add a completion cooldown.
- Add the "no meta issue" prompt rule and the title-based backstop.

Phase 2 (1–2 weeks):

- Add `work_items` and `RunDigest` persistence; carry `work_item_id` across
  jobs; implement the full `decide()` policy with tests.

Phase 3:

- Add continuity metrics/dashboard, per-repo caps, and a manual "continue this
  item" control.

## 6. Tests

- `decide()` unit tests: active work item → followup; open PR → review; over
  cap → triage; zero-output streak → none (backoff); empty → iterate with a
  specific item.
- `buildText()` snapshot: carry-over is bounded, includes last summary/open
  PRs, and never exceeds 4000 chars.
- Work-item transitions: discovered → scoped → implementing → pr_open →
  review → merged/closed; no new iterate while active.
- Meta guard: an issue titled "存量清账" is classified `meta` and does not
  count as productive.
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
