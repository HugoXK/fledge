# AGENTS.md

Instructions for AI agents and maintainers working on **Fledge**. Humans should
read [CONTRIBUTING.md](CONTRIBUTING.md) too; both files are binding.

Read first, in this order:

1. [LESSONS.md](LESSONS.md) — dated, open constraints.
2. [docs/code-standards.md](docs/code-standards.md) — review honesty and gates.
3. [docs/autonomous-dev.md](docs/autonomous-dev.md) — the maintenance loop.

---

## What Fledge is

Fledge is a self-hosted platform where a user connects GitHub repositories and a
FlyBot agent iterates on them: it writes a failing test, makes the smallest
correct fix, opens one reviewable PR, and stops. Fledge orchestrates, meters and
audits; it never runs a user repository and does not merge a PR unless a maintainer explicitly enables auto-merge for that repository.

Core paths:

| Path | What it is |
|---|---|
| `src/app.ts`, `src/index.ts` | Fastify app, routes, bootstrap |
| `src/auth/`, `src/users/` | GitHub OAuth, sessions, approvals |
| `src/repos/` | GitHub API client and repo validation |
| `src/jobs/`, `bridge/` | Job lifecycle, runners, FlyBot bridge contract |
| `src/gateway/` | OpenAI-compatible model gateway and quota |
| `src/email/` | Approval and quota mail |
| `src/views/`, `public/` | Server-rendered UI |
| `src/db.ts` | SQLite schema and store |
| `test/` | `node:test` suites with fakes |
| `deploy/` | systemd and nginx samples |
| `docs/` | Architecture, API, deploy, quota, security, workflow |

## Hard rules

0. **Scope the permission.** A Fledge approval grants Fledge only. Do not wire
   it to FlyBot, Bot Social, ScienceDiscovery or the shared Portal, and keep the
   console explicit about what is not available.

1. **No secrets in git.** Never commit `.env`, API keys, GitHub tokens, SMTP
   passwords, cookies, the `data/` directory, or the development mail outbox.
   Never print a secret in a comment, log, PR body or test fixture.
2. **Fledge never executes user code.** It calls the GitHub API and a FlyBot
   bridge. Do not add a shell runner, a clone-and-build runner, or a second agent
   runtime.
3. **One issue → one branch → one PR.** If an issue already has a PR, push to
   that branch. Never open a second PR and close the first.
4. **Test first.** A regression test must fail on the unbroken tip, then pass
   with the fix. Keep both halves of the evidence.
5. **No admin merge, no bypass.** Merge only through auto-merge (or the merge
   queue when one is available) once the required checks are green at the tip.
   A new commit voids a PASS.
6. **No deploy without consent.** A production deploy, a DNS/tunnel change, a
   quota change on a live user, or a token rotation needs the owner's explicit
   yes.
7. **Only original material.** Do not copy code, text, icons or graphics from
   other products. Licensed dependencies keep their notices.
8. **One write session, one PR, one writer, one port.** Four rules keep a write
   session honest; [docs/autonomous-dev.md](docs/autonomous-dev.md#gates) carries
   the same four with their commands:
   - **One write session per repository.** One branch or worktree at a time; a
     second concurrent write session is how duplicate PRs happen.
   - **One branch, one open PR.** Before opening, query
     `GET /repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=open`; if one
     exists, push to it, and close a second PR for that branch at once.
   - **One worktree, one writer.** No two bots and no two sessions in the same
     worktree.
   - **Dedicated ports for verification servers.** Never `8080`, the documented
     default, and never a port another session may use; start the server from an
     isolated worktree at the reviewed tip and check the response against the
     tree it claims to serve.

## Pipeline

```
issue → claim → worktree/branch → red test → fix → gates → PR
      → review at the tip → risk tier → merge queue → release
```

1. **Issue.** One issue per session and per worktree. Search for duplicates. A
   change is admitted only when it fixes a reproducible defect or is something
   the routine work itself needs.
2. **Claim.** Assign the issue to the bot account, add `agent-working`, and
   comment with the branch name. Release the claim if you stop.
3. **Branch** from the latest `main`. Use a separate worktree when the local
   tree is dirty. One branch, one PR — query open PRs for the head before
   opening.
4. **Red test.** Write the smallest test that fails for the class of bug.
5. **Gates** at the tip you will link:

   ```sh
   npm ci
   npm run check        # lint + typecheck + tests + build
   node scripts/version.mjs check
   npm run dev          # when the change is user-visible
   ```

6. **PR.** Imperative English title, `Fixes #N`, what changed, what you ran and
   did not run, risks, and a `Docs-not-needed:` line only when the docs really
   say nothing about the change. Add one changelog fragment for a user-visible
   change. One branch, one PR — query open PRs for the head before opening.
7. **Review.** `ci-ok` covers the build; `review-gate` and `pr-lint` are also
   required. T0/T1 merge on green `ci-ok`. T2/T3 need a PASS at the same tip
   from a reviewer in `.github/agent/review-policy.json`; the author of the tip
   may never PASS it, so a reviewer always signs another identity's work. The
   review format is fixed; see below.
8. **Merge.** Enqueue with `gh pr merge --auto --squash --match-head-commit
   <sha>` after the guard script agrees. Auto-merge (or the merge queue when
   available) performs the squash merge. Never use `--admin`, never force-push
   `main`.
9. **Release.** The release routine owns `CHANGELOG.md` and the version. It
   assembles `changelog.d/` fragments and creates the tag.

## Risk tiers

The tier is **computed from the diff**, never from a label. `node
scripts/risk-gate.mjs --base origin/main` prints the report and a machine line:

```
risk-tier: T2; basis: src/jobs/service.ts
```

- **T0** — docs, README, changelog fragments. Green `ci-ok` only.
- **T1** — tests, `public/` assets, small UI-only changes. Green `ci-ok` only.
- **T2** — `src/` app code (views, email, users, lib, app routing). PASS at the
  tip + green `ci-ok`.
- **T3** — auth, gateway, jobs, repos, config, DB, bridge, scripts, deploy,
  `.github/**`, `package*.json`, `tsconfig*.json`, `Dockerfile`, `AGENTS.md`,
  `LESSONS.md`, `docs/code-standards.md`, `docs/autonomous-dev.md`, `SECURITY.md`,
  `LICENSE`. PASS at the tip + green `ci-ok`.
- Any path no rule names is **T2**, never silently T0/T1.

Labels (`risk:T0`…`risk:T3`) are advisory mirrors for humans; they are not the
decision. The controller copies the computed tier onto the PR on its next poll.

## Review format (machine-read)

The first line is exactly one of:

```
Verdict: PASS at <sha>
Verdict: INC at <sha>
Verdict: REQUEST_CHANGES at <sha>
```

The lines after the verdict are `Written-by: <GitHub account>` from the policy's
`writers` list and `Author: <Bot identity>`. Identity comes from the platform
object: a verdict submitted as a review is decided by `review.user.login`, and
`Author:` is a declaration the gate never reads, so no body line can satisfy it.
A verdict posted as an issue comment is the legacy shape: it decides only while
the pull request has no review object at all and before
`COMMENT_VERDICT_FALLBACK_UNTIL` (`2026-12-14`) in
`scripts/lib/review-gate.mjs`, and it must carry `Posted-by:` matching its own
author. Never edit someone else's report. The PR author may never PASS its own
tip: the policy carries no self-review waiver.

`requiredPass` in `.github/agent/review-policy.json` names the required
reviewer/PASS identity: `HugoXK-bot`, the GitHub account for
`hugo2001xk@gmail.com`. The owner `HugoXK` keeps repository merge authority; the
bot must have write access so it can post the required PASS and perform the merge
when the owner delegates it. A T2/T3 PASS must be written and posted by the bot.
`writers` keeps both `HugoXK` and `HugoXK-bot`, so either account may write the
PR body; only the bot PASS satisfies the review gate. The gate reads the policy
from the base branch, so a pull request cannot weaken its own review requirement.
Below that:

```
Ran:
- `npm run check` — pass
- `npm test -- --test-name-pattern gateway` — pass
Not run: Docker image, real SMTP
```

A PASS with no real `Ran:` command is not a PASS. The reviewer must re-run the
gates itself; the author's narrative is not evidence. One tip carries one
conclusion. If a PASS at a tip is rejected only because `Ran:` is missing, the
reviewer may post **one replacement PASS at the same tip** with a `Replaces:`
line; that is not a second conclusion.

A `hold` label plus a comment `Record only — do not merge` blocks the queue. The
label alone is a marker; the pair is the record. Never edit or delete an earlier
PASS to change history.

## Changelog

- One file per user-visible change: `changelog.d/<issue-or-slug>.<kind>.md`.
- Kinds: `added`, `changed`, `deprecated`, `removed`, `fixed`, `security`.
- The entry is one paragraph, no heading and no leading `- `.
- A change users cannot see needs no fragment.
- Never edit `CHANGELOG.md` in a feature PR; the release routine assembles it.
- `node scripts/changelog.mjs check` and `preview` are the local tools.

## Docs ownership

A change to an owned module updates its doc in the same PR:

| Changed | Doc |
|---|---|
| `src/auth/`, `src/users/`, `src/email/` | `docs/security.md` |
| `src/gateway/`, `src/jobs/` (quota) | `docs/quota.md` |
| `src/repos/`, `src/jobs/` (callback) | `docs/api.md` |
| `src/app.ts`, `src/db.ts`, `src/views/` | `docs/architecture.md` |
| `bridge/` | `bridge/README.md` |
| `deploy/`, `Dockerfile`, `docker-compose.yml` | `docs/deploy.md` |

A change that truly needs no doc update adds a `Docs-not-needed:` line to the PR
body and the branch's commit message.

## Commands

```sh
npm ci
npm run dev            # http://localhost:8080
npm run check          # the local equivalent of CI
npm test               # node:test suites
npm run lint           # oxlint
npm run typecheck      # tsc --noEmit
npm run build          # dist/
npm run db:backup      # online SQLite backup
npm run mail:outbox    # newest development email + approval links
```

Node 22.9+ is required (`node:sqlite`). The CI matrix is Node 22 and 24.

## Maintenance routines (optional)

When automation is used, it follows the same rules as a person and keeps the
three jobs separate:

| Routine | May do | Must not do |
|---|---|---|
| Self-test | Use the platform, file reproducible issues | Open PRs, push branches, change code |
| Maintenance | Triage, claim `agent-ready`, open fix PRs, merge within the gates | Deploy, edit the version or `CHANGELOG.md` |
| Release | Assemble fragments, bump version, tag, publish | Change product code |

A scheduled task belongs to one session. An empty per-session list is evidence
about that session only, never proof that a task does not exist; read the
project-wide list and ask the maintainer before deleting or recreating anything.

## Labels

- Type (one): `bug`, `enhancement`, `documentation`, `accessibility`.
- Area (one or more): `area:auth`, `area:repos`, `area:jobs`, `area:gateway`,
  `area:ui`, `area:deploy`, `area:security`, `area:docs`.
- Source: `self-test`.
- State: `needs-info`, `needs-human`, `agent-ready`, `agent-working`, `agent-pr`,
  `hold`.
- Controller-managed (never by hand): `risk:T0`…`risk:T3`, `status:done`.

`agent-ready` requires: no open design conflict, a clear expected behaviour and
scope, not `hold`, not an umbrella, not team-via-groups work, and
`review:approved` from the Reviewer whose PASS names the live body hash. The Lead
recomputes that hash with `node scripts/issue-gate.mjs --issue <N>` immediately
before adding the label; a `changes` line blocks it exactly like a missing PASS,
and the person who wrote the issue never adds the label. A verdict may name the
raw body or the trailing-whitespace-stripped one; the gate accepts both and
prints ` (trimmed)` when the stripped form matched, because trailing whitespace
is not a material edit. Any other byte difference voids the PASS — a
byte-for-byte revert revives it, because GitHub exposes no edit history, so the
gate is not revert-proof. Agents develop only `agent-ready` issues.

A held issue is approved but not claimable. `hold` on an issue makes the gate
print `issue-gate: hold #<N> <hash>` and exit 7 instead of `ok`, even when a PASS
names the live body; it replaces `ok` only, so `changes`, `stale-pass`,
`no-pass`, `bad-passer` and `corrupt-body` keep their precedence. The label alone
is the machine signal for an issue; the `Record only — do not merge` comment
remains the rule for the merge queue.

## Every write says who wrote it

Every state-changing write (issue, PR body, comment, queue note) starts with
`Written-by: <Bot name>` — except a review verdict, whose first line is the
verdict and whose second line is `Written-by:`. A conclusion is read only from a
comment whose author is an owner/member/collaborator; a passer-by cannot hold a
merge.

## Deployment

- Production is `fledge.hugoxk.online`; the project homepage and guide live at
  `hugoxk.online/fledge/`.
- The service is a single Node process behind nginx; SQLite is single-writer.
- The FlyBot bridge runs on the FlyBot host and listens on loopback.
- Never point a test at the live database, the live SMTP account or a real
  user's GitHub token.
- A deploy needs the owner's yes; the runbook is [docs/deploy.md](docs/deploy.md).

## Style

- TypeScript strict; no `any` without a one-line reason.
- Follow the code around the change; small functions, plain names.
- Comments only for a hidden constraint, an invariant or a workaround.
- Escape every value interpolated into HTML.
- Never log a request body, a token, a key, a full email, or a repo clone URL
  with credentials.
- User-facing UI text is bilingual Chinese/English; keep both translations and
  `README.md` / `README.zh.md` in step.
