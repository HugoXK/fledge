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
| `hold` | Automation leaves it alone; on an issue it means approved but not claimable, and the gate refuses it |

Controller-managed (never by hand): `risk:T0`…`risk:T3`, `status:done`.

### When an issue is `agent-ready`

All four:

1. Every design conflict is resolved; no open question for the owner.
2. Expected behaviour and change scope are clear.
3. It is not `hold`, not an umbrella, and not team-via-groups work.
4. The Reviewer posted `Issue-review: PASS at issue #<N> body <12-hex>` and added
   `review:approved`. That verdict plus the label is the Reviewer's only state
   write: it never adds `agent-ready`, never assigns, and never edits the body.
   `agent-ready` is added by the Lead and only by the Lead.

The hash is sha256 over the decoded body, first 12 hex. A verdict may name
either the raw body or the body with trailing whitespace stripped — several
published verdicts were taken over the stripped form — and the gate honours
both, printing ` (trimmed)` on any line that matched the stripped form. Any
other byte difference is a material edit and voids the PASS. One definition
serves both ends: `scripts/lib/issue-body-hash.mjs` is what the gate reads with
and what `scripts/issue-hash.mjs` prints, so a verdict writer records from the
same function instead of trimming by hand. The Lead recomputes it with

```sh
node scripts/issue-gate.mjs --issue <N>   # ok | stale-pass | no-pass | bad-passer | changes | corrupt-body | hold
node scripts/issue-hash.mjs --issue <N>   # raw <hash> / trimmed <hash> for a verdict line
```

immediately before adding `agent-ready` — never from an earlier run in the same
session, never from memory, never from the PASS text alone. A `changes` line
(exit 4) blocks the label exactly like a missing PASS, and a verdict from
anyone other than the policy's `requiredPass` is not a PASS at all. A `hold`
line (exit 7) means the card is approved but not claimable: `hold` replaces
`ok` and nothing else, so a held card with `changes` still reports `changes`,
and a held card with no verdict still reports `no-pass`.

Known limit, stated rather than papered over: a byte-for-byte revert back to the
PASSed text **does** revive the PASS, because the gate compares the live body
with the published verdicts and GitHub exposes no body-edit history. Do not
describe this gate as revert-proof. The machine half covers every other case;
the human rule — a material edit voids the approval, so the Reviewer re-reads —
covers that window.

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

The required checks on `main` are **`ci-ok`**, **`review-gate`**,
**`pr-lint`**, **`dependency-review`** and the CodeQL job's own name,
**`Analyze JavaScript/TypeScript`**. The set is recorded, with the names exactly
as the checks API reports them, in
[`.github/agent/required-checks.md`](../.github/agent/required-checks.md); that
file is the record and not the gate — branch protection is an owner action.

`ci-ok` is green only when all of these are green at the same tip:

- `lint`
- `typecheck`
- `test` on Node 22 and Node 24
- `coverage` (the Node coverage floor recorded in `package.json`)
- `build`
- `docker` (image builds, scans and starts)
- `audit` (no high-severity advisory in either the runtime set or the full graph)
- `changelog` (fragments are well formed)
- `version` (`package.json`, lockfile, changelog, compose and tag agree)
- `risk` (the tier report succeeds)
- `restore-drill` (the SQLite backup restores into a throwaway path)
- `dependency-review` (no new high-severity advisory in the pull request diff)
- `action-pins` (every `uses:` is a 40-hex commit pin with its tag comment)
- `workflow-lint` (actionlint over the workflow tree, plus the template-injection check)
- `secret-scan` (gitleaks over the commit range, full history on `main`)
- `codeql-required` (the CodeQL analysis for this event's commit exists and is green)

A skipped required job is a failure, not a pass: `scripts/ci-ok.mjs` fails on
`skipped`, `cancelled` or a job absent from `needs`, except where
`SKIPPABLE_ON` records that an event has nothing for that job to read.

### A red `main` reports itself

`ci-ok` still only computes the commit's health; the job that says so out loud is
`main-health` in `ci.yml`. It runs only on `refs/heads/main` (a push, the nightly
schedule or a manual run), is the one job in the file that holds `issues: write`,
and depends on every job `ci-ok` gates on as well as on `ci-ok` itself, so the
tracker can name the jobs that actually failed rather than only the aggregate. It
opens a single issue labelled `ci:main-red` naming the head sha, the failing jobs
and the run, comments on that issue while the branch stays red, and closes it with
the clearing sha once `ci-ok` is green. When it opens that first issue the
reporter creates the `ci:main-red` label itself (`gh label create`; present is a
no-op), because `gh issue create --label <unknown>` is rejected before the issue
exists, and a label it cannot create is a named failure in the job log. The
bootstrap sits on the create path only: a run that decides nothing writes
nothing, so a green `main` never touches the label. The tracker is found by
the label, never by its title, and `concurrency: ci-main-red` with
`cancel-in-progress: false` stops two pushes in one red state from opening two
issues. The decision is `scripts/lib/main-health.mjs` (pure, fixture-tested), and
so is the write half: `apply(result, runner)` and the `gh` argument builders live
there, so a suite pins the exact calls; `scripts/main-health.mjs` only gathers the
run's input and passes `gh` in as the runner. A pull request or merge-queue ref can
never reach the write: the job's condition and the module both refuse anything
but `refs/heads/main`.

### Write sessions, one PR per branch, and verification servers

Hard rule 8 in `AGENTS.md` points at these four rules; they are repeated here
with the commands they name, because a gate only works if it can be run:

1. **One write session per repository.** A bot works in one branch or worktree at
   a time. A second concurrent write session is how a duplicate PR appears.
2. **One branch, one open PR.** Before opening, query
   `GET /repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=open`; if a pull
   request exists, push to it. A second PR on that branch is closed the moment it
   appears.
3. **One worktree, one writer.** No two bots and no two sessions share one
   worktree.
4. **Dedicated ports for verification servers.** Never `8080`, the documented
   default, and never a port another session may use. Start the server from an
   isolated worktree at the reviewed tip, and accept a measurement only after the
   response matches the tree it claims to serve.

### Supply-chain gates

`docker` scans the built image with trivy at `HIGH,CRITICAL` and fails the build
(`exit-code: 1`), ignoring unfixed findings; an exception goes in
`.trivyignore.yaml` as one entry with an expiry, never as a severity downgrade.
It then runs the image with a throwaway SQLite path and a generated session
secret and asserts `GET /healthz` returns 200 with a version — a build that
passes is not an image that starts.

`workflow-lint` runs actionlint (YAML, expressions, shellcheck) and separately
`scripts/workflow-injection.mjs`, which is the part actionlint cannot do: it has
no taint analysis, so `${{ github.event.pull_request.title }}` inside a `run:`
body is well-formed at every level actionlint checks and still executes text
whoever opened the pull request wrote. An expression string that must appear in
a shell script goes in
`.github/agent/workflow-injection-allowlist.json` with a reason.

`secret-scan` runs gitleaks as a checksum-pinned binary with `fetch-depth: 0`
and a commit range (`pull_request`, `merge_group`, `push`, whole history
otherwise). Squash merges mean a secret added and then deleted on a branch is in
neither the head tree nor the pull request diff, and only the range still holds
it. The config is `.gitleaks.toml`; it deliberately carries no `paths`
allowlist, because that suppresses every finding in a file, including a real
token pasted later. The one reviewed exception is `.gitleaksignore`, whose
single line is a fingerprint — one commit, one path, one rule, one line — for
the synthetic fixture in the initial commit that #185 removed from the tree; a
token committed afterwards is still a finding, which is why the exception names
a commit rather than a path.

`coverage` enforces a line floor with a number: `test:coverage` in
`package.json` (`--test-coverage-lines=84`, measured 84.59% at the commit that
introduced it). Lowering it is a reviewed diff, not an edit. The job also writes
the report into the run summary — not a pull request comment, since a fork pull
request runs without `pull_request_target`.

The release workflow signs the published image: `id-token: write` and
`attestations: write` on the release job only, `actions/attest-build-provenance`
against the pushed digest, and an SBOM from `anchore/sbom-action`. Verification
is in [deploy.md](deploy.md).

CodeQL is gated on its own diff, not globally. `github/codeql-action/analyze`
exits 0 whether it found a sink or nothing at all, so the job runs
`scripts/codeql-gate.mjs` afterwards: it reads the SARIF that run just wrote and
fails on a high or critical result the recorded baseline does not already hold.
The baseline is `.github/agent/codeql-baseline.json` — every high/critical result
the analysis at the recorded sha emits, by rule id, path and line. It holds seven
entries today: the four open `js/missing-rate-limiting` findings in `src/app.ts`
(issues #62–#65) and three results GitHub already carries as dismissed false
positive (alert #36 in `src/app.ts`, alerts #41 and #42 in
`src/gateway/gateway.ts`). The lines follow the tree that ships the file, because
the gate compares against the pull request's own tree; a reviewed PR that inserts
before an anchor refreshes that line and says so in its body. The four open alerts
stay open: the gate exists so a pull request cannot quietly add a fifth while
working beside them. The three dismissed entries are recorded so a decision
already reviewed in the alert UI does not fail the gate again — recording them
dismisses nothing. The same step runs on a push to `main`, so new
highs cannot accumulate there either. Changing the baseline is a reviewed commit,
and the PR that does it says why the alert is accepted; a line that drifts for an
unrelated reason fails loudly rather than being silently re-labelled.
`security-severity` is read whether the SARIF writes it as a number or a string,
and rules a query pack keeps under `tool.extensions[].rules` are resolved by
`ruleId` and `ruleIndex`. A security result whose severity cannot be read — and
a result whose rule cannot be resolved — counts as high; a resolved quality
query keeps its analysis level. Every verdict is printed with
`parsed N result(s), H high/critical` so a run that found nothing can be told
apart from a clean one. Those are different verdicts: a SARIF written by an
analysis that really ran and legitimately found nothing passes
(`parsed 0 result(s), 0 high/critical, 0 added`), while a missing file, a
malformed JSON body, a document with no `runs` entry and a `runs` slot that holds
no run each fail closed with a message naming which of the four it was. The last
one is the slot, not the list: `{"runs":[]}` and `{"runs":{}}` are the no-run
shape, while `{"runs":[null]}` — and any other slot that is not a JSON object,
an array included — is refused as `run <n> is not an object`, because the reader
otherwise reaches for `run.tool` and reports zero results for a document no
analysis wrote.

A result this gate accepts by severity is not always mergeable: the branch also
requires conversation resolution, so a medium finding whose thread is still open
blocks a merge that this gate passes. `#307` closes that gap without adding a
second blocker — `review-gate` owns the decision, `codeql-gate` owns the
explanation. On the pass path the gate prints one `accepted-by-severity` line per
accepted result whose review thread is unresolved at the tip, with the
`path:line` to resolve, and the job stays green; the pair of cases is pinned in
`test/codeqlGate.test.ts`, resolved threads stay quiet and a thread on a line the
run did not report costs no line. The thread list comes from the same
`scripts/lib/review-threads.mjs` reader `review-gate` uses, which is why the
`analyze` job carries `pull-requests: read`: no other step needs it. The gate step
maps `GITHUB_TOKEN` itself, because a step inherits no token and the permission
alone grants no credential. The two empty-handed cases are told apart on purpose:
a read that fails, and a pull request run that has no token or repository, print
that they could not read the threads and name the pull request, so no result is
implied to be resolved; a run with no pull request at all — a push to `main`, the
scheduled analysis — has nothing to read and stays quiet.

Enforcement is a second question and `#304` answers it: `analyze` runs in
`codeql.yml`, so `ci-ok` in `ci.yml` could not aggregate its conclusion and no
required context named it — a red analysis blocked only itself. The
`codeql-required` job reads the completed run of `codeql.yml` for this event's
commit and fails `ci-ok` when that analysis is red or absent, so the verdict is
required through the aggregate that already gates every merge. The commit is
chosen per event (`scripts/lib/codeql-required.mjs`): `push` and
`workflow_dispatch` gate the commit they run on; `pull_request` gates the pull
request head, which is the commit the analysis run reports, because `GITHUB_SHA`
on that event is the `refs/pull/N/merge` commit; `merge_group` gates
`pull_requests[0].head_sha`, never the synthetic merge commit — nothing analyzes
that commit, so waiting on it would block every queue entry — and `codeql.yml`
gains no `merge_group:` trigger for the same reason. The wait for a slow analysis
is bounded at ten minutes with twenty-second polls, because failing on the first
poll would turn a queued runner into a red required check. A scheduled run exits
0 with its reason and is not in `SKIPPABLE_ON`: the gate must never be skippable
on the event that merges.

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
  at most (1 → 2, then 2 → 3). Posting the same PASS twice is therefore not a
  no-op — the second trigger re-runs the attempt-2 run — while posting the same
  rejection twice writes nothing, because the red it painted is already standing;
- above the cap the count cannot decide, so the blocking red check's own
  `completed_at` does (#341). A red at or before the newest verdict was already
  there when the PASS arrived and is repainted once (`STATE=repainted run=<id>
  attempt=<n>`); a red after it is a genuine failure after the verdict and is
  reported as blocked on a new commit; an attempt still `queued` or `in_progress`
  is `STATE=wait` with no ids, because the API refuses a re-run of a live run. The
  comparison uses the check's timestamp, never the run's `updated_at`, which moves
  when any sibling job finishes. Without a verdict timestamp the plan fails closed.

The comment path is the job `review-gate-comment`, never `review-gate`: its checks
land on the default branch, and a skipped job would still publish a check run
under the required name. Its `if:` tests the event first and reaches the
association test only for `issue_comment`, so a stranger cannot start the
`actions: write` job and the other three events never evaluate the association.
A PASS that arrives after a rejection at the same SHA keeps the
check red until the repair step re-runs the failed run at that SHA; that now
happens without a hand step. A run above the attempt cap (attempt 3, after
two automatic re-runs) is repainted once when the red it owns predates the newest
verdict, and otherwise needs a new commit to move the tip; the step says which by
name instead of exiting quietly.

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
git add CHANGELOG.md README.md README.zh.md changelog.d package.json package-lock.json
git commit -m "release: v0.1.1"
git tag v0.1.1
```

The nightly release is planned by `scripts/release-plan.mjs`, a pure function
with no I/O, no clock and no environment. It takes the latest tag, the package
version, the tagged commit time, the workflow's run time, the merged pull
requests since that tag (number, title, labels, `mergedAt`), the `changelog.d/`
fragments, whether a release pull request is open and the existing tags; it
returns the counts, the next version, a `bump` of `minor` or `patch`, a named
reason and `shouldRelease`. The first release of an ISO week bumps the minor;
later releases in that same week bump the patch. If either timestamp is
unreadable the planner falls back to the minor. It releases only when at least
10 pull requests merged since the tag, at least 5 of them are features, at least
one fragment exists, the package version matches the tag and no release pull
request or `v<next>` tag already exists. Every other case is a reason and no
release; nothing is guessed. `git log` may only cross-check the pull-request
numbers, and a disagreement never changes the decision.

The release workflow runs `npm run check`, builds the image, publishes it to
GHCR and creates the GitHub release from the changelog. The tag must point at a
commit whose `CHANGELOG.md` has the matching section.

The release PR touches only `CHANGELOG.md`, `README.md`, `README.zh.md`,
`changelog.d/`, `package.json`, `package-lock.json` and `docker-compose.yml`;
anything else is a normal PR and needs a review. The two READMEs are on that list
because the routine writes their status line (`#348`) — one line each, version and
date, read back from the `package.json` it just wrote, and nothing else in either
file: a README hunk that is not the status line is outside the surface. No release
with no fragments.

### The daily drive

`.github/workflows/daily-release.yml` has two jobs on three triggers and no stored
credential: both run with the automatic `GITHUB_TOKEN`, and the token is scoped per
job rather than at file level (`release`: contents write, pull-requests read, checks
read, issues write; `tag`: contents write, pull-requests read, actions write).

The `release` job runs at 22:30 Asia/Shanghai (`30 14 * * *`), on
`workflow_dispatch` (default `dry_run: true`) and on a push to `main`. It collects
the state, asks the planner and the pure `decideDrive()` in
`scripts/lib/release-drive.mjs`, and does exactly one thing per night:

| Situation | Action |
|---|---|
| the rule is met and nothing is in flight | push `release/v<next>` with the mechanical commit and comment on `#80` with the counts, the branch and the pushed sha |
| the same branch already exists with the same tree | `already pushed` — report it and exit 0 |
| the same branch exists with other content | fail; the branch is never overwritten, so a review in progress cannot be discarded |
| a `release/v<next>` branch has no pull request in any state and no tag | `STATE=orphan-branch` in the summary, naming the branch and its sha, and the run is red: this is a slot wedged by an earlier run, and only the owner deletes or adopts that branch |
| a release PR is already open | no push; the drive decision goes to the artifact and the summary, and whoever calls `#187` owns the PR |
| the rule is not met | write the counts and the reason to the job summary and exit 0 |
| the trigger refuses: tag newer than the `14:30Z` boundary, a release branch present, or a release pull request open | no push; the summary names the blocker. Exit 0 only when the Decide step above already cleared the branch: a `release/v<next>` branch with no pull request and no tag is the orphan row, red and named, and no run repairs it |
| a push before today's boundary with the previous boundary unreleased | plan; the summary says `catch-up` |
| a dry run | the same summary and artifact, and no push and no comment |

A push is a planning trigger, not a tolerated one, and the event name no longer
decides: the quantity the rule counts — merged pull requests since the tag —
changes only on a push, so a push is sufficient, and a night with no merge has
nothing to release. What actually gates the night is the pure
`decideTrigger()` in `scripts/lib/release-trigger.mjs`: it plans only when the
planner's guards pass, no `release/v<next>` branch exists, no release pull request
is open and the newest tag is older than the most recent `14:30Z` boundary. That
boundary is the at-most-once marker: after a plan the branch exists, after the
merge the tag is newer than it, so no run has to remember an earlier one. A push
before today's boundary that finds the previous boundary unreleased fills it and
says `catch-up`, deliberately — a dropped slot must not cost a day. The run prints
`trigger=`, `plan=`, `catchUp=` and `reason=` in the job summary, so a merge that
planned nothing and a slot that was refused are both visible in the run history.
The `schedule` stays as a second trigger; a delivery ratio of one slot in 68 runs
(6h27m late) is why it is not the primary one (`#315`).

The push and the pull request are one action, so the credential that opens the
pull request is a precondition checked **before** anything is pushed: with
`RELEASE_OPEN_TOKEN` unset the `release` job is red, pushes no branch and names the
missing secret. A branch is pushed only when the run can open its pull request, and
the push step's `if:` names that precondition, so the state that wedged the slot —
a pushed branch no pull request could be opened for — is not reachable again. The
tree-equality guard above the push is untouched: it is the last thing between a
stale branch and a wrong release. An orphan branch is reported, never repaired: no
step creates, deletes, resets, adopts or force-pushes a `release/*` ref.

The job never opens, merges or publishes a pull request, and the file contains no
`gh pr` command at all: the pull-request half is `#187`. Rule 4 (the latest
`ci-ok` on `main` is green) has no input in the planner, so the drive checks it
before the push; a red or missing `ci-ok` on `main` is a `none` night.

The `tag` job runs on `push` to `main` only. It reads `package.json` at the pushed
commit, asks `plan()` in `scripts/lib/release-tag.mjs` whether that commit is the
squash of the mechanical release, and — if it is — writes the annotated tag with
`POST /git/tags` and `POST /git/refs` on that merge commit, then dispatches
`release.yml` at the tag with `-f tag=<tag>`. There is no `git tag` and no tag push
in the file: a tag written with the automatic token starts no workflow, and the API
path is what pins the object to the merge commit. A short sha, an unreadable
version, an existing tag, an unmerged pull request, a foreign squash commit, a head
branch that is not `release/v<version>` and two claims on one version each return
`skip` with their reason.

Both jobs read the tag list through `GET /git/matching-refs/tags/v`, never through
the runner's own tag store. `test/dailyRelease.test.ts` holds the file to that
shape: no `secrets.` other than the automatic token, no file-level `permissions:`
block, no pull-request or release command, one branch push, and the tag write
present only as the two API calls.

The mechanical class is keyed on identity, never on the file set alone:
`scripts/lib/mechanical-release.mjs` requires the head branch `release/v<next>`,
the title `release: v<next>` for the same `<next>`, and every changed path inside
the seven allowed paths. `pr-lint` uses it to skip the size rule (a release PR is
~33 files) and the `docs/deploy.md` obligation; `risk-gate` reports
`risk-tier: T0; basis: mechanical release v<next>` when `ci.yml` passes
`--branch` and `--title`. The same seven-file diff without that key stays T3,
which is what keeps the `package.json` review gate in place.

A branch name and a title are written by whoever opens the PR, so the identity is
not enough on its own: `review-gate` asks `mechanicalDiffShape()` as well, and the
exemption holds only when the diff is what the release routine writes — the
version fields in `package.json` and `package-lock.json`, the image tag in
`docker-compose.yml`, and in each README exactly one status line replaced with the
same line at the identity's version and the release date, with any content allowed
in `CHANGELOG.md` and `changelog.d/`. A dependency line, an environment change or a file the API returned
without a patch keeps the PR at T3, where it needs a PASS like any other.
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
