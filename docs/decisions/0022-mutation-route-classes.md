# 0022 — a mutating route carries a class, and a test enforces it

Status: **accepted** (2026-11-15)
Date: 2026-11-15
Approved by: **Chief, 2026-11-14** (the ordinary class is unlimited by decision,
not by omission) and the Lead's three-class ruling of the same date
Supersedes: nothing; it records the rule `#708` applies and the shape of its
remaining slices

## Context

`#708` found that most of the browser-facing state-changing routes in
`src/app.ts` carried neither a limiter nor a recorded decision, against eight
that carried `destructiveLimit`. The first slice built the budgets
(`src/lib/rateLimit.ts`, one `RouteLimiters` keyed by `rateLimitKey`, numbers
from config) and paced five of the hottest mutations. What it did not change is
that a route added tomorrow inherits nothing: the gap was found by counting, not
by a test, and a count rots as fast as the routes do.

Two things were therefore still missing, and they are the same thing seen twice:
a written class for every mutating route, and a mechanism that notices when one
is missing.

## Decision

Every mutating route in `src/app.ts` belongs to exactly one of three classes,
declared as data in `src/lib/routeClasses.ts`:

1. **destructive** — irreversible or privilege-changing: a role, a token, a
   credential, a policy or a repository goes, or an account's standing changes.
2. **expensive** — starts, stops or merges real work: a job, a plan, a release,
   a schedule, an instance, a team turn.
3. **ordinary** — everything else that changes state.

`test/routeClassSweep.test.ts` reads the registrations out of `src/app.ts` and
compares them with that table in **both** directions. A mutating route with no
class fails as `unclassified: METHOD /path`, naming it. A class left behind for
a route that no longer exists fails as `stale classification: METHOD /path`. The
sweep reads the file; it does not pin a count, a total or a list, so an unrelated
edit cannot turn it red the way `#720` did to a suite that pinned a call total.

The class is data rather than a decorator on the handler on purpose. A handler's
`limits.take(...)` or `config: { rateLimit }` says how a route is paced **today**;
the table says how it should be. Keeping them apart means the classifier can be
complete before every route is paced, and it means a route whose pacing is
removed stays classified — the removal is visible as a diff on the enforcement
line, not as a silent change of policy.

## The ordinary class is unrestricted by decision

It is listed route by route, never implied: a route is ordinary because someone
wrote it in `ORDINARY_ROUTE_LIST`, not because it was left out of the other two.
Chief approved that class on 2026-11-14 on the ground that a form repost is not
an attack surface worth a shared budget — the blast radius of an ordinary write
is one record the account already owns.

The re-review condition: the first time an ordinary route's blast radius is not
"one record the account owns" — it starts work, moves money, or becomes
reachable with wider scope than the session — it moves to `expensive` or
`destructive` in the same change that grants it that reach. A class never
expands because nobody noticed.

## What this slice paces, and what is still pending

The card's five privileged routes are the reason the card exists. Two of them
(`POST /admin/users/:id/role`, `POST /repos/:id/run`) were paced by the first
slice; this one paces the remaining four:

- `POST /repos/:id/role` and `POST /settings/providers/:id/delete` — destructive,
  through `config: { rateLimit }` so the ceiling stays visible to an analyzer;
- `POST /repos/:id/team/stop` and `POST /repos/:id/jobs/:jobId/merge` —
  expensive, through the class limiter with the route's own bucket.

The eight routes that already carried `destructiveLimit` keep that window; they
gain a class and nothing else. Every other destructive or expensive route in the
table is **classified but not yet paced**, and `#708` stays open for them: the
classification is the policy, pacing the rest is the remaining work. That is a
stated gap, not an omission — the table makes the list explicit and the sweep
makes it current.

Some ordinary routes carry a control that is not a class budget: the sign-in
routes and the session-revocation routes keep the `login` window against
credential guessing, and the machine endpoints under `/api/` keep the 120-a-minute
`apiLimiter` that paces callers rather than forms. Those controls defend a
different thing; being ordinary says they take no **class** budget.

## Consequences

- Adding a mutating route now costs one line in the table. Forgetting it is a red
  test that names the route, not a quiet unlimited route.
- Renaming or deleting a route without the table turns the same test red, so the
  table cannot silently describe routes that no longer exist.
- The classifier is complete while enforcement is staged: `routeClassOf` answers
  for every route, and the paced set is smaller than the classified set until the
  remaining slices land.
