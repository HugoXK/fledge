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
| POST | `/auth/logout` | session + CSRF | Sign out |
| GET | `/pending` | session | Application status |
| GET | `/dashboard` | approved + session | Repos, quota, jobs |
| POST | `/repos` | approved + CSRF | Add a repository |
| GET | `/repos/:id` | owner | Repo detail |
| POST | `/repos/:id/run` | owner + CSRF | Enqueue a manual job |
| POST | `/repos/:id/settings` | owner + CSRF | Goal, cadence, enabled |
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
{ "token": "github_pat_…", "owner": "octo", "name": "demo", "defaultBranch": "main" }
```

Only while the job is `queued` or `running`.

### `POST /api/jobs/:id/callback`

Headers: `Authorization: Bearer <callbackSecret>`, `Content-Type: application/json`

```json
{
  "status": "succeeded",
  "branch": "fledge/fix-123",
  "prUrl": "https://github.com/octo/demo/pull/42",
  "summary": "Fixed the off-by-one in the CSV splitter; added a regression test.",
  "error": ""
}
```

`status` may be `running`, `succeeded` or `failed`. A finished job revokes its
job-scoped model token.

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
  -d '{"model":"DeepSeek-V4.1-Flash-1017","messages":[{"role":"user","content":"hi"}],"max_tokens":64}'
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

`GET /healthz` → `{ "ok": true, "service": "fledge", "version": "0.1.0" }`.

## Conventions

- JSON errors always have `error.type` and `error.code`.
- Browser form errors redirect back with `?error=`; API errors use HTTP status.
- All timestamps are ISO-8601 UTC.
- Money in the API is CNY unless the field says `usd`.
