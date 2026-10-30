# Fledge code standards

Short acceptance rules for agents and maintainers. Hard rules live in
[AGENTS.md](../AGENTS.md); dated lessons live in [LESSONS.md](../LESSONS.md) and
are promoted here after at least three days.

These are Fledge's acceptance rules for people and automation. They are not a
license to copy another product's code or docs.

## Verifier honesty

When you report status on a change:

1. **Tip SHA** — name the exact commit (`git rev-parse HEAD`).
2. **Ran** — list each command you personally ran at that tip, with pass/fail.
3. **Not run** — list material checks you did not run (Docker, real SMTP, real
   GitHub OAuth, a real bridge job). Missing evidence is a gap, not a PASS.
4. **No borrowed credit** — the author's claims and CI on another SHA are not
   your result.
5. **PASS wording** — say only what the evidence supports: “unit + lint + build
   green at `abc1234`; Docker and SMTP not run”.

A PASS must contain at least one real `Ran:` command. A report without one is
not a conclusion.

## Fail without change

- Add the regression test first and run it **red** on the unbroken tip.
- Then fix and run it green at the new tip. Keep both halves of the evidence.
- Test the class, not one sample. If a token or URL has three shapes, cover the
  shared helper and the sibling shapes.
- A test that passes on the unbroken tip is not a regression test; say so.

## Fix the class, not the sample

- If review finds one escape path, fix the shared helper and cover the siblings.
- Same-class reds tighten this file or LESSONS; do not paper over them with a
  special case.

## Silent catches

- A `catch` that swallows an error says why in a comment inside the block, or
  handles it.
- A fire-and-forget promise (`.catch(() => {})` whose result is dropped) needs a
  `void` or a one-line reason.
- Test helpers are not exempt from honesty, only from the production gates.

## Security

### Secrets

- Never commit or log a GitHub token, a model key, an SMTP password, a session
  cookie, an approval token, a `flg_` token, or a full `.env`.
- GitHub tokens and user model keys are encrypted with AES-256-GCM
  (`TOKEN_ENCRYPTION_KEY`). Never store the key in the database.
- The development mail outbox contains approval links; mode 0600, never commit.

### Untrusted strings

- Escape every value interpolated into HTML (`escapeHtml`).
- A GitHub login, repo name, branch, PR URL or model name comes from an external
  system: validate the shape and cap the length before storing or rendering it.
- A callback body is untrusted until its bearer secret matches and the fields
  pass the type checks.

### SSRF and egress

- User model base URLs must be `https://` for public hosts; `http://` only for
  loopback with `ALLOW_PRIVATE_MODEL_URLS=true`.
- Reject IP literals and resolved addresses in private/loopback/link-local
  ranges, and URLs with credentials.
- GitHub API calls go to `GITHUB_API_BASE` (default `https://api.github.com`);
  never build a URL from a user-supplied host.

### Authentication and authorization

- Sessions: random 32-byte token, SHA-256 at rest, HttpOnly/SameSite cookie.
- Every form has a CSRF token; approval links and job endpoints use their own
  bearer secret instead.
- Approval tokens are single-use and expire in 7 days; a status change requires
  `pending`.
- `DEV_LOGIN_LOGIN` is refused in production; startup fails closed.
- A repo route checks ownership before reading or mutating.

### Quota

- Platform-funded calls are metered per user; the platform key is never returned.
- Use `x-litellm-response-cost` when present; otherwise estimate from usage.
- A provider error deducts nothing. A request already in flight may finish; the
  next request sees the updated balance.
- A quota-exhausted notice is deduped per user per day.

## Merge only a reviewed tip

- **T0/T1:** merge through the queue when `ci-ok` is green, the PR is mergeable
  and design-conformant. No PASS needed.
- **T2/T3:** a **PASS at the same tip** from a reviewer in
  `.github/agent/review-policy.json` (self-PASS by the owner's reviewer agent
  counts) and green `ci-ok`. The agent that gated it enqueues it itself.
- Any new commit voids the PASS. Re-run the Verifier on the new tip.
- Never admin-merge, never bypass a required check, never force-push `main`.
- One PR per issue. Push to the existing branch instead of opening a duplicate.

## Review report shape

```
Verdict: PASS at <sha>
Written-by: <name>
Ran:
- `npm run check` — pass
- `node scripts/risk-gate.mjs --base origin/main` — T2
Not run: Docker image, real SMTP
```

- First line: exactly `Verdict: PASS|INC|REQUEST_CHANGES at <sha>`.
- Second line: `Written-by:` from the policy's `writers` list.
- A relay may add `Posted-by:` third; it does not change the verdict.
- One tip carries one conclusion. A replacement PASS at the same tip is allowed
  only when the first was rejected for a missing `Ran:` line, and it must say
  `Replaces:`.
- A `hold` label plus a `Record only — do not merge` comment blocks the queue.

## Docs ownership

A change to an owned module updates its doc in the same PR:

| Area | Doc |
|---|---|
| Auth, approvals, email | `docs/security.md` |
| Gateway, quota | `docs/quota.md` |
| Repos, job callback | `docs/api.md` |
| App, DB, views | `docs/architecture.md` |
| Bridge | `bridge/README.md` |
| Deploy | `docs/deploy.md` |

`Docs-not-needed:` in the PR body and the branch's commit message is the only
excuse. A reviewer fails an owned-path change without either.

## Tests

- `node:test` and `node:assert/strict`; no test framework dependency.
- Fakes: in-memory SQLite, a local HTTP server for GitHub/model upstreams, a
  memory mailer. No network in CI.
- Each test closes its server, store and app.
- A test that depends on wall-clock timing gets a generous window and no
  retries-as-pass.

## Migrations and data

- The schema is additive and idempotent (`CREATE TABLE IF NOT EXISTS`).
- Bump `PRAGMA user_version` for a breaking change and write the migration.
- Never edit a user's live database in a test; use `:memory:` or a temp file.
- `npm run db:backup` is the only supported online backup.

## Tiny loops

- One issue (or one tightly coupled pair) per branch and worktree.
- Security fixes before large features.
- After a PASS and merge, stop or take the next issue; do not pile unrelated
  diffs into the same PR.
