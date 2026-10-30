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

### Sessions

- 32-byte random session id; only its SHA-256 hash is stored.
- Cookie: `HttpOnly`, `SameSite=Lax`, `Secure` when `BASE_URL` is HTTPS, 30 days.
- Logout deletes the session row and clears both cookies.
- Expired sessions are swept every minute.

### CSRF

Every state-changing browser form includes a hidden `csrf` field derived from
`HMAC(SESSION_SECRET, sessionHash)`. The server also accepts `X-CSRF-Token` for
future JSON endpoints. Approval links and job endpoints use their own bearer
secrets and do not use CSRF.

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

- HTTPS only for public hosts; HTTP is allowed only for loopback when
  `ALLOW_PRIVATE_MODEL_URLS=true`.
- IP literals in private/loopback/link-local ranges are rejected.
- Hostnames are resolved and every address is checked.
- Credentials in the URL are rejected.

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
LiteLLM `api_key:` hashes from log messages. Request bodies are never logged.
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

Email `hugo2001xk@gmail.com` with a minimal reproduction. Do not open a public
issue for a vulnerability. Please allow 72 hours for a first response.
