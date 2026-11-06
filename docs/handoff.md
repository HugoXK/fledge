# Handoff — Fledge v0.2.4

Status: **v0.2.4 is the latest release (`fledge.hugoxk.online`, GitHub token login; OAuth App pending); docs are live; CI green.**
Last updated: 2026-11-06.

This page is the public handoff for a new development session. The operator's
private handoff (server paths, env locations, non-public URLs) is not committed;
it lives next to the working copy as `SESSION_HANDOFF.md`.

## Start here

1. Read [AGENTS.md](../AGENTS.md), [LESSONS.md](../LESSONS.md),
   [docs/code-standards.md](code-standards.md) and
   [docs/autonomous-dev.md](autonomous-dev.md).
2. Run `npm ci && npm run check`.
3. `cp .env.example .env`, then `npm run dev` and open
   `http://localhost:8080/auth/dev` for a local admin (the dev login is refused
   when `NODE_ENV=production`).
4. Pick the next item from **Open work** and follow the pipeline.

## What exists

- **Repository:** <https://github.com/HugoXK/fledge>
- **Release:** <https://github.com/HugoXK/fledge/releases/tag/v0.2.4>
- **CI:** `ci.yml` (Node 22 + 24, lint, typecheck, tests, build, Docker, audit,
  changelog, risk), `codeql.yml`, `dependency-review.yml`, `release.yml`; the
  aggregate check is `ci-ok`.
- **Stack:** Node 22.9+, TypeScript, Fastify, `node:sqlite`, nodemailer,
  server-rendered HTML.
- **Service:** <https://fledge.hugoxk.online/> (live; token login until an OAuth
  App is connected).
- **Docs:** <https://fledge-docs.hugoxk.online/docs/> (mirror:
  <https://hugoxk.online/fledge/docs/>).
- **Project page / guide:** <https://hugoxk.online/fledge/>.

### Implemented

- GitHub login with an application gate: a new user signs the disclaimer and the
  information-security agreement once, submits, and sees a live queue/status
  page. The administrator receives a single-use approve/reject email from
  the configured administrator address (7 days). The login is OAuth when
  `GITHUB_CLIENT_ID` is configured; the token login is a bootstrap fallback.
- Bilingual Chinese/English UI with a persistent language switch shared with the
  rest of the platform, and a focused `/console` workspace for repositories,
  active jobs and quota. The shared Portal is a footer link, never a permission
  handoff.
- Admin panel, roles, audit log, in-app notifications.
- Team stage evidence gate (`off` / `shadow` / `enforced`), issue-label intake
  (`priority:*`, `agent-ready`), a deduped repeated-failure ops alert, and
  selective question-notification read.
- Model providers with multiple models, discovery, editing with re-test,
  per-bot model assignment, a mandatory platform connection test and a per-user
  private/HTTP permission.
- Repository lifecycle banner and danger zone, PR delivery with maintainer merge,
  issue commands and a live inbox SSE stream.
- Durable job events, personal and admin delivery metrics (7/30 days),
  cost by repository and model, alerts, a read-only `/api/read/metrics` JSON
  contract, a baseline shadow report (`npm run evolution:export -- --report`) and the first AgentDescent evolution ledger/ADR.
- Failed jobs show an actionable failure category and recovery link, with an
  admin failure breakdown for the window.
- Product/Test stage sessions, a Fledge-driven delivery chain, grounded team
  attribution, token backfill and managed instance-token rotation.
- Multiple repositories per user; per-repo fine-grained GitHub tokens, validated
  on add and encrypted with AES-256-GCM.
- Upstream/fork onboarding: Fledge detects or creates the user's fork, pushes
  work to the fork, and targets issues/PRs at the upstream. If the user owns the
  upstream, work stays in that repository.
- Reviewer role for repository maintainers with GitHub admin/maintain permission: scheduled review jobs
  list all open upstream PRs, score them, and post COMMENT reviews without
  merging.
- Repo goals, manual/hourly/daily/weekly cadence, enabled flag.
- Job lifecycle (`queued → running → succeeded|failed|quota_exhausted`), a mock
  runner and a signed FlyBot bridge contract (credential URL + callback).
- OpenAI-compatible model gateway with a per-user **1 CNY** quota, real cost
  headers, a `quota_ledger`, a 402 `FLEDGE_QUOTA_EXHAUSTED` response, and an
  own-model fallback with a 1-token connection test.
- SSRF guard for user model URLs, CSRF, rate limits, security headers, redacted
  logs.
- Dockerfile, docker-compose, systemd/nginx samples, online SQLite backup,
  deployment/security/quota/API docs, tests and issue/PR templates.

### Verified

- `npm run check`: lint, typecheck, 161 tests, production build — green.
- `npm run check`: lint, typecheck, 161 tests, production build — green.
- GitHub Actions: Node 22 and Node 24 green at the release commit.
- A real platform-funded call with the alternate key returned 200 and deducted
  `$0.00001064` from the dev account's quota.
- The quota 402, own-model bypass, approval links and repo/job flow are covered
  by tests.
- Production startup fails closed when the OAuth app or the two secrets are
  missing.

### Not yet verified / not done

- Real GitHub OAuth login (the service currently uses the token login fallback;
  create an OAuth App, set `ALLOW_TOKEN_LOGIN_ONLY=false`, and add the client
  id/secret).
- Real SMTP delivery (the server env is wired to the operator SMTP account; no
  test mail has been sent).
- The leaked GitHub development PAT still needs owner rotation; managed bridge
  and instance tokens are rotated by `scripts/rotate-instance-tokens.mjs`.
- A merge queue is not available through this repository's API plan, so
  branch-protection checks plus auto-merge are used.

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

1. **GitHub OAuth App** for `https://fledge.hugoxk.online/auth/github/callback`;
   put the client id/secret in the deployment env and set
   `ALLOW_TOKEN_LOGIN_ONLY=false`. The service is already live on the token
   fallback.
2. **Operational hardening**: repeated-failure alerts, stall detection, the
   credential circuit breaker and managed token rotation are done; still needed
   are log rotation, a backup restore drill and admin token rotation. The leaked
   GitHub development PAT must be rotated by the owner with
   `NEW_GITHUB_TOKEN=... node scripts/rotate-github-token.mjs`.
3. **Next product slice**: shared repository members (design in
   [decisions/0002](decisions/0002-shared-repo-members.md)), native DSH message
   streaming and deeper stage orchestration.
4. **Homepage + guide**: live at `hugoxk.online/fledge/` and
   `hugoxk.online/fledge/guide/` (English under `/en/`); keep them in step with
   the product.

## Decisions to keep

- Name: **Fledge / 羽巢**; tagline “hosted repositories that grow themselves”.
  See [decisions/0001-name.md](decisions/0001-name.md).
- 1 CNY is a configurable platform budget, not an invoice.
- The model gateway uses the platform key only for platform-funded calls; an
  own model bypasses the quota.
- The platform is single-tenant per instance in v0.1; SQLite is single-writer.
- The dev login is a local convenience and must never be enabled in production.
- Reviews are by tip SHA; a PASS without a `Ran:` command is invalid.
- Reviewer work is hosted by `HugoXK-bot` (`hugo2001xk@gmail.com`); the owner
  `HugoXK` keeps merge authority, the bot gets a required PASS and write access,
  and the review policy is read from the base branch.
- One PR per issue; never a duplicate.

## Environment map (operator-only)

The deployment env is not in git. It contains the OAuth client secret, the
session/encryption secrets, the SMTP password, the platform model key and the
bridge token. The private `SESSION_HANDOFF.md` says where each one lives and how
to rotate it. Never paste those values into a public issue, PR, test fixture or
log.
