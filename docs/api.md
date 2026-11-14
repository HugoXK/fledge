# API

All browser routes are HTML. Machine routes are JSON. Errors use:

```json
{ "error": { "type": "quota_exhausted", "code": "FLEDGE_QUOTA_EXHAUSTED", "message": "..." } }
```

## Browser routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | public | Landing or redirect to dashboard |
| GET | `/auth/github` | public | Start OAuth |
| GET | `/auth/github/callback` | public | OAuth callback |
| GET | `/auth/github/app/install` | approved | Redirect to the GitHub App installation page |
| GET | `/auth/github/app/installed` | approved | Bind an installation to the current user (falls back to a matching unbound installation) |
| GET | `/auth/github/app/callback` | approved | Alias for the installed callback |
| GET | `/auth/github/reauthorize` | approved | Re-authorize with repo scope for user-attributed App writes |
| GET | `/repos/new` | approved | GitHub App installations and repository picker |
| POST | `/repos/app` | approved + CSRF | Connect repositories through an installation |
| POST | `/api/github/webhook` | GitHub signature + delivery id | GitHub App webhook ingestion, replay dedupe and CI/review/auto-merge follow-up |
| POST | `/auth/token` | public, rate-limited | Sign in with a GitHub token when OAuth is not configured |
| POST | `/auth/logout` | session + CSRF | Sign out |
| GET | `/apply` | session | Disclaimer and information-security signature |
| POST | `/apply` | session + CSRF | Submit the signed application once |
| GET | `/apply/status` | session | Live queue position and status |
| GET | `/api/application` | session | JSON status/queue for the status page |
| GET | `/dashboard` | approved + session | Repos, quota, jobs, personal delivery metrics (`?window=7 or 30`) |
| GET | `/console` | approved + session | Workspace overview (repos, jobs, quota) |
| POST | `/repos` | approved + CSRF | Add an upstream repository; Fledge checks or creates the user's fork |
| GET | `/repos/:id` | owner | Repo detail, including the selected role, delivery board and allowed roles (`?workState=...` filters the work-item list) |
| GET | `/readyz` | public | Database and per-repository instance readiness summary |
| GET | `/metrics` | `Authorization: Bearer <METRICS_TOKEN>` only | Prometheus metrics; a production start refuses an empty `METRICS_TOKEN`, so there is no unauthenticated production path, and a `?token=` query value is not accepted |
| GET | `/api/read/metrics` | approved | Read-only metrics: a super admin gets the global window, users get their own personal window (`?window=7 or 30`) |
| GET | `/schedule` | approved | Schedule preview page: the next runs of a cron expression or interval, with local times and DST skips |
| GET | `/api/schedule/preview` | approved | The same preview as JSON |
| GET | `/repos/:id/schedule` | owner | Schedule console: the stored schedule, the planner's next run, the newest decided instant (state, reason, attempts, lease) and the last success; an unknown value prints `unknown` |
| POST | `/repos/:id/schedule` | owner + CSRF | Save the console form (cron or interval, zone, window); audits `schedule.saved` and writes nothing when the form is refused |
| POST | `/repos/:id/schedule/remove` | owner + CSRF | Delete the schedule so the repository returns to its legacy interval; audits `schedule.removed` |
| POST | `/repos/:id/run` | owner + CSRF | Enqueue a manual iterate job; plan-first repositories enqueue a plan |
| POST | `/repos/:id/work` | owner + CSRF | Create a work item |
| POST | `/repos/:id/work/:workItemId/state` | owner + CSRF | Move a work item through the triage/assignment/review state machine |
| POST | `/repos/:id/work/:workItemId/run` | owner + CSRF | Start a plan or iterate job for a work item |
| POST | `/repos/:id/work/:workItemId/scope` | owner + CSRF | Queue a Product scope job for a work item |
| POST | `/repos/:id/work/:workItemId/verify` | owner + CSRF | Queue a Test verify job for a work item with a PR |
| POST | `/repos/:id/role` | owner + CSRF | Select `maintainer` or `developer` for this user-repository connection |
| POST | `/repos/:id/plan` | owner + CSRF | Enqueue a plan-only job (no code, branch or PR) |
| POST | `/repos/:id/instance` | owner + CSRF | Start the per-repository FlyBot instance |
| POST | `/repos/:id/instance/stop` | owner + CSRF | Stop the per-repository FlyBot instance |
| POST | `/repos/:id/refresh` | owner + CSRF | Re-check the upstream, fork and permissions |
| POST | `/repos/:id/enable` | owner + CSRF | Enable the repository connection |
| POST | `/repos/:id/disable` | owner + CSRF | Disable scheduling and cancel active jobs |
| POST | `/repos/:id/delete` | owner + CSRF | Delete the Fledge connection after typing the repository name |
| GET | `/api/inbox/events` | approved | Server-Sent Events stream of the user's inbox |
| POST | `/repos/:id/review` | owner + CSRF | Enqueue a manual review job |
| GET | `/repos/:id/jobs/:jobId` | owner | Job detail: evidence, cost, attribution, retry |
| POST | `/repos/:id/jobs/:jobId/retry` | owner + CSRF | Retry a failed job, including its checkpoint |
| POST | `/repos/:id/jobs/:jobId/approve-plan` | maintainer + CSRF | Approve a completed plan with allowed/forbidden paths |
| POST | `/repos/:id/jobs/:jobId/reject-plan` | maintainer + CSRF | Reject a completed plan |
| POST | `/repos/:id/jobs/:jobId/execute` | maintainer + CSRF | Execute an approved plan as an iterate job |
| POST | `/repos/:id/jobs/:jobId/recheck` | owner + CSRF | Re-read the PR, checks, reviews and changed files; store verification and path-guard state |
| POST | `/repos/:id/jobs/:jobId/merge` | maintainer + CSRF | Re-check paths, evidence, checks and protection, then squash-merge a Fledge PR |
| POST | `/repos/:id/delivery/merge-clean` | maintainer + CSRF | Re-check paths, evidence and merge gates for all clean Fledge PRs, skipping blocked ones |
| POST | `/repos/:id/jobs/:jobId/cancel` | owner + CSRF | Cancel a queued or running job |
| POST | `/repos/:id/jobs/:jobId/pause` | owner + CSRF | Pause a queued or running job |
| POST | `/repos/:id/jobs/:jobId/resume` | owner + CSRF | Resume a paused job from its checkpoint |
| GET | `/repos/:id/workspace` | owner | Fledge-branded agent workspace shell |
| `*` | `/repos/:id/workspace/app/*` | owner | Authenticated reverse proxy to the per-repo DSH UI |
| GET | `/repos/:id/team` | superadmin | Team console |
| GET | `/api/repos/:id/team` | superadmin | Team state JSON (polling fallback) |
| GET | `/api/repos/:id/team/events` | superadmin | Server-Sent Events snapshot stream |
| POST | `/repos/:id/team/guidance` | superadmin + CSRF | Send guidance to a role |
| POST | `/repos/:id/chief/message` | owner + CSRF | Send guidance to the Chief from the simplified UI |
| GET | `/api/repos/:id/chief/messages` | owner | Chief conversation snapshot (filtered/redacted) |
| GET | `/api/repos/:id/chief/events` | owner | Server-Sent Events for new Chief messages |
| POST | `/api/repos/:id/team/answer` | superadmin + CSRF | Answer a team question |
| POST | `/api/repos/:id/team/stop` | superadmin + CSRF | Stop the active roles (hard when possible, otherwise a stop request) |
| POST | `/repos/:id/settings` | owner + CSRF | Goal, target branch, role, plan-first, path constraints, merge method/protection, stage mode, budgets, model selection, bot models, cadence, enabled, reviewer interval |
| POST | `/repos/:id/delete` | owner + CSRF | Delete the Fledge connection after typing the repository name; GitHub is untouched |
| GET | `/settings` | approved | Account, model providers and models, API tokens |
| GET | `/admin/webhooks` | superadmin | Recent GitHub webhook deliveries, filters and retry state |
| POST | `/admin/webhooks/:id/retry` | superadmin + CSRF | Retry one failed delivery from its stored payload |
| GET | `/admin/metrics` | superadmin | Product funnel, delivery efficiency, daily trend, failure breakdown, cost breakdown, actionable alerts, team participation, attribution and stage metrics (`?window=7 or 30`) |
| POST | `/settings/model` | approved + CSRF | Save/clear own model |
| POST | `/settings/notifications` | approved + CSRF | Notification email, job/question mail, per-job success mail, daily digest, test mail |
| POST | `/settings/tokens` | approved + CSRF | Create a `flg_` token |
| POST | `/settings/tokens/:id/revoke` | owner + CSRF | Revoke a token |
| POST | `/notifications/read` | approved + CSRF | Mark notifications read |
| GET | `/admin` | admin / super admin | Scoped pending users, quotas, jobs and audit (admins see themselves and normal users only) |
| GET | `/admin/metrics` | owner | Product funnel, success rate, job cost, team participation, events |
| POST | `/admin/users/:id/approve` | admin + CSRF | Approve |
| POST | `/admin/users/:id/reject` | admin + CSRF | Reject |
| POST | `/admin/users/:id/quota` | admin / super admin + CSRF | Set quota in CNY; unlimited is super-admin-only |
| POST | `/admin/users/:id/role` | owner + CSRF | Promote a normal user to admin or demote an admin |
| POST | `/admin/simulation` | owner + CSRF | Toggle the normal-user UI preview |
| POST | `/admin/platform/stop` | admin + CSRF | Stop all platform work: every enqueue is refused with `PLATFORM_PAUSED`, active jobs are paused or cancelled, one audit row records who and why. The read-only preview does not block it |
| POST | `/admin/platform/resume` | admin + CSRF | Clear the platform stop and report the repositories the next tick will consider; it re-enqueues nothing |
| GET | `/approve/:token` | token | Confirmation page |
| POST | `/approve/:token` | token | Apply approve/reject |

## Management commands (internal)

There is no public management HTTP endpoint yet; #392 exposes one. The contract
is internal (`src/management/`) and the console call it outlives:

```ts
POST /repos/:id/jobs/:jobId/cancel   // form adapter, carries expected_revision and idempotency_key
POST /repos/:id/jobs/:jobId/pause    // same adapter shape, behind MANAGEMENT_SERVICE
POST /repos/:id/jobs/:jobId/resume   // same adapter shape, fenced on the job
POST /repos/:id/jobs/:jobId/retry    // same adapter shape, fenced on the job
POST /repos/:id/run                  // task.create, fenced on the project
POST /repos/:id/plan                 // task.create, kind=plan
POST /repos/:id/review               // task.create, kind=review
POST /repos/:id/triage               // task.create, kind=triage
POST /repos/:id/work/:itemId/run     // task.create with a work item
POST /repos/:id/work/:itemId/scope   // task.create, kind=scope
POST /repos/:id/work/:itemId/verify  // task.create, kind=verify
POST /repos/:id/jobs/:jobId/execute  // task.create from an approved plan
```

A command is `{ operation, target: { projectId, jobId? }, arguments,
expected_revision, idempotency_key, source_conversation?, source_message? }`.
The server fills the actor; a payload that carries an identity field is refused.
`task.create` takes `{ kind, goal?, workItemId?, prUrl?, priority? }`; a
`workItemId` must belong to the project, checked again at execution time, and a
`priority` outside `0..100` (or not an integer) is refused rather than clamped.

`/execute` is the only create drawn on a job page, so it is the one form whose
hidden revision is the **project's**: cancel, pause, resume and retry fence the
job they are printed on, but an execute starts a new job and must send the
revision `task.create` compares. It also writes the `job.executed` audit row
that links the plan to the job it started.

| Outcome | Meaning |
|---|---|
| `succeeded` | The business write ran; the receipt records before/after revision and result |
| replay of a `succeeded` receipt | Same key and same arguments; nothing runs again |
| `idempotency_conflict` | Same key, different arguments; refused, the first receipt stands |
| `management_revision_conflict` | The resource moved on; nothing was written |
| `authorization_revoked` | The caller lost the capability between acceptance and execution; nothing was written |
| `job_not_cancellable` | The job had already finished; the cancel operation refused |
| `job_not_pausable` | The job had already finished; the pause operation refused |
| `job_not_resumable` | The job is not paused; the resume operation refused |
| `job_not_retryable` | The job is queued or running; the retry operation refused |
| `invalid_arguments` | The command's arguments failed validation; nothing was written |
| `work_item_not_found` | The named work item is not in this project |
| `task_not_queued` | `Jobs.enqueue` refused without a code of its own |
| `command_in_progress` | The receipt is `accepted`, `running` or `unknown`: the command is still unresolved, so replaying the same key answers this and never a success notice |

An operation may also fail with its service's admission code (`REPO_DISABLED`,
`JOB_ACTIVE`, `BRANCH_MISSING`, `QUEUE_LIMIT`, …). The receipt keeps that code
verbatim in `error_code`, plus `error_detail` when a banner sentence
interpolates a parameter, so a replay answers with the same refusal and the same
sentence.

Operation names today: `task.cancel`, `task.pause`, `task.create`, `task.resume`,
`task.retry`. The catalog is closed — an unknown operation is
`unknown_operation`, never a fallback.

`MANAGEMENT_SERVICE=off|shadow|on` decides how far the `task.pause` adapter goes.
`off` (the default) keeps the route that existed before it: the same write and the
same outcome, with the notice now chosen through `t()`, so an English-locale
viewer reads it in English where the old route always wrote Chinese; `shadow`
reserves the receipt and then runs that same route, recording what the contract
would have decided, so a divergence is visible in `management_commands` and not in
the page; `on` runs the command and turns its receipt into the response.
`task.cancel`, `task.create`, `task.resume` and `task.retry` run through the
service in every mode: the switch was the pilot's safety net for one operation. A stale page in `shadow` still writes no receipt — the
revision fence runs before the receipt insert, as it does everywhere else — and a
replayed key settles nothing, so a receipt that already answered is never
rewritten and the revision moves once per command.

## Read-only metrics

### `GET /api/read/metrics`

A session-authenticated, read-only dashboard contract for an external control
room. `window=7` (default) or `window=30` selects the time window. A normal user
receives only `personal` metrics for their own account. A super admin
receives the global `product`, `delivery`, `daily`, `team`, `repoCosts`, `modelCosts`
and `alerts` sections. The route never mutates state.

## Schedule preview

### `GET /api/schedule/preview`

Session-authenticated and read-only: it walks the planner and stores nothing.
Query parameters:

- `cron` or `every` — exactly one. `cron` is a five-field expression; `every` is
  an interval with a unit, such as `90s`, `15m`, `2h` or `1d`, between one minute
  and 30 days.
- `timezone` — an IANA zone, required for `cron` and refused for `every`, because
  the interval form has no timezone and is absolute time.
- `from` — an ISO 8601 instant with an offset; defaults to now.
- `start_at`, `end_at` — optional `[start_at, end_at)` window, same shape as `from`.
- `count` — 1..20, default 5.

A bare date and time without an offset is refused: it names a different instant
in each zone. A refusal is HTTP 400 with `{ "error": "<reason naming the
field>" }`; the sentence follows the request locale (`fledge_lang` or
`Accept-Language`) because the planner authors it in both languages, and a
request that names neither gets Chinese, the app default. Success is
`{ schedule, from, count, times, truncated }`, where each
entry carries `at` (ISO), `atMs`, `local`, `offset`, `timezone` and `skipped` —
the wall times that did not exist on the way there, which the planner skipped
rather than shifted. `local`, `offset` and `timezone` are `null` for an interval,
and `truncated` is true when the window ended before `count`.

## Email notifications

Job lifecycle mail is sent from `MAIL_FROM` (production:
`fledge@hugoxk.online`) when a job finishes, fails, or a team question is
waiting. The user can set a notification email (blank uses the GitHub email), disable job
mail, disable the daily digest, or send a test mail in Settings → Email
notifications. Approval and quota mail are not affected. A question is mailed
once per `sessionId + questionId`; the preference is stored on the user.

## Inbound email

`POST /api/inbound/email` accepts a JSON message from a mail worker:
`{ "from": "...", "to": "...", "subject": "...", "text": "..." }`. It requires
`X-Fledge-Email-Secret` to match `INBOUND_EMAIL_SECRET`, extracts the
`+token` from the recipient, checks the sender against the user's notification
email, and sends the cleaned text to the Lead as guidance. Tokens expire after
7 days; a reply to the daily digest is the only supported input.

## Workspace

`GET /repos/:id/workspace` renders the Fledge shell and embeds
`/repos/:id/workspace/app/`. The `app` path is an authenticated same-origin
reverse proxy to the per-repository DSH instance: Fledge verifies the session and
repository ownership, fetches the DSH cookie server-side, strips upstream
`Set-Cookie`/CSP/frame headers, rewrites the HTML title/base and injects the
Fledge brand, and proxies WebSocket upgrades. The raw DSH token is never sent to
the browser.

## Team endpoints

`GET /api/repos/:id/team/events` is an admin-only SSE stream. It emits a
`snapshot` event when roles, questions, jobs or quota change, and a heartbeat
comment otherwise. The snapshot includes `bots` (with `tool`, `step`, `since`,
`lastActivityAt`), `questions` (with `id`, `sessionId`, `question`, `detail`,
`options`, `multiSelect`), `timeline` (active/ended role activity), `jobs`
(summary, status, issue/PR and attribution) and quota. Clients should fall back to the
5-second JSON poll if the stream drops.

`POST /api/repos/:id/team/answer` takes JSON:

```json
{ "sessionId": "session-…", "questionId": "q1", "selected": ["Fix the bug"], "custom": "" }
```

The Fledge inbox uses the equivalent form endpoint `POST /repos/:id/team/answer`
(owner + CSRF) with `sessionId`, `questionId`, `selected`, `custom` and a safe
`returnTo` path; it redirects back with a localized notice or error.
`POST /repos/:id/team/stop` is the admin-only form counterpart for the workspace shell: it
takes `target` (empty for every working role) and `returnTo`, applies the same
stop logic as the JSON API, and redirects with an honest hard-stop/request note.

`POST /api/repos/:id/team/stop` takes `{ "target": "lead" }` or an empty target
to stop every role that is currently thinking/working. The response distinguishes
`stopped` (hard cancel) from `requested` (stop message delivered; it takes effect
at the next safe point). Both endpoints require the `x-csrf-token` header.

## GitHub webhook follow-up

A verified `check_run`/`check_suite` failure or a `pull_request_review` with
`changes_requested` can enqueue a follow-up job when the PR URL matches an
existing Fledge job for a repository with the same installation. The follow-up
reuses the original branch and PR URL, skips a second PR/issue, and is deduped by
`repo + PR + head SHA + fingerprint(reason, review body)` and by
`X-GitHub-Delivery`. The `changes_requested` body is clipped to one line of at
most 1000 characters, with an ellipsis marking the cut, and carried in the job
goal, so two different reviews on one
commit are two follow-ups while the same review twice is still a duplicate; a
repo with an active job parks each pending request separately instead of
overwriting it. Arbitrary PRs with no Fledge job are ignored.

A default-branch `workflow_run.completed` failure is recorded in
`workflow_failures`. For a queued row, Fledge lists the run's jobs
(`GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs`) and reads the failed
job's log (`GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs`), capping the
body at 8 MiB and following a signed redirect without the GitHub token. Only a
redacted 4,000-character excerpt is stored; a fetch failure is stored as a reason
on the row and the intake stays. This path reruns nothing and opens no issue.

## Duplicate-work preflight

Before an iterate job is enqueued, Fledge reads the upstream repository's open
pull requests (`GET /repos/:owner/:name/pulls?state=open`, three pages) and looks
for one that references the job's issue — in the pull request body, title or head
branch, as a bare `#N` or as an `/issues/N` URL for that same repository. A
cross-repository reference such as `other/repo#42`, `other/repo #42` or
`https://github.com/other/repo/issues/42` never matches, because team pull
requests routinely cite other repositories' issues. When one does match, no job
is created: the caller gets `code: "DUPLICATE_WORK"` with the existing pull
request's URL in `error`, the attempt is audited as `job.duplicate_work`, and the
`job_duplicate_work` event is recorded. No branch is created and no second pull
request is opened.

A duplicate is one of two facts, and the preflight keeps them apart (#174). An
open pull request means the work is in flight. If nothing is in flight, the same
match is repeated over the merged pull requests
(`GET /repos/:owner/:name/pulls?state=closed`, three pages, merged only), and a
match there means the fix already landed: the caller gets
`code: "ALREADY_FIXED"` instead, and the record names the evidence — the audit
detail reads `already fixed by <pull request url> (<merge commit>)` and the event
meta carries `outcome=already-fixed;pr=<url>;commit=<sha>`. The merged read costs up to
three pages of 100, so it runs only when no open pull request matched, and the
issue read happens only when a merged candidate matched. A pull
request that was closed without merging is never evidence: it is dropped while
the list is read.

A merged pull request that only *mentions* the issue is not proof the fix landed —
its title, body or head branch can cite an issue it does not close. So the issue
itself decides: after a merged candidate matches, the preflight reads
`GET /repos/:owner/:name/issues/:N` once and answers `ALREADY_FIXED` only when the
issue is closed; an open issue lets the job through and records nothing, because
a mention is not a fact.

The refusal never creates a job, so it has no job page; the banner on the
repository page is where a maintainer reads it, and it names the pull request as a
link: the open one for `DUPLICATE_WORK`, the merged one for `ALREADY_FIXED`. The
audit row and the event meta carry the same evidence as text, with the merge commit
for an already-fixed answer.

The preflight is read-only and best-effort. It runs only for an iterate job that
does not already carry a `prUrl` — a follow-up job owns its pull request — and a
GitHub failure is logged and lets the job through, so an API outage cannot block
dispatch. The issue number comes from the work item's issue URL, falling back to
the goal text, and is read only from a reference to the same repository; a
dispatch with no such reference makes no GitHub call.

A pull request body longer than 8,000 characters is matched at both of its ends —
its first and last 4,000 characters, joined by a newline — because a closing
`Fixes #N` line sits at the top of a description or at its bottom. Only the
reference is matched: the body is not stored and not rendered, and the audit line
and the `job_duplicate_work` event carry the pull request URL.

## Changed-file listing and the path guard

`GET /repos/:owner/:name/pulls/:number/files` answers 100 entries per page, so a
pull request that changes thousands of files cannot be read in one request. The
listing walks up to 30 pages (3,000 files) and returns `{ files, complete }`
together with `changedFiles` from the pull request itself
(`changed_files`), so the guard can compare what it saw with what GitHub
reports.

Each entry in that listing carries the `patch` GitHub returns for the file when it
returns one, truncated by GitHub at its own limit and absent for a binary file.
The path guard never reads it; it matches filenames only, so an entry with a
`patch` and one without are judged the same. The field exists because the last
gate before an automatic merge (the adversarial pass in
`src/lib/adversarialReview.ts`) reviews the diff itself rather than the author's
summary, and it takes the text from this listing.

A list that stops short is never an all-clear: `checkPathGuard` returns
`ok: false` with `checkedFiles`, `reportedFiles` and `truncated`, the merge path
refuses with that reason, and the job page prints `Checked X / Y reported files`
(`已检查 X / 报告 Y 个文件`) instead of a pass. A pull request above the cap is
refused rather than judged, which is deliberate — an unread file is not a
permitted one. Rows stored before these fields existed keep their old sentence
and are upgraded on the next check, so there is no migration.

## Job endpoints

These are called by the FlyBot bridge/agent, not by a browser.

### `GET /api/jobs/:id/credential`

Headers: `Authorization: Bearer <callbackSecret>`

```json
{
  "token": "github_pat_…",
  "owner": "octo",
  "name": "demo",
  "defaultBranch": "main",
  "upstream": { "owner": "octo", "name": "demo", "defaultBranch": "main", "htmlUrl": "https://github.com/octo/demo" },
  "fork": { "owner": "alice", "name": "demo", "defaultBranch": "main", "htmlUrl": "https://github.com/alice/demo" },
  "isFork": true,
  "permission": "write",
  "repoRole": "maintainer",
  "autoMerge": true,
  "canReview": true,
  "canCreateIssue": true
}
```

`owner/name` is always the upstream. When the token belongs to the upstream
owner, `fork` equals `upstream` and `isFork` is false. Otherwise the agent must
push to `fork` and open the PR against `upstream`. `repoRole` is the role the
user selected for this repository; `autoMerge` is true only for an iterate job
when that role is `maintainer` and the repository auto-merge switch is on. Only
while the job is `queued` or `running`.

A `triage` job is a read-only workflow, and this response is where that is
enforced rather than described: its `token` is a GitHub App installation token
narrowed to `contents`, `issues` and `pull_requests` **read**, never the user's
`repo`-scoped OAuth token, which cannot be narrowed. When the repository has no
installation — so no narrower token can be minted — the read is refused with
`403` and a `TRIAGE_READ_ONLY_TOKEN` error instead of returning a write
credential, and the refusal is audited as `job.triage_token_unavailable`. `autoMerge`
is always false for triage.

Auto-merge only ever targets the pull request **this job produced**: the
callback's `prUrl` must be this repository's own pull request — scheme and host
equal to the recorded `upstream_html_url`/`fork_html_url` origin, or, when no
`html_url` was recorded, to the web host derived from `GITHUB_API_BASE` — and
the PR's head branch must be the job's `branch` with its base equal to the job's
base branch. A URL that does not match, or a PR that does not belong to the job,
is skipped without a merge and recorded as `job.merge_skipped` with the specific
mismatch (host, repository, head or base).

The job state decides the automatic merge as well: for each pull request only the
newest `iterate` job for that PR may merge, and only after it has succeeded
(`created_at DESC`, `rowid DESC` as the tie-break). A queued, running, failed,
cancelled or paused follow-up therefore holds the pull request back — an older
succeeded job for the same PR never merges past its newer attempt. The scheduled
reconciler skips those PRs, and `POST /repos/:id/delivery/merge-clean` reports
them in `skipped` with the job state instead of merging them. A pull request that
is already merged is not a candidate at all: no new `iterate` job for it can
bring it back, and the bulk merge neither re-checks it nor counts it as skipped.
Each `skipped` entry carries its reason, so the operator message tells a job-state
skip apart from one where checks or branch protection refused the merge.

### `POST /api/jobs/:id/callback`

Headers: `Authorization: Bearer <callbackSecret>`, `Content-Type: application/json`

```json
{
  "status": "succeeded",
  "branch": "fledge/fix-123",
  "prUrl": "https://github.com/octo/demo/pull/42",
  "issueUrl": "https://github.com/octo/demo/issues/41",
  "summary": "Fixed the off-by-one in the CSV splitter; added a regression test.",
  "error": "",
  "attribution": {
    "writtenBy": "Dev-1",
    "claimedBy": "Lead",
    "implementedBy": "Dev-1",
    "testedBy": "Test",
    "reviewedBy": "Reviewer"
  },
  "evidence": {
    "scope": "Fix the CSV splitter; do not change the public API",
    "acceptance": "A quoted comma stays one field",
    "testPlan": "Add a failing parser test, then a passing one",
    "testRed": "node --test tests/unit/csv.test.mjs — 1 fail",
    "testGreen": "node --test tests/unit/csv.test.mjs — 1 pass",
    "tests": "node --test tests/unit/foo.test.mjs — 12 pass",
    "checks": "CI green",
    "files": 3,
    "risk": "low",
    "rollback": "revert the commit"
  },
  "checkpoint": "implemented the parser; next: add the rejection test"
}
```

Review jobs use `kind=review` and return `reviewScore` (0–100) instead of a
branch/PR:

```json
{ "status": "succeeded", "summary": "Reviewed 6 PRs; average 78.", "reviewScore": 78 }
```

`status` may be `running`, `succeeded` or `failed`. A `running` callback is a
progress heartbeat: it updates `summary`, `checkpoint` and optionally `branch`,
`attribution` or `evidence` without finishing the job or extending
`JOB_TIMEOUT_MINUTES`. `checkpoint` is shown on the job page and is injected
into the goal when a failed job is retried. A `plan` job writes the plan to
`summary` and must not create a branch, issue or PR; the super admin can execute it
later as an iterate job. `evidence` is stored structurally and shown on the job
detail page; the Fledge automation comment stays compact. With
`repos.stage_mode = 'enforced'`, an iterate callback must also include `scope`,
`acceptance`, `testRed`, `testGreen` and Dev/Test attribution, and a review
callback must include a Reviewer and `reviewScore`; otherwise the job fails with
`STAGE_EVIDENCE_MISSING` and does not auto-merge. `shadow` records the same check
as an event without blocking. On
success, Fledge adds a collapsible automation block to the PR with the job,
team and the attribution steps that actually happened, so humans can see which
role claimed, implemented, tested and reviewed the change without a fabricated
"pending" row. A finished job revokes its job-scoped model token.

A `prUrl` or `issueUrl` is stored only when it names this job's repository:
`https`, the origin `prOrigin` derives from the repository row (its
`upstream_html_url`, else `fork_html_url`, else the web host behind
`GITHUB_API_BASE`, which drops the `api.` label and any path) and the path
`<owner>/<name>/pull/<n>` or `<owner>/<name>/issues/<n>`. That is the same
origin rule the merge path uses, so the accepted host is never a literal
`github.com`. A present value that cannot be placed is treated as no link
(`pr_url`/`issue_url` become `NULL`) and the callback still answers
`200 {"ok":true}`, because a `400` would make the bridge retry the same delivery
forever; a field that is absent leaves the stored value alone. The same rule
applies to `followUps[].prUrl`: an unplaceable entry is dropped, not queued.

### Callback idempotency

A terminal callback is keyed by the state transition, not by a delivery id.
Fledge normalises the report and stores a fingerprint of it on the job, so the
answer distinguishes a replay from a contradiction:

- the delivery that wins the transition (`queued`/`running` → `succeeded`/`failed`)
  runs the side effects exactly once: the review follow-up enqueue, the
  work-item move and the auto-merge;
- replaying the same report after the job finished answers
  `200 {"ok":true,"duplicate":true}` and writes no second event, notification or
  merge;
- a contradicting report (a different `prUrl`, a later `failed`, …) answers
  `409 {"error":"job already finished"}` and changes nothing;
- a terminal report that arrives after `JOB_TIMEOUT_MINUTES` (default 90) answers
  `409 {"error":"job timed out"}`: the reaper owns that decision, so a late
  success does not rewrite a timed-out run. The bridge does not retry a 409, so
  that result is lost by design — see `bridge/README.md`;
- a heartbeat (`{"status":"running"}`) is accepted only for a job that is
  already `running`. For a `queued` job it answers 409 and does not refresh
  `last_callback_at`, because a heartbeat may not promote a row that no worker
  has been dispatched for;
- a payload rejected with 400 (bad branch) does not refresh `last_callback_at`
  either.

Heartbeats extend the stall window (`JOB_STALL_MINUTES`, default 30) but never
the hard timeout (`JOB_TIMEOUT_MINUTES`, default 90), and they never rewrite
`started_at`. A credential read after the job finished still answers 409.

## Model gateway

OpenAI-compatible; base path `/v1`.

Every gateway route answers three stable failure shapes before it does any work:

| Status | `error.type` | When |
|---|---|---|
| `401` | `invalid_api_key` | no `flg_` token, an unknown hash, a revoked token, an expired `expires_at`, or a token whose user is not approved |
| `403` | `insufficient_scope` | a live token whose `scope` is not `gateway`; `last_used_at` is not written, so a refused token leaves no trace |
| `403` | `invalid_job_token` | a token whose name claims `job:<id>` but whose `kind` is not `job`, or whose job belongs to another user; decided before the upstream call, so a forged name spends no quota |
| `429` | `rate_limited` | the per-token or per-IP limiter refused the request |

Neither refusal echoes the token. A personal token always carries an `expires_at`
(#355); only an operator token created by an admin may be minted without one, and
`PAT_EXPIRY_DAYS` (default 90) sets the default lifetime.

A chat call records its model and its cost on a job only when the token's `kind`
is `job` and the job belongs to the token's user (#481). The `job:` prefix in the
name is a label, not the binding; a token that claims a job it does not own is
refused with `invalid_job_token` before the provider is called.

### `GET /v1/models`

```bash
curl -H "Authorization: Bearer flg_…" http://localhost:8080/v1/models
```

### `POST /v1/chat/completions`

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer flg_…" \
  -H "Content-Type: application/json" \
  -d '{"model":"your-model","messages":[{"role":"user","content":"hi"}],"max_tokens":64}'
```

Response headers include:

- `x-fledge-quota-remaining-cny`
- `x-fledge-top-up-url`

When the platform quota is exhausted:

```json
{
  "error": {
    "type": "quota_exhausted",
    "code": "FLEDGE_QUOTA_EXHAUSTED",
    "message": "平台额度已用完，请到 Settings → Model 配置你自己的模型 API 后继续。",
    "quota": { "initialCny": 1, "usedCny": 1.0002, "remainingCny": 0 },
    "settingsUrl": "https://fledge.example/settings"
  }
}
```

Status code: `402`.

## Health

`GET /healthz` → `{ "ok": true, "service": "fledge", "version": "0.2.4", "time": "..." }`.

That is the whole public answer. `commit` (12-character short sha) and `builtAt`
(UTC build stamp) are served only to a caller presenting
`Authorization: Bearer <METRICS_TOKEN>`, or to a loopback caller in a
non-production build with no token configured — the same rule `/metrics` uses,
and the same reason: the live commit is a deploy-timing oracle for anyone who can
ask it. With the bearer the payload grows two fields:

```json
{ "ok": true, "service": "fledge", "version": "0.2.4", "commit": "0123456789ab", "builtAt": "2026-11-10T00:00:00Z", "time": "..." }
```

`commit` and `builtAt` are always present *for an authorised caller*; a build that
carried no stamp answers `"unknown"` for both. A caller without the credential
gets no key at all rather than `"unknown"`: `unknown` means "this build carries no
stamp", so reusing it for "not authorised" would make an unstamped production
build and a denied caller indistinguishable. The status stays `200` for every
caller — a liveness probe is never refused. The values above are illustrative;
read the real ones from the running service.

## Conventions

- JSON errors always have `error.type` and `error.code`.
- Browser form errors redirect back with `?error=`; API errors use HTTP status.
- All timestamps are ISO-8601 UTC.
- Money in the API is CNY unless the field says `usd`.

## Model providers and issue commands

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/settings/providers` | approved + CSRF | Add a provider; HTTP/private URLs need the per-user permission or the global flag |
| POST | `/settings/providers/:id/update` | approved + CSRF | Update a provider; existing models are re-tested before saving |
| POST | `/settings/providers/:id/delete` | approved + CSRF | Delete a provider and its models |
| POST | `/settings/providers/:id/discover` | approved + CSRF | Read the provider's `/v1/models` list from Fledge |
| POST | `/settings/providers/:id/models/bulk` | approved + CSRF | Add selected discovered models, testing each before saving |
| POST | `/settings/providers/:id/models` | approved + CSRF | Run a 1-token test from Fledge and save the model only on success |
| POST | `/settings/providers/:id/models/:modelId/delete` | approved + CSRF | Delete a provider model |
| POST | `/admin/users/:id/private-models` | superadmin + CSRF | Grant or revoke the private/HTTP model permission for a user |

Issue comments from `OWNER`, `MEMBER` or `COLLABORATOR` accounts can run
`/fledge status`, `/fledge plan`, `/fledge approve` or `/fledge fix`, plus the four
job verbs `/fledge retry`, `/fledge pause`, `/fledge resume` and `/fledge cancel`.
Commands are deduped by comment id and reply on the issue. `/fledge approve` is
maintainer-only.

The job verbs act on the job attached to the issue's work item and never create a
work item: `retry` re-queues the latest finished job (resuming its pull request
when it has one), `pause` and `cancel` act on the queued or running job, and
`resume` creates the resumed job from the paused one. A verb with no matching job
refuses in the thread instead of starting one. Each one calls the same service
action as the console, so it writes the existing audit action (`job.retried`,
`job.paused`, `job.resumed`, `job.cancelled`) and the same job-timeline event; the
pause and cancel replies report what the stop path actually did — how many live
sessions were stopped, how many were asked to stop at the next safe point, that no
live session was reachable, or that the stop could not be delivered — so they never
claim a send that did not happen. The job is looked up by its work item, so an item
whose job is older than the repository's newest twenty is still found.


### Release management calls

`GithubClient` carries the release writes and reads used by `src/releases/release.ts`:
`commitExists` (`GET /commits/{sha}`, `false` on 404, so a hand-typed SHA is a
named refusal instead of a crash), `listTags` (paginated tags with their commit),
`compareCommits` (status and `ahead_by` for `GET /compare/{base}...{head}`),
`getRepoFile` (one file at a ref, `null` on 404), `createAnnotatedTag`
(`POST /git/tags`, `object` = the confirmed commit) and `createTagRef`
(`POST /git/refs`). `createTagRef` returns `{ ok: false, status, message }` when
the ref is refused instead of forcing it; a 422 becomes the `tag_exists` refusal,
while any other status becomes the fixed `the tag reference was refused by GitHub
(HTTP <status>); nothing was moved or deleted`, so no upstream body text reaches
the page. A 422 from `createAnnotatedTag` is the `target_missing` refusal rather
than an exception. No call here updates or deletes a ref.

`POST /repos/:id/release` (owner only, CSRF) redirects to
`/repos/:id?release=1&refused=<reason>` on a refusal and
`?release=1&tagged=<tag>` on success; a re-tag of a name that already has a
`repo_releases` row updates that row and adds `&retagged=1` so the page says the
tag already existed and the record was updated. The page renders whichever
outcome is present above the form.
