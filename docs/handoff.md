# Handoff — Fledge v0.1.0

Status: **v0.1.0 is live at `fledge.hugoxk.online` (GitHub token login; OAuth App pending); docs are live; CI green.**
Last updated: 2026-10-30.

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
- **Release:** <https://github.com/HugoXK/fledge/releases/tag/v0.1.0>
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
- Multiple repositories per user; per-repo fine-grained GitHub tokens, validated
  on add and encrypted with AES-256-GCM.
- Upstream/fork onboarding: Fledge detects or creates the user's fork, pushes
  work to the fork, and targets issues/PRs at the upstream. If the user owns the
  upstream, work stays in that repository.
- Reviewer role for upstream maintainers/write members: scheduled review jobs
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

- `npm run check`: lint, typecheck, 7 tests, production build — green.
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
- Real SMTP delivery (the server env is wired to the operator SMTP account; no test mail
  has been sent).
- A real FlyBot bridge job (needs a dedicated FlyBot session and bridge token;
  the service runs `RUNNER_MODE=mock`).
- Docker image build on a host with Docker (CI builds the image in the `docker`
  job).
- Branch protection, required checks and a merge queue on GitHub.

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
2. **FlyBot bridge**: run `bridge/flybot-bridge.mjs` on the FlyBot host with a
   dedicated “Fledge Runner” chat session and a strong `BRIDGE_TOKEN`; set
   `RUNNER_MODE=flybot` in Fledge.
4. **First real job**: add a small test repo, run one job, verify the PR, the
   callback, the job token revocation and the quota ledger.
5. **Branch protection**: require `ci-ok` (and later `review-gate`), require a
   pull request and conversation resolution, enable a merge queue on `main`.
6. **Review gate as a required check**: finish `scripts/review-gate.mjs` for the
   `merge_group` event and enable it on `main`.
7. **Homepage + guide**: live at `hugoxk.online/fledge/` and
   `hugoxk.online/fledge/guide/` (English under `/en/`); keep them in step with
   the product.
8. **Operational hardening**: log rotation, alert on repeated job failures,
   backup restore drill, quota notice dedupe, admin token rotation.
9. **Next product slice**: GitHub App installation (instead of a personal
   token), PR feedback loop (red CI/review comment → follow-up job), per-repo
   budgets, team roles.

## Decisions to keep

- Name: **Fledge / 羽巢**; tagline “hosted repositories that grow themselves”.
  See [decisions/0001-name.md](decisions/0001-name.md).
- 1 CNY is a configurable platform budget, not an invoice.
- The model gateway uses the platform key only for platform-funded calls; an
  own model bypasses the quota.
- The platform is single-tenant per instance in v0.1; SQLite is single-writer.
- The dev login is a local convenience and must never be enabled in production.
- Reviews are by tip SHA; a PASS without a `Ran:` command is invalid.
- One PR per issue; never a duplicate.

## Environment map (operator-only)

The deployment env is not in git. It contains the OAuth client secret, the
session/encryption secrets, the SMTP password, the platform model key and the
bridge token. The private `SESSION_HANDOFF.md` says where each one lives and how
to rotate it. Never paste those values into a public issue, PR, test fixture or
log.
