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
| `ALLOW_PRIVATE_MODEL_URLS` | Keep `false` for untrusted users |
| `NOTIFY_WEBHOOK_URL` / `NOTIFY_WEBHOOK_SECRET` | Optional outbound notifications (Slack-compatible `text`); the secret is sent as a bearer token |

Production startup fails closed if the session/encryption keys, OAuth app or
SMTP password are missing.

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

The volume `fledge-data` holds the SQLite database and the console outbox.

### Node

```sh
npm ci
npm run build
NODE_ENV=production npm start
```

Use a process supervisor (systemd, runit, pm2) and a single instance: SQLite is
not a multi-writer cluster.

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
```

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

- It takes the newest `fledge-*.db` in the backup directory (write a fresh copy
  first with `--fresh`). Nothing is created if a copy already exists, so the RPO
  you see is the age of your real backup schedule.
- **The copy is judged against the file it is, not against the live database.**
  The restored file must be byte-for-byte the copy it came from; then, when that
  copy has a `<copy>.json` manifest (every copy `npm run db:backup` writes does),
  its size, `sha256`, `PRAGMA user_version` and per-table row counts must match
  the manifest, which is what catches a copy that was truncated or interrupted
  at backup time. A copy written before manifests existed still passes the byte
  comparison and prints `manifest=missing` as a warning.
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
  `restore-drill: OK`) before using the restored copy.
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
`DATA_DIR` (the drill refuses a target inside it), so use a scratch path:

```sh
sudo systemctl stop fledge
sudo install -d -m 700 /var/tmp/fledge-restore
if npm run db:restore-drill -- --db "$DB_PATH" --backup-dir "$BACKUP_DIR" --work-dir /var/tmp/fledge-restore; then
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

## 9. Monitoring

- `GET /healthz` for liveness.
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
