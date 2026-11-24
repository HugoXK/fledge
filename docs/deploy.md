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
| `MAIL_OUTBOX_RETENTION_DAYS` | Window for `npm run mail:outbox` to expire `$DATA_DIR/mail-outbox/*.eml`, in days; `7` by default |
| `FEEDBACK_EMAIL` | Optional feedback/error-report destination; defaults to `ADMIN_EMAIL` |
| `FLEDGE_LEAD_REPO_ID` | Repo connected to Fledge whose FlyBot Lead triages feedback |
| `FLEDGE_LEAD_BRIDGE_URL/TOKEN/SESSION_ID` | Direct bridge target when the Fledge Lead is external |
| `FEEDBACK_PUBLIC_REPO` | Sanitized public issue target; defaults to `HugoXK/fledge` |
| `PLATFORM_LLM_BASE_URL` | OpenAI-compatible `/v1` endpoint |
| `PLATFORM_LLM_KEY` | Platform key; never commit it |
| `INITIAL_QUOTA_CNY` | Default 1 |
| `USD_CNY_RATE` | Default 7.2 |
| `PLATFORM_QUOTA_COMFORT_CNY` | Default 50; below this the first-run checklist recommends an own model |
| `RUNNER_MODE` | `mock` or `flybot` |
| `JOB_TIMEOUT_MINUTES` / `JOB_STALL_MINUTES` | Hard timeout (default 90) and no-heartbeat stall timeout (default 30) |
| `FLYBOT_BRIDGE_URL` / `FLYBOT_BRIDGE_TOKEN` | Bridge endpoint and shared secret |
| `DATA_DIR` / `DB_PATH` | Defaults `./data`, `./data/fledge.db` |
| `BACKUP_ENCRYPTION_KEY` | Optional backup key: base64 32 bytes, or a value that is not base64-shaped, treated as a passphrase and stretched with scrypt. A base64-shaped value that decodes to 16–31 bytes is refused as a truncated key rather than used as a passphrase. Environment only, never argv or git |
| `BACKUP_ENCRYPTION_KEY_FILE` | Optional 0600 file holding the same key value; set exactly one of this and `BACKUP_ENCRYPTION_KEY`. A file readable by group or others still backs up but warns on stderr |
| `BACKUP_ENCRYPTION_REQUIRED` | `true` makes `npm run db:backup` refuse to run without a key; default `false` keeps plaintext backups |
| `ALLOW_PRIVATE_MODEL_URLS` | Keep `false` for untrusted users |
| `PAT_EXPIRY_DAYS` | Default lifetime of a new personal `flg_` gateway token, in days (default 90); only an admin may create one without an expiry |
| `METRICS_TOKEN` | Required in production: `/metrics`, and the `commit`/`builtAt` fields of `/healthz`, answer only `Authorization: Bearer <token>` |
| `MODEL_ROUTER_URL` / `MODEL_ROUTER_TIMEOUT_MS` | Optional: base URL of the shared model router. Unset means `/readyz` says nothing about it and the probe cannot make the process unready. Set, `/readyz` adds `router.state` and `router.latencyMs` and answers 503 when the router is unreachable or every key it reports is capped. The timeout defaults to 1000 ms and is clamped to 50–10000; the probe is cached for 2 seconds, so a monitor's cadence decides how often the router is asked |
| `RECENT_AUTH_MINUTES` | How many minutes a destructive action's GitHub re-authentication counts for (default 15, minimum 1). Raising it asks users to re-authenticate less often, lowering it more. It sets the window only: the ceiling on those routes is a code constant, described in `docs/security.md` |
| `PLAN_EXPIRY_DAYS` / `PLAN_REMINDER_DAYS` | How long an unapproved plan may wait before the work item closes with `closed_reason = plan_expired` (default 7), and how many days before that deadline the single reminder is sent (default 2). They are one deadline pair: `PLAN_REMINDER_DAYS` must be smaller than `PLAN_EXPIRY_DAYS`, and Fledge refuses to start with both names in the message otherwise, because a reminder at or after the deadline is sent immediately |
| `LIMIT_REPOS_PER_USER` | How many repositories one user may connect (default 10; `0` means no ceiling). Admins and superadmins are exempt, and lowering it never touches repositories that already exist — only new adds are refused. A bulk add from a GitHub App installation counts each selected repository once and may fill the last free slots exactly; a selection with nothing new to add is not refused |
| `LIMIT_INSTANCES_PER_USER` / `LIMIT_INSTANCES_GLOBAL` | How many running FlyBot instances one user may have (default 3), and an optional ceiling across the whole deployment (default `0`, off). Only an instance that occupies a slot counts (`starting`, `provisioning` or `ready`): a stopped instance does not, so a user at the cap can restart their own. Both the explicit provision and the two repository-add paths consult it, and a refusal carries `INSTANCE_LIMIT`, names the ceiling that refused, and leaves no container, port or half-added repository behind. The check runs per request, not inside a transaction, so two concurrent adds one below the cap can both pass |
| `NOTIFY_WEBHOOK_URL` / `NOTIFY_WEBHOOK_SECRET` | Optional outbound notifications (Slack-compatible `text`); the secret is sent as a bearer token. When set, the URL must be an absolute `https:` URL |
| `PRODUCT_LOOP_WEBHOOK_URL` | Optional aggregate-only product-loop receiver. Unset means nothing leaves the process; when set, the push happens at most once a UTC day and carries the counts and rates on `/admin/product` — no repository fingerprint, account or free text. Like `NOTIFY_WEBHOOK_URL`, an absolute `https:` URL is required in production |
| `RETENTION_PRODUCT_EVENTS_DAYS` | How long `product_events` rows are kept (default 730) |

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
settings, run `node scripts/rotate-github-token.mjs --token-file <0600 file>`
(or pipe the token with `--token-file -`), and revoke the old token. The token is
never passed on the command line or in the environment.

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

### Per-repository FlyBot containers

Each hosted repository gets its own container, started from
`flybotContainerArgs()` in `src/flybot/isolation.ts`. The flags are the boundary,
so they are not configurable per repository: `--read-only` with one `/tmp` tmpfs
(`rw,noexec,nosuid,size=64m`), a single bind of that repository's data directory
at `/data`, `--cap-drop ALL`, `--security-opt no-new-privileges`, a non-root
`--user`, and the CPU, memory and PID ceilings. `NARB_DISABLE_NATIVE_CACHE=1` is
not optional: the DSH native-addon loader copies a binary into the temp directory
and executes it, so a `noexec` `/tmp` otherwise stops the web profile from
starting.

Those flags reach production through the normal deploy and take effect the next
time an instance is provisioned or restarted. Before shipping, prove the boundary
on a host that runs the containers:

```sh
npm run isolation:check                       # node:22-bookworm-slim probe
npm run isolation:check -- --image <flybot image>
```

The check starts its own throwaway container with exactly those arguments, then
asserts from inside it that the root refuses a write, the effective capability set
is empty, a seccomp filter is loaded, the Docker socket is absent, only the
repository data directory is a host bind, and a container on another tenant's
network is unreachable. It exits 3 where no Docker daemon exists rather than
reporting a pass. Egress is not restricted yet: a fresh data volume installs its
profile from `registry.npmmirror.com` on first start, so deny-by-default egress
with an allowlist is still open work and not something a deploy changes today.

## 5. Run

### Docker

```sh
docker compose up -d --build
```

The compose healthcheck probes `/readyz`, not `/healthz`: a container whose
database cannot be read is marked unhealthy instead of healthy.

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

Both stages of the image pin `node:22-alpine` by digest (`Dockerfile`), so a tag
that moves cannot change the toolchain under a build whose diff says nothing
about it. Update the pin deliberately: resolve the digest a fresh pull reports
for `22-alpine`, replace both `FROM` lines together, and keep the readable tag in
the reference. `test/dockerfilePins.test.ts` fails on a `FROM` without
`@sha256:<64 lowercase hex>` and on two stages pinned to different digests, so a
dropped digest is a red suite rather than a silent tag. Dependabot's Docker
ecosystem is the next slice; until it lands, the bump is manual and still needs a
rebuild, the image scan and the smoke check.

Both stages install with `npm ci --ignore-scripts` (#868): a dependency install
script runs inside the build before anything is compiled or copied, so it would
be a way to rewrite the tree the image is built from. The one package in this
tree with a postinstall (`esbuild`) resolves its platform binary from the
`@esbuild/linux-x64` optional dependency, so the build and the test suite run
with scripts disabled; `test/ciInstallScripts.test.ts` fails on a stage that
drops the flag.

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
Monday 10:00 Asia/Shanghai run) bumps the minor (`0.3.4 -> 0.4.0`); every later
release in the same week bumps the patch (`0.4.0 -> 0.4.1`). The planner reads
the last tag's commit time and the workflow's run time; if either is unreadable
it falls back to the minor, which is the first-release behaviour.

#### The `ci-ok` read waits for the verdict (#864)

Rule 4 releases only on a green `ci-ok`, and a check run that is still queued or
running reports no conclusion. The planner used to read the aggregate once, so a
run that started at the same moment as `ci.yml` saw `missing` and ended the slot
with `none`; `0.3.7` was refused that way. `scripts/lib/release-drive.mjs` now
keeps the two facts apart: `failure` (and any other concluded non-success) still
blocks at once, while `missing` returns `wait-ci` and the decide step re-reads
`ci-ok` at the *same* tip the plan was computed from — three reads, five minutes
apart, so at most ten minutes of waiting. The bound is in the module
(`CI_OK_READS`, `CI_OK_INTERVAL_MS`), the step summary prints the run id, the
status and how many reads were made, and a tip that never concludes ends the slot
with `none` and that run id in the reason. A dry run never waits: it reports what
a real run would have done.

#### Superadmin one-click release (#897)

The Admin page has a superadmin-only release action. It reads the live GitHub
state and shows the current `main`, latest tag, the planner's merged-pull-request
and feature counts since that tag with the pending fragment count, the computed
next version, `ci-ok` and the exact reason a release is blocked. The counts and
the verdict come from the same `planRelease` the nightly run calls (#985), so the
button cannot refuse a release the night would make and the numbers a maintainer
reads are the rule's. The action is enabled only when the normal rule is met, no
release PR/branch/tag is in flight and `ci-ok` is green.

The submit button requires `RELEASE <version>` to be typed, a CSRF token, a
recent GitHub re-authentication, the destructive rate-limit class and an audit
row. It dispatches the existing `daily-release.yml` with `dry_run=false`; it
never creates a tag, merges a pull request or deploys a host. The existing
release PR, `ci-ok`, `review-gate`, tag job and `release.yml` publish chain stay
in charge, and a person merges the release PR: the workflow no longer opts it
into auto-merge (#1127).

The dispatch credential is `RELEASE_DISPATCH_TOKEN` in the server `.env`, scoped
to the Fledge repository with `Actions: write` to dispatch the workflow and
`Contents: read`, `Checks: read` and `Pull requests: read` to read the preview;
prefer a fine-grained token, and grant no write scope on contents or pull
requests. A token minted with only `Actions: write` answers `403` on the first
preview read, and the Admin page names the scope it needs.
An empty value disables the action instead of failing the Admin page. The token
is never rendered, logged or returned by the route.

`RELEASE_DISPATCH_REPO` must be `owner/name`, `RELEASE_DISPATCH_WORKFLOW` must be
a `.yml` file name, and `RELEASE_DISPATCH_REF` must be the default branch
(`main`). GitHub runs the workflow file as it exists at the dispatched ref, with
that run's secrets and write scopes, so any other value is refused before the
first request with a message naming the setting; the same `main` the preview
reads is the only ref the action can mean.

A release is not a deploy. Production may already run `main` ahead of the latest
tag; the next infra `service-update-fledge.sh` run installs the version-bump
commit after the release PR merges. A separate operator action owns any restart.

#### Reliable slot trigger

GitHub's `schedule` event is best-effort: on 2026-11-14 the then-`14:30Z` slot
produced a run at `19:24Z`. `scripts/trigger-release.mjs` is the external
trigger. A host cron or a Cloudflare Worker calls it at `02:00Z` (10:00
Asia/Shanghai) with `GITHUB_REPOSITORY` and an Actions-write `GITHUB_TOKEN` in a
`0600` env file; the script calls the `daily-release.yml` workflow_dispatch with
`dry_run=false` and never prints the token. GitHub's `schedule` and the `03:00Z`
catch-up stay as the fallback, and `release-trigger` makes a late run a no-op
once the slot is filled. Install it only on a host whose clock is trustworthy
(see #758) or on an NTP-backed scheduler; the example is
`deploy/release-trigger.cron.example`. Raise one alert if no plan exists by
`02:30Z`.

The trigger refuses to dispatch before the boundary (#881). On a host whose
clock runs ahead (#758) a `0 2 * * *` cron reaches the API before `02:00Z`, and a
dispatch then creates a release commit that belongs to the previous day's slot.
`scripts/trigger-release.mjs` compares its own clock with that day's `02:00Z`
boundary and exits without making a request (`before-boundary`), so the slot
falls to GitHub's `schedule` rather than shipping twice; move the cron forward by
the host's offset so it lands inside `[02:00Z, 02:05Z]`, and fix the clock
separately. The workflow applies the same rule to a `workflow_dispatch` that
arrives early, and the slot's own tag rule counts a release committed earlier on
the slot's UTC day as that slot shipped, so a commit made 28 minutes early no
longer leaves the slot "unshipped" at the boundary. A tag committed on an earlier
UTC day still leaves the slot open, and the planner's week comes from the slot
boundary rather than the runner's instant.

#### The slot watchdog (#941)

The hourly `ci-watchdog` workflow also judges the `02:00Z` slot. Once the
slot's 60-minute grace window has passed, `scripts/release-slot-watchdog.mjs`
reads that UTC day's releases, the `daily-release` runs, their `release-plan`
artifacts and the recent issues from the API and opens exactly one card when the
day should have shipped a release and did not. The card
names the day, the expected slot, the grace window, the observed run ids (with
the `event` that fired each one) and the API `Date` it used; the clock is the
API's `Date` header, never the host's. A rerun of the same day opens nothing,
because the card carries a marker built from the slot. A night the planner
declined — a green run whose own `release-plan` says `shouldRelease: false` —
opens no card, while a failed run, no run at all, and a plan that cannot be read
still do, and the card names which alarm it is. The detector writes nothing else:
it dispatches no workflow and creates no tag, release or deploy.

#### Reading the slot back (#1035)

The dispatch is proven, not assumed (#1035). `scripts/trigger-release.mjs` reads
back the run it created and prints it, so a release can name whether the slot
came from the trigger or from GitHub's late `schedule`. The
`.github/workflows/release-slot.yml` job runs at `02:10Z` and fails when no
`workflow_dispatch` run landed inside `[02:00Z, 02:05Z]`: a run that filled the
slot hours late is reported as `slot-late`, no run at all as `slot-missed`, and
a run list the job cannot read as `unreadable` (exit 2) rather than as a missed
promise — "we could not look" is not evidence that nobody came. The check only
reads the runs API; it dispatches nothing and changes no release record. Run it
by hand with `node scripts/trigger-release.mjs --check-slot` and the same
`GITHUB_REPOSITORY` / `GITHUB_TOKEN` variables.

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

The release routine refreshes the generated UI snapshot once per release:
run `npm run mock:snapshot`, then `npm run mock:check`, and commit the
regenerated `mock/` with the release work or its follow-up docs pull request.
The nightly release job also runs `npm run mock:check` before it plans a
branch; a stale snapshot is a red night and names the command. `mock/` is
generated from the released views and is read-only; do not edit it by hand.
Every pull request runs the same check as the required `mock-check` job in
`ci.yml`, so staleness is caught at the tip that introduces it instead of at
release time; there is no second drift gate. The snapshot is still the UI at
the release tip, not a second application.

The daily workflow pushes `release/v<next>` and then opens exactly one release
pull request for it, because a pull request opened with `GITHUB_TOKEN` starts no
`pull_request` workflow and would never get a `ci-ok`. The opener uses a real
token for that reason. `.github/workflows/ci-watchdog.yml` is the scheduled
backstop: it dispatches `ci.yml` when an open same-repo pull request has no `CI`
run at all at its head SHA, and it does not replace opening the PR with a real
identity.

The opener runs on the environment secret **`RELEASE_OPEN_TOKEN`** of the
`release` environment (Settings → Environments → `release` → Environment
secrets), not on a repository secret: the `release` job in
`.github/workflows/daily-release.yml` is the only job that declares
`environment: release`, so no other workflow on `main` can read the token, and
the `tag` job gets no environment at all. Set it to a token for the team
account — never the Reviewer's `HugoXK-bot` account — scoped to this repository
alone, with `Contents: read` and `Pull requests: write` — it does not need push,
because the workflow pushes `release/v<next>` before the opener runs.

The environment must carry **no required reviewers**: the routine runs
unattended, and a protection rule blocks it exactly like a missing secret. Order
matters too — the environment and its secret have to exist before the workflow
change that names it merges, because a job that declares an environment reads
repository secrets too until an environment secret of the same name overrides
them. Since the repository secret is deleted in that same owner step, a daily run
that starts between the two would fail the opener with `RELEASE_OPEN_TOKEN is not
set`: loudly, before anything is pushed, and with nothing posted on #80. The opener reads
`GET /user` and
refuses a credential whose login is the review policy's `requiredPass`, so the
reviewer account cannot open the release pull request even if it were installed
by mistake. The token reaches the step through the environment only; it is never
an argument, an output or a log line.

A missing secret is a red precondition, not a reported run: the run fails
before the branch is pushed and names `RELEASE_OPEN_TOKEN`, and because nothing
was pushed it says nothing on #80. A refused opener — the branch at another
commit, `main` moved since the plan, a path outside the mechanical set, the
version or changelog check failing in the fetched tree — is a red run with the
reason in the job summary and on #80. Dry runs reach no write path, and a run
that pushed nothing writes to #80 only when the night was held by an open
release pull request; every other pushed-nothing run stays silent.

A night held by an open release pull request is a no-plan: one slot, one
release pull request (`scripts/lib/release-trigger.mjs`). That refusal used to
leave no record at all — the night pushed nothing, so the #80 step exited — and
the one fact that decides whether it ships, the pull request's own `ci-ok`, was
never read. The collect step now reads that pull request's head and its `ci-ok`
conclusion, with the names of the checks that failed, and a held night posts
one line on #80 naming the pull request, its head, the conclusion and the failed
checks. The line is keyed by the number, the head and the conclusion, so it
repeats only when one of those changes. Nothing on that path merges, closes,
re-runs or pushes: the release stays a person's decision.

A manual run is still possible and uses the same tool:

```sh
GITHUB_TOKEN=… node scripts/release-open.mjs --artifact release-plan.json --version <next> --sha <branch tip>
```

The tool re-runs `scripts/version.mjs check` and `scripts/changelog.mjs check`
against the branch's contents fetched through the API (never the branch's own
copies of those scripts), refuses when `main` moved since the plan or the diff
leaves `CHANGELOG.md`, `README.md`, `README.zh.md`, `changelog.d/`,
`docker-compose.yml`, `package-lock.json` and `package.json`, reuses an open pull
request at the same commit — after re-reading its head, the same check a freshly
opened pull request gets, so a head in another repository, a flag that reads back
`true`, or a readback that cannot be made is a refusal rather than a reuse —
instead of opening a second one, and prints the JSON it acted on. It writes that
one pull request and nothing else, and it carries no tag endpoint: the tag stays
in the workflow. A `POST /pulls` that answers non-201, or answers no pull request
number, or a readback that reports `maintainer_can_modify: true` — that flag is
only true for a fork head, and the release head is pushed to this repository — is
a refusal, but the pull request already exists at that point and stays open:
closing it is the owner's action only (owner instruction 2026-11-15), even
though the opener's `Pull requests: write` scope would allow a close — so the
refusal goes to the owner from #80 like any other, and the next run re-reads that
pull request's head and either reuses it at the same commit or refuses it again,
never opening a second one.

### Verify a release

The publish run records what it produced in the GitHub Release body — the image
reference with its digest, the SBOM asset URL and the attested digest — so the
chain can be read back through the API alone:

```sh
# the whole chain, from the plan to the running instance. METRICS_TOKEN is what
# lets the script read /healthz's commit, which is bearer-only (#236).
GITHUB_TOKEN=… METRICS_TOKEN=… node scripts/verify-release.mjs --version 0.3.2 --base-url https://fledge.hugoxk.online

# the same check, rendered on /admin for an operator without a token
GITHUB_TOKEN=… METRICS_TOKEN=… node scripts/verify-release.mjs --version 0.3.2 \
  --base-url https://fledge.hugoxk.online --write "${DATA_DIR}/release-status.json"
```

`release.yml` runs that same check itself as its last step (#883), so a release
whose body claims a digest, an SBOM or an attestation it does not have fails the
publish instead of leaving the claim for an operator to find. Both release
workflows read "does this tag have a Release?" through one encoder that keeps the
tag as a single path segment (`scripts/lib/release-lookup.mjs`), so a tag
containing `/` is not read as a deeper path and mistaken for "no release yet".
The publish side is closed in five places:

- the image is built once and published under a commit tag
  (`ghcr.io/hugoxk/fledge:sha-<12 hex>`), and the digest that push produced is
  the only identity later steps read;
- that exact digest is scanned by Trivy at the CI threshold, and the container is
  started from it and asserted on `/healthz`, so the image a host will pull is
  the image this run proved;
- the SBOM is generated from the same digest and uploaded as a Release asset, and
  the body names its download URL;
- `vX.Y.Z` is an alias created from the verified digest. A run that finds the
  alias already naming another digest stops: repointing it would silently change
  what every record that named it points at (`scripts/lib/release-alias.mjs`);
- the whole chain is verified after the Release exists, with the job token.

A redispatch of a tag that already has a Release still stops at the guard before
anything is built; what the alias rule adds is that a tag without a Release
cannot move a name that already published one.

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

Release branches are retained on this repository. The ruleset `keep release
branches` blocks deletion of `refs/heads/release/*`, so GitHub's "automatically
delete head branches" setting leaves a merged release branch in place. That keeps
the pre-squash tip readable and lets the branch link stay `ok`; a branch deleted
before the ruleset existed still falls back to the pull request head.

`--fixtures <file>` replays a recorded chain instead of reading the API, which is
how the test suite exercises the same code path.

### Release tag provenance

A `v*` tag is a published name: whatever it points at becomes an image, an SBOM,
a GitHub release and, on a host, the next deployed version. The ruleset
`release tag protection` (id `27014081`) blocks deletion and non-fast-forward
updates of `v*`. Those two rules stop a tag being moved or removed; neither
stops a **new** one being created, so anyone with write access can still push
`v9.9.9`. Making that half true is a ruleset change — repository state, not a
commit — so it is recorded here as an owner action, and `release.yml` verifies
what a commit can.

**The owner action, once.** In Settings → Rules → `release tag protection`,
target `v*`, add the **Create** rule beside the existing deletion and
non-fast-forward rules, with a bypass list holding exactly the release identity:
the GitHub Actions integration (id `15368`) and, if manual tags are still
wanted, the repository role `Admin`. Nothing else belongs in that list — a bypass
is what makes a rule stop applying, so every actor there can create a version
tag. The API form is `PUT /repos/{owner}/{repo}/rulesets/27014081` with the
current rules, `{ "type": "creation" }` added, and `bypass_actors` naming those
two. The tag job keeps working because it writes the tag with `GITHUB_TOKEN`,
which is that integration. Keep the deletion and non-fast-forward rules as they
are.

**What `release.yml` verifies before it publishes.** The tag object is read from
the checkout the run already fetched; the one API read is the release pull
request behind the tag's commit. A tag that fails any check is a red run whose
message names the field, and the publish stops before anything is built, pushed
or released:

- the tag is an **annotated object**, not a lightweight ref, so it carries the
  tagger and message the next two checks read;
- its tagger is the release routine (`github-actions[bot]`) or a documented owner
  identity (`HugoXK`, `Day Dreamer` — the names on the tags created by hand
  before the routine existed, which are still re-published after a bad image);
- it points at a commit that is an **ancestor of `main`** — this check is
  unchanged and still refuses a tag off the release line;
- when the tagger is the routine, that commit is the one a merged pull request
  titled `release: v<version>` produced: the pull request's `merge_commit_sha`
  must equal the tag's commit, so a tag made by hand cannot borrow the routine's
  identity without merging a release pull request.

The tagger field is git text, not an authentication claim — anyone can write
`Day Dreamer` into a tag object. It is checked because, together with the
`creation` rule, it records which identity produced a tag that exists. The
enforcement of *who may create* is the ruleset; this check is what keeps a tag
that got in another way from publishing.

One reading worth stating: the card asks for a tag that points at "a merge
commit on `main`". That is verified as "points at the commit its release pull
request merged", not as "has two parents". Every tag this repository has released
points at a one-parent squash commit (`v0.3.6` → `aa83dc0`, one parent), so a
two-parent check would refuse every real release.

Not in this slice: no signed-commit requirement (a non-goal on the card) and no
change to the release cadence or the tag name.

### Finishing a half-made release (#866)

A release is two write moments: the annotated tag, then the publish run
dispatched at it. When the dispatch failed after the tag was written, the tag job
used to answer `skip` on every later run — the tag existed, so nothing was owed —
and the release stayed at `not released` until a human re-dispatched it.

The tag job now decides from three API facts (`scripts/lib/release-tag.mjs`, one
test per row):

| tag | GitHub Release | action |
|---|---|---|
| missing | — | `create` the tag on the release pull request's squash commit |
| present | missing | `publish`: dispatch `release.yml` at the existing tag, write no tag |
| present | present | `skip`: nothing to publish |

`publish` is gated by the same identity check as `create`: the commit must be the
squash of the merged `release: v<version>` pull request from `release/v<version>`,
so an ordinary push to `main` cannot re-dispatch a release it did not produce.
`release.yml` re-verifies the tag before publishing, and it asks one question
before it builds anything: if a GitHub Release already exists for the tag, the run
records `published` in `Stop when the release already exists` and every step that
would write is gated on that answer. A repeated dispatch of a complete release
therefore cannot rebuild and repush the image or rewrite its notes — the claim is
the step, not a sentence here.

Neither workflow guesses when the lookup itself fails. `gh` exits non-zero for
"not found" and for "forbidden", a server error or a dead network alike, so both
steps classify the answer in one tested place, `scripts/lib/release-lookup.mjs`: a
successful read is **present**, a 404 is **absent** ("not released yet"), and
everything else is **unreadable**. Present and absent gate the run as before; an
unreadable answer is a non-zero exit with no `published` value, so the publish run
stops before it builds or pushes anything and the tag job stops before it plans a
tag — a 403 or a 5xx is never read as "no release yet". The publish run also never
edits a release it did not create: a release that appears between this lookup and
the final write is a refusal, not a notes rewrite.

The job still runs on the `push` that merges the release pull request, and it now
also runs on the scheduled slot: a tag without its release, or a merged release
pull request without a tag, is repaired by the next daily run instead of waiting
for someone to notice. A scheduled run acts on the merge commit of the merged
`release: v<version>` pull request rather than on `main`'s tip, because after any
later merge the tip is no longer that merge and the identity check would correctly
refuse it; a scheduled run that cannot name exactly one such pull request keeps
the tip, and the identity check then refuses it with its own reason rather than
guessing a release to repair. **The tag job is the only tag writer**: the release
job never creates a tag, and its drive no longer carries a `tag` action at all.
That action was unreachable — the release job never fed it the merged pull request
list, so it could neither execute nor be reported — and it was removed rather than
left as a claim in the code; a merged release pull request without a tag is found
by the tag job itself (#866).

Two recovery steps remain owner actions, unchanged by this slice: an orphan
`release/vX.Y.Z` branch still cannot be deleted through the `keep release
branches` ruleset (`bypass_actors: []`), and relaxing that is a ruleset edit, not
a commit. The runbook is still: delete or adopt the branch after adding the
identity to the ruleset bypass, then let the next run tag the merge.

### Naming the changes a release carried but its notes did not (#1207)

A release's notes are assembled once, when the release pull request is built:
`node scripts/changelog.mjs release` folds every fragment it can see and deletes
it, and nothing reads `changelog.d/` again before the tag is written. Every
change merged into `main` while that pull request waited for its merge click is
therefore carried by the tag and missing from the notes the tag publishes —
v0.4.5 shipped three that way while its pull request body said "changelog
fragments: 22".

The publish run now checks the checkout at the tag before it builds anything. A
fragment still present in `changelog.d/` there is by construction a change the
release does not name, so `scripts/release-stranded-notes.mjs` appends one
section to the assembled body that lists each of them and says why it arrived
late; the three chain lines (`Image:`, `SBOM:`, `Attestation:`) are appended
after it and read exactly as before. The step fails, and the image is never
built, when `changelog.d` cannot be read: a body that reads complete without the
release's own changes is worse than no body. The fragment names are then said on
#80 by a separate job that holds `issues: write` and nothing else, so the release
log and the published notes agree.

Nothing else moves: the same tag, image and `CHANGELOG.md`; no push to `main`,
no second release, no re-tag. A stranded fragment is still folded into the next
release's section, so a change can be named twice until the fold itself is
reworked.

### Automatic tag deployment and verification

The release plan → release pull request → tag half lives in
`.github/workflows/daily-release.yml` and `release.yml`. The deployment half is
run by `hugoxk-infra`, which installs the two scripts kept here under `deploy/`
and schedules them from its own crontab (see [Who actually deploys
production](#who-actually-deploys-production)):

```sh
# Deploy a newer tag; never roll a newer main back.
*/10 * * * * /home/xuke/work/fledge-deploy-tag.sh

# Refresh release-status.json for /admin.
*/30 * * * * /home/xuke/work/fledge-verify-release.sh
```

`fledge-deploy-tag.sh` fetches tags, takes the newest `vX.Y.Z`, and deploys only
when that version is newer than the running `package.json`. It uses a detached
tag worktree, builds, stops/starts the configured service, gates the rollout on
the release it built (below), and restores the previous release — `dist`,
`public/`, `package.json` and `.build-identity` — when the source copy, the build
or the rollout check fails. A refused rollout leaves the host on the release it
was running, and the next tick retries the same tag instead of reading the new
version and exiting as already deployed. It never runs `git push`, `--admin`, a
merge or a rollback to an older tag. On success it invokes the verifier.

The source copy is `rsync -a --ignore-times --delete`: `--ignore-times` makes it
copy a changed file whatever its size and mtime say, which rsync's default quick
check would otherwise skip and leave one file at the old release.

`fledge-verify-release.sh` reads `GITHUB_TOKEN` from the environment or the
`GITHUB_TOKEN` entry in `FLEDGE_SECRETS_FILE` (default
`~/.dsh/bot/secrets.json`), loads `METRICS_TOKEN` / `BASE_URL` from `.env`, and
writes `release-status.json` through a temporary file and rename. The token is
never printed or passed as an argument. A `not released` verdict is a normal
result in the log and status file, not a cron crash; missing input exits 1.

Both scripts accept `FLEDGE_APP_DIR`, `FLEDGE_SOURCE_DIR`, `FLEDGE_DATA_DIR`,
`FLEDGE_DEPLOY_LOG`, `FLEDGE_STOP_CMD`, `FLEDGE_START_CMD`, `FLEDGE_HEALTH_URL`,
`FLEDGE_SECRETS_FILE` and `FLEDGE_REPOSITORY` overrides. They hold a `flock`
so two cron ticks cannot overlap, and the deploy script exits without changing
anything when production is already at the newest tag or ahead of it.

The deploy lock is a fixed path, `/tmp/fledge-deploy-tag.lock`, so a second cron
tick on the same host exits 0 without touching anything. `FLEDGE_DEPLOY_LOCK`
moves it, and only a test host should: a fixture that shares the production path
is decided by whatever else on the machine holds it, which is how the deploy
cases failed once on a busy shard and passed on a replay (#943).

### Gate a rollout on the release it claims

A version string is not a rollout. On 2026-11-14 production answered
`/healthz` and the footer as `0.3.2` while `/assets/app.css` was 59,354 bytes —
matching no tag (`0.3.2` 51,920, `0.3.3` 60,777, `0.3.4` 63,758, `0.3.5` 64,182)
— and the page had no `data-density` the running layout renders. The process, the
page and the asset directory were three different releases, and the deploy
script's only test was `"version":"X.Y.Z"` in `/healthz`.

`scripts/rollout-check.mjs` answers that with six links and exits non-zero when
any of them disagrees. `METRICS_TOKEN` is needed for the `commit` half of
`/healthz`; the deploy script reads it from the app `.env`, the same credential
`/metrics` uses.

```sh
# the automatic path: the deploy script runs this after the restart, before it
# writes deployed-tag, and rolls the previous dist back when it exits non-zero.
METRICS_TOKEN=… node scripts/rollout-check.mjs --version 0.3.5 \
  --commit <40-hex tag commit> --base-url http://127.0.0.1:8095 \
  --release-dir /home/xuke/work/fledge-deploy-src --public-dir /home/xuke/work/fledge/public
```

`--release-dir` is the tag worktree the deploy built from, so the expected
`app.css` bytes come from the release artifact and never from the running tree —
the running tree is the thing that gets replaced by hand. When that worktree is
gone, pass the recorded hash instead:
`--expect-css-sha256 <64-hex>` (from the deploy log's `rollout-check: ok …` line,
or `sha256sum public/app.css` on a fresh `git worktree add` of the tag).

Output of a rollout that serves its release — this is the line the deploy log
keeps:

```
rollout-check: ok v0.3.5 commit 2f55afd54cf4b68066dadf54efaf814bd7af0d29 app.css 1a2b3c4d5e6f
healthz version  ok        served 0.3.5, expected 0.3.5
healthz commit   ok        served 2f55afd54cf4b68066dadf54efaf814bd7af0d29, expected 2f55afd54cf4b68066dadf54efaf814bd7af0d29
footer version   ok        served v0.3.5, expected v0.3.5
served asset     ok        served 1a2b3c4d5e6f7a8b (64182 bytes), expected 1a2b3c4d5e6f7a8b
page asset       ok        page versions 1a2b3c4d5e6f, bytes hash to 1a2b3c4d5e6f
public tree      ok        10 file(s) match the release
```

The drill the acceptance asks for is one deliberate skip: build the target but
do not restart the service, then run the check by hand. It must refuse, and the
process keeps answering the old version:

```
$ METRICS_TOKEN=… node scripts/rollout-check.mjs --version 0.3.5 \
    --commit <tag commit> --base-url http://127.0.0.1:8095 --release-dir <tag worktree>
rollout-check: refused — 1 link(s) disagree with v0.3.5 (<tag commit>)
healthz version  mismatch  served 0.3.2, expected 0.3.5
…
$ echo $?
1
```

The check opens no file: the report is stdout, and keeping it is the caller's
redirection. `--json > rollout.json` writes the same report `--write` used to,
with the shell owning the path — and `--write` is refused (exit `2`) rather than
silently dropped, so an old command line cannot lose the record.

Exit codes are the same shape as `verify-release.mjs`, so one habit covers both:

| Exit | Meaning | Action |
|---|---|---|
| `0` | every link agrees with the target | the rollout is the release; nothing to do |
| `1` | a link disagrees — the running process, the page, the served bytes or `public/` is another release | fix the cause named in the rows; the deploy script restores the previous release (`dist`, `public/`, `package.json`, `.build-identity`) and restarts it, so production stays on the old release rather than on a half-swapped tree, and the next tick retries the same tag |
| `2` | the command could not read its input (no release artifact, no `--version`, unreadable fixture, HTTP failure) | never a green verdict: correct the input and re-run |

What the gate does **not** cover, so nobody reads it as more than it is:

- It runs after the restart, because that is when there is a process to ask. The
  gate's guarantee is that a rollout which fails it is rolled back and never
  recorded in `deployed-tag`; a deploy that swaps files and skips the restart
  entirely is caught by `healthz version` before anything is recorded.
- A refusal restores the whole release, not just `dist/`. The old process serves
  `public/` and reports the version in `package.json` at startup, so those go back
  with the build and the identity; restoring `dist/` alone would restart the old
  build under the new release's name and leave the version check at the top of
  the script on the target version, so the refusal would never be retried.
- The `public tree` link compares the release with the tree this deploy just
  copied into place, so it catches a partial copy but cannot see a web server
  rooted somewhere else; `served asset` and `page asset` are the links that prove
  what is actually served.
- It does not hash `dist/`. The running build is identified by the commit in
  `/healthz`, which comes from `.build-identity` written beside it; `dist/` has
  its own manifest for CI (`scripts/dist-manifest.mjs`).
- It never writes, reloads nginx, or restarts anything itself: the deploy script
  owns the restart, and the owner owns running the deploy.

### Required before start

The sample unit runs the same verifier as `ExecStartPre=` (#462), so a host whose
recorded release is absent or disagrees does not start. Record the release on the
host first, with the digest the machine actually has:

```sh
# the API half: the chain, and the digest this host would run
digest="$(sudo docker image inspect ghcr.io/hugoxk/fledge:v0.3.2 \
  --format '{{index .RepoDigests 0}}' | cut -d@ -f2)"
: "${digest:?docker image inspect returned no digest — pull the released tag by digest first}"
GITHUB_TOKEN=… METRICS_TOKEN=… sudo node scripts/verify-release.mjs --version 0.3.2 \
  --base-url https://fledge.hugoxk.online \
  --local-image-digest "$digest" \
  --write /etc/fledge/release-status.json
# the hook runs as User=fledge, so a root:root 0600 record is unreadable to it
sudo chown root:fledge /etc/fledge/release-status.json
sudo chmod 0640 /etc/fledge/release-status.json
```

The group ownership is the part that is easy to miss: `EnvironmentFile=` is read
by systemd as root *before* privileges drop, so root-only `0600` is right for
`fledge.env`, but `ExecStartPre=` runs as the unit's `User=fledge`. Hand the
record to the group the unit runs as — `root:fledge` with mode `0640` — and the
hook can read it without the record being world-readable. An image with no
`RepoDigests` entry (built locally, `docker load`ed, a tag never pulled by
digest) makes the substitution empty; the `: "${digest:?…}"` line above stops
before the record is written, and passing an empty `--local-image-digest` at all
is refused with exit `2` rather than recorded as a skipped link.

`--local-image-digest` is the one comparison the API cannot make: the digest
`docker image inspect` reports for the tag on this host, compared with the digest
the release and its build-provenance attestation name. It is one more row in the
same output, and a mismatch names both digests. Without the flag the row reads
`skipped`, and the chain is still judged on its API links.

The file the command writes is also the record the unit starts from. `ExecStartPre=`
replays it with `--fixtures /etc/fledge/release-status.json --package
/opt/fledge/package.json`: no token, no API call, no docker. It re-checks the
recorded chain, the recorded digest and the version of the tree that will
actually run. What it catches is a record that disagrees with itself or with
`/opt/fledge`: a changed `package.json` version, a mangled or hand-edited
record. The image comparison happens at recording time — the boot hook has no
docker, so at start the recorded digest is compared with the recorded image
digest, which is a self-consistency check, and a same-version image swap on the
host is not caught by it; re-record after such a swap. **A host with no
`/etc/fledge/release-status.json` does not start** — that is the hook doing its
job, not a bug.

The console's copy of the same snapshot lives under `${DATA_DIR}`; run the
command a second time with `--write "${DATA_DIR}/release-status.json"` if the
`/admin` card should show it too.

A non-zero exit means **do not start**. Read the failing row in
`journalctl -u fledge` and fix the release:

| Exit | Row | Meaning | Action |
|---|---|---|---|
| `2` | `verify-release: cannot read /etc/fledge/release-status.json: ENOENT…` | nothing was recorded on this host | run the recording command above on this host; never hand-write the file |
| `2` | `verify-release: cannot read /etc/fledge/release-status.json: EACCES…` | the file exists but `User=fledge` may not read it | `chown root:fledge` and `chmod 0640` the record, as in the recording command; do not widen it to `0644` |
| `2` | `verify-release: /opt/fledge/package.json has no readable version` | the installed tree is incomplete | finish the install, then start |
| `1` | `local mismatch the local image sha256:… is not the attested digest sha256:…` | the image on this host is not the released one | pull the tag the chain names; do not start |
| `1` | `version mismatch package.json is at vX, the chain is for vY` | `/opt/fledge` is not the recorded release | install the recorded version, or re-record if the new version really is the release |
| `1` | `healthz mismatch …` | the recorded probe disagrees with the tag it was compared with | fix the deployment or the record; do not start |

Both non-zero codes refuse the start: `1` is a fact that disagrees, `2` is an
input that could not be read. They are printed as different lines so the journal
says which one happened. The hook never contacts GitHub, so a reboot depends on
one local file and nothing else — a stale record is refused rather than started.

### Deployment records, drift and rollback

A release tag is not a deploy. Fledge keeps a **record** of what an operator
deployed to an environment, and compares it with the latest release snapshot the
verify command writes. It never reads the host, SSHes, calls Docker or runs the
rollback command.

The read model is admin-only:

- `GET /admin/deployments` renders it (the admin page links to it as
  **Deployments**);
- `GET /api/admin/deployments` returns the same facts as JSON.

Every record carries the environment, version, commit, image digest,
`deployedAt`, operator, the `/healthz` and `/readyz` results measured at deploy
time, and the GitHub Release link. A non-admin receives `403`; no token, provider
key or host path is stored or rendered.

The drift view compares what an environment actually runs with the latest
release in `${DATA_DIR}/release-status.json` (written by
`node scripts/verify-release.mjs --write …`). What it runs is the newest
deployment, unless a rollback was recorded after that deployment and names a
different commit or digest: then the environment is the rollback's previous
commit and digest, it carries no version, and it never reads `ok`. It reports:

- **behind** when the deployed version is older than the released version;
- **mismatch** when the deployed version is ahead, the tag commit differs, or a
  `/healthz` probe names a different commit or version;
- **unknown** when no deployment or no release snapshot is recorded, and for a
  rollback record that names no readable commit or digest;
- **ok** only when the version, commit and recorded health agree, and no newer
  rollback moved the environment.

Only **behind** and **mismatch** alert. `verify-release.mjs --deployment FILE`
performs the same comparison in the CLI, adds a `deployment` link and exits `1`
when the recorded deployment is behind or mismatched.

A promotion is written only after its canary checklist passes:

1. `/healthz` returns `2xx` with the promoted commit and version;
2. `/readyz` returns `2xx`;
   A status field that is present and non-empty must be an integer from 100 to
   599; anything else (a typo such as `2OO`, a word, a number out of range)
   blocks the write instead of being recorded as `200`. Only an absent field
   defaults to `200`. The same rule applies to the rollback form.
3. a named smoke job passed;
4. the error window has a measured duration, error count and the error threshold
   it is judged against;
5. the latency window has a measured duration, p95 and the p95 threshold it is
   judged against.

Missing evidence fails the gate; a failed gate writes an audit line and **does
not** create a deployment record. A window that claims `ok` without a threshold
is missing evidence, not a pass: the measured number alone proves nothing. The
admin page states which item blocked the promotion.

A rollback plan must name a previously recorded digest and commit, the owner and
the command the host owner will run. Fledge records that decision and checks the
resulting `/healthz` against the previous commit, but it never executes the
command. The command is recorded with token/secret assignments redacted, and a
value containing a host path is refused.

## 6. Reverse proxy

Ready-to-copy samples live in [`deploy/`](../deploy/): a systemd unit and an nginx
(these are the source of what `hugoxk-infra` installs, not a claim that production
boots from this exact unit — the infra host uses its own service wrapper)
server block. The nginx example:

```nginx
server {
  listen 443 ssl http2;
  server_name fledge.example.com;

  client_max_body_size 25m;

  # #1009: inherited by both locations; `always` covers nginx's own 4xx/5xx.
  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header X-Frame-Options "DENY" always;

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

server {
  listen 80;
  server_name fledge.example.com;

  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header X-Frame-Options "DENY" always;

  return 301 https://$host$request_uri;
}
```

The sample sets those four headers at server level, each with `always`, because
the app itself sends HSTS only when `BASE_URL` is `https` (`src/app.ts`) and the
responses nginx generates on its own — the 80→443 redirect and a 502 while the
app is down — never reach the app at all. Three rules keep that true: `always`
is required or nginx skips the header on 4xx/5xx; a `location` that declares
any `add_header` of its own stops inheriting the server set and must repeat all
four; and the sample must not rely on `BASE_URL` alone, because its documented
default is `http://localhost:8080`. A reverse proxy in front of this nginx keeps
its own copy of the set.

CI syntax-checks the example on every diff that touches `deploy/` or one of the
three scripts the contract delegates to (`scripts/check-nginx-config.sh`,
`scripts/check-systemd-unit.mjs`, `scripts/lib/systemdUnit.mjs`): `deploy-check`
installs nginx, then runs `scripts/check-deploy-samples.sh`, which renders the
example with generated certificates and loopback listens and parses it with a
real `nginx -t`. The wrapper it renders, `deploy/nginx.check.conf`, declares
`pid <tmp>/nginx.pid;` before `events {}` because `nginx -t` opens the pid path
while it initialises the cycle, and an unprivileged runner cannot open nginx's
compiled-in `/run/nginx.pid`; the result is a failed step and a red `ci-ok`
(#795). A runner without nginx is a failed step rather than a recorded gap
(#882): the install is the check's input, so its absence cannot be green.

The contract script also proves the check can fail. It appends an unknown
directive to a copy of the example and expects `nginx -t` to reject it, so an
invocation that accepts everything fails the job instead of passing it, and the
job summary says each check was real (`nginx: real`, `nginx: real negative
proof`). Locally, `bash scripts/check-deploy-samples.sh` runs the whole contract
and prints one line per check; `bash scripts/check-nginx-config.sh` is the nginx
half on its own.

The same half also asserts the four security headers statically on the rendered
sample — every top-level server block, each header with `always` (#1009) — and
the contract drives two negative copies through it: one with the framing header
deleted and one whose HSTS line lost `always`, both of which must be rejected
with the header named. That half is static on purpose: a proxied 2xx probe is
green today because the app already sends three of the four, so it could not be
the assertion.

The assertion also reads one level deeper (#1097). nginx does not merge header
sets: a `location` that declares any `add_header` of its own stops inheriting the
server-level set, so that path serves none of the four — including the
nginx-generated 4xx/5xx that `always` exists for. The sample states this trap at
`deploy/nginx.conf.example:19-21` but declares no such header, so nothing proved
the gate could see one. Now a `location` that declares a header anywhere in its
body must repeat all four with `always` at its own level, and the check fails
naming the location's opening line when it does not. The rule reads directives as
a token stream, so the shape does not matter: a one-liner
(`location = /health { add_header …; }`), a location whose `{` sits on the next
line, and a CRLF copy all read the same as the sample's indented form (the CRLF
copy used to fail with a missing-header message although every header was
present). The contract drives the shapes: a `Cache-Control` inside `location /`
(refused, location named), that location repeating the four (accepted, so the
rule cannot pass by refusing every location), and the one-liner in both forms
plus the brace-on-the-next-line copy.

Two further shapes close the same rule (#1097 security review). A `}` that
nginx keeps inside a token — a regex such as `location ~ ^/v}v[0-9]+` — does not
close the block, so the location is still read and one `add_header` there is
still refused; the control is the same `}`-in-token shape repeating the whole
set, which must be accepted rather than refused for carrying a brace. A `{` is
the other way round: nginx opens a block at every `{` outside a quoted string,
even in the middle of what looks like a token, so an unquoted regex quantifier
(`^/v[0-9]{1,3}$`) is invalid nginx (`unknown directive "1,3}$"` on nginx 1.18)
and must be quoted. The `${var}` form is the one exception, where the `{`
directly after `$` stays in the token; the contract's quoted-quantifier control
pins the accepted shape. And the shadowing level is not always a `location`: an
`if` (or `limit_except`) inside a server or a location that declares any
`add_header` drops the enclosing set for exactly the responses it applies to, so
that level is now judged on what it serves, named by its own opening line, and
accepted once it repeats the four. `include` stays unresolved in this static
half: an included file is not read, so a header set that arrives through an
`include` is still only covered by the real `nginx -t` parse, which is why that
step remains load-bearing.

The systemd sample is gated by a static parse, `scripts/check-systemd-unit.mjs`,
chosen over `systemd-analyze verify` because that binary is absent on a GitHub
runner and its output names the runner's unrelated units. It reads the sections,
the directive shape, duplicate keys — which systemd resolves silently to the last
value — and the keys that must name an absolute path, and it rejects a copy of
`deploy/fledge.service` with `ExecStart` removed. The job summary and the script's
own line call it `static`, so a static parse is never read as a live systemd run.

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

The entries are also combined, not only checked one at a time: a list whose union
is the whole IPv4 or IPv6 space is refused, because it trusts every caller
exactly as a `/0` would. Host bits are masked before the comparison, and an
IPv4-mapped entry counts as the IPv4 range it actually trusts (proxy-addr matches
a mapped subnet of `/96` or longer against IPv4 callers), so
`0.0.0.0/1,128.0.0.0/1`, `::/1,8000::/1` and `::ffff:0:0/96` all fail with
`TRUST_PROXY: ... together cover the whole IPv4 space` (singular `covers` for a
single entry) and the service does not boot until the env names the proxy address
or its narrow CIDR. A list that stops short of the whole space - three quarters of
IPv4, a bridge gateway, a Cloudflare-sized set - is accepted. A request address
that cannot be parsed at all, such as the nine-group value a trusted hop can
forward verbatim, falls into one shared rate-limit bucket instead of answering
500.

Set `BASE_URL=https://fledge.example.com` so cookies are `Secure` and email links
are absolute.

## 7. Backup and restore

```sh
npm run db:backup
# writes ${DATA_DIR}/backups/fledge-<ISO timestamp>.db via SQLite's online backup API
# set BACKUP_DIR to override; in Docker the default is /data/backups
# every copy is checked with PRAGMA integrity_check and pruned to its class's
# write-time count — BACKUP_KEEP_PLAINTEXT (default 1) plaintext copies,
# BACKUP_KEEP_ENCRYPTED (default 30) encrypted copies; --keep / BACKUP_KEEP
# overrides both for one run (an empty value is refused); a copy that fails the
# check is deleted and the run exits non-zero, so a failed backup never leaves a
# usable-looking file
# each copy gets a <copy>.json manifest: size, sha256, schema version and
# per-table row counts, written 0600 and deleted together with its copy
# plaintext is the default; with a backup key this writes fledge-<timestamp>.db.enc
# and the manifest records the ciphertext checksum plus the non-secret key id/version
# BACKUP_ENCRYPTION_REQUIRED=true refuses the run when no key is configured
# the plaintext copy an encrypted run is made from lives in a 0700 work directory
# outside the backup directory; BACKUP_WORK_DIR moves it (default: the temp dir)
```

### One writer per backup directory

A run takes the directory for its own length: `npm run db:backup` creates
`${BACKUP_DIR}/.fledge-backup.lock` exclusively before it writes anything and
removes it however the run ends. A second run started while the first holds the
directory — a cron tick meeting a manual backup — refuses instead of pruning
beside it:

```
backup: another backup run holds /data/backups (pid 4242); refusing to share the backup directory
```

That is exit 1, one line, and no copy is written or deleted. The lock is not a
wait: if the holder is gone (a `SIGKILL`, a host reboot) the next run takes the
lock over and proceeds, but only once the lock's own mtime is older than ten
seconds — a lock created milliseconds ago may belong to a run that is one
instruction from writing its pid, or to one whose exit handler is about to
release it. The takeover itself is serialised through
`.fledge-backup.lock.takeover`, an exclusive marker held only across the remove
and the recreate: several runs that judge the same dead lock stale can therefore
not delete each other's fresh lock and all write in the directory — the
concurrent-run defect the lock exists to stop. A lock file that exists but cannot
be read is only taken over once it is a minute old, so a run that is mid-creation
is never robbed. The lock and the marker both name their holder twice: the pid,
and the process start time the kernel gives that pid. The start time is what makes
a reused number harmless — a dead run's lock whose pid some unrelated process has
since inherited is alive by pid alone and refuses every run until that process
exits, while with the start time recorded the number is judged stale and the
takeover proceeds. A lock written before the field existed carries the pid only
and keeps the old meaning, so a live pid still refuses; nothing can tell a reused
number from its holder without it. The marker is released by identity for the
same reason: a run stopped inside the takeover for longer than the grace has its
marker swept and replaced, and when it resumes it removes only the entry it
wrote, leaving the current holder's marker — and the section it guards — alone.
The directory is also read as a directory of files: an entry that is not a regular
file (a directory or a symlink named like a copy) is never treated as a copy and
is never deleted — the writer and the dry run now use the same classifier, so a
copy the console counts is a copy the writer may prune.

### Backup retention and the dry run

The write-time counts are per class, and they are the counts the console reports
and the dry run applies: `npm run db:backup` prunes plaintext copies to
`BACKUP_KEEP_PLAINTEXT` (default 1) and encrypted copies to
`BACKUP_KEEP_ENCRYPTED` (default 30), so the encrypted copies an instance keeps
do not consume the plaintext copy the restore drill reads. `--keep` /
`BACKUP_KEEP` is an explicit override of both counts for that one run — the
`retention=` line prints `override=--keep` beside the two counts it applied —
not a second policy. An explicitly supplied but empty value (`--keep ""` or
`BACKUP_KEEP=""`) is refused with exit 2 instead of being treated as absent, and
the copy a run writes is always among the copies its class keeps, even when an
older copy carries a future mtime:

| Env | Default | What the scan keeps |
|---|---|---|
| `BACKUP_KEEP_PLAINTEXT` | `1` | plaintext `fledge-<stamp>.db` copies (`npm run db:backup` writes one on the host) |
| `BACKUP_KEEP_ENCRYPTED` | `30` | encrypted `fledge-<stamp>.db.enc` copies |

Both are read by `loadConfig`, by the writer that deletes and by the scan
itself, so the policy is in the repository instead of only in a host wrapper and
the three cannot disagree about what is kept. A value that is not a positive
whole number is refused — `0` would erase every copy of that class — rather than
clamped.

`node scripts/backup-prune.mjs` prints what the next run with those counts would
take and **deletes nothing**. It lists each copy beyond its class's keep count
with its age and reason, and the manifest and the `-wal`/`-shm` sidecars that
belong to that copy:

```sh
node scripts/backup-prune.mjs                  # dry run against BACKUP_DIR, human output
node scripts/backup-prune.mjs --json           # same decision for a script or the console
node scripts/backup-prune.mjs --keep-plaintext 2 --keep-encrypted 30
```

The `<section id="backups">` card on `/admin` shows the same number as
`Expired copies: N (dry run)`, read through the same `planBackupExpiry()` helper,
so the operator sees what the next run would take without opening a copy. This
tip has no `--apply`: confirm the counts first, and the first real deletion stays
the owner's.

The scan stays strict where it decides: `node scripts/backup-prune.mjs` exits
non-zero on a directory it cannot read, and on a `BACKUP_DIR` that exists but is
a regular file (`ENOTDIR`), because neither may read as "nothing to prune". Only
a missing directory scans as empty, which is the first boot before any copy is
written. The card is the surface an operator opens when backups are already
broken, so a failed scan there is a row — `scan failed: <errno>` beside the
configured counts — instead of a failed `/admin` request; the copy counts the
page can still read are shown as usual.

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
command line, and never commit it. A value that is a base64-encoded 32-byte key is
used as the key; any other value is a passphrase, stretched with scrypt using a
random salt per copy. Because a 32-byte base64 key is 44 characters, a truncated
one still looks like base64: a value that is base64-shaped but decodes to 16–31
bytes is therefore refused with a non-zero exit naming the source and the byte
count, instead of silently becoming a passphrase and encrypting the copy under a
key you did not set. **To declare a passphrase, pick a value that is not
base64-shaped, or whose base64 shape decodes to no whole number of bytes** — one
space or one character outside the base64 alphabet is enough, so
`correct horse battery staple` works, and a 25-character all-alphanumeric value
such as `correcthorsebatterystaple` works too because `decodeBase64` returns
`null` when `length % 4 === 1`. What is refused is a base64-shaped value that
decodes into the window, such as `abcdefghijklmnopqrstuvwx` (24 characters,
18 bytes, exit 2). The window is exactly those 16–31 decoded bytes: a
base64-shaped value of 32 bytes is the key itself, and one of 33 bytes or more
(or 15 or fewer) is not a truncated 32-byte key, so it stays a passphrase — the
boundary is `TRUNCATED_KEY_MIN_BYTES`/`TRUNCATED_KEY_MAX_BYTES` in
`scripts/lib/backup-crypto.mjs`. The refusal is a **write-side** guard: the
restore drill still derives a copy written under a base64-shaped passphrase,
because the only way to read an existing copy is the derivation it actually used,
and GCM authentication decides whether the value reproduces it. The encrypted file
is a JSON envelope header
(format version, the key
derivation `raw` or `scrypt`, key id and key version, scrypt salt when used, IV,
GCM authentication tag) followed by the ciphertext. The key itself is never in
the envelope or the manifest. Set exactly one key source; setting both is refused
instead of guessing, and a source that is present but empty —
`BACKUP_ENCRYPTION_KEY=` from a secret that expanded to `""`, or an empty key file
— is refused with a non-zero exit naming that source, rather than falling back to
a plaintext copy.

The derivation a copy needs is recorded: the envelope, `manifest.encryption.kdf`
and the `encryption=… kdf=… key_id=… key_version=…` line the backup and the
restore drill print all say `raw` or `scrypt`, so whoever restores a copy knows
whether to supply a 32-byte key or a passphrase without matching ids by hand. A
manifest written before the field existed still validates; `kdf` is new
information, never a requirement to read the copy. A key file readable by group
or others still backs up — refusing at 03:00 over a mode bit would be a worse
failure than the warning — and the run prints a warning naming the path and the
mode it found.

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

**Where the plaintext copy is taken.** An encrypted backup is made from a
plaintext copy of the database, and that copy is never written into the backup
directory: it goes into an owner-only (`0700`) work directory outside it, as
`fledge.db.plaintext.tmp` at mode `0600`, and the directory is removed however
the process ends — including every non-zero exit. The work area defaults to the
system temporary directory; set `BACKUP_WORK_DIR` to move it, which matters when
`/tmp` is a tmpfs or a container's small filesystem, because it needs room for one
copy of the database. A process killed outright (OOM, `SIGKILL`, power loss)
cannot clean up after itself: the next backup sweeps `fledge-backup-*` and
`fledge-drill-*` work directories older than an hour, and `prune` collects a
`*.plaintext.tmp` an older tip left in the backup directory once it is that old.
Anything younger is left alone, because during a rolling restart it may belong to
a backup that is still running. A copy of the backup directory therefore never
contains a readable database, whatever happens to a run.

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
check` is what an empty directory says. An encrypted copy is listed the same
way: its manifest's size and `sha256` cover the file on disk, so the card
compares the ciphertext and reads the age from the name. The restore drill
writes `${DATA_DIR}/backup-drill.json` when `DATA_DIR` is set (or the path passed
with `--status-file`), and the card shows that record's time, `ok`/`failed`,
RTO/RPO and the column check as its own row — `列检查：通过 / column check:
passed`, `列检查：未运行（未提供密钥） / not run (no key given)` when the run
carried no key, `列检查：未到达（本次运行在检查前失败） / not reached (the run
failed before it)` when it carried a key and died first, `列检查：失败 / failed`
with the column names, or `列检查：未记录 / not recorded` for a record written
before the field existed. A drill whose column check did not pass never reads as
an unqualified `成功 / ok`: the success word carries the qualification. It says
`none recorded` only when that file is absent or unreadable, so the card never
shows a green it cannot prove.

The same two readers publish five series on `/metrics` at scrape time, so the
backup can page without somebody opening the card: `fledge_backup_age_hours`,
`fledge_backup_copies`, `fledge_backup_encrypted_copies`,
`fledge_restore_drill_age_hours` and `fledge_restore_drill_ok` (`1` only for a
successful drill inside the expected interval; with no drill record at all the
scrape publishes neither the verdict nor the age, so a fresh install cannot trip
the rule, while a drill that ran and failed or aged out reads `0` beside its age
series). The drill gauge follows the card's column check: a record whose
`columnCheck` is `fail` or `not-reached` reads `0` even beside an `ok: true`,
because that record is not a passing drill on the page either; `skipped` keeps
reading `1`, since a host with no column key configured has not failed a drill
and paging it on every scrape would be the wrong alarm. Two rules in
`deploy/prometheus/fledge-alerts.yml` use them:
`FledgeBackupStale` at `fledge_backup_age_hours > 26` — raise that number in the
rule if you raise `BACKUP_EXPECTED_HOURS` — and `FledgeRestoreDrillFailing` at
`fledge_restore_drill_ok == 0`. The platform also raises one in-app ops alert per
problem through `OPS_ALERT_COOLDOWN_MINUTES`: a stale copy, a failed drill, or a
drill older than the expected interval. A platform that has never written a copy
raises nothing; the card's `no backup copy recorded yet` is the answer there.


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
# The column key lives in the root-only env file. Derive it into an owner-only
# file so it never appears on a command line, and remove it when the run ends:
# a drill that refuses a bad copy exits non-zero, so a plain `rm` after it would
# be skipped exactly when the key matters most. The subshell's EXIT trap runs on
# success and on every failure.
sudo sh -c 'umask 077; sed -n "s/^TOKEN_ENCRYPTION_KEY=//p" /etc/fledge/fledge.env > /var/tmp/fledge-column.key'
( trap 'sudo rm -f /var/tmp/fledge-column.key' EXIT
  npm run db:restore-drill -- --db "$DB_PATH" --backup-dir "$BACKUP_DIR" --status-file "$DATA_DIR/backup-drill.json" --secret-key-file /var/tmp/fledge-column.key )
# a keyring host passes the JSON file TOKEN_ENCRYPTION_KEYS_FILE names instead
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
- `--status-file <path>` records the result for `/admin`:
  `{at, ok, detail, columnCheck, columnErrors}`, mode `0600`, written atomically.
  With neither the flag nor `DATA_DIR` the drill writes nothing, so a CI run
  cannot touch an operator's data directory. A failed drill overwrites the last
  success with `ok:false`, so the card never shows a stale green.
- `--secret-key-file <path>` proves the copy's encrypted columns still open: one
  payload per ciphertext column (`users.github_token_enc`, `repos.token_enc`,
  `jobs.callback_secret_enc` and the other `*_enc` columns an application schema
  carries) is decrypted with the key at that path. The file holds one base64
  32-byte key, or the keyring JSON `{"<id>": "<base64 32 bytes>"}` a keyed host
  already uses, so a `v2:<id>:…` payload passes with the id it names and fails
  naming that id when the file does not carry it. The drill records
  `columnCheck: pass`, `fail` (with the failing `table.column` entries in
  `columnErrors`, exit non-zero), `skipped` when the flag is absent, or
  `not-reached` when the flag was given but the run died before the check — the
  last two are different facts, and only the first of them means "no key given".
  The previous verdict and exit code are unchanged, and an unrun check is never
  reported as a pass. The drill never reads the key from its own environment and
  never imports the application's config; the block above removes the key file
  with an `EXIT` trap, so a refused copy does not leave it behind.
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

### Previous-release restore check

`db:restore-drill` proves that a copy *this* build wrote can be restored; it
cannot prove that a database the *previous release* wrote still opens here. A
column that is renamed or dropped without a migration passes the drill and
breaks a real upgrade, so a small fixture written by an older release is kept and
restored on every run.

- Fixture: `test/fixtures/prev-release/fledge.db.gz` (one user, one repository,
  one finished job; 696,320 bytes of SQLite gzipped to ~14 KB) with
  `provenance.json` beside it.
- The check: `npm run build && npm run db:prev-release:restore`. The suite runs
  the same function on every `npm run check`, so it also runs on every PR and on
  `main`; the command is for an operator who wants the sentence without the whole
  suite. It exits 0 with `previous-release restore: ok <tag> schema <from> ->
  <to>, N tables, M rows` and exits 1 with `FAIL (<code>) — <reason>` otherwise.
- What it proves: the fixture decompresses to the bytes `provenance.json`
  records; its schema version is **older** than `SCHEMA_VERSION` (a fixture
  regenerated from the current build is refused as `not-older`, because it would
  prove nothing); the current `Store` opens it and migrates it to exactly
  `SCHEMA_VERSION`; every table and every column the fixture recorded still
  exists (`schema-lost` names the first five that do not, which is what a rename
  without a migration looks like); the row counts do not shrink (`rows-lost`);
  and the repository's encrypted credential decrypts with the fixture key
  (`key-mismatch` otherwise — a wrong or lost key never reports a pass).
- The fixture key is not a secret: `Buffer.alloc(32, 7)`, base64-encoded, named in
  `src/lib/prevRelease.ts`. The fixture holds no real token, no production data
  and no live database; it is generated from a release tag's own `Store`, never
  from a backup.
- Regenerate it when a release is cut, so the newest tag becomes the fixture's
  tag and the check exercises the migration from that schema:

  ```sh
  npm run db:prev-release:fixture -- --tag v0.3.6
  ```

  That command creates a git worktree at the tag, copies
  `scripts/fixtures/build-prev-release-db.ts` into it, links this clone's
  `node_modules`, writes the database with *that* build, compacts it to one
  journal-delete file, gzips it, and rewrites `provenance.json` (tag, commit,
  sha256 of the decompressed bytes, schema version, row counts, column lists).
  It writes only those two files and removes its worktree afterwards.

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
stops the drill before it can produce a `restored.db`. The column key is passed
the same way, so a copy whose credentials no longer open is refused here — a
non-zero exit takes the `else` branch and `restored.db` is never copied in:

```sh
sudo systemctl stop fledge
sudo install -d -m 700 /var/tmp/fledge-restore
sudo sh -c 'umask 077; sed -n "s/^TOKEN_ENCRYPTION_KEY=//p" /etc/fledge/fledge.env > /var/tmp/fledge-restore/column.key'
if BACKUP_ENCRYPTION_KEY_FILE=/etc/fledge/backup.key npm run db:restore-drill -- --db "$DB_PATH" --backup-dir "$BACKUP_DIR" --work-dir /var/tmp/fledge-restore --secret-key-file /var/tmp/fledge-restore/column.key; then
  echo "restore-drill: OK"
else
  echo "drill failed; do not restore from this copy" >&2
  # remove the key before the block stops: `exit 1` skips every line after `fi`
  sudo rm -f /var/tmp/fledge-restore/column.key
  exit 1
fi
# the column key was only needed for the check above
sudo rm -f /var/tmp/fledge-restore/column.key
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
GHCR and creates the GitHub release against the tag; the tag itself is written by
the daily release job through the Git data API (`POST /git/tags` +
`POST /git/refs`) once the mechanical release pull request is merged, so a tag on
`main` is evidence of a released version, not of a rollout.

### Who actually deploys production

Production execution is owned by the private **[`hugoxk-infra`]** repository, not
by this one. The files under `deploy/` here are the source and the contract — the
nginx sample, the systemd unit, the journald drop-in, the deploy scripts and the
tests that gate them — and `hugoxk-infra` is where they are installed and run.
Read that repository for the authoritative host layout; this page documents what
it runs and what the tag deployer verifies.

`hugoxk-infra/config/crontab.txt` drives two paths, and they deploy different
things:

```sh
# Daily: update the service from main
0 16 * * *  /home/xuke/work/service-update-all.sh

# Every ten minutes: deploy the newest release tag
*/10 * * * * /home/xuke/work/fledge-deploy-tag.sh

# Every thirty minutes: refresh the release-chain verdict for /admin
*/30 * * * * /home/xuke/work/fledge-verify-release.sh
```

- **The daily `main` update** — `service-update-all.sh` → `service-update-fledge.sh`
  — fetches `origin/main`, merges it into the `server-deploy` branch on the host,
  builds and restarts. It moves the host to whatever `main` holds, independent of
  tags, so an unreleased fix can be running in production.
- **The tag deploy** — `fledge-deploy-tag.sh` — deploys the newest `vX.Y.Z` only
  when it is newer than the running `package.json`, from a detached tag worktree.

**Which one wins:** when they disagree, the tag deploy does not roll
`server-deploy` back and the daily update does not wait for a tag — the host ends
up on whichever ran last, and the newest release tag remains the release of
record. A host on `main` after a daily update can therefore be ahead of the newest
tag, which is why `release-status.json` reports the release chain separately from
the running commit; `/healthz`'s `commit` is the running artifact, not a release.

The tag deployer's preflight, before it switches the service: the tag is
**annotated**, it is an **ancestor of `origin/main`**, the whole published release
chain verifies (`fledge-verify-release.sh` / `verify-release`), and dependencies
are installed with **`npm ci --ignore-scripts`**. A missing or failed check leaves
the host on the release it was running and the next tick retries the same tag.

The three commands at the top of this section are the manual fallback for a host
where those scripts are not installed. On the production host they are what the
infra timers run; nobody has to follow them by hand.

[`hugoxk-infra`]: https://github.com/HugoXK/hugoxk-infra

## 9. Monitoring

- `GET /healthz` for liveness — unauthenticated, always `200`, and never gated.
- After a deploy, compare `/healthz`'s `commit` with the commit you deployed: a
  mismatch or `unknown` means the running artifact is not the one you intended.
  The field needs the bearer, so ask with
  `curl -H "Authorization: Bearer $METRICS_TOKEN" https://<host>/healthz`; without
  it the key is absent by design, not a deploy failure.
- Watch for `level:"error"` in structured logs.
- Clock skew: a wrong host clock shifts every stored timestamp, every digest line
  and every scheduled run, and the container cannot be trusted to keep time on its
  own. `GET /readyz` carries `clock.skewSeconds` — the last measured offset from
  GitHub's `Date` header, positive when the process is ahead — and it is `null`
  when nothing has been measured, never `0`:

  ```sh
  curl -s https://<host>/readyz | jq .clock
  curl -s -H "Authorization: Bearer $METRICS_TOKEN" https://<host>/metrics \
    | grep fledge_clock_skew_seconds
  ```

  An **absent** `fledge_clock_skew_seconds` line means "not measured" — no App
  configured, GitHub unreachable, or a `Date` header the client could not parse
  (a rewriting proxy) — and is not evidence that time is right.
  `FledgeClockSkewHigh` fires on `abs(fledge_clock_skew_seconds) > 120` for ten
  minutes. Fix the host clock (`timedatectl set-ntp true`, or start the container
  with a host that keeps time); Fledge reports the drift and never rewrites a
  stored timestamp to hide it.

  The measured offset is used, not only shown. `clock.state` says what the last
  measurement means, and `clock.thresholdSeconds` carries the number it is
  compared against — `CLOCK_SKEW_FAIL_SECONDS` in `src/repos/app.ts`, which must
  stay equal to the `120` in `deploy/prometheus/fledge-alerts.yml`:

  | `clock.state` | meaning | `/readyz` |
  |---|---|---|
  | `not-configured` | no GitHub App on this deployment, so nothing is measured | `200` |
  | `ok` | measured at most 15 minutes ago and within 120 s | `200` |
  | `unknown` | never measured, or the last reading is older than 15 minutes | `200`, except a configured App that has never measured after 15 minutes of uptime: **`503`, `ok:false`** |
  | `fail` | the last measurement is outside 120 s | **`503`, `ok:false`** |

  In `fail` the platform refuses to start work: `Jobs.enqueue` answers
  `CLOCK_SKEW` (counted as `fledge_admission_rejected_total{reason="clock_skew"}`)
  before any job row is written, and the console banner names the measured
  seconds. App JWTs are signed only in `ok`; `fail` raises `CLOCK_SKEW_EXCEEDED`
  and `unknown` raises `CLOCK_SKEW_UNVERIFIED` instead of signing with a stale or
  zero correction. A GitHub outage therefore stops App calls after at most 15
  minutes rather than serving a signature nobody re-measured. Fix the clock, then
  confirm `/readyz` is `200` again — the next measurement (at most five minutes
  after a `fail` or an unmeasured `unknown`) clears it, and the scheduler takes
  that reading on its own tick rather than waiting for App traffic.
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
`$DATA_DIR/mail-outbox/*.eml`. It is a dev aid (`npm run mail:outbox`), and an
instance with SMTP does not write it. Each run of `npm run mail:outbox` first
deletes every `.eml` older than `MAIL_OUTBOX_RETENTION_DAYS` (7 by default) and
then prints the newest one, so the directory is never a store of account
identifiers: the file name is a stamp plus an opaque id, never the recipient,
and the address lives only inside the file. The directory may be deleted at any
time.

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

### Data retention windows

`pruneOldData` runs in the scheduler tick (at most hourly) and deletes rows older
than a per-class window. Each window is an environment variable; unset takes the
built-in value, which is the number the service already enforced:

| Variable | Class | Default |
|---|---|---|
| `RETENTION_OAUTH_STATES_DAYS` | `oauth_states` | 7 |
| `RETENTION_APPROVAL_TOKENS_DAYS` | `approval_tokens` (expired or used) | 30 |
| `RETENTION_NOTIFICATIONS_READ_DAYS` | read `notifications` | 30 |
| `RETENTION_NOTIFICATIONS_UNREAD_DAYS` | unread `notifications` | 90 |
| `RETENTION_EVENTS_DAYS` | `events` | 90 |
| `RETENTION_JOB_EVENTS_DAYS` | `job_events` | 365 |
| `RETENTION_WEBHOOK_DELIVERIES_DAYS` | `webhook_deliveries` | 30 |
| `RETENTION_OUTBOX_SENT_DAYS` | sent `notification_outbox` | 30 |
| `RETENTION_OUTBOX_DEAD_DAYS` | dead/blocked `notification_outbox` | 90 |
| `RETENTION_OUTBOX_UNKNOWN_DAYS` | unknown `notification_outbox` | 365 |
| `RETENTION_JOBS_DAYS` | finished `jobs` | 365 |
| `RETENTION_DELIVERY_OUTCOMES_DAYS` | `delivery_outcomes` (by `merged_at`) | 365 |
| `RETENTION_AUDIT_LOG_DAYS` | `audit_log` | 365 |
| `RETENTION_QUOTA_LEDGER_DAYS` | `quota_ledger` | 730 |

An unset window is the default, never "keep forever", and a value that is not an
integer or is below 1 falls back to the default rather than being read as zero
(zero here would mean "delete every row"). `sessions` are removed by
`expires_at` and `api_tokens` have no age window; neither is configurable here.

The store refuses as well as the config. `Store.pruneOldData` throws on a window
that is not a whole number of days of at least 1 — including a caller that passes
`{ jobs: 0 }` directly, which without the guard would delete every finished job —
and it refuses before the first delete, so a call that cannot be honoured removes
nothing.

Preview any change before making it. The tool opens the database read-only, holds
no write lock, prints one `count=` line per class and two states instead of a
number:

```sh
sudo -u fledge DB_PATH=/var/lib/fledge/fledge.db node scripts/retention.mjs --dry-run --days 30
```

`--days` is required; it never guesses a window. `--dry-run` is accepted for
symmetry with `npm run artifacts:prune`, and the tool never deletes rows with or
without it. The output is counts only — never a row body, login, email or token
value — so the preview can be pasted into a log. The same counts for the
configured windows appear on `/admin`'s **Data retention** card, with an unset
window marked `default`.

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
