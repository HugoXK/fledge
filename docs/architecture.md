# Architecture

## Principles

0. **Approval is scoped.** A Fledge approval grants Fledge only. The console is
   a focused workspace; it never issues permissions or sessions for other
   products, and the shared Portal is only a footer link.

1. **A human merges.** Fledge opens one focused pull request per job. It never
   pushes the default branch, force-pushes, or merges.
2. **The platform is not a code runner.** It orchestrates a FlyBot agent; the
   agent works in its own workspace. Fledge never executes a user repository.
3. **Least privilege.** A user supplies a fine-grained GitHub token per
   repository. A job gets a scoped credential URL and a job-scoped model token,
   both revocable and expiring.
4. **Meter what is spent.** Platform-funded model calls pass through a gateway
   that records real cost per user and per job.
5. **Every state change is auditable.** Approval, repo changes, job transitions,
   token creation/revocation and quota edits write to `audit_log`.
6. **One version source.** `/healthz` and the release tooling read `package.json`
   through `src/version.ts`; a release bumps that file and `CHANGELOG.md`
   together.

## Components

```
                    ┌──────────────────────────────────────┐
 Browser ──cookie──►│ Fledge (Fastify)                     │
                    │  auth · approval · repos · jobs      │
                    │  OpenAI-compatible gateway · admin   │
                    └───────┬───────────────┬──────────────┘
                            │               │
                 SQLite (WAL)│               │ HTTPS
                            │               ├──► api.github.com
                            │               ├──► SMTP (operator-configured)
                            │               └──► model provider / router
                            │
                            └── job queue ──► FlyBot bridge ──► FlyBot agent
                                                   │
                                                   ├─ GET /api/jobs/:id/credential
                                                   └─ POST /api/jobs/:id/callback
```

### Fledge

- **Fastify** HTTP server, server-rendered HTML, no frontend build step.
- **Bilingual UI** in Chinese and English. The locale is stored in the
  `fledge_lang` cookie, and the header switch shares the `hugoxk-lang`
  preference with the rest of the platform.
- **SQLite** via Node's built-in `node:sqlite` (WAL, foreign keys). The database
  file is the only state; the mail outbox is a development artifact.
- **Sessions** are random 32-byte tokens, stored as SHA-256 hashes; the cookie is
  HttpOnly/SameSite=Lax.
- **OAuth**: GitHub OAuth App with `state` stored server-side for 10 minutes.
- **Applications**: a new user starts as `onboarding`. Submitting the signed
  disclaimer and information-security agreement moves them to `pending` and
  emails the administrator. The status page shows the live queue position and
  rejects a second submission. Approvals create two single-use random tokens
  (approve/reject), stored as hashes, valid for 7 days.
- **Roles**: platform roles are `user`, `admin` and super admin (`superadmin`). The
  primary `GITHUB_ADMIN_LOGIN` is promoted to owner on startup. Admins get the
  normal product UI plus a scoped management page for themselves and normal
  users; the super admin sees everyone, can set admins and is the only role that can
  set unlimited quota. The owner can toggle a normal-user preview cookie that
  renders the simple UI while advanced routes stay blocked. An admin can open a
  read-only support view for a visible user and that user's jobs; it never
  mutates data or triggers work.
- **No worker process**: a 60-second tick schedules due iterate jobs and, when
  the user selected the maintainer role and the upstream grants admin/maintain permission, review jobs for all open PRs.
  The interval is the minimum gap between runs, not a cap on PRs or issues; a
  repository can accumulate many PRs/issues over time. A run is skipped while
  another job for that repository is active. The global concurrency cap is 2.
  Iteration cadence ranges from every 15 minutes to every 30 days; review
  cadence from every 6 hours to every 30 days. Jobs that exceed the timeout are
  failed.
- **Upstream/fork onboarding**: the user submits the upstream repository. Fledge
  reads it with the user's token, checks for a same-name fork, creates one when
  needed, and stores both sides. Iteration jobs push to the fork and open the PR
  against the upstream; issues are created on the upstream. If the token user
  owns the upstream, no fork is created and the branch/PR stay in that repo.
- **Repository role**: each user-repository connection stores `repo_role` as
  `maintainer` or `developer`. Fledge derives the allowed roles from the user's
  GitHub permission on that repository: `admin`/`maintain` may choose either,
  and every other permission can only choose `developer`. The user must choose
  explicitly; the platform never auto-selects and an admin cannot assign the
  role. A user can be a maintainer in one repository and a developer in another.
  Maintainer enables review/triage maintenance actions and the opt-in
  auto-merge switch; developer runs iterate/plan jobs only. There is no separate
  owner or viewer role. The scheduler re-checks a stale role before review or
  auto-merge and downgrades it when the GitHub permission is lost.
- **Target branch**: each repository stores a `target_branch` that defaults to
  the upstream default but can be `develop` or a release branch. Jobs snapshot
  it as `base_branch`; the agent still creates a new head branch and opens the
  PR against that base. Follow-ups keep the existing PR base. Invalid target branch names are rejected when
  saved; if a verified branch disappears later, the job fails clearly instead
  of silently falling back to the repository default.
- **Reviewer role**: a maintainer with GitHub admin/maintain permission on the
  upstream can enable a scheduled reviewer. Review jobs list every open upstream
  PR, score each one, and post a COMMENT review; they never merge or modify
  code. A developer cannot run review jobs even when GitHub grants write access.
- **Work items and gates**: each repository has work items with a
  triage-to-merge state machine (`proposed → triaged → assigned → in_progress →
  pr_ready → in_review → changes_requested → approved → merged/closed`). Jobs
  link to a work item, and issue/PR/review webhooks keep state and PR outcome in
  sync. Issue labels map `priority:high|medium|low` (or `p0`–`p3`) to work-item
  priority, and an `agent-ready` label moves a proposed item to triaged. A
  repository can require a plan before code; a maintainer approves or
  rejects it with allowed/forbidden path constraints, and execution is blocked
  until approval. Iterate jobs preflight the target branch, record the base SHA,
  warn when the fork is behind, and scheduled work is skipped while an active
  work item is open.
- **Auto-merge switch**: off by default. Only a maintainer can enable it. When
  it is on, Fledge (not the agent) verifies the PR is open and mergeable, every
  check run is green, the combined commit status is not failing, and no current
  review requests changes, and the branch protection rule confirms the required
  checks and approvals before it performs a squash merge. The agent prompt
  always forbids merging. The switch is stored on the repository and included
  in the job payload for reporting. A stale or downgraded role blocks the merge.

### Model gateway

`/v1/*` is OpenAI-compatible and authenticated with `flg_` tokens.

- If the user has an own model configured, Fledge proxies to it and does **not**
  meter platform quota.
- Otherwise it proxies to `PLATFORM_LLM_BASE_URL` with `PLATFORM_LLM_KEY`, reads
  `x-litellm-response-cost` (or estimates from `usage`), and records the cost in
  `quota_ledger` + `users.quota_used_usd`.
- At zero it returns HTTP 402 with `code: FLEDGE_QUOTA_EXHAUSTED` and a settings
  link.
- Streaming is passed through; `stream_options.include_usage` is added so the
  final usage chunk can be metered.

The operator chooses the upstream through `PLATFORM_LLM_BASE_URL`; keep the
real endpoint and key out of git and out of public documentation.

### Per-repository FlyBot instances

Each hosted repository gets its own FlyBot container and its own team. The user
directory contains the per-repo data; a container has a private network, a
private bridge, a model proxy and a fixed FlyBot release image. A repository
team is one Chief plus Lead, Product, Test, Security, Reviewer and two Devs;
the Reviewer is scoped to upstream/all PRs or self-review based on the user's
upstream permission. Deleting or stopping a repository stops only that
container. The shared operator FlyBot is never used for user jobs.

Provisioning writes a versioned team playbook into every role and records the
version and a goal fingerprint in `team_json` (`playbook`, `playbookHash`). It
defines the hierarchy (Chief -> Lead -> Product/Test/Security/Reviewer/Dev), the
Lead as the single job owner, the one-issue/one-PR rule, the handoff protocol,
the progress heartbeat, and the current repository goal with role-specific
guidance for it. Saving a new goal refreshes the playbook; older instances are
also refreshed on the next job before dispatch. Iterate jobs go to the Chief,
which must pass the job block to the Lead verbatim; review jobs go to the
Reviewer only when the repository has enabled it. The Lead delegates to the
member whose scope fits and posts the final callback exactly once.

### Team console and live events

The team console is admin-only. `GET /api/repos/:id/team/events` streams
Server-Sent Events: a full snapshot when the DSH revision, role activity,
questions, jobs or quota changes, plus a heartbeat. The browser uses
`EventSource` and falls back to the existing 5-second JSON poll on error.
Questions render inline with their options and a custom field;
`POST /api/repos/:id/team/answer` sends the DSH `answer-question` payload.
Normal users can talk to the Chief from the repository page without opening the
team console. Fledge sends the message and reads the Chief session transcript
from the DSH session export, keeping only human/Chief text, dropping Fledge job
prompts and masking tokens. `GET /api/repos/:id/chief/events` polls the Chief
session-turn signature and pushes new snapshots over SSE, with a 5-second JSON
polling fallback. The Chief remains responsible for routing work inside the
team, and every message is audited.
The same open questions are collected server-side from every ready instance and
shown as a Fledge inbox on `/console`, `/dashboard` and the repository page, so a
human can see and answer FlyBot's pending questions without opening the team
console. The inbox form posts to `POST /repos/:id/team/answer`, which uses the
same DSH call, marks the matching question notifications read and invalidates
the short-lived inbox cache.
`POST /api/repos/:id/team/stop` first tries DSH `stop-member-work` when the role
is in a room, otherwise it sends a stop message that takes effect at the next
safe point. The workspace shell uses the form equivalent
`POST /repos/:id/team/stop`, with the same authorization, audit and honest
hard-stop/request reporting. The UI reports the difference honestly; it never
claims a turn was paused when only a request was delivered. Every answer,
guidance and stop is written to the audit log.

The native DSH UI is exposed through the owner-accessible workspace; the Fledge
team console remains superadmin-only. The workspace uses a per-repository
authenticated path and a Fledge shell around the native UI (branded "Powered by
FlyBot"), with a short-lived ticket and server-side cookie injection so the raw
DSH token never reaches the browser.

### GitHub App onboarding and webhooks

The optional GitHub App removes the PAT from the common path. Fledge generates a
short-lived App JWT (with a clock-skew correction from GitHub's `Date` header),
exchanges it for an installation token, lists the installation repositories and
stores only `repos.installation_id`; `repoGithubToken()` prefers a user OAuth token authorized with `repo` scope for human attribution and otherwise uses a fresh installation
token when that column is set and falls back to the encrypted PAT otherwise. The
installation callback binds the installation to the logged-in user (verified
through the user's OAuth token or an individual account match). GitHub webhooks
are verified with `X-Hub-Signature-256` before parsing; verified events are
recorded in `events` for the follow-up loop. PAT onboarding stays available.

### Inbound email replies

When `INBOUND_EMAIL_SECRET` is set, the daily digest gets a
`Reply-To: <local>+<token>@<domain>` address and a reply hint. The inbound
endpoint verifies the shared secret, resolves the token to a user + repository,
checks that the sender is the user's notification email, strips quoted lines and
sends the remaining text to the Lead as guidance. Tokens live in `settings` with
a 7-day expiry. Cloudflare Email Routing + an Email Worker can post to the
endpoint; IMAP polling is not required.

### Job model token lifecycle

The bridge binds a job-scoped model token on `/run`. Fledge clears it on job
finish via `POST /job-done` (bridge token auth), and the model proxy retries
once with the instance token on a 401/403 from the gateway. This keeps per-job
cost attribution while avoiding a stale/revoked job token breaking later Chief
greetings, memory reviews or guidance turns.

### Dashboard lists and onboarding

The dashboard paginates repositories and jobs at ten per page; a repository page
and the team console paginate their job tables at ten per page, with the page
number clamped to the available pages. Add repository presents two explicit
alternatives: the GitHub App installation path (recommended) and a collapsed
fine-grained token form; users pick one, not both. The App repository picker
carries the same task template, goal, auto-iterate interval and reviewer
settings as the token form, so both paths configure repositories identically.
Long help text is shown through compact `!` info icons on hover/focus.

### Team observation and effectiveness

`teamState` now exposes each role's current tool/step, start time and last
activity, plus a recent active/ended timeline. The team console renders the
tool, elapsed time, a stale warning when an active job has no role activity for
five minutes, and a recent-activity list; SSE updates it every second. When a
job finishes, Fledge captures a per-role call snapshot into
`jobs.team_stats_json`. The admin metrics page aggregates those snapshots into
jobs with stats, average participating roles, Lead-only jobs and calls per role,
and the job page shows the same per-role table.

### Agent workspace

The owner-accessible workspace is path-based to avoid a wildcard certificate:
`https://fledge.hugoxk.online/repos/:id/workspace/`. The shell is Fledge-branded
and embeds an iframe on `/repos/:id/workspace/app/`. That path is a same-origin
reverse proxy to the repo's DSH web port: Fledge checks the session and repo
ownership, reads the latest DSH token from `dsh-web.log`, obtains the DSH cookie
server-side and injects it, strips `Set-Cookie`/CSP headers and CSP meta tags/`X-Frame-Options`, rewrites
the document title/base, injects `workspace-brand.js`/`.css`, and proxies
WebSocket upgrades with the same cookie. The browser sees only Fledge URLs and
the Fledge brand ("powered by FlyBot"); the raw DSH token never leaves the
server. A wildcard subdomain remains a future option if a certificate covers it.

### PR follow-up

Verified webhooks drive a small follow-up loop: a failed check run/suite or a
review requesting changes on a PR that has a Fledge job enqueues an iterate job
with the existing branch and PR URL. The bridge prompt tells the agent to push
to the same branch and update the existing PR, never open a second PR. The
follow-up is deduped by delivery id and by repo + PR + head SHA + reason, and is
skipped while the repository has an active job. A follow-up does not receive a
second automation comment; the job list labels it "Follow-up".

### Plan-first-lite, checkpoints and templates

A manual "plan only" job uses the same team and repository context but the
bridge gives it plan rules: inspect, propose files/steps/tests/acceptance,
risks and rollback, and never write code, branch or open a PR. The plan is
returned in `summary`; a completed plan shows an **Execute this plan** action
that enqueues an iterate job with the plan appended to the goal. This is the
safe, small step before a full pause-and-approve protocol.

Every heartbeat can carry a `checkpoint` (what is done and what is next). It is
stored on the job, shown on the job page, and appended to the goal when a failed
job is retried, so a new job can continue from the last known point instead of
starting from scratch. The add/settings goal forms also offer four task
templates (bug, tests, docs, dependency) that fill the goal text.

### Pull-request delivery

Each repository page has a delivery list of iterate jobs with open pull requests,
with review score, cost, age and a maintainer one-click merge. Merging re-checks
the PR state, checks, commit status, reviews and branch protection through the
same path as auto-merge, updates the linked work item and marks the job's PR
state. A webhook updates the PR state when a PR is merged or closed. When at
least three PRs are waiting and auto-merge is off, the page suggests enabling it.

### Job health and credential circuit breaker

Every callback records `jobs.last_callback_at`. A running job with no callback for
`JOB_STALL_MINUTES` (default 30) fails with a `stalled` message instead of holding
the repository slot until the 90-minute hard timeout. A successful job resets the
repository failure counter; three consecutive failures pause auto-iterate and
notify the owner.

An iterate preflight (and a cached check for plan/review jobs) reads the target
branch with the repository token. A 401/403 marks `repos.credential_state =
'invalid'`, pauses auto-iterate, and notifies the owner with a re-authorize link.
The repository page shows the credential banner until a refresh or a successful
preflight clears it.

### Model connections

Settings owns a per-user catalog of OpenAI-compatible model connections
(`user_models`), each with an encrypted key and an optional private/HTTP flag.
A repository only selects which catalog entries it may use and which is default
(`repo_models`). The instance patch lists the selected alias ids as DSH models,
and the gateway maps an alias back to its provider, key and underlying model.
Applying a changed selection rewrites the patch and restarts the container only
when no job is active.

### Per-job cost, evidence and metrics

The bridge's model proxy normally uses the per-repository instance token. While
a job is running it uses that job's short-lived `flg_` token instead (the
`/run` payload carries it), so the gateway can write `job_id` into
`quota_ledger` and add `jobs.cost_usd`. The job page shows cost, attribution and
Team attribution is grounded in the DSH per-role call counts: the job page and the
PR automation comment use only roles with actual calls, and a claimed role with
zero calls is recorded as a `team_attribution_grounded` mismatch event.

structured evidence (`scope`, `acceptance`, `testPlan`, `testRed`, `testGreen`,
`tests`, `checks`, `files`, `risk`, `rollback`); failed jobs have a one-click
retry. A repository can set a team stage gate: `off` keeps the old behaviour,
`shadow` records missing stage evidence, and `enforced` fails an implement job
without scope, acceptance criteria, red/green tests and Dev/Test attribution,
or a review job without a Reviewer and a score. Enforced jobs never auto-merge.
Admins get a read-only `/admin/metrics` funnel:
users, approved, repos, users with jobs/PRs, success rate, job cost and recent
events. `/admin/search` filters jobs and audit entries by the same user
visibility as the admin page and can export the current result as CSV. The
`events` table records activation and intervention events only; no prompt or
token data.

### Email notifications

Fledge sends mail from the configured `MAIL_FROM` (production:
`fledge@hugoxk.online`). The shared FlyBot service keeps its own
`flybot@hugoxk.online` sender; the two projects do not share a mailbox.

Each user can set `notify_email` (blank falls back to the GitHub email),
`email_job_updates` and `email_daily_digest`. Job mail covers success/failure
and a new team question; question mails are deduped by
`sessionId + questionId` in `settings`. A server-side digest pass runs after
`DIGEST_HOUR` in `DIGEST_TIMEZONE`, builds a 24-hour summary per approved user
(jobs, PRs, spend, next scheduled runs, open questions) and sends it once per
day (`digest_sent:<userId>:<date>`). Templates include the repo, job id,
issue/PR links, summary or question, and a link to the repository inbox or job page; they never
contain tokens or model keys. Approval and quota mail are transactional and are
not controlled by the digest/job switches.

### Operational alerts

A failed job also feeds the ops signal: three consecutive failures in one
repository write an `ops.repeated_failures` audit entry, one in-app notification
and, when `NOTIFY_WEBHOOK_URL` is set, a `repo.repeated_failures` webhook. The
notice is deduped until the next successful job resets it.

### FlyBot bridge

The bridge is a tiny HTTP service on the FlyBot host. Fledge POSTs a job
descriptor; the bridge relays it to a configured FlyBot chat session. The agent:

1. fetches the GitHub token from `GET /api/jobs/:id/credential` with the job
   secret;
2. uses the platform model at `.../v1` with the job token;
3. creates a branch, commits to the fork when one is used, opens an issue and a
   PR against the upstream;
4. calls `POST /api/jobs/:id/callback` with the branch, issue URL, PR URL,
   summary and an `attribution` object naming the roles that wrote, claimed,
   implemented, tested and reviewed the change. Review jobs instead list all
   open upstream PRs, post scored COMMENT reviews, and return `reviewScore`.

The playbook asks every role to end its GitHub issues, PRs and comments with one
small line: `<sub>Fledge · team · role · step</sub>`, where step is claimed,
implemented, tested or reviewed. On a successful iterate job Fledge also adds a
collapsible automation block to the PR. It lists only the steps that actually
happened (a single role is grouped once), links the issue and job page, and
states whether the maintainer enabled auto-merge. A missing step is omitted rather than shown as
"pending", so the block stays truthful and quiet even when attribution is thin.

Both endpoints require `Authorization: Bearer <callbackSecret>`. The secret is
generated per job, stored as a hash, and never appears in the UI.

## Data model

| Table | Purpose |
|---|---|
| `users` | GitHub identity, application status, signed agreement fields (name/version/time/IP/UA), role, quota, own model (encrypted key) |
| `sessions` | hashed session id, expiry, IP/UA |
| `oauth_states` | short-lived OAuth `state` values |
| `approval_tokens` | single-use approve/reject links |
| `repos` | upstream/fork identity, encrypted token, permission, reviewer config, goal, cadence, state |
| `jobs` | lifecycle, kind (iterate/review), branch, issue/PR URL, review score, summary, cost, job-scoped token hash |
| `api_tokens` | `flg_` tokens (PAT or job), hashed |
| `quota_ledger` | per-request cost records |
| `notifications` | in-app messages (quota, job failure) |
| `audit_log` | who changed what |
| `settings` | small key/value flags (e.g. quota notice dedupe) |

## Job lifecycle

```
queued ──► running ──► succeeded
   │          │
   │          ├──► failed
   │          └──► timeout ──► failed
   └──► quota_exhausted
```

- `queued` is written before the runner is called.
- `running` is set when the bridge accepts the job (or immediately for the mock).
- `succeeded` / `failed` come from the callback or the mock.
- The repo records `last_run_at` and `last_status`; a scheduled job is skipped if
  another job for the repo is active.

## Trust boundaries

| Boundary | Control |
|---|---|
| Browser → Fledge | session cookie, CSRF token on every form, rate limits |
| Fledge → GitHub | user's fine-grained token; platform OAuth only for identity |
| Fledge → SMTP | credentials in env, never logged |
| FlyBot bridge → Fledge | job callback secret; credential URL; job token |
| Fledge → model provider | platform key or user key; SSRF guard on user URLs |
| Admin email link | single-use 32-byte token, 7-day expiry |

## Failure modes

| Failure | Behaviour |
|---|---|
| Bridge unreachable | job fails with `RUNNER_ERROR`; user notified |
| Agent never calls back | job failed after `JOB_TIMEOUT_MINUTES` (default 90); progress heartbeats update the running summary but do not extend the limit |
| Provider 429/5xx | gateway returns the upstream status; user sees the error |
| Quota exhausted | job marked `quota_exhausted`; one notification + email per day |
| SQLite locked | WAL + single process; retries surface as 500 and are logged |
| Mail down | approval still exists in Admin; login shows pending |

## Non-goals for v0.1

- Running arbitrary code inside Fledge.
- Auto-merging.
- Multi-tenant process isolation (one instance = one operator/team).
- Billing integration; the 1 CNY quota is a soft platform budget, not an invoice.
