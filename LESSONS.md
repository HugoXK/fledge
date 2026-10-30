# LESSONS.md

Dated, short lessons from real Fledge work. Read this **before coding**. Treat
every open lesson as a hard constraint until it is promoted or retired.

## How to use this file

1. Before a change, skim every open lesson.
2. When something bites again, add or bump the lesson the same day. Date it
   (`YYYY-MM-DD`). Trigger → wrong move → right move, a few lines.
3. `Seen N×`: the first write-up is `Seen 1×`; each recurrence increments it.
4. After the lesson has stayed true for **at least 3 days**, promote the durable
   rule into [docs/code-standards.md](docs/code-standards.md) (and
   [CONTRIBUTING.md](CONTRIBUTING.md) if humans need a pointer). Leave a
   `Promoted → …` stub or delete it once the standard covers it.
5. Security lessons stay hot until the matching test and standard land.

## Open lessons

### 2026-10-29 — `node:sqlite` is experimental and version-bound

- **Seen:** 1× (initial build)
- **Trigger:** importing `node:sqlite`, or running the app on Node 18/20.
- **Wrong:** assuming the built-in module exists on whatever Node is on `PATH`;
  shipping a `dist/src/index.js` path that the package scripts did not use.
- **Right:** require Node **22.9+**, keep the CI matrix on 22 and 24, build with
  `tsconfig.build.json` so the entry is `dist/index.js`, and use `node:sqlite`
  through one wrapper (`src/db.ts`) so a future move to a native driver is local.
- **Promote path:** after ≥3 days → code-standards (runtime and build).

### 2026-10-29 — Product URLs must come from `BASE_URL`

- **Seen:** 1× (approval and quota emails)
- **Trigger:** an email template or a redirect needs an absolute URL.
- **Wrong:** hardcoding `https://fledge.dev` (or a localhost URL) in a template;
  the link works in one environment and breaks in the other.
- **Right:** pass `config.baseUrl` into every template and redirect; the only
  hardcoded URL is the GitHub API root. Tests assert the configured origin.
- **Promote path:** after ≥3 days → code-standards (configuration).

### 2026-10-29 — The development login must fail closed

- **Seen:** 1× (local demo)
- **Trigger:** adding a no-OAuth login to make local demos easy.
- **Wrong:** a route that stays enabled when `NODE_ENV=production`; one copied
  `.env` becomes an authentication bypass.
- **Right:** `DEV_LOGIN_LOGIN` is empty in production and the app **refuses to
  start** if it is set; the route is 404 in production; tests cover both.
- **Promote path:** after ≥3 days → code-standards (authentication).

### 2026-10-29 — Approval mail is a notification, not the record

- **Seen:** 1× (SMTP can fail)
- **Trigger:** a pending user is created and the approval email cannot be sent.
- **Wrong:** failing the login, or making the email the only way to approve.
- **Right:** create the pending user, log a redacted error, keep the Admin panel
  as the fallback, and tell the user the application exists. A resend is
  rate-limited to once per 24 h.
- **Promote path:** after ≥3 days → code-standards (authentication).

### 2026-10-29 — The cost header wins; token estimates are a fallback

- **Seen:** 1× (quota gateway)
- **Trigger:** deducting platform quota after a model call.
- **Wrong:** always estimating from `usage.total_tokens`; discounts, retries and
  cached tokens make the estimate drift from the gateway charge.
- **Right:** use `x-litellm-response-cost` when present (USD), otherwise
  `PLATFORM_LLM_PRICE_PER_TOKEN` × tokens. Record a `quota_ledger` row for every
  platform-funded call and never deduct on a provider error.
- **Promote path:** after ≥3 days → code-standards (quota).

### 2026-10-29 — The npm mirror can lag; use npmjs for a fresh install

- **Seen:** 1× (server staging)
- **Trigger:** `npm ci` on a host configured with a regional mirror.
- **Wrong:** treating a 404 for a new package version as a bad lockfile.
- **Right:** retry with `--registry=https://registry.npmjs.org` (or pin the
  registry in the deploy runbook); verify `node_modules/typescript/bin/tsc` and
  the build before starting the service.
- **Promote path:** after ≥3 days → docs/deploy.md.

### 2026-10-29 — A commit uploaded through the GitHub API has a different SHA

- **Seen:** 1× (bootstrap)
- **Trigger:** bootstrapping `HugoXK/fledge` through the Git Data API because the
  local network cannot reach `github.com:443`.
- **Wrong:** assuming the local commit and the remote commit are the same object;
  the trees match, the commit timestamps do not, so `git status` looks odd and a
  later push is non-fast-forward.
- **Right:** fetch the canonical branch (mirror or `git fetch origin`) before the
  next edit, or rebuild the local commit from the remote tree; never force-push a
  public branch to hide the difference.
- **Promote path:** after ≥3 days → code-standards (workflow).

### 2026-10-29 — A tip SHA is the unit of review

- **Seen:** 1×
- **Trigger:** reporting or reviewing a PR.
- **Wrong:** citing an earlier green run, or a PASS on a previous commit.
- **Right:** name `git rev-parse HEAD`; run the gates at that tip; any new commit
  voids the PASS. The author's “tested” is narrative, not evidence.
- **Promote path:** after ≥3 days → code-standards (Verifier honesty).
