# 0025 — a priced call names the role that spent it, or the role axis is refused

Status: **proposed** — one question is the owner's and it is open; both branches
are recorded below and neither is decided here.
Date: 2026-11-20
Decision owner: HugoXK
Depends on: [0023](0023-per-role-concurrency-and-leases.md) (a job is a role
chain, not one role), the `budget_scopes` mechanism from `#697`
(`docs/quota.md:192-236`), `#636` (currency, model, price snapshot on a row)
Settles: `#710`. It keeps `#697`'s refusal of the role axis in place until the
owner answers, and says exactly what each answer changes.

## Context

A cap scoped to a role needs priced rows that name the role that spent the
money. Today no row can answer that question.

- `quota_ledger` (`src/db.ts:1688-1700`) carries `at`, `user_id`, `job_id`,
  `repo_id`, `cost_usd`, `meta`, `currency`, `model`, `price_snapshot` and
  `cost_known`. The additive migrations at `src/db.ts:3370-3375` added
  `repo_id`, `currency`, `model`, `price_snapshot` and `cost_known`; no role
  column was ever added.
- There is exactly one write point: `recordUsage()` (`src/db.ts:7998`, the
  `INSERT` at `:8003`). Its two callers are both in the priced path of
  `src/gateway/gateway.ts:443` and `:457`, and all three receive only
  `authed.user.id`, `jobId` and `authed.token.repo_id`. `src/gateway/gateway.ts`
  contains no `role` reference at all, so the priced path cannot record what it
  never receives.
- The read side is already keyed: `usageForJobChain`, `repoUsageSince` and
  `principalUsageSince` feed the candidates at `src/jobs/service.ts:3290-3299`,
  and `budgetStop()` (`:3318`) decides with the precedence list in
  `src/lib/budgetScope.ts:12`. A role scope would be a fourth kind, a fourth
  query, and a position in that list.
- The only role data in the tree is **call counts**, not cost:
  `jobs.team_stats_json` (`src/db.ts:1589`, read at `src/db.ts:5151-5158`) parses
  as `{ role, calls }` (`src/lib/teamStats.ts:3-6`) and the seats it names are
  the team's, not the repository's (`src/lib/teamStats.ts:9-22`).
- Two vocabularies are in use and only one can key a budget. `REPO_ROLES` is
  `maintainer`/`developer`/`viewer` (`src/identity/authorization.ts:51`) — a
  permission on a repository. The spender vocabulary is the team seat
  (`lead`, `product`, `dev1`, `dev2`, `test`, `reviewer`, `security`), because
  that is who makes the priced call.

This is why `#697` ruled the role axis out of its slice rather than building half
of it: repository and principal scopes have keys in the rows today
(`repos.id`, `identityPrincipalId()`), and a role scope has none.

## The question that is the owner's, and it is open

**Does the FlyBot bridge send, with each priced call, the team role that made
it?** The bridge is the caller of the gateway; if it does not send a role, no
column can be filled without guessing. This is a cross-repository contract
question, so it is carried to the owner by Chief, and this ADR does not decide
it.

### Branch A — the bridge sends a role

Then the role belongs on `quota_ledger`, added the same additive way as
`repo_id` (`src/db.ts:3370`), and the slice is:

1. `ALTER TABLE quota_ledger ADD COLUMN role TEXT` — **nullable, no default**, plus
   `quota_ledger_role_idx (role, at DESC)`.
2. `recordUsage()` takes the role as an argument (a field on `UsageDetail`), so
   the single insert stays the single insert and no caller writes the column
   itself. A gateway request that carries no role writes `NULL`.
3. `BUDGET_SCOPE_KINDS` gains `'role'` at index 1, after `job` and before
   `repository`: a seat is narrower than the repository it works in, so an outer
   cap may tighten but never loosen it. The position is a tested rule, not a
   detail — `budgetStop()` ranks by index.
4. A new read, `roleUsageSince(role, window)`, sums `quota_ledger` rows that name
   that role, with the same USD-only and unknown-row rules the other scopes use.
5. The switch: the kind is inert until it is on. With no `budget_scopes` row of
   kind `'role'`, nothing reads the column, `budgetStop()` cannot return a role
   stop, and the console shows the column only as attribution.

### Branch B — the bridge does not send a role

Then the role axis is **refused**, and the refusal is the deliverable:

1. No role column, no role kind, no role query.
2. `docs/quota.md:236-237` changes from "a per-role scope is out of this
   mechanism and lives in `#710`, because no priced row records the role" to a
   sentence naming this ADR as the ruling that a role-scoped budget is refused,
   with the reason (no role reaches the gateway).
3. `#710` closes on this ADR with no code, which the card already names as an
   accepted outcome rather than a failure.

## What is decided here, whichever branch the owner picks

1. **No half-built role axis.** Nothing adds a column, a kind or a query before
   the owner's answer; the two branches above are the only shapes this team will
   implement.
2. **The scope key is the team seat, never `REPO_ROLES`.** A permission role on a
   repository is not a spender; scoping money to `maintainer` would charge every
   maintainer of a repository into one cap that no call names.
3. **A row that does not name a role is never charged to one.** `NULL` stays
   `NULL`: no default role, no backfill that invents a seat for historic spend,
   and no rule that makes the largest spender the owner of an unattributed row. A
   role cap counts named rows only, and the console reports unattributed spend
   beside it so a cap cannot look satisfied because its rows were dropped.
4. **One role per call, so one role per row.** A job runs a stage chain with
   several roles (0023), and `team_stats_json` proves more than one can act in a
   job, so neither "the job's role" nor "the job's first role" is a single value.
   This is also why the `jobs`-column option is rejected below.
5. **The owner's own quota does not move.** `users.quota_used_usd` and
   `quotaView()` are unchanged by either branch; a role scope is a team budget
   kind beside the three that exist, not a change to the owner's quota.

## Rejected

- **A role column on `jobs`.** Cheap and wrong: a job can carry several roles
  (0023, and `team_stats_json`'s array shape), so the column would attribute every
  priced call in the job to whichever role won, and a cap would fire on the wrong
  spender. It also cannot express a user-PAT call, which has no job at all.
- **Deriving the role from `team_stats_json` proportions.** It counts calls, not
  cost (`src/lib/teamStats.ts:3-6`); splitting a bill by call count prices a
  cheap call and an expensive one the same and invents a number the ledger does
  not contain.
- **Putting the role on `budget_scopes` instead of the ledger.** A cap must be a
  query over spend; a scope table that names a role with nothing to sum is the
  half-built shape this ADR exists to prevent.
- **Widening `REPO_ROLES` to include team seats.** It is an authorization list
  with capabilities attached (`capabilitiesForRole`), and a budget key must not
  be able to change who may merge.

## Consequences

- **Branch A:** `src/db.ts` (column, index, `recordUsage` signature, one query),
  `src/lib/budgetScope.ts` (the kind and its precedence position),
  `src/jobs/service.ts` (the candidate and the read), `src/gateway/gateway.ts`
  (the field it passes), the bridge contract in `bridge/README.md`,
  `docs/quota.md` (the new kind and the unattributed rule), `docs/api.md` if the
  gateway request shape changes, plus tests for the precedence position, the
  `NULL` rule and a pre-existing row.
- **Branch B:** `docs/quota.md` only, plus this ADR, and `#710` closes on it.
- **Either way:** the ruling is binding only as this file merged through a pull
  request that passes the repository's gates (T3: a Reviewer PASS at the tip). A
  sentence in a comment is not an ADR and does not unblock `#710`.

## When this becomes accepted

The status changes from **proposed** to **accepted** when the owner answers the
one question in "The question that is the owner's" and the answer is recorded in
the branch that applies. Until then `#710` stays held, and nothing in the code
or the schema pretends the axis exists.
