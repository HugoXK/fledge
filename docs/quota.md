# Quota

## The rule

Every user starts with **1 CNY** of platform-funded model usage
(`INITIAL_QUOTA_CNY`). When it is gone, the platform stops paying and tells the
user to configure their own OpenAI-compatible model service. Their jobs then run
on their key, with no platform metering.

## Units

- Ledger and provider cost: **USD**.
- User-facing quota: **CNY**.
- `remaining_cny = quota_cny - quota_used_usd * USD_CNY_RATE`.
- `USD_CNY_RATE` defaults to `7.2`; change it in `.env`.

## Cost source

1. `x-litellm-response-cost` response header (USD), when present. This is the
   gateway's actual charge and includes retries/discounts.
2. Otherwise `usage.total_tokens` (or prompt + completion) ×
   `PLATFORM_LLM_PRICE_PER_TOKEN` (default `0.0000002` USD/token).

For streaming requests Fledge adds `stream_options.include_usage = true` and
parses each SSE `data:` line. It keeps the last `usage` object, including nested
`completion_tokens_details` / `prompt_tokens_details`, and meters after the
stream ends. A request that is already in flight is allowed to finish; the
**next** request sees the updated balance.

## Enforcement

- Before a platform-funded request: if `remaining_cny <= 0`, return HTTP 402
  immediately and mark that user's active jobs `quota_exhausted` (their job
  tokens are revoked) so the UI does not wait for the job timeout.
- After a platform-funded request: record a `quota_ledger` row and increment
  `users.quota_used_usd`. While a job is running the bridge injects the
  job-scoped `flg_` token into the model proxy, so the row also carries
  `job_id`; the gateway adds the same cost to `jobs.cost_usd` for per-job
  display. On job finish Fledge calls the bridge `/job-done` endpoint to drop
  the job token immediately; the proxy also retries once with the instance
  token if the gateway returns 401/403, so a revoked/expired job token cannot
  leave the team with AUTH errors. Outside a job the instance token is used and
  the row has no job id.
- When the balance crosses zero: create one in-app notification and at most one
  email per user per day (deduped by `settings:quota_notified:<userId>`).
- A failed job before it starts (quota already zero) is recorded as
  `quota_exhausted` and does not call the model.

402 body:

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

## Repository and per-job budgets

A maintainer can set two optional caps per repository in the repository
settings:

- **Monthly repository budget (CNY)** — a rolling 30-day cap on the repository's
  attributed platform spend. A new job is refused with
  `REPO_BUDGET_EXHAUSTED` when the cap is reached.
- **Per-job budget (CNY)** — an alerting threshold, not a hard stop. When a
  finished job's attributed cost exceeds it, Fledge writes a
  `job.budget_exceeded` audit entry and an in-app quota notification.

Cost is attributed through `quota_ledger.repo_id`; rows written before that
column existed fall back to the job's `repo_id` when they can be joined. Both
caps default to `0` (disabled) and are recorded in the repository audit entry
when changed.

## Model providers and repository selection

Settings manages a per-user set of OpenAI-compatible providers. A provider has a
label, base URL, encrypted key and an optional private/HTTP flag; each provider
can have multiple models (`provider_models`). Repository settings select which
provider models the repository may use and which is default
(`repo_model_selection`).

The gateway aliases each provider model by its id. An instance or job token that
carries `repo_id` resolves `body.model` to the selected provider model and calls
that provider; an unselected model falls back to the user's legacy own model,
then the platform model. `/v1/models` lists the selected aliases for a
repository token.

Adding a model performs a 1-token test from Fledge. A failed test is an error and
nothing is saved. A provider can be edited after re-testing every existing model,
and "Discover models" reads `/v1/models` and bulk-adds only the models that pass
the test. HTTP/private addresses require `ALLOW_PRIVATE_MODEL_URLS`, a
per-user `allow_private_models` flag set by a superadmin, or the superadmin
checkbox; the test must pass; the gateway host is the
component that calls the model, so it must be able to reach the address.

Existing legacy `user_models` and `users.own_llm_*` rows are migrated into
provider/model rows at startup. Existing `flybot:<repo>` and `job:<id>` tokens
are backfilled with their repository id, so new usage is attributed per
repository. Historical ledger rows without a job id remain unattributed.

## Admin

Admins can set `quota_cny` per user from `/admin` (0–10000), or tick
**Unlimited** (`users.quota_unlimited = 1`). Changes are audited. An unlimited
user is never blocked and no quota notice is sent, but every platform-funded call
is still recorded in `quota_ledger` and shown as usage. Resetting usage is
intentionally not a button in `v0.1`; raise the quota instead so the ledger stays
honest.

## Edge cases

| Case | Behaviour |
|---|---|
| Cost header missing | Token estimate is used |
| Cost header zero | Nothing is deducted (provider bug or cached response) |
| Provider 429 | No deduction; the user sees the upstream error |
| Provider 5xx | No deduction if no usage is returned |
| User switches to own model mid-day | New requests bypass quota; old ledger stays |
| User has no email | In-app notification only |
| Admin lowers quota below usage | Remaining is clamped to zero |
| User is marked unlimited | No 402 and no notice; usage keeps accumulating |
| Streaming response omits the cost header | Metered from the final usage chunk |

## Why 1 CNY

It is enough to demonstrate real iteration on a small repository (roughly
hundreds of thousands of flash-model tokens at the reference price) and small
enough that an operator can gift it without a billing system. The number is a
configuration value, not a business rule.

## Model fallback

A repository selects an ordered set of models (`repo_model_selection`). The
`is_default` row is the primary; the remaining rows keep the order they are
listed in, which is the order the selection query returns (provider first, then
model). There is no separate order column, so the console's picker and the
gateway read the same order.

When a chat call to the primary is refused **transiently** — `429` rate limit,
`408`, a `5xx`, an unreachable provider, or a `404` that says the model was
retired — the gateway retries the same request on the next model in that order
and answers with the first success. The job finishes once, on one model, and its
row records which model replied plus the models it fell through (`jobs.model_json`).
The job page and the pull-request automation comment name that model.

It never falls back on:

| Refusal | Why not |
|---|---|
| `401` / `403` | The credential is the repository's, not the model's: another model behind the same key is no more likely to be accepted |
| `402` | Payment or plan; changing model does not fix it |
| `429` carrying `insufficient_quota` / billing / budget | An exhausted provider quota is not a rate limit; retrying it on another model spends the same account again |
| A policy or content refusal | That is a decision about the request, not the model's health |

One charge per answered call: a refused attempt returns no usage, so only the
model that answered is billed, and the attempt list on the job shows the refused
models without a cost.
