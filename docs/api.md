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
| POST | `/api/github/webhook` | GitHub signature | GitHub App webhook ingestion and CI/review follow-up |
| POST | `/auth/token` | public, rate-limited | Sign in with a GitHub token when OAuth is not configured |
| POST | `/auth/logout` | session + CSRF | Sign out |
| GET | `/apply` | session | Disclaimer and information-security signature |
| POST | `/apply` | session + CSRF | Submit the signed application once |
| GET | `/apply/status` | session | Live queue position and status |
| GET | `/api/application` | session | JSON status/queue for the status page |
| GET | `/dashboard` | approved + session | Repos, quota, jobs |
| GET | `/console` | approved + session | Workspace overview (repos, jobs, quota) |
| POST | `/repos` | approved + CSRF | Add an upstream repository; Fledge checks or creates the user's fork |
| GET | `/repos/:id` | owner | Repo detail, including the selected role and allowed roles |
| GET | `/readyz` | public | Database and per-repository instance readiness summary |
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
| POST | `/repos/:id/jobs/:jobId/merge` | maintainer + CSRF | Re-check and squash-merge a Fledge PR |
| POST | `/repos/:id/delivery/merge-clean` | maintainer + CSRF | Re-check and merge all clean Fledge PRs, skipping blocked ones |
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
| GET | `/admin/metrics` | superadmin | Product funnel, team participation, attribution and stage metrics |
| POST | `/settings/model` | approved + CSRF | Save/clear own model |
| POST | `/settings/notifications` | approved + CSRF | Notification email, job/question mail, daily digest, test mail |
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
| GET | `/approve/:token` | token | Confirmation page |
| POST | `/approve/:token` | token | Apply approve/reject |

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
`repo + PR + head SHA + reason` and by `X-GitHub-Delivery`. A repo with an active
job skips the follow-up; arbitrary PRs with no Fledge job are ignored.

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
"pending" row. A finished job revokes its job-scoped model token, and later
callbacks or credential reads return HTTP 409.

## Model gateway

OpenAI-compatible; base path `/v1`.

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

`GET /healthz` → `{ "ok": true, "service": "fledge", "version": "0.2.4" }`.

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
`/fledge status`, `/fledge plan`, `/fledge approve` or `/fledge fix`. Commands are
deduped by comment id and reply on the issue. `/fledge approve` is maintainer-only.

