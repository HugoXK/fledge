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
| Team GitHub PAT | git push, `gh`, and branch/PR writes for the maintenance Bots; those writes start workflows, unlike `GITHUB_TOKEN` | `~/.dsh/bot/secrets.json` (0600) | classic `repo`; revoke everything else | owner | pending (#59) | `node scripts/rotate-github-token.mjs --token-file <0600 file>` | old value `GET /user` → 401 and new value → 200 in the same run (see `docs/security.md`) | unknown |
| `SESSION_SECRET` | signs session cookies | production `.env` | 32 random bytes, base64 | owner | unknown | `openssl rand -base64 32` then restart | sign in, then `curl -I` the console and confirm the session survives a restart | unknown |
| `TOKEN_ENCRYPTION_KEY` | AES-256-GCM key for stored GitHub tokens and user model keys | production `.env`, backed up separately from the database | exactly 32 bytes, base64 | owner | unknown | `openssl rand -base64 32` then re-enter every stored token | `npm run dev` and load a page that reads a stored token | unknown |
| `TOKEN_ENCRYPTION_KEYS_FILE` | optional named keys for `v2` ciphertext, by key id | a `0600` JSON file outside the repository; only its path is in `.env` | `{ "<id>": "<base64 32 bytes>" }`, every entry exactly 32 bytes | owner | n/a | no command is shipped (#388): the owner adds a key, re-encrypts values and retires the old id by hand | start the app and read a stored token whose payload names that id | unknown |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app | production `.env` | OAuth app client secret | owner | unknown | mint a new client secret in the GitHub OAuth app, then replace and restart | complete one OAuth login | unknown |
| `SMTP_PASS` | approval and digest mail | production `.env` | provider's send-only SMTP credential | owner | unknown | mint a new SMTP credential at the provider | `npm run mail:outbox` on a development box, or one approval mail | unknown |
| `PLATFORM_LLM_KEY` | platform-funded model calls | production `.env` | one OpenAI-compatible key with a spend cap | owner | unknown | mint at the provider, then replace and restart | one platform-funded job reaches the gateway | unknown |
| `FLYBOT_BRIDGE_TOKEN` | shared secret on the optional global bridge | production `.env` and the bridge host | random 32 bytes | owner | unknown | `openssl rand -hex 32` in both places | one mock job round-trips a callback | unknown |
| `FLEDGE_LEAD_BRIDGE_TOKEN` | bearer token for the external Fledge Lead triage bridge | production `.env` and the bridge host | random 32 bytes | owner | unknown | `openssl rand -hex 32` in both places | one feedback packet reaches the configured Lead session | unknown |
| `GITHUB_APP_PRIVATE_KEY_PATH` | GitHub App authentication | file on the host, path in `.env` | App private key | owner | unknown | regenerate the key in the App settings and replace the file | install the App on a repository and list its repositories | unknown |
| `GITHUB_APP_WEBHOOK_SECRET` | verifies App webhooks | production `.env` | random 32 bytes | owner | unknown | `openssl rand -hex 32` in both the App and `.env` | redeliver one webhook and confirm it is accepted | unknown |
| `INBOUND_EMAIL_SECRET` | shared secret with the inbound Email Worker | production `.env` and the worker | random 32 bytes | owner | unknown | `openssl rand -hex 32` in both places | reply to one digest mail and confirm it lands | unknown |
| `METRICS_TOKEN` | `/metrics` outside loopback | production `.env` | random 32 bytes | owner | unknown | `openssl rand -hex 32` then restart | `curl -H "Authorization: Bearer …" /metrics` returns 200 | unknown |
| `RELEASE_DISPATCH_TOKEN` | superadmin one-click release workflow dispatch | production `.env` | repo-scoped token with `Actions: write` (dispatch) and `Contents: read`, `Checks: read`, `Pull requests: read` (preview) on `HugoXK/fledge` only; fine-grained preferred, and no contents/PR write is needed | owner | unknown | mint a repo-scoped token, replace it in the server `.env`, restart Fledge | the release preview is `ready` and a `workflow_dispatch` run appears on `main` | unknown |
| `NOTIFY_WEBHOOK_SECRET` | outbound notification webhook | production `.env` | random 32 bytes | owner | unknown | `openssl rand -hex 32` in both places | one event delivers with a valid signature | unknown |

## Key ids

A stored payload says which key encrypted it. `v1:<iv>:<tag>:<ciphertext>` is the
default-key format and still uses `TOKEN_ENCRYPTION_KEY`; `v2:<key id>:<iv>:<tag>:<ciphertext>`
names a key from `TOKEN_ENCRYPTION_KEYS_FILE`. A reader that does not know the id
fails closed with `unknown key id <id>` — it never retries with the default key,
because a payload that names a key is a claim about which key wrote it.

The file is read at startup and every entry is checked with the same 32-byte
rule as `TOKEN_ENCRYPTION_KEY`; an unreadable file, invalid JSON, or an entry
that is not exactly 32 bytes refuses to boot with the path (and the id) in the
message. `encryptSecret(plain, key)` with no id still writes `v1`, so the
existing call sites are unchanged.

This is the mechanism only. Nothing in Fledge re-encrypts an existing value,
deletes a key, or performs a rotation: adding a key to the file does not change
what is stored, and the owner decides when a value is rewritten under a new id.
The audit-log hash chain is a separate card and shares no code with this path.

## What is deliberately not in this table

- CI's `GITHUB_TOKEN`: minted per run, never stored, never rotated by hand. It is
  also the only credential of the daily release (`#80`): the branch push, the tag
  through the Git data API and the dispatch of `release.yml` all run with it, so
  the stored `RELEASE_TOKEN` that used to gate that workflow is gone.

  A branch pushed or a pull request opened with `GITHUB_TOKEN` starts no `push`
  or `pull_request` workflow; `workflow_dispatch` and `repository_dispatch` are
  the exceptions. Automation that pushes branches or opens PRs therefore uses a
  PAT or a GitHub App installation token, not this per-run token.
  `.github/workflows/ci-watchdog.yml` is the backstop: it dispatches `ci.yml` on a
  head branch whose pull request has no `CI` run at all at its head SHA — a check
  run from another workflow does not count — and no live `CI` run.

- Per-user OAuth tokens and per-repository fine-grained tokens: they live in the
  database encrypted with `TOKEN_ENCRYPTION_KEY` and are rotated by their owner
  through the UI, not on this host.
- The three token-shaped test fixtures (`test/crypto.test.ts:32`,
  `test/transcript.test.ts:52` and `test/transcript.test.ts:66`): they are fake,
  and they are whitelisted by exact file and line in
  `scripts/secret-scan-allowlist.json`. Three lines, not two: the transcript
  suite needs a token-shaped string both to carry in a user message and to prove
  the redaction removes it.
