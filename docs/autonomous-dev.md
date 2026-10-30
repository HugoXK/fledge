# Maintenance and release workflow

This page is the operating contract for every change to Fledge, whether it comes
from a person or an automation. It is intentionally small: one Node service, one
required check, one review gate.

## Roles

| Role | May do | Must not do |
|---|---|---|
| Owner | Everything; deploy; rotate keys; change policy | — |
| Maintainer | Triage, claim, implement, open PRs, run gates, merge within the gates | Deploy, change quotas on live users, rotate keys |
| Reviewer | Read the diff at a tip, re-run the gates, post PASS / INC / REQUEST_CHANGES | Push code, edit the implementer's PR body |
| Release manager | Assemble fragments, bump version, tag, publish | Change product code |
| Contributor | Pick an `agent-ready` issue, write a test, open one PR | Push to `main`, merge their own PR |

A human contributor does not approve their own PR. The maintainer's automation
may self-PASS only when `.github/agent/review-policy.json` lists it in
`selfReview`; a self-PASS never replaces green CI.

## The loop

```
issue → claim → branch/worktree → red test → fix → gates → PR
      → review at the tip → risk tier → merge queue → release
```

### 1. Issue

- A change starts from a reproducible defect or a concrete maintenance need.
- Search open and closed issues first. Never file a duplicate.
- A report contains: expected behaviour, actual behaviour, minimal reproduction,
  `file:line` where possible, environment.

### 2. Claim

- Skip an issue with a human assignee or a live claim.
- Assign the maintainer account, add `agent-working`, and comment with the
  branch name and a one-line plan.
- Heartbeat every 2 h for long work. Release the claim with a comment if you
  stop.
- An open PR outranks a comment: if a PR exists, join that branch.

### 3. Branch

- Branch from the latest `main`; use a separate worktree when the local tree is
  dirty.
- One issue, one branch, one PR. Never open a second PR and close the first.
- If an issue already has a PR, push to that branch (rebase, `update-branch`, or
  a new commit) and put the new tests there.

### 4. Red test

- Write the smallest test that fails on the unbroken tip.
- Keep the red output and the green output; a reviewer re-verifies them.
- Test the class, not one sample.

### 5. Gates

At the exact tip you will link:

```sh
npm ci
npm run check
node scripts/risk-gate.mjs --base origin/main
node scripts/changelog.mjs check
```

Add a changelog fragment for a user-visible change. Update the owned doc or add
`Docs-not-needed:` to the PR body **and** a branch commit.

### 6. PR

- Imperative English title; `Fixes #N` on its own line.
- Body: what changed, why, `Ran:` with real commands, `Not run:` with reasons,
  risks, tier, and `Docs-not-needed:` if used.
- Assign the maintainer account, label `agent-pr`.

### 7. Review

- The reviewer reads the diff at the tip, checks out a fresh worktree, re-runs the
  gates and re-verifies red-at-base.
- Findings are fixed on the same branch; push a new tip and reply once.
- A tip move voids the PASS. One tip carries one conclusion.
- A non-blocking finding outside the diff becomes a follow-up issue immediately.

### 8. Merge

- T0/T1: `ci-ok` green, mergeable, design-conformant.
- T2/T3: a PASS at the same tip (self-PASS only if the policy allows it) with a
  real `Ran:` command.
- Enqueue with `gh pr merge --auto --squash --match-head-commit <sha>`.
- Never `--admin`; never force-push `main`; never bypass a required check.
- After merge: fetch, fast-forward `main`, delete the branch/worktree, and file
  follow-ups as issues (not TODOs).

## Issue states and labels

Type (exactly one): `bug`, `enhancement`, `documentation`, `accessibility`.

Area: `area:auth`, `area:repos`, `area:jobs`, `area:gateway`, `area:ui`,
`area:deploy`, `area:security`, `area:docs`.

State:

| Label | Meaning |
|---|---|
| `needs-info` | The report is not reproducible or the spec is unclear |
| `needs-human` | A design, security or policy decision is required |
| `agent-ready` | Clear, unblocked, no open design conflict |
| `agent-working` | A claim is live |
| `agent-pr` | A PR exists |
| `hold` | Automation leaves it alone; pair with a `Record only` comment |

Controller-managed (never by hand): `risk:T0`…`risk:T3`, `status:done`.

### When an issue is `agent-ready`

All three:

1. Every design conflict is resolved; no open question for the owner.
2. Expected behaviour and change scope are clear.
3. It is not `hold`, not an umbrella, and not team-via-groups work.

Otherwise `needs-human` or `needs-info`, with the blocking question in a comment.

## Risk tiers

`node scripts/risk-gate.mjs --base origin/main` is the source of truth. It prints
a report and a final machine-readable line:

```
risk-tier: T2; basis: src/jobs/service.ts
```

| Tier | Paths | Merge requirement |
|---|---|---|
| T0 | `docs/`, `README*`, `CHANGELOG.md`, `changelog.d/`, `CODE_OF_CONDUCT.md` | `ci-ok` green |
| T1 | `test/`, `public/`, issue templates, small UI-only changes | `ci-ok` green |
| T2 | the rest of `src/` (app routing, views, email, users, lib) | PASS at tip + `ci-ok` |
| T3 | auth, gateway, jobs, repos, config, db, bridge, `scripts/`, `deploy/`, `.github/`, manifests, licence, policy docs | PASS at tip + `ci-ok` |

Unknown path → T2. A `risk:T*` label is advisory and never a reason to skip a
review.

## Gates

The required check is **`ci-ok`**. It is green only when all of these are green
at the same tip:

- `lint`
- `typecheck`
- `test` on Node 22 and Node 24
- `build`
- `docker` (image builds)
- `audit` (no high-severity production dependency)
- `changelog` (fragments are well formed)
- `risk` (the tier report succeeds)

`review-gate` is a second check. It parses the newest conclusion at the PR head:

```
Verdict: PASS at <sha>
Written-by: <name>
Ran:
- `npm run check` — pass
Not run: Docker, real SMTP
```

- T2/T3 need a PASS at the head being merged.
- A PASS with no real `Ran:` command is refused.
- A report with no `Written-by:` line, or a writer outside
  `.github/agent/review-policy.json`, is refused.
- The newest conclusion wins; a later INC overrides an earlier PASS.
- A new commit voids the PASS.
- A `hold` label blocks the queue.

Until `review-gate` is a required check and `main` has a merge queue, the
maintainer must apply the same rules manually. The repository settings checklist
is in [docs/handoff.md](handoff.md).

## Release

```sh
node scripts/changelog.mjs check
node scripts/changelog.mjs preview
node scripts/changelog.mjs release 0.1.1 --date 2026-10-31
git add CHANGELOG.md changelog.d package.json package-lock.json
git commit -m "release: v0.1.1"
git tag v0.1.1
```

The release workflow runs `npm run check`, builds the image, publishes it to
GHCR and creates the GitHub release from the changelog. The tag must point at a
commit whose `CHANGELOG.md` has the matching section.

The release PR touches only `CHANGELOG.md`, `changelog.d/`, `package.json` and
`package-lock.json`; anything else is a normal PR and needs a review. No release
with no fragments.

## Automation (optional)

If the project uses an automation account:

- It follows every rule above; it gets no direct push to `main`.
- A scheduled task belongs to one session. An empty per-session list is evidence
  about that session only, never proof that a task does not exist. Read the
  project-wide list or ask the maintainer before deleting or recreating a task.
- It reports the tip SHA, what it ran and what it did not run, and the blocker.

## Reporting

One short report per change or per run:

```
Tip: <sha>
Tier: <T0..T3> (basis: <path>)
Ran: <commands and results>
Not run: <material checks>
Blocked: <who can unblock>
Next: <one line>
```

No screenshots with tokens. No full logs with credentials. No “should be fine”
without a command behind it.
