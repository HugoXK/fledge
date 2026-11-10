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

A human contributor does not approve their own PR, and neither does a bot: the
author of the tip may never PASS it, and `.github/agent/review-policy.json`
carries no self-review waiver. A PASS never replaces green CI.

The required reviewer/PASS identity is `HugoXK-bot`, the GitHub account for
`hugo2001xk@gmail.com`. The owner `HugoXK` keeps repository merge authority and
remains a valid PR author; the bot gets write access so it can post the required
PASS and merge when delegated. A T2/T3 PASS must be written and posted by the
bot. Both the review gate and `pr-lint` read the policy from the base branch, so
a PR cannot relax the requirement that applies to its own merge.

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
- T2/T3: a PASS at the same tip from another identity (the tip author never
  PASSes it) with a real `Ran:` command.
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

The required checks are **`ci-ok`**, **`review-gate`** and **`pr-lint`**.
`ci-ok` is green only when all of these are green at the same tip:

- `lint`
- `typecheck`
- `test` on Node 22 and Node 24
- `build`
- `docker` (image builds)
- `audit` (no high-severity production dependency)
- `changelog` (fragments are well formed)
- `version` (`package.json`, lockfile, changelog, compose and tag agree)
- `risk` (the tier report succeeds)
- `action-pins` (every `uses:` is a 40-hex commit pin with its tag comment)
- `Analyze JavaScript/TypeScript` (the CodeQL job: no new high/critical result)

CodeQL is gated on its own diff, not globally. `github/codeql-action/analyze`
exits 0 whether it found a sink or nothing at all, so the job runs
`scripts/codeql-gate.mjs` afterwards: it reads the SARIF that run just wrote and
fails on a high or critical result the recorded baseline does not already hold.
The baseline is `.github/agent/codeql-baseline.json` — every open high/critical
alert at its `recordedAtSha`, by rule id, path and line, which today is the four
`js/missing-rate-limiting` findings in `src/app.ts` (issues #62–#65). They stay
open and none is dismissed: the gate exists so a pull request cannot quietly add
a fifth while working beside them. The same step runs on a push to `main`, so new
highs cannot accumulate there either. Changing the baseline is a reviewed commit,
and the PR that does it says why the alert is accepted; a line that drifts for an
unrelated reason fails loudly rather than being silently re-labelled.

Every action a workflow runs is pinned to a 40-hex commit with the tag it came
from in a trailing comment, and the `action-pins` job fails the build on a
floating tag: a tag is a pointer the action's owner can move, and whatever it
points at runs on our runner with our token. To re-pin one, resolve the tag the
same way CI would and paste the commit, never the tag:

```sh
git ls-remote --tags https://github.com/<owner>/<repo>.git | grep 'refs/tags/v<major>'
# take the peeled `^{}` sha for an annotated tag, the plain sha for a lightweight one
node scripts/action-pins.mjs   # checks the tree: 40-hex pin plus `# <version>` comment
```

`pr-lint` checks the PR body (`Written-by:`, `Fixes #N` / `No-issue:`, `Ran:`,
`Not run:`), the changelog fragment and docs obligations, the `Written-by`
writer, and any `risk:T*` label against the computed tier.

`review-gate` runs on `pull_request`, `pull_request_review`, `merge_group` and on
a verdict posted as a comment by an owner, member or collaborator
(`issue_comment`), and it parses the newest conclusion at the PR head:

```
Verdict: PASS at <sha>
Written-by: <GitHub account>
Author: <Bot identity>
Ran:
- `npm run check` — pass
Not run: Docker, real SMTP
```

- T2/T3 need a PASS at the head being merged.
- A PASS with no real `Ran:` or `Not run:` line is refused.
- A report with no `Written-by:` line, or a writer outside
  `.github/agent/review-policy.json`, is refused.
- Identity comes from the platform object, never from the body: a review is
  judged by `review.user.login` against the required reviewer, and `Author:` is
  a declaration the gate does not read.
- A comment-shaped verdict is the legacy shape. It decides only while the pull
  request has no review object at all and only until
  `COMMENT_VERDICT_FALLBACK_UNTIL` (`2026-12-14`) in
  `scripts/lib/review-gate.mjs`; it must carry `Posted-by:` matching its own
  author. After that date the gate refuses it.
- The PR author may never PASS its own tip: the policy carries no self-review
  waiver.
- The newest conclusion wins; a later INC overrides an earlier PASS.
- A new commit voids the PASS.
- A `hold` label blocks the queue.

A verdict only paints the check that sits at the head SHA when a run at that SHA
is re-run, because a run started by `issue_comment` checks the default branch and
a review run only adds a check of its own. `scripts/gate-repair.mjs` therefore
evaluates the gate itself and re-runs at most one set of runs at the head.

"Standing" has one definition here, and it is the merge gate's: a `review-gate`
check run belongs to the check suite of the workflow run that produced it, the
newest attempt stands inside a suite, and every suite at the SHA counts. A re-run
replaces the check run inside its own suite, so a red that a re-run superseded is
history; a second workflow run at the same SHA opens a new suite and leaves the
earlier suite's conclusion where it is, so a newer green suite does not retire an
older red one. `#175` stayed blocked exactly that way while the newest check run
by name was green. The step reads check runs with `filter=all` for that reason:
`filter=latest` returned only the green one and the plan reported "nothing to do"
while the merge gate kept refusing.

- a PASS re-runs the failed runs whose own `review-gate` job failed, which clears
  the pre-PASS red that would otherwise block the merge. No failed suite may be
  left standing, because that is what the merge gate reads;
- a rejection re-runs the newest repairable run of the `Review gate` workflow at
  the SHA, so a run that is currently green turns red. A run of any other
  workflow at the same SHA is never a target: re-running it paints no
  `review-gate` check;
- a run is repairable while its `run_attempt` is at most 2
  (`MAX_REPAIR_ATTEMPT`), so a run that a person already re-ran by hand is still
  reachable — the state a PASS usually arrives into. The cap is the loop bound:
  each re-run raises the attempt, so one failed run is re-run automatically twice
  at most (1 → 2, then 2 → 3), and a run already above the cap has its red reported
  as blocked on a new commit instead of being re-run again. Posting the same PASS
  twice is therefore not a no-op — the second trigger re-runs the attempt-2 run —
  while posting the same rejection twice writes nothing, because the red it painted
  is already standing.

The comment path is the job `review-gate-comment`, never `review-gate`: its checks
land on the default branch, and a skipped job would still publish a check run
under the required name. Its `if:` tests the event first and reaches the
association test only for `issue_comment`, so a stranger cannot start the
`actions: write` job and the other three events never evaluate the association.
A PASS that arrives after a rejection at the same SHA keeps the
check red until the repair step re-runs the failed run at that SHA; that now
happens without a hand step. A run already above the attempt cap (attempt 3, after
two automatic re-runs) still needs a new commit to move the tip, and the step says
so by name instead of exiting quietly.

`main` is protected by required `ci-ok`, `review-gate` and `pr-lint` plus
conversation resolution; admins are enforced. This repository has no merge
queue available through its API plan, so auto-merge performs the squash merge
once the required checks pass. Never bypass these with a direct push or an
admin merge.

## Release

```sh
node scripts/changelog.mjs check
node scripts/changelog.mjs preview
node scripts/changelog.mjs release 0.1.1 --date 2026-10-31
git add CHANGELOG.md changelog.d package.json package-lock.json
git commit -m "release: v0.1.1"
git tag v0.1.1
```

The nightly minor release is planned by `scripts/release-plan.mjs`, a pure
function with no I/O, no clock and no environment. It takes the latest tag, the
package version, the merged pull requests since that tag (number, title, labels,
`mergedAt`), the `changelog.d/` fragments, whether a release pull request is
open and the existing tags; it returns the counts, the next minor version, a
named reason and `shouldRelease`. It releases only when at least 10 pull
requests merged since the tag, at least 5 of them are features, at least one
fragment exists, the package version matches the tag and no release pull request
or `v<next>` tag already exists. Every other case is a reason and no release;
nothing is guessed. `git log` may only cross-check the pull-request numbers, and
a disagreement never changes the decision.

The release workflow runs `npm run check`, builds the image, publishes it to
GHCR and creates the GitHub release from the changelog. The tag must point at a
commit whose `CHANGELOG.md` has the matching section.

The release PR touches only `CHANGELOG.md`, `changelog.d/`, `package.json`,
`package-lock.json` and `docker-compose.yml`; anything else is a normal PR and
needs a review. No release with no fragments.

### The daily drive

`.github/workflows/daily-release.yml` runs at 22:30 Asia/Shanghai (`30 14 * * *`)
and does exactly one thing per night, decided by the pure `decideDrive()` in
`scripts/lib/release-drive.mjs`:

| Situation | Action |
|---|---|
| the rule is met and nothing is in flight | open the mechanical PR `release: v<next>` on `release/v<next>` |
| a release PR is already open and mergeable | `gh pr merge --auto --squash --match-head-commit <its sha>` — never a second PR, never `--admin` |
| a release PR is open but red or blocked | report the failing check names and stop |
| the last merged PR is a release PR whose tag does not exist | tag it and dispatch `release.yml` with `-f tag=v<next>` |
| the rule is not met, or a dry run | write the counts and the reason to the job summary and exit 0 |

Rule 4 (the latest `ci-ok` on `main` is green) has no input in the planner, so the
drive checks it before opening anything; a red or missing `ci-ok` on `main` is a
`none` night. The branch is pushed and the PR is opened with `RELEASE_TOKEN`, not
`GITHUB_TOKEN`: a branch pushed with the workflow token starts no `pull_request`
workflow, so the release PR would never get a `ci-ok`. Without `RELEASE_TOKEN` the
run fails closed with `reason: missing-release-token` and opens nothing.

The mechanical class is keyed on identity, never on the file set alone:
`scripts/lib/mechanical-release.mjs` requires the head branch `release/v<next>`,
the title `release: v<next>` for the same `<next>`, and every changed path inside
the five allowed paths. `pr-lint` uses it to skip the size rule (a release PR is
~33 files) and the `docs/deploy.md` obligation; `risk-gate` reports
`risk-tier: T0; basis: mechanical release v<next>` when `ci.yml` passes
`--branch` and `--title`. The same five-file diff without that key stays T3, which
is what keeps the `package.json` review gate in place.

A branch name and a title are written by whoever opens the PR, so the identity is
not enough on its own: `review-gate` asks `mechanicalDiffShape()` as well, and the
exemption holds only when the diff is what the release routine writes — the
version fields in `package.json` and `package-lock.json` and the image tag in
`docker-compose.yml`, with any content allowed in `CHANGELOG.md` and
`changelog.d/`. A dependency line, an environment change or a file the API
returned without a patch keeps the PR at T3, where it needs a PASS like any other.
Otherwise a release-named branch could carry a dependency change into `main` on a
green `ci-ok` alone.

The state the drive reads is assembled by `scripts/release-state.mjs` from the
three API payloads; page flattening and the newest-`ci-ok` pick live in
`scripts/lib/release-state.mjs`, where the suite executes them. This exists because
the same logic inline in the workflow broke invisibly: `--slurp` plus
`jq -s 'add'` produced an array of page arrays, and the first `.title` selection
aborted the night before the planner ran.

The release PR is identified by a title match **and** a head in this repository:
the open list is newest-first, so a fork PR titled `release: v<next>` must not take
the slot of the routine's own PR. Such a PR is written to the run summary as a
notice and never counted as a release in flight — an outsider can neither stop the
nightly nor be enqueued. The planner gets that projection from `plannerInput` in
`scripts/lib/release-state.mjs`, where a test executes it instead of a `jq`
expression in the workflow.

`release.yml` publishes only a tag that is an ancestor of `main`, holds one run
per ref (`concurrency: release-<ref>`, no cancel), and still runs the checks,
builds and pushes the image, then creates or edits the GitHub release. It never
deploys: a tag, an image and a release are artefacts, and the live service stays
owner-only.

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
