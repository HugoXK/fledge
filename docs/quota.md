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
- Before the upstream call: a token that claims a `job:` id it does not own is
  refused with `403 invalid_job_token` (#481), so a forged name spends no quota
  and writes no ledger row, no `jobs.cost_usd` and no `users.quota_used_usd`.
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
- **Per-job budget (CNY)** — how far a single job may spend. `job_budget_action`
  decides what happens when the job crosses it:

  - `alert` (the default) — the old behaviour. When a **finished** job's
    attributed cost exceeds the cap, Fledge writes a `job.budget_exceeded` audit
    entry and an in-app quota notification, after the spend.
  - `pause` — the job is paused at its **next checkpoint**, which is the
    earliest point where the spend is already in the ledger and no second model
    call is needed to learn it. The job records `JOB_BUDGET_PAUSED` with the
    observed cost, the owner gets a notification, and the job page names the
    action and the next step (raise the budget, then resume from the checkpoint
    or start a new job).
  - `cancel` — the same check, but the job ends `cancelled` with
    `JOB_BUDGET_CANCELLED`, the job token is revoked and only a new job continues
    the work.

  A terminal callback that arrives after a `pause` or `cancel` is refused, so a
  late result cannot revive a job the budget stopped. The threshold is never
  compared against an unknown cost: a job with no `quota_ledger` row yet (a
  provider error deducts nothing, so there may be none) is left running and the
  checkpoint writes one `job.budget_unknown` audit entry instead of treating the
  unknown as zero.

Cost is attributed through `quota_ledger.repo_id`; rows written before that
column existed fall back to the job's `repo_id` when they can be joined. Both
caps default to `0` (disabled) and are recorded in the repository audit entry
when changed; `job_budget_action` defaults to `alert`, so no existing repository
changes behaviour until its maintainer picks a stop.

## Model providers and repository selection

Settings manages a per-user set of OpenAI-compatible providers. A provider has a
label, base URL, encrypted key and an optional private/HTTP flag; each provider
can have multiple models (`provider_models`). Repository settings select which
provider models the repository may use and which is default
(`repo_model_selection`).

A request that is refused before a model is called is not metered: an unknown,
revoked or expired token gets `401 invalid_api_key`, and a live token whose
`scope` is not `gateway` gets `403 insufficient_scope` before `last_used_at` is
written. Only an authenticated call reaches the quota check and the ledger, so a
refused token cannot spend and cannot leave a usage row. A personal token's
finite expiry (default `PAT_EXPIRY_DAYS` 90) is what ends a leaked token's reach
without a manual revoke; job and instance tokens keep the lifetime their own
lifecycle sets.

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

### Repository provider policy

A repository may keep a provider allowlist and an optional region tag. The
gateway checks every candidate, including a fallback, before dispatch and refuses
a provider that is disabled, outside the allowlist or outside the required
region with `FLEDGE_PROVIDER_DISABLED`, `FLEDGE_PROVIDER_NOT_ALLOWED` or
`FLEDGE_PROVIDER_REGION_NOT_ALLOWED`. The refusal is returned as HTTP 403 with
`error.type = provider_policy_refused`, so no quota is spent and no upstream call
is made. An empty allowlist or region means no restriction in this version.

A repository that sets a policy must also name one of its models on every call.
A call that omits `model`, or names a model that does not resolve, is refused
with `FLEDGE_PROVIDER_POLICY_NO_MODEL` instead of falling through to the caller's
own model or the platform model: neither carries a provider id or a region, so
the policy would never be consulted. Omitting the field is therefore never a way
around the policy.

### Model URL guard and webhook egress

The model URL guard and the notification-webhook guard share one IP classifier
(`src/lib/ipAddress.ts`), so loopback, RFC1918, carrier-grade NAT, link-local,
multicast, ULA and IPv4-mapped private addresses are refused consistently. The
webhook check runs at send time and after every redirect; it does not change
quota accounting, and a refused webhook spends no quota and calls no provider.

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
The record is per **chat call**, not per job: every call a job makes rewrites which
model answered and which models **that call** tried, and the job page and the
pull-request automation comment name the model of the last call. The fallback a job
made is kept separately, as `fallback: { from, to, status }`, so the job page still
states it after a later call answered on the primary; the first fallback is the one
kept, and neither a later call that does not fall back nor one that falls back to a
different pair can clear or replace it. The pull-request automation comment names
only the last call's model and its attempts — it does not state an earlier fallback.

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
