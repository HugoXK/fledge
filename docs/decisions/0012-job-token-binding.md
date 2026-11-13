# 0012 — a job token is a `kind`, not a name

Status: **accepted** (2026-11-12)
Date: 2026-11-12
Supersedes: nothing; completes the token model `#355`/`#404` established for
personal tokens

## Context

The gateway records the model that ran and the cost it produced on a job when
the caller's token names one. Until `#481` it decided *which* job from the token
name alone:

```ts
const jobId = auth.token.name.startsWith('job:') ? auth.token.name.slice(4) : null
```

The name is user input: the PAT form writes `(body.name ?? '').trim().slice(0, 80)`
and sets `kind: 'pat'`. So any approved user could mint a token named
`job:<someone else's job id>` and the two writes that follow — `updateJob`
(`model_json`) and `addJobCost` (`cost_usd`) — are both `WHERE id = ?` with no
user scope. A job id is `job_` plus 80 random bits, so it cannot be guessed; it
is also not a secret. It appears in the owner's URLs, audit rows and screenshots,
and one pasted link is enough. The result is an integrity gap, not an open door:
the victim's row is only read to keep its fallback, nothing from it reaches the
response, and the caller pays with their own quota. But a job page could claim a
model ran that never ran, at a cost its owner never spent.

The model already says what a job token is. `docs/security.md` describes a
personal token as a gateway capability with a `scope` and an `expires_at`, job
tokens are minted with `kind: 'job'`, and the two places that turn a token name
into a repository filter test `kind` first.

## Decision

1. `jobId` is derived only when `auth.token.kind === 'job'` **and** the job row's
   `user_id` equals `auth.user.id`. Both facts are checked in
   `src/gateway/gateway.ts` where the id is derived, before the upstream call, so
   a forged name cannot spend quota either. The writes keep their signatures; one
   check covers both.
2. A token that claims a `job:` id it does not own is refused with
   `403 invalid_job_token`, mirroring the stable `insufficient_scope` refusal next
   to it. It is not silently ignored, because a silent ignore would leave the
   call spending quota under a name that reads like a job.
3. A genuine job token whose job row has been deleted keeps its old behaviour:
   the call proceeds and records nothing. The row is the record, and `recordModel`
   already tolerates its absence; retention deleting a job must not turn into a
   new refusal.
4. `docs/security.md` states the binding as a rule and `docs/api.md` gains the
   `invalid_job_token` row in the gateway's failure table.

No schema change: `api_tokens.kind` already exists and every job token already
sets it beside its name.

## Rejected

- **A name-only check with a stronger prefix.** The name is attacker-controlled
  by definition; any pattern over it is a suggestion, not an identity.
- **Silently ignoring a claimed job that is not owned.** The call would still
  succeed and spend the caller's quota, and the failure would be invisible to the
  operator — an integrity bug that looks like normal usage.
- **Scoping `updateJob` / `addJobCost` by user id in `src/db.ts`.** It would
  change two shared writers for one caller's mistake, and every other caller
  already passes a row it owns. The authorization decision belongs at the point
  where the untrusted name is read.
- **Refusing a job token whose row is gone.** It converts a cleanup into a
  credential failure for a call that already records nothing.

## Consequences

- A `job:` name on a personal token is refused with a stable error type; the PAT
  form is unchanged, and an operator can still name a token anything else up to
  80 characters.
- The two job writers stay unscoped, so a future caller must pass an id it has
  already authorized. The ownership check is the precondition, not the writes.
- `#376` (capability sets and signed receipts) can now assume the job binding is
  a property of the token row rather than a string convention.
