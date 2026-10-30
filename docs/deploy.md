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
| `ADMIN_GITHUB_LOGIN` | Auto-approved bootstrap admin (default `HugoXK`) |
| `MAIL_TRANSPORT` | `smtp` in production, `console` for a local demo |
| `SMTP_HOST/PORT/SECURE/USER/PASS` | For yeah.net: `smtp.yeah.net`, 465, secure |
| `MAIL_FROM` / `ADMIN_EMAIL` | `no-reply@example.com` / `admin@example.com` |
| `PLATFORM_LLM_BASE_URL` | OpenAI-compatible `/v1` endpoint |
| `PLATFORM_LLM_KEY` | Platform key; never commit it |
| `INITIAL_QUOTA_CNY` | Default 1 |
| `USD_CNY_RATE` | Default 7.2 |
| `RUNNER_MODE` | `mock` or `flybot` |
| `FLYBOT_BRIDGE_URL` / `FLYBOT_BRIDGE_TOKEN` | Bridge endpoint and shared secret |
| `DATA_DIR` / `DB_PATH` | Defaults `./data`, `./data/fledge.db` |
| `ALLOW_PRIVATE_MODEL_URLS` | Keep `false` for untrusted users |

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

## 3. SMTP

Configure your operator SMTP account (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
`SMTP_PASS`) and set `MAIL_FROM` / `ADMIN_EMAIL` to the addresses you control.
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
the job-scoped model token, open a PR and call back. The platform will fail the
job after `JOB_TIMEOUT_MINUTES` if no callback arrives.

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
# writes backups/fledge-YYYYmmdd-HHMMSS.db using SQLite's online backup API
```

Back up `.env` separately (it contains the encryption key). Without
`TOKEN_ENCRYPTION_KEY`, stored GitHub/model tokens cannot be decrypted.

Restore on a stopped instance:

```sh
cp backups/fledge-YYYYmmdd-HHMMSS.db "$DB_PATH"
npm start
```

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
