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

### Sessions

- 32-byte random session id; only its SHA-256 hash is stored.
- Cookie: `HttpOnly`, `SameSite=Lax`, `Secure` when `BASE_URL` is HTTPS, 30 days.
- The `fledge_lang` preference cookie is `HttpOnly`, `SameSite=Lax`, valid for
  one year, and stores only `zh` or `en`; it carries no identity. The UI keeps it
  in step with the platform-wide `hugoxk-lang` localStorage preference.
- Logout deletes the session row and clears the session and CSRF cookies; the
  language preference remains.
- Expired sessions are swept every minute.

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

### Job cost, evidence and metrics

`events` stores activation/intervention names, user/repo/job ids and a short
meta string (for example `guidance:lead`); it never stores prompts, tokens or
full answers. Evidence strings (`tests`, `checks`, `rollback`) are written by
the agent and rendered on an super-admin-only job page; they must not contain
secrets. `/admin/metrics` is admin-only and read-only.

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

### OAuth

- `state` is a 32-byte random value; only its hash is stored, for 10 minutes.
- The callback consumes the state exactly once.
- The OAuth token is used only to read the GitHub profile; repository access uses
  the user's fine-grained token.

### Token login

When `GITHUB_CLIENT_ID` is empty, the landing page offers a GitHub token login.
The token is used only for `GET /user` (identity) and is **not stored**; the
repository token is supplied later, per repository. The route is rate-limited
and writes `login.github-token` to the audit log. A production instance that has
no OAuth app must set `ALLOW_TOKEN_LOGIN_ONLY=true` explicitly; the default is
fail-closed. Configure an OAuth App to make
OAuth the primary path.

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

- Login: 30 requests/minute per IP.
- Job callbacks: 120 requests/minute per IP.
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
| Quota abuse | Per-user ledger, hard 402, admin adjustments audited |
| Job secret leak | Short-lived, per job, credential endpoint scoped to the job |
| Log leak | Redaction; no request bodies; secrets never rendered |

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
