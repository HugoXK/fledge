# Handoff — Fledge (v0.5.0 current)

Status: **v0.5.0 is the latest release (2026-11-23, `fledge.hugoxk.online`)**;
this page is current as of 2026-11-23. The previous public baseline is
[handoff-2026-11-10.md](handoff-2026-11-10.md), kept as history. The plan and
open questions live in [roadmap.md](roadmap.md).

The operator's private handoff (server paths, env locations, non-public URLs) is
not committed; it lives next to the working copy as `SESSION_HANDOFF.md`.

## Start here

1. Read [AGENTS.md](../AGENTS.md), [LESSONS.md](../LESSONS.md),
   [docs/code-standards.md](code-standards.md) and
   [docs/autonomous-dev.md](autonomous-dev.md).
2. Run `npm ci && npm run check` on Node 22.9+.
3. `cp .env.example .env`, then `npm run dev` and open
   `http://localhost:8080/auth/dev` for a local admin (the dev login is refused
   when `NODE_ENV=production`).
4. Pick the next item from **Open work** below and follow the pipeline.

## What exists

- **Repository:** <https://github.com/HugoXK/fledge>
- **Release:** <https://github.com/HugoXK/fledge/releases/tag/v0.5.0>
- **CI:** `ci.yml` (Node 22 + 24, lint, typecheck, tests, coverage, build,
  visual, Docker, audit, dependency review, changelog, version, risk,
  restore-drill, action pins, workflow lint, secret scan, CodeQL, deploy-check,
  mock-check), `codeql.yml`, `release.yml`, `daily-release.yml`,
  `release-slot.yml`, `review-gate.yml`. The aggregate is **`ci-ok`**.
- **Stack:** Node 22.9+, TypeScript, Fastify, `node:sqlite`, nodemailer,
  server-rendered HTML.
- **Service:** <https://fledge.hugoxk.online/> (GitHub OAuth; the token-login
  fallback is disabled in production).
- **Docs:** <https://docs.fledge.hugoxk.online/docs/> (mirror:
  <https://hugoxk.online/fledge/docs/>).
- **Project page / guide:** <https://hugoxk.online/fledge/>.

### Implemented

- **Governed delivery loop.** One issue → one branch → one PR. A tip-SHA review
  gate (`review-gate`), risk tiers computed from every changed path, path
  guards, PR evidence verification, merge bound to the job's own PR, duplicate
  preflight, and an opt-in maintainer auto-merge that independently verifies the
  PR state, checks, reviews and branch protection.
- **Durable execution.** `job_attempts` with lease epochs and fencing,
  idempotent callbacks, plan-first checkpoints, decision pauses, schedule
  occurrences with timezone/misfire/pause/run-now, durable retries with bounded
  backoff, a platform emergency stop, orphan cleanup and graceful drain.
- **Identity and governance.** Platform roles, per-repository maintainer /
  developer roles, tenants/projects/principals and scoped grants, a shared
  repository read path (slice 1 of #105), management commands, audit log,
  postmortems, task relations and project memory.
- **Models and budgets.** Platform quota, own-model fallback, provider → models,
  per-bot model assignment, a model router health view, and job / repository /
  principal budget scopes with alert, pause or cancel.
- **Release chain.** The daily minor drive, the mechanical release identity and
  diff shape, release readiness and tagging, draft release notes, SBOM and build
  provenance, a publish guard, and `verify-release` for the plan / branch / PR /
  tag / image / SBOM / attestation chain.
- **Operations.** Prometheus `/metrics`, optional OTLP traces, SLO rules and an
  error-budget report, operational alerts with cooldown, webhook delivery and
  replay, GitHub API budget, backup/restore drill, deployment drift and a
  previous-release migration fixture.
- **UI.** The flight-deck visual system, owner (`/dashboard`) and operator
  (`/console`) surfaces, the loop rail and one next action, bilingual copy, a
  design-token layer, the visual/a11y geometry matrix, and the repository
  rules/skills and gate-plan surfaces.
- **Public API v1.** `GET /api/v1/jobs` with a `jobs:read` `flg_` token, a
  stable cursor, and the three documented refusals.

### Verified

- `ci-ok` is green on `main` at the `v0.5.0` release commit.
- `node scripts/verify-release.mjs --version 0.5.0` reports
  `release-status: ok` for the plan, branch, pull request, annotated tag, image,
  SBOM and provenance.
- The image is `ghcr.io/hugoxk/fledge:v0.5.0` at
  `sha256:d0fe98d6cbaf735a8c2e759f727a0ec75419784461b8c715de17ad48ed6ed7a8`.
- The suite is 3,300+ tests with the coverage floor recorded in `package.json`.
- A local macOS `npm test` has nine known host/tool failures (`deployAutomation`,
  `gateBaseTree`, `nginxCheck`, `securityHeaders`); the same nine fail on an
  untouched `v0.5.0` tree. CI on Ubuntu is green.

### Not done / open

- **#1246** — the architecture-boundary gate is implemented and green on every
  code check; it is a T3 tip and needs a PASS from `HugoXK-bot` at its head
  before it can merge.
- **v0.5.x foundation series** — #1224–#1236: Store/route/view/job seams, the
  architecture gate, the dialect port, lease/query/maintenance visibility, an
  audit hash chain, a release fault matrix, an incident bundle and a rotation
  drill.
- **v0.6 owner loop and openness** — #1237–#1243: command palette, cross-device
  preferences, i18n/a11y gates, `SourceProvider` and `AgentRunner` ports, and
  the OpenAPI 3.1 contract.
- **Still open elsewhere** — #387 (Postgres, worker pool, distributed leases),
  #651 (a second independent identity for T3), #863 / #879 / #885 (check-name
  shadowing, release-tag rule, commit signing and secret-scanning patterns),
  #105 (shared repository members beyond slice 1), #654 (product soul and
  feature admission test), #547 (owner-surface direction).
- **0.5.0 was an owner-authorized exception.** The nightly planner's feature
  threshold was not met (12 merged PRs and 1 feature against 5). The exception
  is recorded in #1245; the next release follows the normal rule again.

## Architecture in one screen

```
Browser ──cookie──► Fastify (src/app.ts)
                       ├─ SQLite (src/db.ts)        users/repos/jobs/quota/audit
                       ├─ GitHub API (src/repos/)   validate tokens, PRs
                       ├─ SMTP (src/email/)         operator SMTP
                       ├─ /v1/* (src/gateway/)      per-user quota + own model
                       └─ jobs (src/jobs/) ──► FlyBot bridge ──► FlyBot agent
```

The platform never runs a user repository. The bridge gives the agent a scoped
GitHub token URL and a job-scoped model token; the agent opens a PR and calls
back. See [architecture.md](architecture.md) and [api.md](api.md).

## Open work (ordered)

1. **Review #1246** at its tip. A `HugoXK-bot` PASS is the only thing missing;
   the author of the tip may not PASS it.
2. **Wave 0 of v0.5.x** — #1235 (release fault matrix), #1239 (i18n gate),
   #1240 (axe on the visual matrix).
3. **Wave 1** — #1224–#1227 (structure), #1229–#1232 (durability and scale),
   #1233–#1236 (trust and release).
4. **v0.6** — #1237–#1243, after **#654** and **#547** are decided.
5. **v1.0** — #387, a second source provider and runtime, a second T3 identity,
   merge queue and signing, audit retention, external review.

## Decisions to keep

- Name: **Fledge / 羽巢**; tagline “hosted repositories that grow themselves”.
  See [decisions/0001](decisions/0001-name.md).
- 1 CNY is a configurable platform budget, not an invoice.
- The model gateway uses the platform key only for platform-funded calls; an
  own model bypasses the quota.
- The platform is single-tenant per instance in `v0.5`; SQLite is single-writer.
- The dev login is a local convenience and must never be enabled in production.
- Reviews are by tip SHA; a PASS without a real `Ran:` command is invalid.
- Reviewer work is hosted by `HugoXK-bot`; the owner `HugoXK` keeps merge
  authority, and the review policy is read from the base branch.
- One PR per issue; never a duplicate.
- A release is the mechanical set (`CHANGELOG.md`, `README.md`,
  `README.zh.md`, `changelog.d/`, `package.json`, `package-lock.json`,
  `docker-compose.yml`) and the tag follows the merge through the tag job.
- The nightly cadence and its release rule live in `docs/autonomous-dev.md` and
  `daily-release.yml`; an owner-authorized release outside the rule is recorded
  in its PR.

## Environment map (operator-only)

The deployment env is not in git. It contains the OAuth client secret, the
session/encryption secrets, the SMTP password, the platform model key and the
bridge token. The private `SESSION_HANDOFF.md` says where each one lives and how
to rotate it. Never paste those values into a public issue, PR, test fixture or
log.
