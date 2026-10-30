# Architecture

## Principles

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
                            │               ├──► SMTP (flybot@yeah.net)
                            │               └──► model provider / router
                            │
                            └── job queue ──► FlyBot bridge ──► FlyBot agent
                                                   │
                                                   ├─ GET /api/jobs/:id/credential
                                                   └─ POST /api/jobs/:id/callback
```

### Fledge

- **Fastify** HTTP server, server-rendered HTML, no frontend build step.
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
- **No worker process**: a 60-second tick schedules due repos with a global
  concurrency cap of 2. Jobs that exceed the timeout are failed.

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

In the reference deployment `PLATFORM_LLM_BASE_URL` points at the local model
router (`127.0.0.1:8081/v1`), so the primary/alternate key failover applies
before the per-user quota.

### FlyBot bridge

The bridge is a tiny HTTP service on the FlyBot host. Fledge POSTs a job
descriptor; the bridge relays it to a configured FlyBot chat session. The agent:

1. fetches the GitHub token from `GET /api/jobs/:id/credential` with the job
   secret;
2. uses the platform model at `.../v1` with the job token;
3. creates a branch, commits, opens a PR;
4. calls `POST /api/jobs/:id/callback` with the branch, PR URL and summary.

Both endpoints require `Authorization: Bearer <callbackSecret>`. The secret is
generated per job, stored as a hash, and never appears in the UI.

## Data model

| Table | Purpose |
|---|---|
| `users` | GitHub identity, application status, signed agreement fields (name/version/time/IP/UA), role, quota, own model (encrypted key) |
| `sessions` | hashed session id, expiry, IP/UA |
| `oauth_states` | short-lived OAuth `state` values |
| `approval_tokens` | single-use approve/reject links |
| `repos` | repo owner/name, encrypted token, goal, cadence, state |
| `jobs` | lifecycle, branch, PR URL, summary, cost, job-scoped token hash |
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
