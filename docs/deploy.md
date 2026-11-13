# Deploy

## Requirements

- Node 22.9+ (the app uses the built-in `node:sqlite`).
- A public HTTPS URL (GitHub OAuth callback, cookies, email links).
- A GitHub OAuth App.
- An operator SMTP account (or set `MAIL_TRANSPORT=console` for a private demo).
- A model endpoint (OpenAI-compatible) and a platform key.
- Optional: the FlyBot bridge on a machine that runs FlyBot.

## 1. Environment

```sh
cp .env.example .env
chmod 600 .env
```

Generate the two secrets:

```sh
node -e "console.log('SESSION_SECRET='+require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log('TOKEN_ENCRYPTION_KEY='+require('crypto').randomBytes(32).toString('base64'))"
```

Key settings:

| Variable | Meaning |
|---|---|
| `BASE_URL` | Public origin, no trailing slash |
| `SESSION_SECRET` | >= 32 chars, signs CSRF and session-derived values |
| `TOKEN_ENCRYPTION_KEY` | 32 bytes base64, encrypts GitHub/model keys |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | OAuth App |
| `ADMIN_GITHUB_LOGIN` | Auto-approved bootstrap super admin; set your own GitHub login (no default) |
| `MAIL_TRANSPORT` | `smtp` in production, `console` for a local demo |
| `SMTP_HOST/PORT/SECURE/USER/PASS` | For yeah.net: `smtp.yeah.net`, 465, secure |
| `MAIL_FROM` / `ADMIN_EMAIL` | `fledge@hugoxk.online` / `admin@example.com` |
| `PLATFORM_LLM_BASE_URL` | OpenAI-compatible `/v1` endpoint |
| `PLATFORM_LLM_KEY` | Platform key; never commit it |
| `INITIAL_QUOTA_CNY` | Default 1 |
| `USD_CNY_RATE` | Default 7.2 |
| `RUNNER_MODE` | `mock` or `flybot` |
| `JOB_TIMEOUT_MINUTES` / `JOB_STALL_MINUTES` | Hard timeout (default 90) and no-heartbeat stall timeout (default 30) |
| `FLYBOT_BRIDGE_URL` / `FLYBOT_BRIDGE_TOKEN` | Bridge endpoint and shared secret |
| `DATA_DIR` / `DB_PATH` | Defaults `./data`, `./data/fledge.db` |
| `BACKUP_ENCRYPTION_KEY` | Optional backup key: base64 32 bytes, or any other value treated as a passphrase and stretched with scrypt. Environment only, never argv or git |
| `BACKUP_ENCRYPTION_KEY_FILE` | Optional 0600 file holding the same key value; set exactly one of this and `BACKUP_ENCRYPTION_KEY` |
| `BACKUP_ENCRYPTION_REQUIRED` | `true` makes `npm run db:backup` refuse to run without a key; default `false` keeps plaintext backups |
| `ALLOW_PRIVATE_MODEL_URLS` | Keep `false` for untrusted users |
| `PAT_EXPIRY_DAYS` | Default lifetime of a new personal `flg_` gateway token, in days (default 90); only an admin may create one without an expiry |
| `METRICS_TOKEN` | Required in production: `/metrics`, and the `commit`/`builtAt` fields of `/healthz`, answer only `Authorization: Bearer <token>` |
| `RECENT_AUTH_MINUTES` | How many minutes a destructive action's GitHub re-authentication counts for (default 15, minimum 1). Raising it asks users to re-authenticate less often, lowering it more. It sets the window only: the ceiling on those routes is a code constant, described in `docs/security.md` |
| `PLAN_EXPIRY_DAYS` / `PLAN_REMINDER_DAYS` | How long an unapproved plan may wait before the work item closes with `closed_reason = plan_expired` (default 7), and how many days before that deadline the single reminder is sent (default 2). They are one deadline pair: `PLAN_REMINDER_DAYS` must be smaller than `PLAN_EXPIRY_DAYS`, and Fledge refuses to start with both names in the message otherwise, because a reminder at or after the deadline is sent immediately |
| `LIMIT_REPOS_PER_USER` | How many repositories one user may connect (default 10; `0` means no ceiling). Admins and superadmins are exempt, and lowering it never touches repositories that already exist — only new adds are refused. A bulk add from a GitHub App installation counts each selected repository once and may fill the last free slots exactly; a selection with nothing new to add is not refused |
| `LIMIT_INSTANCES_PER_USER` / `LIMIT_INSTANCES_GLOBAL` | How many running FlyBot instances one user may have (default 3), and an optional ceiling across the whole deployment (default `0`, off). Only an instance that occupies a slot counts (`starting`, `provisioning` or `ready`): a stopped instance does not, so a user at the cap can restart their own. Both the explicit provision and the two repository-add paths consult it, and a refusal carries `INSTANCE_LIMIT`, names the ceiling that refused, and leaves no container, port or half-added repository behind. The check runs per request, not inside a transaction, so two concurrent adds one below the cap can both pass |
| `NOTIFY_WEBHOOK_URL` / `NOTIFY_WEBHOOK_SECRET` | Optional outbound notifications (Slack-compatible `text`); the secret is sent as a bearer token. When set, the URL must be an absolute `https:` URL |

Production startup fails closed if the session/encryption keys, OAuth app,
SMTP password or `METRICS_TOKEN` are missing, or if `NOTIFY_WEBHOOK_URL` is set
to anything but an absolute `https:` URL — a plain-`http` webhook would send the
alert payload and its bearer secret in cleartext. That refusal lands in
`buildApp()`, which `src/index.ts` calls unguarded, so the process exits instead
of listening with an unauthenticated `/metrics`. `loadConfig()` deliberately
does not assert: the operator scripts (`rotate-instance-tokens`, `set-role`,
`mail-probe`) read it and must keep working while a secret is being repaired.

## 2. GitHub OAuth App

<https://github.com/settings/developers> → New OAuth App:

- Homepage URL: `${BASE_URL}`
- Authorization callback URL: `${BASE_URL}/auth/github/callback`

Scopes requested: `read:user user:email`. Users still supply a fine-grained
token per repository; OAuth only confirms identity.

If the OAuth App is not ready, leave `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`
empty and set `ALLOW_TOKEN_LOGIN_ONLY=true`. The landing page then offers a
**GitHub token login** that uses `GET /user` only to confirm identity and never
stores the token. Configure OAuth before a public launch.

### Rotate managed instance tokens

Fledge-managed bridge and per-instance gateway tokens can be rotated without
touching user data:

```sh
cd /home/xuke/work/fledge
node --env-file=.env scripts/rotate-instance-tokens.mjs --dry-run
node --env-file=.env scripts/rotate-instance-tokens.mjs
```

The script refuses while a job is active unless `--force` is passed. It updates
`bridge.env`, `repo_instances.bridge_token_enc` and the matching `api_tokens` row
and restarts each bridge. The GitHub PAT used by the development routine is not
managed by this script: create a new classic PAT with `repo` scope in GitHub
settings, run `NEW_GITHUB_TOKEN=... node scripts/rotate-github-token.mjs`, and
revoke the old token.

## 3. SMTP

Configure your operator SMTP account (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
`SMTP_PASS`) and set `MAIL_FROM` / `ADMIN_EMAIL` to the addresses you control.
For the hosted instance `MAIL_FROM=fledge@hugoxk.online`; job and digest
notifications use the same sender. The standalone FlyBot service on
`flybot.hugoxk.online` keeps `flybot@hugoxk.online`; they are separate projects.
Set `DIGEST_HOUR` (default 9) and `DIGEST_TIMEZONE` (default `Asia/Shanghai`) for
the daily summary. The GitHub App must be **public** for users other than its owner to install it:
GitHub → Settings → Developer settings → GitHub Apps → Fledge Platform →
Make public, with "Where can this app be installed?" set to **Any account**.
Fledge's login/approval still gates who can use the platform.

For email replies, set `INBOUND_EMAIL_SECRET` and route the `fledge@` mailbox to
a Cloudflare Email Worker (sample: `deploy/cloudflare-email-worker.js`) or an
equivalent inbound webhook. The worker must send the same secret in
`X-Fledge-Email-Secret` and preserve plus addressing
(`fledge+<token>@hugoxk.online`). The daily digest then adds a `Reply-To` header.

The agent workspace is served at `/repos/:id/workspace/`; it needs no wildcard
DNS or certificate. It proxies the per-repo DSH port over loopback, so keep that
port bound to loopback. When the bridge code changes, restart each per-repository
bridge (the Fledge service restart alone does not): `InstanceManager.restartBridge(repoId)`
stops the old bridge, starts the current `bridge/flybot-bridge.mjs` with the
same `bridge.env`, updates `bridge_pid` and waits for `/healthz`.
Use an app password if the provider requires one. The application sends:

- the application email to `ADMIN_EMAIL` with approve/reject links;
- an approval/rejection notice to the applicant;
- a quota-exhausted notice to the applicant.

Test without sending:

```sh
MAIL_TRANSPORT=console npm run dev
npm run mail:outbox
```

## 4. FlyBot bridge

On the FlyBot host:

```sh
cat > /etc/fledge-bridge.env <<'EOF'
BRIDGE_PORT=8787
BRIDGE_TOKEN=<random 32 bytes>
FLYBOT_CHAT_SESSION_ID=session-...   # the Bot chat that should take jobs
FLYBOT_WEB=http://127.0.0.1:3080
FLYBOT_LOG=/home/xuke/work/dsh-web.log
EOF
chmod 600 /etc/fledge-bridge.env
node /path/to/fledge/bridge/flybot-bridge.mjs
```

The bridge listens on `127.0.0.1:8787` by default. Put it under systemd or a
one-minute watchdog. Fledge reaches it over a private network or an SSH tunnel;
never expose it publicly without TLS and a strong token.

Set `RUNNER_MODE=flybot`, `FLYBOT_BRIDGE_URL`, `FLYBOT_BRIDGE_TOKEN` in Fledge.

The agent prompt tells FlyBot to fetch the token from the credential URL, use
the job-scoped model token, open a PR and call back. It also asks for a
`{"status":"running","summary":"..."}` heartbeat after each major step and at
least every 10 minutes; heartbeats update the job summary but do not extend the
limit. The platform fails the job after `JOB_TIMEOUT_MINUTES` (default 90) if no
final callback arrives, and a final callback that arrives after that deadline is
rejected with 409 and is not retried by the bridge — the run counts as failed
even if the PR was good. Raising `JOB_TIMEOUT_MINUTES` widens that window for
long runs; lowering it makes that failure more likely, so change it together
with the agent's own time budget. `JOB_STALL_MINUTES` (default 30) is the
separate no-heartbeat stall sweep; a heartbeat moves only that one.

## 5. Run

### Docker

```sh
docker compose up -d --build
```

To make `/healthz` name the build, stamp it at build time so the image can carry
the commit: `GIT_SHA=$(git rev-parse HEAD) BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) docker compose build`.
Without the stamp the image answers `unknown` — honest, and useless for
identifying a deploy. The stamp is served only to an authorised caller: send
`Authorization: Bearer $METRICS_TOKEN` (or, in a development build with no token
configured, come from loopback). An unauthenticated `/healthz` still answers `200`
with `ok`/`service`/`version`/`time`, but carries neither `commit` nor `builtAt`.

Compose publishes the port on loopback, so nginx outside the container is the
caller and its address is this project's bridge gateway. Read that value from the
running project instead of copying an example:

```sh
docker network inspect <project>_default --format '{{(index .IPAM.Config 0).Gateway}}'
```

The project name defaults to the directory name (`docker compose ls` prints it).
Put the answer in `.env` as `TRUST_PROXY=<gateway>`, or add it to the existing
list, and restart. Compose allocates the next free `/16`, so the gateway is often
`172.18.0.1` or higher; the frequently copied `172.17.0.1` is docker0's gateway
and usually does not contain this peer. A hop that names the wrong address fails
closed: `proxy-addr` stops at the peer, every client looks like the gateway, and
the whole instance shares one rate-limit bucket (30/min on token, login, callback
and approve; 120/min across credential, callback, webhook, inbound and metrics).

The volume `fledge-data` holds the SQLite database and the console outbox.

The runtime stage also copies `CHANGELOG.md` and `changelog.d/` into `/app`
(`Dockerfile`, runtime stage). The console reads them for the footer version and
the `/admin` release card, which states the running version, the newest changelog
section and the pending fragment count. Keep both paths in the image: without
them those lines read "not available in this build" instead of answering.

### Verify what you pulled

A published image carries a build-provenance attestation signed by the release
workflow, stored in the registry beside its digest. Check the tag you are about
to run rather than trusting the tag name:

```sh
gh attestation verify oci://ghcr.io/hugoxk/fledge:v0.3.0 --repo HugoXK/fledge
```

The output names the workflow, the commit and the digest that was attested. If
the command fails, the image was built or pushed by something other than this
repository's release workflow — do not run it. `docker images --digests` shows
the digest the local tag resolved to, and it must be the one the verification
printed.

### Node

```sh
npm ci
npm run build
NODE_ENV=production npm start
```

Use a process supervisor (systemd, runit, pm2) and a single instance: SQLite is
not a multi-writer cluster.

### Daily release pull request

The version follows the weekly cadence: the first release of an ISO week (the
Monday 22:30 Asia/Shanghai run) bumps the minor (`0.3.4 -> 0.4.0`); every later
release in the same week bumps the patch (`0.4.0 -> 0.4.1`). The planner reads
the last tag's commit time and the workflow's run time; if either is unreadable
it falls back to the minor, which is the first-release behaviour.

A release that changes user-facing behaviour updates `README.md`,
`README.zh.md` and the relevant `docs/` page in the same pull request. The
documentation site builds from this repository's `README.md`, `README.zh.md` and
`docs/` rather than a pinned copy, so the release pull request and the docs site
stay in step.

The status line each README carries is checked against `package.json`:
`test/readmeStatus.test.ts` runs in `npm run check`, so `ci-ok` is red on a
release pull request that bumps the version without updating both status lines,
and the failure names the file and the line to edit. The two READMEs are part of
the mechanical release set, so the release routine writes those two lines itself
(`#348`, which supersedes the T1 boundary `#263` drew): only the version token and
the date move, the version is read back from the `package.json` the routine just
wrote, and any other hunk in either README keeps its review like any other file.
Before that, every release pull request was red by construction — `#347` was the
one that showed it. The reasoning is recorded in
[decisions/0011-mechanical-readme-status.md](decisions/0011-mechanical-readme-status.md).

The nightly workflow pushes `release/v<next>` and then opens exactly one release
pull request for it, because a pull request opened with `GITHUB_TOKEN` starts no
`pull_request` workflow and would never get a `ci-ok`.

The opener runs on the repository secret **`RELEASE_OPEN_TOKEN`** (Settings →
Secrets and variables → Actions). Set it to a token for the team account —
never the Reviewer's `HugoXK-bot` account — scoped to this repository alone, with
`Contents: read` and `Pull requests: write` — it does not need push, because the
workflow pushes `release/v<next>` before the opener runs. The opener reads
`GET /user` and
refuses a credential whose login is the review policy's `requiredPass`, so the
reviewer account cannot open the release pull request even if it were installed
by mistake. The token reaches the step through the environment only; it is never
an argument, an output or a log line.

A missing secret is a red precondition, not a reported night: the run fails
before the branch is pushed and names `RELEASE_OPEN_TOKEN`, and because nothing
was pushed it says nothing on #80. A refused opener — the branch at another
commit, `main` moved since the plan, a path outside the mechanical set, the
version or changelog check failing in the fetched tree — is a red run with the
reason in the job summary and on #80. Dry runs and nights that pushed nothing
never reach the write path.

A manual run is still possible and uses the same tool:

```sh
GITHUB_TOKEN=… node scripts/release-open.mjs --artifact release-plan.json --version <next> --sha <branch tip>
```

The tool re-runs `scripts/version.mjs check` and `scripts/changelog.mjs check`
against the branch's contents fetched through the API (never the branch's own
copies of those scripts), refuses when `main` moved since the plan or the diff
leaves `CHANGELOG.md`, `README.md`, `README.zh.md`, `changelog.d/`,
`docker-compose.yml`, `package-lock.json` and `package.json`, reuses an open pull
request at the same commit instead of
opening a second one, and prints the JSON it acted on. It writes that one pull
request and nothing else, and it carries no tag endpoint: the tag stays in the
workflow. A `POST /pulls` whose readback does not show
`maintainer_can_modify: true` is a refusal, but the pull request already exists
at that point, so close it by hand before retrying.

### Verify a release

The publish run records what it produced in the GitHub Release body — the image
reference with its digest, the SBOM artifact name and the attested digest — so
the chain can be read back through the API alone:

```sh
# the whole chain, from the plan to the running instance. METRICS_TOKEN is what
# lets the script read /healthz's commit, which is bearer-only (#236).
GITHUB_TOKEN=… METRICS_TOKEN=… node scripts/verify-release.mjs --version 0.3.2 --base-url https://fledge.hugoxk.online

# the same check, rendered on /admin for an operator without a token
GITHUB_TOKEN=… METRICS_TOKEN=… node scripts/verify-release.mjs --version 0.3.2 \
  --base-url https://fledge.hugoxk.online --write "${DATA_DIR}/release-status.json"
```

It exits `0` only when every link is present and agrees: the plan's base `main`
sha, the `release/v<version>` branch and tip, the merged release pull request,
the annotated tag object and the commit it targets, the image tag and digest,
the SBOM, the build-provenance attestation, the GitHub Release and — when
`--base-url` is given — the `/healthz` version and commit. A link that is
missing or disagrees prints one line and exits `1`; a fixture or token it cannot
read exits `2`, never `0`. It is read-only: no deploy, tag, merge or comment.
Without `--base-url` the running-instance link is reported as skipped, and a
release branch a merged release already deleted is skipped too — the pull
request head is then the record of the tip.

`--fixtures <file>` replays a recorded chain instead of reading the API, which is
how the test suite exercises the same code path.

## 6. Reverse proxy

Ready-to-copy samples live in [`deploy/`](../deploy/): a systemd unit and an nginx
server block. The nginx example:

```nginx
server {
  listen 443 ssl http2;
  server_name fledge.example.com;

  client_max_body_size 25m;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  # SSE for the model gateway
  location /v1/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 30m;
  }
}
```

The app trusts only the hops named in `TRUST_PROXY`, never every hop.
`$proxy_add_x_forwarded_for` appends `$remote_addr`, so the address nginx actually
saw is the rightmost `X-Forwarded-For` entry, and that is the value Fledge uses as
`request.ip`, as the input to the rate-limit bucket key and for the `/metrics`
loopback check. Everything to the left of it is caller-supplied and ignored, so a
client cannot mint a new bucket by rotating the header. Every limiter, including
the gateway's two, derives its key from that address through one helper: IPv4 is
exact and IPv6 keeps only its `/64` prefix, so rotating the low bits inside a
routed `/64` does not mint a fresh bucket either.

| Topology | `TRUST_PROXY` |
|---|---|
| nginx on the same host (the supported default shown above) | leave unset - defaults to `127.0.0.1,::1` |
| Docker Compose as published (bridge network, nginx outside the app container) | the project's bridge gateway, read from the running project with `docker network inspect <project>_default --format '{{(index .IPAM.Config 0).Gateway}}'` (see §5); or run the app with `network_mode: host` and keep the default |
| another proxy in front of nginx | that proxy's address or CIDR, added to the list |

The rule for every row is the same: **add the hop, do not loosen it.** A value
that is not an address or CIDR is refused at startup - `true`, `false`, `*`,
`all` and a `/0` range all fail with `TRUST_PROXY: ... is not a trusted hop`,
because each of them trusts the caller-supplied left end of the header. A
`TRUST_PROXY` that names the wrong hop fails closed: the real client address is
not seen, so clients behind that proxy share one rate-limit bucket until the hop
is corrected.

Set `BASE_URL=https://fledge.example.com` so cookies are `Secure` and email links
are absolute.

## 7. Backup and restore

```sh
npm run db:backup
# writes ${DATA_DIR}/backups/fledge-<ISO timestamp>.db via SQLite's online backup API
# set BACKUP_DIR to override; in Docker the default is /data/backups
# every copy is checked with PRAGMA integrity_check and pruned to BACKUP_KEEP
# (default 14) newest copies; a copy that fails the check is deleted and the run
# exits non-zero, so a failed backup never leaves a usable-looking file
# each copy gets a <copy>.json manifest: size, sha256, schema version and
# per-table row counts, written 0600 and deleted together with its copy
# plaintext is the default; with a backup key this writes fledge-<timestamp>.db.enc
# and the manifest records the ciphertext checksum plus the non-secret key id/version
# BACKUP_ENCRYPTION_REQUIRED=true refuses the run when no key is configured
```

### Backup encryption

Backups stay plaintext by default, so existing schedules keep working. Set one
of `BACKUP_ENCRYPTION_KEY` (inline) or `BACKUP_ENCRYPTION_KEY_FILE` (a path to a
`0600` file; a trailing newline is ignored) to encrypt every new copy:

```sh
# generate once, store it 0600 and outside the repository
openssl rand -base64 32 > /etc/fledge/backup.key
chmod 600 /etc/fledge/backup.key
BACKUP_ENCRYPTION_KEY_FILE=/etc/fledge/backup.key npm run db:backup
```

The key is read only from the environment or the key file: never pass it on the
command line, and never commit it. A value that is not a base64-encoded 32-byte
key is treated as a passphrase and stretched with scrypt using a random salt per
copy. The encrypted file is a JSON envelope header (format version, key id and
key version, scrypt salt when used, IV, GCM authentication tag) followed by the
ciphertext. The key itself is never in the envelope or the manifest. Set exactly
one key source; setting both is refused instead of guessing, and a source that is
present but empty — `BACKUP_ENCRYPTION_KEY=` from a secret that expanded to
`""`, or an empty key file — is refused with a non-zero exit naming that source,
rather than falling back to a plaintext copy.

The key id in the envelope and the manifest is a truncated sha256 of the key the
copy was encrypted with. For a base64 32-byte key that is the key itself; for a
passphrase it is the scrypt-stretched key, so it is per copy and recovering it
from a guess costs one scrypt, not one fast hash. It names which key a copy
needs without being a cheap oracle for passphrase guesses.

For production, require encryption so a misconfigured schedule cannot silently
write plaintext:

```sh
BACKUP_ENCRYPTION_REQUIRED=true BACKUP_ENCRYPTION_KEY_FILE=/etc/fledge/backup.key npm run db:backup
```

Required mode exits non-zero before creating the backup directory when no key is
configured. Copies written before the switch stay plaintext and remain
restorable; only new copies are encrypted.

**Key custody.** Keep the backup key separate from the copies: a different
machine or a different medium, readable only by the operator (`0600`). A copy
held with its key hands both halves to anyone who finds the disk. Rotation means
starting a new key and keeping the old one for as long as its copies are
retained; the manifest names the key id each copy needs (a per-copy id for a
passphrase, a stable id for a base64 key).

`/admin` shows what is in that directory, read-only: the newest copy with its
size and age, whether that copy's manifest still matches (size and `sha256`),
how many copies exist, and a warning when the newest copy is older than
`BACKUP_EXPECTED_HOURS` (default 26) — a night that stopped running leaves no
error anywhere, so the card can only show it as staleness. It never opens
`fledge.db`, and it carries no backup, restore or delete control; those stay
host commands. Hashing is bounded: the card hashes only the newest copy, and
only when that copy is at most 4 MiB, so a page render cannot stall on a large
dump; every older copy is compared by size only and reads `size matches, sha256
not checked (only the newest copy is hashed)`. Above the cap the newest row says
the `sha256` was not checked, which is not a pass — `npm run db:restore-drill` is
the command that verifies a large copy. The copies line counts only copies a
manifest contradicts and names the rest separately, so `0 copies · nothing to
check` is what an empty directory says. The
drill prints its verdict and records nothing, so the card says `none recorded`
rather than showing a green it cannot prove.

Back up `.env` separately (it contains the encryption key). Without
`TOKEN_ENCRYPTION_KEY`, stored GitHub/model tokens cannot be decrypted.

Keep the key and the dumps apart: a copy of `.env` on a different machine or a
different medium from the database copies. A dump alone cannot decrypt the
tokens it holds, and a key stored next to the dump hands both halves to anyone
who finds the disk. The backup directory is created `0700` and every copy is
written `0600`, so the dump is not readable by other accounts on the host either.

### Restore drill

Prove that the newest copy still restores, without touching the live database:

```sh
npm run db:restore-drill -- --db "$DB_PATH" --backup-dir "$BACKUP_DIR"
# encrypted copy: prefix with BACKUP_ENCRYPTION_KEY_FILE=/etc/fledge/backup.key
# manifest=/var/lib/fledge/backups/fledge-2026-11-06T09-44-53-448Z.db.json
# table=jobs expected=5000 actual=5000        one line per table: copy vs manifest
# schema_version expected=28 actual=28
# source_table=jobs source=5012 restored=5000   information: the live database moved on
# schema_drift=none                            or missing:<table> / extra:<table>
# source_drift=+12
# backup=/var/lib/fledge/backups/fledge-2026-11-06T09-44-53-448Z.db
# restored=/tmp/fledge-restore-drill-xxxx/restored.db
# RTO=0.385s
# RPO=0.002s
# restore-drill: OK
```

How it works and how to read it:

- It takes the newest `fledge-*.db` or `fledge-*.db.enc` in the backup
  directory (write a fresh copy first with `--fresh`; with a key configured that
  fresh copy is encrypted too). Nothing is created if a copy already exists, so
  the RPO you see is the age of your real backup schedule.
- **An encrypted copy is decrypted with the configured key before the database
  checks.** The `.db.enc` extension selects the encrypted path; the ciphertext is
  checked against the manifest first, then decrypted with
  `BACKUP_ENCRYPTION_KEY` or `BACKUP_ENCRYPTION_KEY_FILE` into
  `<work-dir>/restored.db`. AES-256-GCM authenticates the ciphertext, so a wrong
  key or an altered copy fails closed instead of producing a database. A missing
  key exits non-zero with a lost-key message and leaves no restore result: the
  copy cannot be recovered without the key, and the printed `key_id` (a
  fingerprint, never the key) names the key it needs. Plaintext copies keep
  restoring without a key.
- **The copy is judged against the file it is, not against the live database.**
  For a plaintext copy the restored file must be byte-for-byte the copy it came
  from; then, when that copy has a `<copy>.json` manifest (every copy
  `npm run db:backup` writes does), its size, `sha256`, `PRAGMA user_version` and
  per-table row counts must match the manifest, which is what catches a copy that
  was truncated or interrupted at backup time. A copy written before manifests
  existed still passes the byte comparison and prints `manifest=missing`, but
  only after it passes the same schema check as every other copy: a restore must
  hold the application tables `users`, `repos`, `jobs` and a positive `PRAGMA
  user_version`, so a copy that does not hold the application schema is refused —
  a 0-byte file compares equal to itself and `PRAGMA integrity_check` answers `ok`
  on it.
- **The live source is reported, never required to match or even to be
  readable.** Each shared table prints `source_table=<table> source=<n>
  restored=<n>`, `schema_drift` names a table the source has and the copy does
  not (or the reverse), and `source_drift` is the total difference. Writes — and
  deletes, so an older copy can legitimately hold more rows — since the copy was
  taken are normal: they are printed as information and never fail the drill.
  If the live database cannot be opened or read at all, the drill prints
  `schema_drift=unavailable` and `source_drift=unavailable` with the reason on
  stderr and still reports the restored copy. That is the case an operator
  restores *because* of, so it can never be the reason a good copy is refused.
- It refuses a `--backup-dir` or `--work-dir` that holds the source database,
  and exits non-zero — naming the file and the table — when the copy is corrupt
  or does not match its manifest. The source database is opened read-only and
  never written; a drill leaves its bytes unchanged.
- It refuses a `--work-dir` inside `DATA_DIR` (the live data directory), inside
  the source database's own directory, or one whose parent directory does not
  exist — `DATA_DIR` need not be exported for the source directory to be
  refused. Every one of those paths is resolved through symbolic links first, so
  a link that points into the live area is refused too. It never creates a missing parent and never creates a database at a
  path that was refused, so a typo cannot write into the live area. The work
  directory is `0700`, the restored copy `0600`.
- **A failed drill leaves no restore result.** The copy at
  `<work-dir>/restored.db` is renamed to `restored.db.failed` before the command
  exits non-zero, and a drill that used its own temp directory removes that
  directory entirely. Restoring from a `restored.db` left by a failed run is
  therefore impossible, and a temp drill does not leave a copy of production
  data in `/tmp`. Drift alone never triggers that rename, so a `restored.db` that
  is gone means the copy itself failed. Always check the exit status (or look for
  `restore-drill: OK`) before using the restored copy; every accepted copy holds
  the application schema — `users`, `repos`, `jobs` and a positive `PRAGMA
  user_version` — with or without a manifest, so `restore-drill: OK` never
  describes a copy that does not hold the application schema. A fresh instance
  with the schema and zero rows still restores.
- **RTO** is the measured restore-and-verify time: how long a real restore would
  take to produce a verified copy. **RPO** is the age of the copy that restored:
  how much data a real loss would cost. Record both after every drill.

### Restore drill log

Both numbers are specific to this host, this database size and this disk: a
larger database and a slower disk produce a larger RTO, and RPO only reflects how
fresh the newest copy is. Quote a row together with its "Data" column; never
present one as the platform's production RTO.

| Date | Environment | Data | RTO | RPO | Result |
|---|---|---|---|---|---|
| 2026-11-06 | this host, Node 22.23, drill on a temp path | synthetic database, 32 MiB, 5,000 jobs and 200,000 audit rows; no production data | 0.385 s | 0.002 s | 25 tables equal, `integrity_check ok` |

A drill against production backups is run by the operator, on the operator's
copies, and appends a row here with the numbers it printed. Do not paste table
contents or query results into this file.

Restore for real, on a stopped instance. The work directory must be outside
`DATA_DIR` (the drill refuses a target inside it), so use a scratch path. For an
encrypted copy, set the same key source the backup used; a missing or wrong key
stops the drill before it can produce a `restored.db`:

```sh
sudo systemctl stop fledge
sudo install -d -m 700 /var/tmp/fledge-restore
if BACKUP_ENCRYPTION_KEY_FILE=/etc/fledge/backup.key npm run db:restore-drill -- --db "$DB_PATH" --backup-dir "$BACKUP_DIR" --work-dir /var/tmp/fledge-restore; then
  echo "restore-drill: OK"
else
  echo "drill failed; do not restore from this copy" >&2
  exit 1
fi
# a failed drill renames the copy to restored.db.failed, so only a fresh, verified
# restored.db can be copied in the next step
sudo rm -f "$DB_PATH-wal" "$DB_PATH-shm"
sudo cp /var/tmp/fledge-restore/restored.db "$DB_PATH"
sudo systemctl start fledge
curl -fsS http://127.0.0.1:8080/healthz
```

Keep the replaced file until `/healthz` answers and one page loads, then remove
the scratch directory (`sudo rm -rf /var/tmp/fledge-restore`).

## 8. Upgrade

```sh
git pull
npm ci
npm run build
# restart the service
```

Schema changes are additive and idempotent for `v0.1.x`; review the changelog
before a major upgrade.

A release tag is not a deploy. `release.yml` builds the image, publishes it to
GHCR and creates the GitHub release against the tag; the running service changes
only when someone follows the three commands above on the host. The tag itself is
written by the daily release job through the Git data API
(`POST /git/tags` + `POST /git/refs`) once the mechanical release pull request is
merged, so a tag on `main` is evidence of a released version, not of a rollout.

## 9. Monitoring

- `GET /healthz` for liveness — unauthenticated, always `200`, and never gated.
- After a deploy, compare `/healthz`'s `commit` with the commit you deployed: a
  mismatch or `unknown` means the running artifact is not the one you intended.
  The field needs the bearer, so ask with
  `curl -H "Authorization: Bearer $METRICS_TOKEN" https://<host>/healthz`; without
  it the key is absent by design, not a deploy failure.
- Watch for `level:"error"` in structured logs.
- The Admin panel shows the audit trail and recent jobs.
- Quota state: `GET /v1/models` with a user token, or the dashboard.
- Disk: SQLite WAL files and logs.

### Log rotation and retention

Fledge logs one JSON line per event to stdout/stderr (`src/lib/log.ts`) and the
systemd unit sets no `StandardOutput=`, so the service's logs live in journald.
The only files are nginx's. The policy — and why it is journald rather than an
application log file — is [decisions/0005-log-rotation.md](decisions/0005-log-rotation.md).

Journal capacity and retention (host-wide, applies to every unit on the box):

```sh
sudo install -m 644 deploy/journald-fledge.conf /etc/systemd/journald.conf.d/fledge.conf
sudo systemctl restart systemd-journald
journalctl --disk-usage              # whole journal against SystemMaxUse=500M
journalctl -u fledge --disk-usage    # what Fledge contributes
journalctl --vacuum-time=7d          # one-off trim; does not change the cap
```

nginx logs (the sample writes `fledge-access.log` / `fledge-error.log`):

```sh
sudo install -m 644 deploy/logrotate-fledge.conf /etc/logrotate.d/fledge
sudo logrotate -d /etc/logrotate.d/fledge   # dry run: prints what would rotate
ls -l /var/log/nginx/fledge-*.log*          # after the first rotation
```

If you keep the distribution's `access.log`/`error.log` (no `access_log` line in
your nginx config), skip this file and let the distribution's nginx rotation own
those paths — never rotate the same file from two stanzas.

Development mail (`MAIL_TRANSPORT=console`) is written to
`$DATA_DIR/mail-outbox/*.eml` and is never pruned: it is a dev aid
(`npm run mail:outbox`), an instance with SMTP does not write it, and the
directory may be deleted at any time.

### Workspace snapshot retention

Each agent run leaves a snapshot under
`$FLYBOT_INSTANCE_ROOT/users/<user>/repos/<repo>/data/bot/workspace/r<number>`,
and nothing in Fledge reclaims them. They are the runtime's working copies
rather than Fledge rows, so the retention of user data (`#281`) does not reach
them, and on the production host this tree is the largest thing under `data/`.
The host-side alert script that watches it lives outside this repository and is
not changed by the tool below.

`scripts/artifact-retention.mjs` is the operator tool. It is a dry run unless
`--apply` is given, and the only thing it can remove is an `r<number>` snapshot:

```sh
# candidates, their bytes and the total; nothing is touched
npm run artifacts:prune -- --root /var/lib/fledge/flybot-users

# remove exactly those candidates, print the audit line and the freed bytes
npm run artifacts:prune -- --root /var/lib/fledge/flybot-users --apply
```

The root comes from `--root`, then `ARTIFACT_RETENTION_ROOT`, then
`FLYBOT_INSTANCE_ROOT`, then the default data directory; an empty value counts
as unset, which is why `.env.example` can ship `ARTIFACT_RETENTION_ROOT=`.
`--root` itself is not optional: a bare `--root`, an empty value or another flag
after it is a usage error (exit `2`), not a fallback to the environment.

The policy has two settings, and they answer different questions rather than
naming one threshold twice:

- `--keep <n>` / `ARTIFACT_RETENTION_KEEP` (default `3`): how many of the newest
  snapshots, by run number, survive whatever their age.
- `--max-age-days <n>` / `ARTIFACT_RETENTION_MAX_AGE_DAYS` (default `14`): how
  old a snapshot must be before it is a candidate at all.

An empty or whitespace-only `ARTIFACT_RETENTION_KEEP` /
`ARTIFACT_RETENTION_MAX_AGE_DAYS` counts as unset and takes the default. It is
never read as `0`: zero is a legal explicit value (`--keep 0` keeps no snapshot
by count), so treating a blank `.env` line as zero would turn the two retention
knobs into "remove everything".

A snapshot is removed only when it is outside **both** windows, and never when:

- `state.json` or `inflight.json` in the repository's `data/bot/` names it, as a
  bare `r<number>` or as a path — a name is matched by its basename, a path is
  resolved against that repository's `data/bot/` rather than against the
  directory the timer happens to run from, and any `r<number>` segment on it
  protects that snapshot, so a reference to `r11/checkout` protects `r11`; a
  state file that cannot be parsed protects every snapshot in that repository;
- the entry is not a run snapshot (`scratch/`, `logs/`) or is a symlink, which is
  reported as `action=skip reason=symlink` and whose target is never walked or
  removed.

`--apply` prints one line per removal plus an
`audit action=artifact-retention …` line naming the root, both windows, the
counts and the freed bytes; that line is the record, and journald keeps it when
the tool runs from a timer. The exit status is `0` for a clean run, `1` when a
removal failed and `2` on a usage error, so a timer can alert on a non-zero one.
Run it from a timer only after a dry run has shown the candidates:

```sh
# 04:10 daily, as the service user, after the dry run above has been reviewed
10 4 * * *  cd /opt/fledge && node scripts/artifact-retention.mjs --root /var/lib/fledge/flybot-users --apply
```

## 10. Go-live checklist

- [ ] HTTPS `BASE_URL`; OAuth callback matches exactly.
- [ ] `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` set and backed up.
- [ ] SMTP test email received at the configured `ADMIN_EMAIL`.
- [ ] Admin login is the intended GitHub account.
- [ ] `DEV_LOGIN_LOGIN` is empty (the app refuses to start otherwise).
- [ ] Platform model key works; a 1-token request succeeds.
- [ ] `RUNNER_MODE=mock` smoke test (add repo, run, see a succeeded job).
- [ ] Switch to `flybot`, run one real job, confirm the PR and callback.
- [ ] `ALLOW_PRIVATE_MODEL_URLS=false`.
- [ ] Firewall: only 443 public; 8787 private.
