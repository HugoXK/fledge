# Roadmap

Fledge is a **governed hosted repository team**, not another coding agent. The
differentiators are per-repository isolation, an explicit Chief/Lead playbook,
human control at every step, and a reviewable audit/cost trail.

The roadmap follows the patterns that have settled in frontier async-agent
products (GitHub Copilot coding agent, OpenAI Codex, Google Jules, Cursor
Background Agents, Devin, Claude Code subagents) and in agent observability /
durable execution (LangSmith/Langfuse, OpenTelemetry, Temporal/DBOS):

1. asynchronous work with a live control surface;
2. plan and permission gates before risky actions;
3. resumable runs with checkpoints;
4. evidence-first review (diff, tests, CI, risk, cost);
5. isolation, secret brokering, budgets and audit.

**Current release: `v0.4.5` (2026-11-21).** This page is current as of
2026-11-23. It is a plan, not a promise: a bullet is not an `agent-ready` issue
until it has a card with expected behaviour, scope and a red test (see
[How a roadmap item becomes work](#how-a-roadmap-item-becomes-work)).

## How to read this page

- **Shipped** — merged, released and gated by `ci-ok`.
- **Next** — admitted, ordered by dependency, and owned by a card on the
  [issue list](https://github.com/HugoXK/fledge/issues).
- **Frozen** — deliberately not next. A frozen item is not a rejection; it is a
  statement that the foundation must land first.

## Where we are — `v0.4.5`

| Era | What it made true |
|---|---|
| `v0.1` | OAuth login and approval gate, multi-repository onboarding, AES-256-GCM tokens, quota gateway, own-model fallback, mock/FlyBot bridge, admin/audit, Docker/CI/docs |
| `v0.2` | Per-repository FlyBot team and playbook, team console, fork/upstream, roles, work items, plan-first, budgets, issue commands, live inbox, stage sessions, grounded attribution |
| `v0.3` | Branded workspace, release automation, tip review gate, operational metrics/alerts, owner/operator surfaces, flight-deck visual system |
| `v0.4` | Durable `job_attempts` and lease fencing, decision pauses, strategy bundles, notification outbox, schedule occurrences/pause/run-now, admin automation health, closure of the release chain, feedback triage, project memory, product-loop metrics, `GET /api/v1/jobs`, repository rules/skills, layered budgets, deploy-check |

Recent releases (the last week) added, among other things:

- one ordered decision per repository on the dashboard, and one primary action
  per job;
- a red-test base run with an intended-reason verdict, a sealed context bundle,
  and a post-merge delivery ledger;
- an external release trigger, a slot watchdog and a conflict-free `ci-ok`
  publisher;
- a read-only CI gate check and a human-confirmed gate pull request;
- repository release readiness, tagging and draft-note analysis;
- `deploy-check` jobs for `deploy/`-only pull requests;
- a restore check that migrates the previous release's fixture;
- `@fledge` mention triggers and a priority ladder with explicit relation
  evidence.

## The one loop and its metrics

The product promise is one loop, not a dashboard of features:

```
Connect -> Goal -> Work -> Review -> Merge
```

The loop is measured by product metrics, not vanity counts
([ADR 0009](decisions/0009-product-loop-metrics.md)):

- time from connecting a repository to its first merged pull request;
- median wait from a pull request being ready to a human merging it;
- reputation of the job: verified evidence, not the agent's narrative;
- cost per merged pull request, split by model and repository;
- release-to-deploy lead time and deploy drift;
- how often a human has to rescue a run.

## v0.5 — foundation renewal (next)

**Goal:** make the next ten features cheaper and the next ten incidents rarer.
The tree is now 65 tables, 174 routes and four files between 5.5k and 8.7k
lines. The system works; the cost of changing it is the risk.

### 5.1 Structure

The single largest risk is that every route, query and page change touches one
giant file. This track cuts seams without a behaviour change, then puts a gate
behind them.

- **#1224** `refactor(db)` — extract the users/identity domain from `Store`
  behind one facade; the SQL moves unchanged.
- **#1225** `refactor(app)` — move routes behind a typed registry and split the
  settings surface first.
- **#1226** `refactor(views)` — give the repository page a typed view model and
  split `pages.ts`.
- **#1227** `refactor(jobs)` — extract the enqueue and callback paths from the
  `Jobs` service.
- **#1228** `test(arch)` — add import-boundary and file-size gates with a
  grandfathered list that can only shrink.

### 5.2 Durability and scale

The queue already has attempts, leases and occurrence claims. This track makes
the limits visible and the database survivable before a second instance is
attempted. It is the on-ramp to **#387** (Postgres, worker pool, distributed
leases), not a replacement for it.

- **#1229** `feat(db)` — put `node:sqlite` behind a dialect port with a backend
  contract suite.
- **#1230** `feat(jobs)` — expose lease age and reaped-lease metrics with an
  SLO alert.
- **#1231** `feat(db)` — add a slow-query budget and an admin query report.
- **#1232** `feat(db)` — add scheduled `ANALYZE`/`VACUUM` maintenance with a
  dry-run.

### 5.3 Trust and release

The release chain is the most automated and the most incident-prone part of the
system. This track turns conventions into checks and makes the release path
survivable under failure.

- **#1233** `feat(audit)` — hash-chain the audit log and add a verify command.
- **#1234** `feat(ops)` — add a read-only incident bundle export.
- **#1235** `test(release)` — add a fault-injection matrix for the release drive
  and watchdog.
- **#1236** `feat(security)` — add a token-rotation drill that proves old tokens
  are refused.

### v0.5 exit criteria

- The architecture gate is green in CI and the grandfathered list has shrunk.
- One domain, one route surface, one page and one job path are extracted with
  byte-identical behaviour.
- Lease, query and database-maintenance reports are visible to an operator.
- `audit:verify` runs in CI; the release fault matrix is green; the rotation
  drill is green.
- No new user-facing feature is required for v0.5; the release may ship as a
  `0.5.0` with a short user-facing note about reliability.

## v0.6 — owner loop and openness

**Goal:** make the owner's next action obvious, and make Fledge a platform other
tools can integrate with.

### 6.1 Owner loop

This is the concrete slice of the owner-surface direction in **#547**, with the
product-soul decision in **#654** as its admission test.

- **#1237** `feat(ui)` — add a keyboard command palette for owner actions.
- **#1238** `feat(ui)` — persist theme and density per user across devices.
- **#1239** `test(i18n)` — add a translation completeness and hardcoded-string
  gate.
- **#1240** `test(a11y)` — add axe-core checks to the visual matrix, on top of
  the geometry gate shipped in #870.

### 6.2 Openness

- **#1241** `refactor(repos)` — put GitHub behind a `SourceProvider` port with a
  contract suite. GitLab is a follow-up card, not this slice.
- **#1242** `refactor(runner)` — extract an `AgentRunner` port from the FlyBot
  bridge. A second runtime is a follow-up card, not this slice.
- **#1243** `feat(api)` — publish the OpenAPI 3.1 contract for API v1, the
  remaining slice named by #392.
- The other remaining #392 slices stay queued: write endpoints under
  `jobs:write`, the TypeScript SDK, and the MCP server.

### v0.6 exit criteria

- A keyboard-only owner can reach and run the next action without the navigation
  tree.
- Both locales and both schemes pass the i18n and a11y gates.
- One source port and one runner port exist with contract suites; the current
  GitHub/FlyBot behaviour is unchanged.
- `/api/v1/openapi.json` validates and every public route appears exactly once.

## v1.0 — production hardening

- **#387** — Postgres adapter, worker pool and distributed job leases. The
  dialect port in #1229 is the on-ramp.
- A second source provider (GitLab) after #1241.
- A second agent runtime after #1242.
- A second independent identity for T3 review (**#651**).
- Merge queue, commit signing and secret-scanning patterns (**#885**, **#879**,
  **#863**).
- Audit and artifact retention/export with an explicit compliance statement.
- External security review of the bridge, gateway and workspace proxy.
- A backup/restore runbook tested end to end, including a key rotation.

### v1.0 exit criteria

- One instance can be replaced without a database rewrite, and two instances do
  not double-run a schedule or a job.
- A T3 change needs two independent identities, and the required checks cannot
  be shadowed by a pull-request workflow.
- A restore, a rotation and a rollback have each been exercised and recorded.

## Frozen until the foundation lands

- **#426–#432** (AgentDescent, shadow evaluation, promotion and canary for
  evolved artifacts). The ledger exists; the loop does not need it yet.
- The per-repository subdomain workspace in the old `v0.3` list. The path
  workspace ships; a subdomain is optional and not on the critical path.
- Default auto-merge. It stays an explicit maintainer opt-in.
- Postgres before #1229, and GitLab before #1241. A second implementation
  without a seam would fork the job path.

## How a roadmap item becomes work

A roadmap bullet is a direction. A change is admitted only when it fixes a
reproducible defect or is something the routine work itself needs.

1. **Card** — one issue with expected behaviour, actual behaviour, a minimal
   reproduction, `file:line` where possible, and scope. Search open and closed
   issues first; never file a duplicate.
2. **Claim and branch** — one issue, one branch, one PR. A dirty tree uses a
   separate worktree.
3. **Red test** — the smallest test that fails on the unbroken tip. Keep both
   halves of the evidence.
4. **Gates** — `npm ci`, `npm run check`, `node scripts/risk-gate.mjs --base
   origin/main`, `node scripts/changelog.mjs check`.
5. **PR** — imperative title, `Fixes #N`, what changed, `Ran:` and `Not run:`,
   risks, tier, and a `Docs-not-needed:` line only when the docs really say
   nothing.
6. **Review and merge** — `ci-ok` for T0/T1; a PASS at the tip from another
   identity for T2/T3. Never admin-merge, never bypass a check.

The binding rules are [AGENTS.md](../AGENTS.md),
[docs/code-standards.md](code-standards.md) and
[docs/autonomous-dev.md](autonomous-dev.md).

## Open questions

1. **Product soul and admission test** — #654. Until this is answered, v0.6's
   owner-loop items are proposals, not commitments.
2. **Owner surface** — #547. Is `/dashboard` the only default, and does the
   operator surface stay a separate page after the flight-deck work?
3. **Openness cost** — when is a second source provider or a second agent
   runtime worth the maintenance it adds? #1241/#1242 build the seam first and
   do not answer this.
4. **Shared repositories** — #105 and
   [ADR 0002](decisions/0002-shared-repo-members.md). The read path is a slice;
   invite, transfer and member roles are not shipped.
5. **Scale trigger** — what load or tenant count makes #387 worth running?
   Without a number, Postgres is a rewrite looking for a reason.
6. **Retention and compliance** — what must be kept, for how long, and who can
   export it? The current windows are operational, not a policy.
7. **Workspace exposure** — the path proxy is the default today; is a subdomain
   still wanted, or does it stay optional?

## Non-goals

- Running arbitrary user code inside Fledge.
- Auto-merging without an explicit maintainer opt-in and green required checks.
- A general-purpose CI system.
- Being a GitHub replacement: Fledge is a thin, reviewable layer on top of it.
- Turning the team console into a generic chat product; it exists to govern the
  repository team.
- Chasing feature parity with another agent product before the one loop is
  measured.
