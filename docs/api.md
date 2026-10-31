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
| POST | `/auth/token` | public, rate-limited | Sign in with a GitHub token when OAuth is not configured |
| POST | `/auth/logout` | session + CSRF | Sign out |
| GET | `/apply` | session | Disclaimer and information-security signature |
| POST | `/apply` | session + CSRF | Submit the signed application once |
| GET | `/apply/status` | session | Live queue position and status |
| GET | `/api/application` | session | JSON status/queue for the status page |
| GET | `/dashboard` | approved + session | Repos, quota, jobs |
| GET | `/console` | approved + session | Workspace overview (repos, jobs, quota) |
| POST | `/repos` | approved + CSRF | Add an upstream repository; Fledge checks or creates the user's fork |
| GET | `/repos/:id` | owner | Repo detail |
| POST | `/repos/:id/run` | owner + CSRF | Enqueue a manual iterate job |
| POST | `/repos/:id/instance` | owner + CSRF | Start the per-repository FlyBot instance |
| POST | `/repos/:id/instance/stop` | owner + CSRF | Stop the per-repository FlyBot instance |
| POST | `/repos/:id/refresh` | owner + CSRF | Re-check the upstream, fork and permissions |
| POST | `/repos/:id/review` | owner + CSRF | Enqueue a manual review job |
| POST | `/repos/:id/settings` | owner + CSRF | Goal, cadence, enabled, reviewer interval |
| POST | `/repos/:id/delete` | owner + CSRF | Delete repo and jobs |
| GET | `/settings` | approved | Account, model, API tokens |
| POST | `/settings/model` | approved + CSRF | Save/clear own model |
| POST | `/settings/tokens` | approved + CSRF | Create a `flg_` token |
| POST | `/settings/tokens/:id/revoke` | owner + CSRF | Revoke a token |
| POST | `/notifications/read` | approved + CSRF | Mark notifications read |
| GET | `/admin` | admin | Pending users, quotas, audit |
| POST | `/admin/users/:id/approve` | admin + CSRF | Approve |
| POST | `/admin/users/:id/reject` | admin + CSRF | Reject |
| POST | `/admin/users/:id/quota` | admin + CSRF | Set quota in CNY |
| GET | `/approve/:token` | token | Confirmation page |
| POST | `/approve/:token` | token | Apply approve/reject |

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
  "canReview": true,
  "canCreateIssue": true
}
```

`owner/name` is always the upstream. When the token belongs to the upstream
owner, `fork` equals `upstream` and `isFork` is false. Otherwise the agent must
push to `fork` and open the PR against `upstream`. Only while the job is
`queued` or `running`.

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
  }
}
```

Review jobs use `kind=review` and return `reviewScore` (0–100) instead of a
branch/PR:

```json
{ "status": "succeeded", "summary": "Reviewed 6 PRs; average 78.", "reviewScore": 78 }
```

`status` may be `running`, `succeeded` or `failed`. A `running` callback is a
progress heartbeat: it updates `summary` (and optionally `branch` or
`attribution`) without finishing the job or extending `JOB_TIMEOUT_MINUTES`. On
success, Fledge posts a short automation comment on the PR with the job, team
and attribution so humans can see which role wrote, claimed, implemented, tested
and reviewed the change. A finished job revokes its job-scoped model token, and
later callbacks or credential reads return HTTP 409.

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

`GET /healthz` → `{ "ok": true, "service": "fledge", "version": "0.2.0" }`.

## Conventions

- JSON errors always have `error.type` and `error.code`.
- Browser form errors redirect back with `?error=`; API errors use HTTP status.
- All timestamps are ISO-8601 UTC.
- Money in the API is CNY unless the field says `usd`.
