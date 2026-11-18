# Quota

## The rule

Every user starts with **1 CNY** of platform-funded model usage
(`INITIAL_QUOTA_CNY`). When it is gone, the platform stops paying and tells the
user to configure their own OpenAI-compatible model service. Their jobs then run
on their key, with no platform metering.

The first-run model step shows the remaining balance. Below
`PLATFORM_QUOTA_COMFORT_CNY` (default 50) it warns that the balance may not cover
the first run and recommends adding an own model now; at or above it the balance
is shown without a warning and Settings → Model remains the later path. The
threshold changes the checklist advice only; it never changes quota accounting.

## Units

- Ledger: the provider's own **currency**, one bucket per currency (`USD`,
  `CNY`, …). There is no exchange rate between buckets.
- User-facing quota: **CNY**, computed from the USD bucket.
- `remaining_cny = quota_cny - quota_used_usd * USD_CNY_RATE`.
- `USD_CNY_RATE` defaults to `7.2`; change it in `.env`.
- `users.quota_used_usd`, `jobs.cost_usd` and the CNY repository budgets are
  **USD columns**: they only read rows billed in USD (a row with no currency is
  the legacy shape and counts as USD). A row priced in another currency is
  reported by `Store.costByCurrency()` in its own bucket and is **not**
  converted into any of them, because there is no rate between the buckets. A
  CNY-priced call therefore does not consume the CNY quota or trip a CNY budget;
  the currency table is where its cost is visible.

## Cost source

1. `x-litellm-response-cost` response header, when present. This is the
   gateway's actual charge and includes retries/discounts; it is recorded in
   **USD** because that header is denominated in USD.
2. Otherwise the model's own price entry, multiplied by its token counts. Each
   entry carries input, output and cached-input prices per token:

   ```sh
   PLATFORM_LLM_PRICE_TABLE='[
     {"model":"deepseek-chat","currency":"CNY","inputPerToken":0.000002,"outputPerToken":0.000008,"cachedInputPerToken":0.0000005}
   ]'
   ```

   A model the table does not list is **unknown**, never a guess: the table is
   the whole truth once it is set. With no table at all, the single
   `PLATFORM_LLM_PRICE_PER_TOKEN` (default `0.0000002` USD/token) still prices the
   platform model, so an upgrade keeps metering.

Every ledger row records the **snapshot** it was charged at — model, currency
and the three per-token prices — so changing the table never rewrites history.
A cached token is a subset of the input tokens and is charged at the cached
price instead of the input price; both `prompt_tokens_details.cached_tokens` and
DeepSeek's `prompt_cache_hit_tokens` are read. Charging both would bill it twice.

### Unknown cost is not free cost

A call that cannot be priced — no table entry for the model, no `usage` block, or
a usage block with no token count — writes a ledger row with `cost_known = 0` and
`cost_usd = 0`, plus one `request.cost_unknown` audit entry (and a
`request.cost_unknown` job event when a job token is in scope). It does not
increment `users.quota_used_usd`, because adding zero would claim the call was
free. `Store.costByCurrency()` therefore reports `unknownRequests`, and its
`semantics` is `lower_bound` while any request in the window is unknown — the
spend it shows is a floor, not the whole bill.

An unknown call is also outside **enforcement**: with no figure to compare, the
user quota and the ambiguous per-job budget cannot refuse it. A job whose calls
are all unknown has no ceiling at either level until one call is priced; that is
the same rule stated the other way (an unknown cost is not read as zero), not a
free allowance. A stream that fails mid-flight is still one attempt the user consumed, so it
writes one of those rows rather than none: the provider's `x-litellm-response-cost`
figure as a known USD row when the response carried one, and a `cost_known = 0`
row with reason `no_usage`, its audit entry and its job event when it did not.

An attempt that never reached a model is not billed: a `404` whose body says the
model does not exist writes no ledger row, so a model its provider has retired
costs nothing, and the fallback to the next selected model is priced on its own
answer. The retirement itself is recorded on the provider model
(`provider_models.retired_at`, #852), not in the ledger.

For streaming requests Fledge adds `stream_options.include_usage = true` and
parses each SSE `data:` line. It keeps the last `usage` object, including nested
`completion_tokens_details` / `prompt_tokens_details`, and meters after the
stream ends. A request that is already in flight is allowed to finish; the
**next** request sees the updated balance.

## Enforcement

- A job is platform-funded only when neither the legacy user-level model nor a
  repository-selected provider model exists. The enqueue and dispatch paths use
  the same predicate as the bridge and the gateway, so selecting a model for the
  repository is enough to pass an exhausted platform quota.
- Before a platform-funded request: if `remaining_cny <= 0`, return HTTP 402
  immediately and mark that user's active jobs `quota_exhausted` (their job
  tokens are revoked) so the UI does not wait for the job timeout.
- Before the upstream call: a token that claims a `job:` id it does not own is
  refused with `403 invalid_job_token` (#481), so a forged name spends no quota
  and writes no ledger row, no `jobs.cost_usd` and no `users.quota_used_usd`.
- After a platform-funded request: record a `quota_ledger` row and, when the row
  is billed in USD, increment `users.quota_used_usd`. While a job is running the
  bridge injects the job-scoped `flg_` token into the model proxy, so the row also
  carries `job_id`; the gateway adds a USD cost to `jobs.cost_usd` for per-job
  display. On job finish Fledge calls the bridge `/job-done` endpoint to drop
  the job token immediately; the proxy also retries once with the instance
  token if the gateway returns 401/403, so a revoked/expired job token cannot
  leave the team with AUTH errors. Outside a job the instance token is used and
  the row has no job id.
- When the balance crosses zero: create one in-app notification and at most one
  email per user per day (deduped by `settings:quota_notified:<userId>`). The
  in-app notification is written before the mail attempt, so it survives a failed
  send; a failed send also writes a `quota.mail_failed` audit row with the SMTP
  error redacted, because the day key is already set and that row is the only
  trace that the reminder was never delivered.
- A failed job before it starts (quota already zero) is recorded as
  `quota_exhausted` and does not call the model. The scheduler predicate that
  answers "why did this repository not start" reads the same answer
  (`automationDispatchBlocker` takes the quota rate and uses the shared
  `quotaExhausted`), so a repository refused for quota is reported as refused and
  never as idle with work — before the attempt and however long the refusal
  lasts. A user with their own model, or a repository with its own model
  selection, never spends platform quota, so quota is never their refusal.

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

  A retry does not reset the budget: the new attempt names the attempt it
  continues in `jobs.retry_of` (the immediate parent, so a retried retry keeps
  every attempt), and the checkpoint sums the whole chain, so a second attempt
  starts from the spend the first one recorded (a resume reuses the same job row
  and needs no chain). A terminal callback that arrives after a `pause`
  or `cancel` is refused, so a late result cannot revive a job the budget
  stopped. The threshold is never
  compared against an unknown cost: a job with no **priced** `quota_ledger` row
  yet (a provider error deducts nothing, so there may be none) is left running
  and the checkpoint writes one `job.budget_unknown` audit entry instead of
  treating the unknown as zero. Rows with `cost_known = 0` do not count as a
  priced row, so a job whose only calls are unknown keeps that refusal. The cap
  reads USD-billed rows only (see **Units**), so a call priced in another
  currency is reported in the currency table instead of being converted into the
  CNY budget by an invented rate.

Cost is attributed through `quota_ledger.repo_id`; rows written before that
column existed fall back to the job's `repo_id` when they can be joined. Both
caps default to `0` (disabled) and are recorded in the repository audit entry
when changed; `job_budget_action` defaults to `alert`, so no existing repository
changes behaviour until its maintainer picks a stop.

## Budget scopes

Two more caps sit beside the per-job one (#697), and all three are one mechanism
with one enforcement point, not three: the per-job cap still reads
`repos.job_budget_cny`, and the two new caps live in the additive
`budget_scopes` table, keyed by scope kind and scope id.

- **Repository budget (CNY)** — `kind = 'repository'`, id = the repository id. It
  sums every job in that repository over a rolling 30 days.
- **User budget (CNY)** — `kind = 'principal'`, id = `principal:user:<user_id>`,
  the person who starts work. It sums that person's spend **across repositories**
  over the same 30-day window.

Both take the same `job_budget_action` values as the per-job cap (`alert`,
`pause`, `cancel`). A **missing row means no cap** — never a zero cap — and the
console lists the cap, the spend consumed and the scope it belongs to, with a
lower-bound caveat when a call in the window could not be priced.

A scope lives exactly as long as the thing it names: clearing a cap to zero
deletes the row, and the account purge deletes both shapes that carry an erased
account — its `principal:user:<id>` row and one repository row per repository it
owned — in the same transaction as the rest of the purge, counts them in the
retention row. A scope must never outlive its subject, because a key such as
`principal:user:<id>` is a row that names the account the purge exists to erase.

**Precedence** is job > repository > principal. A more specific scope always
fires before a wider one, whatever room each has left, so an outer cap can
tighten but never loosen an inner one; two caps at the same specificity are
decided by the **lower remaining budget**, not the lower cap, and the refusal
names the scope that fired. The reason keeps the same shape
(`JOB_BUDGET_PAUSED` / `JOB_BUDGET_CANCELLED`) and its scope word, so the job
page and the localiser read it without a second vocabulary. An `alert` scope
never stops a job — it is reported in a finish notice and in the audit, because
an alert-only cap that could shadow a stopping cap would quietly disable it.

The rolling window is a query bound, not a stored period: nothing expires, no
reset job runs, and no cap is "reset" by deleting ledger rows — the ledger is the
audit record. Both new caps are USD-only, like the per-job one: a call priced in
another currency stays in its own bucket and cannot move a CNY cap.

The `#357` unknown rule holds at every scope. A chain whose only priced rows are
in CNY is **priced**, not unknown, even though the USD sum the cap compares is
zero: `usageCountForJobChain` counts every priced row while `usageForJobChain`
sums USD rows only, and reading the first as the second would turn an unknown
cost into a free one. A per-role scope is out of this mechanism and lives in
`#710`, because no priced row records the role that spent the money.

## Model providers and repository selection

Settings manages a per-user set of OpenAI-compatible providers. A provider has a
label, base URL, encrypted key and an optional private/HTTP flag; each provider
can have multiple models (`provider_models`). Repository settings select which
provider models the repository may use and which is default
(`repo_model_selection`).

A request that is refused before a model is called is not metered: an unknown,
revoked or expired token gets `401 invalid_api_key`, and a live token whose
`scope` is not `gateway` gets `403 insufficient_scope` before `last_used_at` is
written. That decision is one shared function, `authenticateApiToken` in
`src/lib/apiToken.ts`, which the public read API (#392) calls with `jobs:read`;
the gateway passes `gateway`, so a read token can never reach a model and a
gateway token can never reach the job list — neither path spends quota. Only an authenticated call reaches the quota check and the ledger, so a
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
