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

For streaming requests Fledge adds `stream_options.include_usage = true`, reads
the final usage chunk, and meters after the stream ends. A request that is already
in flight is allowed to finish; the **next** request sees the updated balance.

## Enforcement

- Before a platform-funded request: if `remaining_cny <= 0`, return HTTP 402
  immediately.
- After a platform-funded request: record a `quota_ledger` row and increment
  `users.quota_used_usd`.
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

## Own model

`POST /settings/model` stores:

- `own_llm_base_url` (validated, HTTPS for public hosts),
- `own_llm_key_enc` (AES-256-GCM),
- `own_llm_model`.

Saving performs a 1-token test request. Once set, the gateway proxies to the
user's endpoint and **does not** touch the platform quota or ledger. Clearing it
returns the user to the platform quota.

## Admin

Admins can set `quota_cny` per user from `/admin` (0–10000). Changes are audited.
Resetting usage is intentionally not a button in `v0.1`; raise the quota instead
so the ledger stays honest.

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

## Why 1 CNY

It is enough to demonstrate real iteration on a small repository (roughly
hundreds of thousands of flash-model tokens at the reference price) and small
enough that an operator can gift it without a billing system. The number is a
configuration value, not a business rule.
