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
- **No worker process**: a 60-second tick schedules due iterate jobs and, when
  the upstream grants maintain/write permission, review jobs for all open PRs.
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
- **Reviewer role**: a user with maintain/write permission on the upstream (or
  ownership) can enable a scheduled reviewer. Review jobs list every open
  upstream PR, score each one, and post a COMMENT review; they never merge or
  modify code.

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

### FlyBot bridge

The bridge is a tiny HTTP service on the FlyBot host. Fledge POSTs a job
descriptor; the bridge relays it to a configured FlyBot chat session. The agent:

1. fetches the GitHub token from `GET /api/jobs/:id/credential` with the job
   secret;
2. uses the platform model at `.../v1` with the job token;
3. creates a branch, commits to the fork when one is used, opens an issue and a
   PR against the upstream;
4. calls `POST /api/jobs/:id/callback` with the branch, issue URL, PR URL and
   summary. Review jobs instead list all open upstream PRs, post scored COMMENT
   reviews, and return `reviewScore`.

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
| Agent never calls back | job failed after `JOB_TIMEOUT_MINUTES` |
| Provider 429/5xx | gateway returns the upstream status; user sees the error |
| Quota exhausted | job marked `quota_exhausted`; one notification + email per day |
| SQLite locked | WAL + single process; retries surface as 500 and are logged |
| Mail down | approval still exists in Admin; login shows pending |

## Non-goals for v0.1

- Running arbitrary code inside Fledge.
- Auto-merging.
- Multi-tenant process isolation (one instance = one operator/team).
- Billing integration; the 1 CNY quota is a soft platform budget, not an invoice.
