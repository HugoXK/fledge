# Fledge · 羽巢

**Hosted repositories that grow themselves.**

Fledge is a small, self-hosted platform where a developer connects several GitHub
repositories once, and a FlyBot agent keeps iterating on them: it reads the code,
writes a failing test, implements the smallest correct fix and opens a pull
request a human can review. Nothing is pushed to the default branch and nothing
is merged automatically.

[中文说明](README.zh.md) · [Architecture](docs/architecture.md) · [Deploy](docs/deploy.md) · [Security](docs/security.md) · [Roadmap](docs/roadmap.md)

---

## Why this name

A fledgling is a young bird that has grown its flight feathers. Fledge is the
moment it leaves the nest, not because it was pushed, but because it is ready.
That is the product promise for a repository: it stays in your account, under
your review, and gradually learns to produce its own improvements.

See [docs/decisions/0001-name.md](docs/decisions/0001-name.md) for the shortlist
and the reasoning.

## What it does

- **GitHub login** with an approval gate. The first login creates a pending
  application and emails the administrator (`flybot@yeah.net` →
  `hugo2001xk@gmail.com`). The administrator approves from the email link or the
  Admin panel.
- **Multiple repositories per user.** Each repository has its own goal, cadence
  (manual / hourly / daily / weekly) and status.
- **Bring your own token.** A fine-grained GitHub token is validated against the
  repository, encrypted with AES-256-GCM and only decrypted for a running job.
- **FlyBot-backed iteration.** The platform creates a job, gives the FlyBot
  bridge a scoped credential URL and a job-scoped model token, and waits for a
  signed callback with the branch and PR URL.
- **1 CNY of platform model quota per user.** Platform-funded calls go through
  Fledge's OpenAI-compatible gateway, which meters real cost and returns a
  structured `quota_exhausted` error when the quota is gone.
- **Bring your own model.** After the platform quota is used up, a user can point
  Fledge at any OpenAI-compatible service (Base URL / Key / Model). Jobs keep
  running on their own key, and Fledge stops metering.
- **Reviewable by construction.** One focused PR per job, no force-push, no
  merge, an audit log for every state-changing action.

## Architecture

```
Browser ──cookie session──► Fledge (Fastify + SQLite)
                              │
                              ├─ GitHub API (OAuth, repo validation, PRs)
                              ├─ SMTP (flybot@yeah.net → admin)
                              ├─ /v1/chat/completions  ──► model router ──► provider
                              │        (per-user quota, cost headers)
                              └─ job queue ──► FlyBot bridge ──► FlyBot agent
                                                   │
                                                   └─ GET credential (scoped)
                                                      POST callback (scoped)
```

The platform never runs a shell on a user repository. The FlyBot agent does the
work in its own workspace; Fledge only orchestrates, meters and records.

## Quick start

Requirements: Node 22.9+ (for `node:sqlite`), npm 10+.

```sh
npm ci
cp .env.example .env

# Generate the two secrets:
node -e "console.log('SESSION_SECRET='+require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log('TOKEN_ENCRYPTION_KEY='+require('crypto').randomBytes(32).toString('base64'))"

npm run dev
# http://localhost:8080
```

Set `ADMIN_GITHUB_LOGIN=HugoXK` (or your login). The administrator is approved
automatically on first login; everyone else is pending until approved.

For a local demo without GitHub OAuth, leave `DEV_LOGIN_LOGIN=dev` in `.env`
and open <http://localhost:8080/auth/dev>. This creates an approved local admin
and is refused when `NODE_ENV=production`. With GitHub OAuth configured, sign in
normally; a pending application can be inspected with `npm run mail:outbox`.

### GitHub OAuth app

Create an OAuth app at <https://github.com/settings/developers>:

- Homepage: `http://localhost:8080` (or your public URL)
- Callback: `http://localhost:8080/auth/github/callback`

Put the client id/secret in `.env`. The default scope is
`read:user user:email repo`; users still supply a per-repository fine-grained
token when they add a repo.

### FlyBot bridge

`RUNNER_MODE=mock` (default) simulates a job without touching a repository.
For real iteration, run the bridge on the FlyBot host:

```sh
BRIDGE_TOKEN=... FLYBOT_CHAT_SESSION_ID=session-... node bridge/flybot-bridge.mjs
```

Then set `RUNNER_MODE=flybot` and `FLYBOT_BRIDGE_URL` / `FLYBOT_BRIDGE_TOKEN` in
Fledge. See [bridge/README.md](bridge/README.md) and
[docs/architecture.md](docs/architecture.md).

## Quota model

- New users start with **1 CNY** (`INITIAL_QUOTA_CNY`).
- Cost is read from `x-litellm-response-cost` in USD, or estimated from token
  usage at `PLATFORM_LLM_PRICE_PER_TOKEN`.
- CNY remaining = `quota_cny - used_usd * USD_CNY_RATE`.
- At zero the gateway returns HTTP 402 with
  `code: FLEDGE_QUOTA_EXHAUSTED` and a link to `Settings → Model`.
- If the user has configured their own model, the gateway proxies to it and does
  not touch the platform quota.

Details: [docs/quota.md](docs/quota.md).

## Development

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run check        # lint + typecheck + test + build
```

The tests use `node:test`, an in-memory SQLite database, fake GitHub and fake
model upstreams. No network is required.

## Deployment

Docker is the shortest path:

```sh
cp .env.example .env
# fill the secrets, OAuth app, SMTP and model settings
docker compose up -d --build
```

Or run `npm ci && npm run build && npm start` behind nginx. The data directory
contains SQLite plus the development mail outbox; back it up with
`npm run db:backup`. See [docs/deploy.md](docs/deploy.md).

## Security

- GitHub tokens and user model keys are encrypted at rest (AES-256-GCM).
- Sessions are HttpOnly, SameSite=Lax cookies; CSRF tokens protect every form.
- Approval links are single-use, signed implicitly by a 32-byte random token and
  expire after 7 days.
- Model base URLs are checked against private address ranges (SSRF guard), and
  public endpoints must use HTTPS.
- Secrets are redacted from logs; the platform never renders a stored token back.
- The gateway is scoped by `flg_` tokens and meters each user independently.

Report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

## Status

`v0.1.0` is the first working slice: login, approval mail, multi-repo onboarding,
encrypted tokens, mock/FlyBot runners, quota gateway, own-model fallback, admin
panel, audit log, Docker and tests. The roadmap covers GitHub App auth, per-repo
budgets, team roles and a worker pool.

## License

Apache-2.0. See [LICENSE](LICENSE).
