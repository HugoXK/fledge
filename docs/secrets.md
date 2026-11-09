# Secrets inventory

Metadata only. **No value, and no partial value, belongs in this file** — the
real values live in the production `.env` on the host (owner-only, never in git)
and, for the team's GitHub token, in `~/.dsh/bot/secrets.json` (mode 0600,
outside every repository).

`npm run secret:scan` fails when a value-shaped string appears in a tracked file.
A fingerprint is the first 12 hex characters of the value's sha256, computed by
the owner at rotation time:

```sh
printf %s "$VALUE" | sha256sum | cut -c1-12
```

`unknown` means "never recorded", which is the honest state for every secret that
predates this inventory — it is not a value.

| Secret | Purpose | Storage | Minimum scope | Owner | Last rotated | Rotation command | Verification command | Fingerprint |
|---|---|---|---|---|---|---|---|---|
| Team GitHub PAT | git push and `gh` for the maintenance Bots | `~/.dsh/bot/secrets.json` (0600) | classic `repo`; revoke everything else | owner | pending (#59) | `node scripts/rotate-github-token.mjs` | old value `GET /user` → 401 and new value → 200 in the same run (see `docs/security.md`) | unknown |
| `SESSION_SECRET` | signs session cookies | production `.env` | 32 random bytes, base64 | owner | unknown | `openssl rand -base64 32` then restart | sign in, then `curl -I` the console and confirm the session survives a restart | unknown |
| `TOKEN_ENCRYPTION_KEY` | AES-256-GCM key for stored GitHub tokens and user model keys | production `.env`, backed up separately from the database | exactly 32 bytes, base64 | owner | unknown | `openssl rand -base64 32` then re-enter every stored token | `npm run dev` and load a page that reads a stored token | unknown |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app | production `.env` | OAuth app client secret | owner | unknown | mint a new client secret in the GitHub OAuth app, then replace and restart | complete one OAuth login | unknown |
| `SMTP_PASS` | approval and digest mail | production `.env` | provider's send-only SMTP credential | owner | unknown | mint a new SMTP credential at the provider | `npm run mail:outbox` on a development box, or one approval mail | unknown |
| `PLATFORM_LLM_KEY` | platform-funded model calls | production `.env` | one OpenAI-compatible key with a spend cap | owner | unknown | mint at the provider, then replace and restart | one platform-funded job reaches the gateway | unknown |
| `FLYBOT_BRIDGE_TOKEN` | shared secret on the optional global bridge | production `.env` and the bridge host | random 32 bytes | owner | unknown | `openssl rand -hex 32` in both places | one mock job round-trips a callback | unknown |
| `GITHUB_APP_PRIVATE_KEY_PATH` | GitHub App authentication | file on the host, path in `.env` | App private key | owner | unknown | regenerate the key in the App settings and replace the file | install the App on a repository and list its repositories | unknown |
| `GITHUB_APP_WEBHOOK_SECRET` | verifies App webhooks | production `.env` | random 32 bytes | owner | unknown | `openssl rand -hex 32` in both the App and `.env` | redeliver one webhook and confirm it is accepted | unknown |
| `INBOUND_EMAIL_SECRET` | shared secret with the inbound Email Worker | production `.env` and the worker | random 32 bytes | owner | unknown | `openssl rand -hex 32` in both places | reply to one digest mail and confirm it lands | unknown |
| `METRICS_TOKEN` | `/metrics` outside loopback | production `.env` | random 32 bytes | owner | unknown | `openssl rand -hex 32` then restart | `curl -H "Authorization: Bearer …" /metrics` returns 200 | unknown |
| `NOTIFY_WEBHOOK_SECRET` | outbound notification webhook | production `.env` | random 32 bytes | owner | unknown | `openssl rand -hex 32` in both places | one event delivers with a valid signature | unknown |
| `RELEASE_TOKEN` | the daily release pushes a branch and opens its PR so `pull_request` checks start | repository secret (GitHub settings) | fine-grained: contents write, pull requests write, actions write | owner | not created yet (#80) | mint a fine-grained PAT or App token, add it as the repository secret | one `workflow_dispatch` of `daily-release.yml` opens a PR that shows a real `ci-ok` | unknown |

## What is deliberately not in this table

- CI's `GITHUB_TOKEN`: minted per run, never stored, never rotated by hand.
- Per-user OAuth tokens and per-repository fine-grained tokens: they live in the
  database encrypted with `TOKEN_ENCRYPTION_KEY` and are rotated by their owner
  through the UI, not on this host.
- The two token-shaped test fixtures: they are fake, and they are whitelisted by
  exact file and line in `scripts/secret-scan-allowlist.json`.
