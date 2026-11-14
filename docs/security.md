# Security

## Assets

- GitHub OAuth client secret and OAuth tokens.
- Per-repository fine-grained GitHub tokens.
- User-owned model API keys.
- Platform model key.
- SMTP credentials.
- Session and approval tokens.
- The audit trail.

## Controls

### Secrets at rest

GitHub tokens and user model keys are encrypted with AES-256-GCM using
`TOKEN_ENCRYPTION_KEY` (32 bytes, base64). The ciphertext format is
`v1:<iv>:<tag>:<ciphertext>`; the key is never written to the database. A lost key
means tokens must be re-entered, so back it up separately from the database.

### Repository token scope

A repository token must read the upstream repository, create a fork when the
user is not the upstream owner, push to the fork, and create issues/pull
requests on the upstream. Fledge refuses a token whose GitHub login differs from
the signed-in user. The token is never sent to the bridge; the agent fetches it
from the job-scoped credential URL.

### Per-repository FlyBot isolation

Each hosted repository runs in its own container with a private data volume,
network, bridge token and model proxy. The model proxy injects a user-scoped
`flg_` token, so the instance cannot use the operator's model key. The shared
operator FlyBot is not used for user jobs. A container is limited by CPU,
memory, PID and filesystem mounts; stopping or deleting a repository affects
only that container.

### API tokens

- A personal `flg_` token is a gateway capability with two properties: a `scope`
  and an `expires_at`. `gateway` is the only scope the code enforces today and is
  the default for every row, including tokens created before the column existed.
- A new personal token always gets a finite lifetime: the create form offers the
  choices in `PAT_EXPIRY_CHOICES` and `PAT_EXPIRY_DAYS` (default 90) is the
  fallback. A token without an expiry is an operator decision: only an
  `admin`/`superadmin` may mint one, and the route refuses `never` for anyone
  else by name.
- Tokens minted before this existed are given one finite window from the upgrade
  (`pat_expiry_backfilled` in `settings`, a one-time backfill), so no live token
  dies at the moment of the upgrade and none stays permanent by accident.
- The upgrade window is fixed at `DEFAULT_PAT_EXPIRY_DAYS` (90), not at
  `PAT_EXPIRY_DAYS`: the backfill runs inside the store migration, which has no
  configuration, so an operator who wants a shorter window for legacy tokens
  revokes and re-mints them.
- Job-issued tokens (`kind = 'job'`, `kind = 'instance'`) keep the lifetime their
  own lifecycle sets; the backfill only touches `kind = 'pat'`.
- A gateway call writes the model and the cost onto a job only when the token's
  `kind` is `job` and that job belongs to the token's user. The `job:` prefix in a
  token name is a label, never the binding: a personal token may be named
  anything, so a name that claims a job it does not own is refused with
  `403 invalid_job_token` before the upstream call (#481). A job token whose job
  has been deleted still runs and records nothing.
- The gateway refuses an expired or revoked token with `401 invalid_api_key` and
  a token whose scope is not `gateway` with `403 insufficient_scope`. A refused
  scope does not write `last_used_at` and no refusal echoes the secret.
- Revoke stays one click in Settings and writes `token.revoked` to the audit log;
  the list shows the scope, the expiry date and the last-used time.

### Sessions

- 32-byte random session id; only its SHA-256 hash is stored.
- Cookie: `HttpOnly`, `SameSite=Lax`, `Secure` when `BASE_URL` is HTTPS, 30 days.
- The `fledge_lang` preference cookie is `HttpOnly`, `SameSite=Lax`, valid for
  one year, and stores only `zh` or `en`; it carries no identity. The UI keeps it
  in step with the platform-wide `hugoxk-lang` localStorage preference.
- Logout deletes the session row and clears the session and CSRF cookies; the
  language preference remains.
- Settings lists the signed-in user's live sessions (masked IP, client string,
  sign-in time, and which row is the current one). Revoking a row, or "sign out
  other sessions", deletes rows scoped to `user_id` and writes `session.revoked`
  to the audit log; a foreign or unknown hash deletes nothing and answers the
  same way, so the page cannot probe another account. Revoking the current row
  is refused by name - that is what "rotate this session" is for (new cookie,
  old hash deleted) - and every mutation is CSRF-guarded.
- The list never prints a full address (the last IPv4 octet, or everything past
  the second IPv6 group, is dropped) and never prints another user's rows.
- Expired sessions are swept every minute.

### Recent re-authentication

A session cookie lives 30 days, so the cookie alone is not evidence that the
person at the keyboard is still the GitHub account behind it. Destructive writes
therefore require a GitHub confirmation inside `RECENT_AUTH_MINUTES` (default 15),
tracked as `sessions.recent_auth_at`:

- Gated actions: repository delete, turning a repository's auto-merge on or off,
  quota changes, API-token creation and revocation, admin approve/reject, and
  stopping a FlyBot instance. Reads and normal job actions are unaffected.
- A session that has not re-authenticated (`recent_auth_at` is `NULL`, which is
  also every session that predates this control) is refused, audited as
  `recent_auth_required` with the action and path, and redirected through
  `/auth/github/reauthorize?next=…` to the form it came from.
- That refresh updates the existing session row instead of creating a new
  session, so the returning form keeps its CSRF token; the form explains why it
  came back and the action is submitted again.
- Role checks still run first: a non-admin is refused with 403 before the
  recency check, and a fresh re-authentication does not grant a role.
- The same handlers are rate-limited (60 attempts a minute per route and client
  address) through `@fastify/rate-limit`, registered with `global: false` so the
  ceiling is a property of the eight routes that name `config.rateLimit` and
  nothing else. The key generator is `rateLimitKey` over the address
  `TRUST_PROXY` resolves, so a caller cannot mint a new bucket with a header or a
  form field, and a refused attempt answers the plugin's 429 before the handler —
  and therefore before anything is written or audited.

The ceiling is `max: 60` in a `timeWindow` of `60_000` ms, counted per route and
per bucket, and it has no environment knob by design: the only way to loosen or
revert it is to edit the two constants of `destructiveLimit` in `src/app.ts`
(`max` and `timeWindow`) or to revert the commit that registered it, and
loosening it gives up exactly the property above.

A burst from one account — a batch of approvals, or a script driving several
destructive calls — can therefore answer 429 inside a minute, and that is the
control working, not a defect: the request was refused before anything was
written or audited, and it succeeds again once the window has passed.

### CSRF

Every state-changing browser form includes a hidden `csrf` field derived from
`HMAC(SESSION_SECRET, sessionHash)`. The server also accepts `X-CSRF-Token` for
JSON endpoints. Approval links and job endpoints use their own bearer secrets
and do not use CSRF.

### GitHub App installation isolation

The install `state` is a CSRF marker only; it does not prove ownership. The
setup callback binds an installation only after a verified webhook sender, the
user's OAuth installation list, or an individual-account login match; an
existing binding cannot be moved to a different Fledge user. Installation
tokens stay in memory and are never stored in SQLite. A user cannot list or use
an installation bound to another user.

### GitHub App

- The private key lives outside the repository (`GITHUB_APP_PRIVATE_KEY_PATH`,
  mode 0600). The App JWT is held in memory and never logged.
- Installation tokens are cached in memory only until shortly before expiry and
  are never stored in SQLite. Repositories with `installation_id` use the
  installation token for jobs by default, so the token is limited to the App's
  repository permissions. Set `GITHUB_APP_USER_TOKEN=true` to opt in to the
  signed-in user's OAuth token for attribution; that token can be broader, so it
  is off by default. PAT repositories keep the encrypted token path.
- The setup callback only binds an installation to a user after checking the
  user's OAuth installations (or an individual account match).
- `POST /api/github/webhook` verifies `X-Hub-Signature-256` on the raw body
  before parsing. A bad signature is 401; an unconfigured webhook is 503.
  Verified event metadata is stored without payload secrets.

### Notification email display

The settings page masks the notification and GitHub email (for example
`k***@zju.edu.cn`); the full address is not rendered in the HTML, and leaving the
field blank keeps the current address instead of silently clearing it. The
admin panel still shows the contact email to administrators for account
management, and approval mail includes it as required. The address is used only
for job/digest mail and is never shown on a public page.

### Transactional email rendering

Every transactional mail now renders through one shared HTML shell beside its
plain-text part. The shell uses inline styles only, no `<style>` block, external
stylesheet, web font or remote image, and a 640px measure that stays inside a
360px client. User-controlled values are escaped before interpolation, and the
footer links are fixed docs/status URLs rather than request input. A failure or
urgent mail keeps its red banner and subject marker in both parts.

### Inbound email

`POST /api/inbound/email` is disabled unless `INBOUND_EMAIL_SECRET` is set. The
caller must present the secret in `X-Fledge-Email-Secret`; the reply token is
single-purpose, expires after 7 days, and resolves to one user + repository. The
sender must match the user's notification email. Quoted lines are removed, the
text is capped, and the action is audited. The endpoint does not expose the DSH
or bridge tokens.

### Agent workspace proxy

The workspace proxy is owner-only and same-origin. The session cookie and repo
ownership are checked on every HTTP request; WebSocket upgrades check the same
session hash, user status and repo owner. The Fledge team console and its SSE
stream remain superadmin-only. The DSH token is read from the
instance log and exchanged for a DSH cookie server-side; that cookie and the
token are never sent to the browser. Upstream `Set-Cookie`, CSP and
`X-Frame-Options` headers are stripped; the proxied document is scoped to the
workspace path and carries the Fledge brand assets. The DSH loopback port is
never exposed.

### Team observation

Tool/step strings and per-role call counts are operational metadata; they are
shown only to the repository owner and admins. They never include prompts,
tokens or full command output (the step is capped and the DSH UI remains the
place for details). No new public surface is added.

### Webhook follow-up

Webhook deliveries are deduped by `X-GitHub-Delivery` in `settings`; the same
failure on the same head SHA is deduped again. Only PRs with an existing Fledge
job are followed up, and a repo with an active job is skipped. Follow-up jobs
reuse the original branch and PR; they never create a second PR or issue. The
webhook signature is verified before any parsing or enqueue.

A default-branch `workflow_run.completed` failure is ingested from that same
signed webhook. The payload is untrusted: only the workflow name, run id,
attempt, branch, SHA and `html_url` are read, each is length-bounded, they are
escaped where the console renders them, and `html_url` must start with
`https://` before it becomes a link. Intake stores the failure and the reason it
will not be triaged; it does not read job logs, so no log content can reach a
model, a report or the database in this slice. A later slice that fetches a log
must redact it before any slice or model input.

### Job cost, evidence and metrics

`events` stores activation/intervention names, user/repo/job ids and a short
meta string (for example `guidance:lead`); it never stores prompts, tokens or
full answers. Evidence strings (`tests`, `checks`, `rollback`) are written by
the agent and rendered on an super-admin-only job page; they must not contain
secrets. `/admin/metrics` is admin-only and read-only.

### Job summaries, errors and digests

A runner's `summary`, `error` and callback `checkpoint` are free text, and so are
the issue/PR links a run reports: a model or a bridge script can echo a token into
any of them, and the job page, the notification mail and the next run's prompt
then repeat it. Three layers apply to that text:

- `redact()` (`src/lib/secrets.ts`) runs **before** every slice, so a truncation
  cannot leave a fragment (`ghp_…` with the body cut off) that no pattern matches.
  It recognises the token shapes (GitHub, `sk-`, `flg_`, AWS, PEM, bearer,
  `api_key:`) and the literal values of secrets that have no shape — the SMTP
  password, model key, session secret, webhook secret, bridge token — which
  `loadConfig()` registers through `registerRedactionSecrets()`.
- Both writers, `updateJob()` and `claimJobTerminal()`, send `summary` and `error`
  through one helper, so a caller that skips the job service (a retry, an admin
  action, a future runner) cannot store a raw value either.
- The render pass redacts again: the summary cell, the job page's technical-detail
  block and the admin jobs table. Rows written before this control still hold the
  raw text, and a stored value is not proof that the page is clean.

### Job email notifications

Job and digest mail is sent from `MAIL_FROM` only to the super admin's configured
`notify_email` (falling back to the GitHub email). It contains the repo, job id,
issue/PR links, a summary or question text, daily spend and a link to the team
console; it never contains a GitHub token, model key, bridge token or full
prompt. The owner can set the address, disable job mail and disable the daily
digest in Settings; approval and quota mail stay transactional. A question is
mailed at most once per `sessionId + questionId`; a digest is sent once per user
per day. Test mail is rate-limited to one per minute.

### Roles, admin scope and preview

- `user`, `admin` and super admin (`superadmin`) are platform roles. The configured
  primary login is promoted to owner on startup; only the super admin can promote or
  demote admins and set unlimited quota. The one-off CLI is
  `npm run role:set -- <github-login> <admin|user>`; it refuses to change the
  owner role. This runs the built `dist/`; for a source checkout use
  `npm run role:set:dev -- <github-login> <admin|user>`.
- Admin management is scoped: an admin sees themselves and normal users, never
  another admin or the super admin. Admin jobs and audit rows are filtered to that
  visible set and actor names are masked in the admin audit view. The owner sees
  all users and actions.
- The two admin CSV exports (`/admin/export/jobs.csv`, `/admin/export/audit.csv`)
  leave one `admin.jobs_export` / `admin.audit_export` row per file recording
  `filters=` (the allow-listed codes and ISO dates verbatim), `rows=`, `scope=`
  (`all` for the owner, `users:<n>` for a scoped admin), and `sha256=` over the
  exact bytes sent, so a file found elsewhere can be matched to its row. Free-text
  filters (`q`, `action`) are recorded only as `<length>ch#<8 hex>`, because an
  admin may search by an address; no trail field carries an address or a fragment
  of an exported row. The search page shows the newest export for the viewer's
  scope, and the read is paged so one query never materialises the 5000-row cap.
- The super-admin-only preview cookie renders the normal-user UI while leaving the
  actual session owner-scoped behind the scenes. The owner workspace is available
  in preview like a normal-user page; advanced team routes remain blocked.
- Repository roles are per user-repository connection: `maintainer` or
  `developer`. The allowed roles come from the user's GitHub permission
  (`admin`/`maintain` may choose either; all other permissions may only choose
  `developer`). The server validates the choice against the GitHub permission
  recorded from the last add/refresh, never trusts a hidden form value, and does
  not let platform admins assign the role. A refresh or a stale-role recheck
  before review/auto-merge downgrades a maintainer to developer when the
  permission is lost. Auto-merge is an explicit maintainer-only switch and is
  off by default; Fledge verifies the PR, checks and reviews before merging.
- A preview account that connects no repository within 7 days of registration is
  rejected by the sweep (hourly in the job service, or by hand with
  `npm run trial:sweep -- [--dry-run] [--login <login>]`). It writes one
  `trial.expired` audit row and sends one bilingual notice, and it never deletes
  an account or a repository. Anyone with a `repos` row or a `repo.added` audit,
  anyone with a job, admins and the super admin are never selected. The status
  change and its audit row commit together and the notice is sent afterwards, so
  the audit row is the record and a rerun is a no-op; the operator output carries
  the login and the registration date, never an address.

### Platform emergency stop

- `POST /admin/platform/stop` and `POST /admin/platform/resume` are the
  platform-wide stop, separate from the per-repository `disable` and from the
  per-job pause and cancel. The state is one row in `settings` (`platform.stop`:
  when, who, why) read fresh on every enqueue and once per tick, so a restart
  cannot silently resume scheduling and a second process cannot keep a stale
  "open" in memory.
- A stop refuses every new enqueue with `PLATFORM_PAUSED`, before any
  per-repository or per-role gate, and the scheduler tick returns before it
  creates, dispatches or merges work. The guard is therefore in the admission
  path and not only on a route: a repository that is due cannot enqueue either.
- The drain is bounded. The stop's own request drains 5 active jobs, because the
  operator is waiting on that form post, and each scheduler tick then drains up to
  25 more until nothing is active. A running job whose bridge is reachable is
  paused, so its checkpoint survives; a job with no bridge, or one that cannot be
  paused, is cancelled with a terminal reason. Either way its platform token is
  revoked, so it cannot keep spending. `platform.drain_incomplete` says how many
  jobs are still left (once on the stop, then on each tick that ends with work
  remaining), and `platform.drain_complete` records the pass that empties them.
- A stop writes exactly one `platform.stopped` audit row and changes nothing
  else: no repository is disabled (`repos.enabled` is untouched), no token is
  rotated, no user is changed and no row is deleted. A second stop while stopped
  is a no-op that keeps the first operator and the reason they gave.
- A resume deletes the row, writes one `platform.resumed` row, and reports the
  repositories the next tick will consider. It does not re-enqueue the set the
  stop froze: after the resume the tick decides under its own rules.
- Both routes require an admin role and answer `403` otherwise. They check the
  role directly instead of going through `requireAdmin`, and deliberately ignore
  the preview cookie, so a super admin whose admin panel has degraded to the
  read-only preview can still stop the platform.

### Team console and agent controls

- `GET /api/repos/:id/team/events` is admin-only. It is read-only and streams
  the same state the team console already shows; it never exposes the DSH token
  or the bridge token.
- The simplified Chief conversation reads the DSH session export server-side on
  the super admin's behalf. It keeps only human/Chief text, drops known Fledge job
  prompts, ignores tool calls/results and attachments, and masks token/secret
  patterns before rendering; the raw DSH token and archive stay server-side.
- Answering a question, sending guidance and requesting a stop require the
  session, repository ownership and `X-CSRF-Token`, and are written to the audit
  log. Answer text is not logged.
- A stop request tries the DSH room cancel first; otherwise it delivers a stop
  message. The UI and API distinguish a hard stop from a request. The native DSH
  UI is exposed through the owner-only authenticated workspace proxy; the Fledge
  team console and its SSE stream remain superadmin-only.
- The v0.3 workspace must use a short-lived signed ticket, a server-side DSH
  cookie, cookie isolation and an ownership check on every request; a raw DSH
  token must never appear in a browser URL.

### Development GitHub PAT

The GitHub PAT used by the maintenance routine is not managed by Fledge. To
rotate it:

1. Create a new classic PAT with `repo` scope in GitHub settings.
2. Run `NEW_GITHUB_TOKEN=... node scripts/rotate-github-token.mjs` on the host
   that holds `~/.dsh/bot/secrets.json` (override with `SECRETS_PATH` if needed).
3. Revoke the old token in GitHub settings.

The script validates the new token, writes a timestamped backup next to the
secrets file and never prints the token. It does not revoke the old token.

**The old value is dead only when one and the same run proves it.** Run
`GET /user` with the old value and `GET /user` with the new value inside a single
run: `401` for the old and `200` for the new is the only pair that counts. A lone
`401` is not evidence — a proxy, a rate limit or a typo produces one too — so any
other outcome is **INCONCLUSIVE** and must be re-run, not recorded as done.

Exit codes of `npm run secret:scan`, the tool this section documents:

| code | meaning |
|---|---|
| `2` | refused: a tracked file could not be read, so the run cannot say the tree is clean |
| `1` | a suspected real value in a tracked file, or an error that stopped the scan (no git, unreadable allowlist) |
| `0` | every tracked file was scanned and nothing was found |

The rotation script keeps its own codes and documents them next to it; this table
deliberately names no code that `secret:scan` cannot produce.

`npm run secret:scan` scans only the files git tracks (`git ls-files`), prints
`file:line` with the first 4 characters and the length of a hit and never the
value, and fails closed: a scan that cannot complete exits non-zero rather than
looking clean — `2` when a tracked file could not be read, `1` when the scan
could not start. Only a complete, empty scan exits `0`. The inventory is
`docs/secrets.md`; the per-line whitelist for the three fake test fixtures is
`scripts/secret-scan-allowlist.json` (`test/crypto.test.ts:32`,
`test/transcript.test.ts:52` and `:66`). Never whitelist a directory.

### OAuth

- `state` is a 32-byte random value; only its hash is stored, for 10 minutes.
- The callback consumes the state exactly once.
- The OAuth token is used only to read the GitHub profile; repository access uses
  the user's fine-grained token.

### Token login

Token login is one rule, `tokenLoginEnabled = !oauthConfigured || allowTokenLoginOnly`,
and both the `POST /auth/token` guard and the landing page call the same exported
predicate, so the page never hides a route that still answers:

- OAuth configured, `ALLOW_TOKEN_LOGIN_ONLY=false`: the route answers 403 and the
  page shows no token form.
- OAuth configured, `ALLOW_TOKEN_LOGIN_ONLY=true`: the fallback is deliberately
  kept, so the token form stays visible next to the GitHub sign-in button.
- OAuth not configured: the fallback is the only path, whatever
  `ALLOW_TOKEN_LOGIN_ONLY` says.

The token is used only for `GET /user` (identity) and is **not stored**; the
repository token is supplied later, per repository. The route is rate-limited
and writes `login.github-token` to the audit log. The code→token exchange is
posted to `GITHUB_OAUTH_TOKEN_URL` (default
`https://github.com/login/oauth/access_token`), which tests point at a fake
server. A production instance that has no OAuth app must set
`ALLOW_TOKEN_LOGIN_ONLY=true` explicitly; the default is fail-closed. Configure
an OAuth App to make OAuth the primary path.

### Development login

`DEV_LOGIN_LOGIN` enables `/auth/dev`, which creates an approved local admin
without GitHub. It is refused when `NODE_ENV=production` (startup fails if the
variable is set). Never set it on a public instance.

### Authorization scope

An approved Fledge account grants Fledge only. It does not grant access to
FlyBot, Bot Social, ScienceDiscovery or the shared Portal. The `/console` page is
a workspace for Fledge repositories, jobs and quota; it never creates a session
or permission for another product. The shared Portal is only a footer link.
Admin users see the Fledge Admin panel; their rights in other products are
managed by those products.

### Application and approval

- A new user starts as `onboarding`; nothing is emailed until they sign the
  disclaimer and information-security agreement and submit once.
- The signature must match the GitHub login; both agreement checkboxes are
  required. The platform stores the signer, versions, timestamps, IP and
  User-Agent.
- A second submission is refused and only opens the status page; the status page
  shows the live queue position.
- Two 32-byte random tokens per application (approve, reject), stored as hashes.
  Single-use; 7-day expiry; status must still be `pending`.
- The email is sent to `ADMIN_EMAIL` only. The Admin panel shows the signature,
  timestamps, IP and queue number, and is the fallback if SMTP fails.
- The administrator login (`ADMIN_GITHUB_LOGIN`) is auto-approved. Keep it
  correct; it is the bootstrap identity.

### Notification webhook egress

`NOTIFY_WEBHOOK_URL` is an operator-configured outbound POST target, so it is
checked like any other server-side request:

- In production the URL must be an absolute `https:` URL; a `http:` URL is
  refused at startup even when its host is allowlisted.
- The host is resolved and every address is checked before the body is sent:
  loopback, RFC1918 and shared (100.64/10) ranges, link-local (including
  `169.254.169.254`), multicast/reserved, IPv6 `::1`, ULA (`fc00::/7`),
  link-local (`fe80::/10`) and IPv4-mapped private addresses are refused.
- Redirects are followed manually, at most five, and every target is resolved
  and checked again before the next request. A redirect from one origin to
  another drops the bearer secret, so a public target cannot forward it onward.
- `NOTIFY_WEBHOOK_ALLOWED_HOSTS` is an optional comma-separated list of exact
  hostnames for a self-hosted deployment that must notify an internal service.
  When the list is non-empty only those hosts are accepted; a listed host is
  trusted and therefore skips the private-address refusal. Empty (the default)
  means public https targets only.
- `buildApp()` refuses an unsafe webhook in production, so the process does not
  start. The send path resolves and checks again at delivery time and fails
  closed, because DNS can change after startup.
- A refusal names the host in the log but never the URL, the bearer secret or
  the payload.

DNS rebinding is not fully mitigated: the address can change between the check
and the connection. Deploy behind an egress policy when the network is hostile.

### SSRF guard

User model base URLs are validated before saving and before use:

- HTTPS only for public hosts.
- HTTP and private/loopback/link-local addresses are accepted only when
  `ALLOW_PRIVATE_MODEL_URLS=true`, the user has `allow_private_models=1` (set by
  a superadmin in Admin), or a superadmin ticks the private-URL checkbox on the
  model form. This is an explicit trust decision: the gateway host must be able
  to reach that address.
- Without the opt-in, IP literals in private/loopback/link-local ranges are
  rejected and hostnames are resolved and checked.
- Credentials in the URL are rejected.
- Model connection keys are encrypted with the platform key and never rendered;
  a repository can only select connections owned by the same user.
- A model is saved only after a successful 1-token test from Fledge. A failed
  test returns an error and nothing is saved; the gateway host must be able to
  reach the address.
- Fledge-managed bridge and per-instance gateway tokens can be rotated with
  `scripts/rotate-instance-tokens.mjs`; the GitHub development PAT is outside
  Fledge and must be rotated in GitHub settings.

DNS rebinding is not fully mitigated; deploy behind an egress policy if users
are untrusted.

### Provider policy

A model provider carries a display label, base URL, region/jurisdiction tag, an
optional data-policy URL and an allowed flag. The base URL and the data-policy
URL reject credentials, and neither is written to a log or an audit row; the
stored key is encrypted and never rendered.

A repository may keep a provider allowlist and an optional region constraint.
The allowlist names provider ids owned by the repository owner; an empty
allowlist means no restriction in this version, and a region constraint matches
the provider's region tag case-insensitively, with an empty value allowing any
region. The region tag is descriptive metadata, not a residency guarantee or a
certification.

The gateway applies the effective policy when it resolves each candidate model,
before any upstream request, and the same path covers the fallback loop. A
disallowed candidate is refused with a stable code: `FLEDGE_PROVIDER_NOT_ALLOWED`
for the allowlist, `FLEDGE_PROVIDER_REGION_NOT_ALLOWED` for the region and
`FLEDGE_PROVIDER_DISABLED` for a provider whose allowed flag is off. A fallback
outside the policy is therefore refused at the same seam and is never silently
used.

A repository that sets a policy must name one of its models on every call. A
call whose `model` is missing, or names a model that does not resolve, is
refused with `FLEDGE_PROVIDER_POLICY_NO_MODEL` before any target is chosen. The
alternative targets — the caller's own `own_llm_*` model and the platform model —
carry no provider id and no region, so without this refusal omitting one field
would bypass both the allowlist and the region constraint.

The job row records the provider id, label, region and the actual model that
answered. The job page, the pull-request review packet and the `job.succeeded`
audit detail show those fields. Provider settings and the per-repository policy
are owner-only: a non-owner, including an administrator, cannot read another
user's providers or change that repository's policy. A later call that resolves
no provider keeps the values the job already recorded instead of clearing them,
and settings do not offer a disabled provider as an allowlist entry.

### Gateway

- `flg_` tokens are random, hashed at rest, revocable, and can expire.
- The platform key is never returned to a client.
- Quota is per user; each request records a ledger row.
- The gateway only accepts chat-completions-style JSON; it does not proxy
  arbitrary paths.

### FlyBot job secrets

- A callback secret is generated per job and stored as a hash.
- The credential endpoint returns the decrypted GitHub token only while the job
  is `queued`/`running`, and only with that secret.
- The job-scoped `flg_` token is revoked when the job finishes or times out.
- The bridge token is a separate shared secret with the FlyBot host.

### Logging

`redact()` removes GitHub tokens, `sk-…` keys, `flg_…` tokens, bearer values and
Upstream `api_key:` hashes from log messages. Request bodies are never logged.
The development mail outbox is written with mode 0600 and contains approval links;
treat it as a secret.

### Headers

- `Content-Security-Policy` for HTML pages: self only, no inline scripts, images
  from GitHub avatars only.
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: strict-origin-when-cross-origin`.
- HSTS when `BASE_URL` is HTTPS.

### Rate limits

- Login: 30 requests/minute per client address.
- Job callbacks: 120 requests/minute per client address.
- A client address is the one the trusted proxy appended to `X-Forwarded-For`;
  a caller-supplied left end cannot open a new bucket. The trusted hops come from
  `TRUST_PROXY` (loopback by default), never from `trustProxy: true`, and a
  wildcard or boolean value is refused at startup. IPv6 clients are bucketed by
  their /64, because one host usually controls the whole prefix.
- `/metrics` shares the 120/minute API bucket, so the unauthenticated 401/403
  path is not free to hammer.
- The model gateway should be rate-limited at the reverse proxy per token if the
  platform is exposed to many users.

## Threat notes

| Threat | Mitigation |
|---|---|
| Stolen database file | Tokens encrypted; sessions hashed; hashes of approval tokens |
| Stolen session cookie | HttpOnly, SameSite, Secure in production; short-lived approval |
| Approval link leaked | Single-use, 7 days, only changes pending → approved/rejected |
| Malicious repo token | Token is only used through the GitHub API for that repo; validated on add |
| SSRF via model URL | HTTPS + DNS/IP checks; egress policy recommended |
| Unapproved model provider | Repository allowlist and region check at gateway resolution, stable refusal code, fallback covered |
| Quota abuse | Per-user ledger, hard 402, admin adjustments audited |
| Job secret leak | Short-lived, per job, credential endpoint scoped to the job |
| Log leak | Redaction; no request bodies; secrets never rendered |

## Approval mail failures

An approval mail that cannot be sent is a security-relevant outage, not a log
line: the applicant stays `pending` and nobody can approve them. The product
records it instead of swallowing it.

- `Approvals.request` writes an `approval.mail_failed` audit entry with the
  sender error **redacted** (`src/lib/secrets.ts`), then rethrows.
- The applicant's `/apply/status` page shows a banner that the mail did not reach
  the administrator and that the queue position is unchanged.
- The pending list on `/admin` marks that user with "approval mail not
  delivered" and offers **Resend approval mail**
  (`POST /admin/users/:id/resend-approval`, CSRF-guarded, admin only). The marker
  clears on its own when a later send succeeds, because only a success sets
  `users.approval_sent_at`.
- The automatic retry on `/apply/status` does **not** write an audit row: that
  page refreshes every 10 seconds and a failing SMTP host would otherwise flood
  the audit log.
- The probe is `npm run mail:probe -- --to <address>`. It sends exactly one mail
  over the configured transport and prints `transport=… host=… elapsed=…ms` plus
  ok/failed; it prints neither the address nor a credential, and exits non-zero
  on failure. Run it after any SMTP change, before trusting the approval path.

The same rule applies to the approval notice and the quota reminder: their
failures are logged (`log.warn`) but do not change a user's state.

## Operator checklist

- [ ] `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` are unique and backed up.
- [ ] `BASE_URL` is HTTPS and the reverse proxy terminates TLS.
- [ ] `ADMIN_GITHUB_LOGIN` is the intended bootstrap admin.
- [ ] SMTP credentials are in a 0600 env file, not in git.
- [ ] `ALLOW_PRIVATE_MODEL_URLS=false` for untrusted users.
- [ ] The FlyBot bridge listens on loopback or a private network only.
- [ ] The data directory is backed up and the backup is encrypted.
- [ ] Logs are shipped somewhere with access control.

## Reporting

Use GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**) with a minimal reproduction. Do not
open a public issue for a vulnerability. Please allow 72 hours for a first
response.

## Project memory visibility (`#539`)

Project memory keeps a versioned record per repository, and an entry is either
shared with the project or scoped to one role (`role:maintainer`,
`role:developer`). The audience is resolved from the repository's chosen role,
not from the account's permission: an administrator acting as a developer reads
the developer view and an entry outside that audience is reported as absent, so
a role boundary is not a list filter that a direct URL walks around. A revision
is read under its own audience, so an old revision written for another role is
neither listed nor rendered even after the current entry moves to a wider one.
A writer may not author an entry for a role it cannot act as, and a write aimed
at an entry outside the actor's audience is refused as if the entry were absent,
before the revision fence, so a hidden key is not a write target or a revision
oracle. The store refuses a write whose `expected_revision` is stale instead of
overwriting the current body.
