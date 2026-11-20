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
- A branch pushed or a pull request opened with the automatic `GITHUB_TOKEN`
  starts no `push` or `pull_request` workflow. Automation that writes a branch or
  opens a PR uses a PAT or a GitHub App installation token with the needed
  `contents` and `pull-requests` scopes, so the ordinary `pull_request` run still
  starts. The watchdog below is the backstop for when it does not.

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

### Missing CI backstop

`.github/workflows/ci-watchdog.yml` runs hourly and on
`workflow_dispatch`. It lists open same-repo, non-fork pull requests and, for each
head SHA with no `CI` run at all, dispatches `ci.yml` on the head branch. The run
is a backstop, not the primary path: it never replaces the `pull_request` run a
real identity starts.

- A fork pull request is skipped: a fork ref is not dispatchable with this
  repository's token.
- A pull request with a completed `CI` run at its head SHA is skipped, whatever
  that run's conclusion; another workflow's check run does not count, because
  `CodeQL` or a review bot can leave a check on a tip `CI` never visited.
- A queued or in-progress `CI` run is never duplicated.
- A cancelled run is not evidence that `CI` reached the tip: it can end before any
  job exists, so the head carries no `ci-ok` and nothing repairs it. A head whose
  `CI` runs are all `cancelled` is dispatched once. That repair is bounded per head
  SHA by the `workflow_dispatch` run it starts: when the repair is cancelled too,
  the watchdog prints the pull request as `stalled (cancelled-repair)` instead of
  dispatching it again on the next tick, and re-dispatching it becomes a human's
  decision.
- At most 5 pull requests are dispatched per tick, so an outage cannot start an
  unbounded number of full CI runs in one pass.

The job uses the automatic `GITHUB_TOKEN` with `contents: read`,
`pull-requests: read` and `actions: write`. `workflow_dispatch` is the documented
exception to the token-suppression rule, so the dispatch itself starts a run. The
watchdog does not bypass a required check and does not change branch protection;
it only gives an empty head a run to report.

## Issue states and labels

Type (exactly one): `bug`, `enhancement`, `documentation`, `accessibility`.

Area: `area:auth`, `area:repos`, `area:jobs`, `area:gateway`, `area:ui`,
`area:deploy`, `area:security`, `area:docs`.

State:

| Label | Meaning |
|---|---|
| `needs-info` | The report is not reproducible or the spec is unclear |
| `needs-human` | An owner-only decision is required: a real signature, production, keys, data deletion, or opening a security surface. A design or policy question the team can settle is not `needs-human` — pick the answer and record it |
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
   write: it never adds `agent-ready` and never edits the body. `agent-ready` is
   added by the Lead and only by the Lead.
   For an owner-filed card the same write also removes `needs-review` and
   assigns the card back to `HugoXK`; that hand-back is part of the verdict, not
   a separate step (`AGENTS.md`, "Issue ownership and verdict writing"). A
   verdict that leaves an owner-filed card assigned to the Reviewer is a board
   defect, because dispatch reads the assignee.

The hash is sha256 over the decoded body, first 12 hex. A verdict may name
either the raw body or the body with trailing whitespace stripped — several
published verdicts were taken over the stripped form — and the gate honours
both, printing ` (trimmed)` on any line that matched the stripped form. Any
other byte difference is a material edit and voids the PASS. One definition
serves both ends: `scripts/lib/issue-body-hash.mjs` is what the gate reads with
and what `scripts/issue-hash.mjs` prints, so a verdict writer records from the
same function instead of trimming by hand. The Lead recomputes it with

```sh
node scripts/issue-gate.mjs --issue <N>   # ok | stale-pass | no-pass | bad-passer | changes | corrupt-body | hold | stale-anchor
node scripts/issue-hash.mjs --issue <N>   # raw <hash> / trimmed <hash> for a verdict line
```

immediately before adding `agent-ready` — never from an earlier run in the same
session, never from memory, never from the PASS text alone. A `changes` line
(exit 4) blocks the label exactly like a missing PASS, and a verdict from
anyone other than the policy's `requiredPass` is not a PASS at all. A `hold`
line (exit 7) means the card is approved but not claimable: `hold` replaces
`ok` and nothing else, so a held card with `changes` still reports `changes`,
and a held card with no verdict still reports `no-pass`.

A `stale-anchor` line (exit 8) is the other question the gate answers: a card
can be approved at the live body and still cite a `path:line` that does not
exist at the sha the body names. The gate reads the tree at that sha — the first
full 40-hex outside a fence, or `main` when the body pins nothing — and refuses
`ok` when a cited path is absent (`found=missing-path`) or a cited line is past
the file's last line (`found=last-line-<n>`), where the last line is the `\n`
segments minus the trailing empty one. It replaces `ok` and nothing else, so a
stale PASS, a CHANGES, a `hold` and a missing PASS all keep their own line and
gain one stderr note per unresolved citation (at most five). Two things it
deliberately does not do: a bare name that matches several paths is a note and
never a verdict, and a citation inside a fenced block or on a line that declares
the file new is not scanned. It cannot tell that a real line now holds a
different function — the premise stays a human catch, as `docs/autonomous-dev.md`
already says of the review itself.

Known limit, stated rather than papered over: a byte-for-byte revert back to the
PASSed text **does** revive the PASS, because the gate compares the live body
with the published verdicts and GitHub exposes no body-edit history. Do not
describe this gate as revert-proof. The machine half covers every other case;
the human rule — a material edit voids the approval, so the Reviewer re-reads —
covers that window.

Otherwise `needs-human` or `needs-info`, with the blocking question in a comment.

A reviewed branch never gains a merge commit whose only purpose is to absorb a
newer base: it voids the PASS and makes the same change be judged twice. Fix the
branch, push a new tip, and ask for a verdict at that tip. Resolve a real
conflict inside the branch; never rewrite a tip that was already reviewed.

## Risk tiers

`node scripts/risk-gate.mjs --base origin/main` is the source of truth. It prints
a report and a final machine-readable line:

```
risk-tier: T2; basis: src/jobs/service.ts
```

| Tier | Paths | Merge requirement |
|---|---|---|
| T0 | `docs/`, `README*`, `CHANGELOG.md`, `changelog.d/`, `CODE_OF_CONDUCT.md` | `ci-ok` green |
| T1 | `test/`, `public/` assets, issue templates, small UI-only changes | `ci-ok` green |
| T2 | the rest of `src/` (app routing, views, email, users, lib), a `public/**/*.js|mjs` client-side script | PASS at tip + `ci-ok` |
| T3 | auth, gateway, jobs, repos, config, db, bridge, `scripts/`, `deploy/`, `.github/`, manifests, licence, policy docs | PASS at tip + `ci-ok` |

Unknown path → T2. A `risk:T*` label is advisory and never a reason to skip a
review.

The tier is also raised by what a diff does, not only by the path it touches
(#869). A T1 tip becomes T2 when it removes an `assert.`/`expect(` line under
`test/`, adds `assert.ok(true)`/`assert(true)`, or adds an inline `<script>`
under `public/`: changed-line coverage counts added `src/` lines, so a deleted
assertion leaves the suite green and the percentage flat. The rules are data in
`.github/agent/risk-rules.json` (`escalations`), and the CI risk job,
`scripts/lib/review-gate.mjs` and `scripts/pr-lint.mjs` all classify through
`tierForChanges` in `scripts/lib/risk.mjs`, so the computed tier, the `risk:T*`
label and the PASS the gate demands cannot disagree.

## Gates

Branch protection on `main` enforces **`ci-ok`**, **`review-gate`** and
**`pr-lint`** directly. `dependency-review` and the CodeQL analysis are enforced
inside `ci-ok` (as `dependency-review` and `codeql-required`), so they are not
separate branch-protection contexts. The set is recorded, with the names exactly
as the checks API reports them, in
[`.github/agent/required-checks.md`](../.github/agent/required-checks.md); that
file is the record and not the gate — branch protection is an owner action.

`ci-ok` is also published by `ci-ok-publish.yml`, a `workflow_run` workflow that
GitHub always takes from the default branch, so the copy that judges a change is
never the one under test. The aggregate job inside `ci.yml` keeps publishing the
same context for one step — the pull request that adds the publisher would
otherwise carry no `ci-ok` and could never merge; every check run at the head sha
counts, so the head's green cannot retire the publisher's red — and a follow-up
renames it to `ci-ok-head`. See
[Gate integrity](#gate-integrity-the-evaluator-runs-from-the-base-branch).

`ci-ok` is green only when all of these are green at the same tip:

- `changes` (the diff classifier; it must succeed before any conditional job)
- `lint`
- `typecheck`
- `test` on Node 24 (the supported-version compatibility run)
- `coverage` (the Node 22 full-suite execution and the Node coverage floor
  recorded in `package.json`; one execution per supported Node line, plus the
  changed-lines floor on the pull request diff)
- `build`
- `visual` (the UI matrix, when the diff reaches a rendered surface)
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
- `deploy-check` (the `deploy/` worker, alert rules, the nginx sample against a real `nginx -t`, and the systemd sample through a static unit parser, when the diff reaches `deploy/`)

A skipped required job is a failure, not a pass: `scripts/ci-ok.mjs` fails on
`skipped`, `cancelled` or a job absent from `needs`, except where
`SKIPPABLE_ON` records that an event has nothing for that job to read.

### Change-aware gates

The `changes` job in `ci.yml` classifies the pull request diff once and writes
nine flags: `source`, `frontend`, `deps`, `db`, `docker`, `workflows`, `codeql`,
`deploy` and `docsOnly`. Jobs that cannot learn anything from the diff carry a job-level `if`
and are skipped **before a runner starts**, not after an install:

| Flag false | Jobs skipped |
|---|---|
| `source` | `lint`, `typecheck`, `build` |
| `frontend` | `visual` |
| `deps` | `audit` |
| `db` | `restore-drill` |
| `docker` | `docker` |
| `workflows` | `action-pins`, `workflow-lint` |
| `deploy` | `deploy-check` |
| `codeql` | `codeql-required` (and the CodeQL workflow's own docs/deploy/Dockerfile path filter) |

`test` and `coverage` are never conditional, and are not in this table. The suite
is a cross-cutting reader: 60 of the 184 files under `test/` read `docs/`,
`public/`, `deploy/` or `.github/`, so a docs-only, asset-only, deploy-only or
workflow-only diff still turns the suite red. Skipping it for `source: false` let
`ci-ok` go green over a red suite, and for `docs/` (T0) and `public/` (T1) no
verdict reads it either.

`deploy` is its own flag because a deploy-only diff is not gate-free: `deploy/`
ships the Cloudflare worker, the Prometheus rules and the nginx/systemd samples,
and none of the app gates reads them. `deploy-check` parses the worker, runs
`promtool check rules`, installs nginx and parses the sample for real — with a
negative proof that the same invocation rejects a deliberately broken copy — and
gates `deploy/fledge.service` through a static unit parser that runs on any
runner. A missing tool is a failed step, never a gap recorded beside a green job
(#882). The
flag is computed from the same path list as `source`, so a diff that mixes
`deploy/` with `src/` sets both and the code gates still run; the classifier
cannot answer "deploy-only" for a mixed diff, and `test/ciChanges.test.ts`
pins that refusal.

One full-suite execution per supported Node line is enough (#642): `test (24)` is
the compatibility run and `coverage` is the Node 22 run, since both commands
execute `test/*.test.ts` and a second Node 22 leg bought no second signal. The
matrix job keeps its name and `ci-ok` still requires both jobs; a failing test
fails both remaining runs.

`restore-drill` reuses the build artifact instead of installing and building a
second time (#643). Reuse is bound to provenance, not to an artifact name: the
`build` job writes `dist/build-manifest.json` naming `$GITHUB_SHA` and the sha256
of every file it emitted, and the drill runs `node scripts/dist-manifest.mjs
verify --dir dist --commit "$GITHUB_SHA"` before it does anything. A stale,
partial, edited or foreign artifact fails there instead of standing in for the
commit under test; a missing artifact fails at the download step, and there is no
fallback rebuild, because that fallback is exactly what would hide a broken
`build` job. The drill loads only `dist/` and the checked-out `scripts/`, so it
needs no `npm ci`.

The classifier is an allowlist. An unknown path, an unreadable diff or an empty
path list runs every gate. A push, schedule or manual run sets every flag true,
so `main` is still verified in full. `ci-ok` accepts a skipped conditional job
only when the matching flag is false on a `pull_request` or `merge_group`
event; a missing flag fails closed. `SKIP_WHEN` in `scripts/ci-ok.mjs` is the
machine copy of this table.

The diff is read by `scripts/ci-changes.mjs`, not by the step. A pull request
whose branch was cut before the latest `main` names a base commit that the
checkout does not carry, so the first diff fails. The script then fetches that
commit **with its history**: a depth-limited fetch places the commit but grafts
it as a shallow root, so the three-dot diff fails again — with `no merge base`
instead of `Invalid symmetric difference expression` — and nothing is gained. It
also deepens the checkout when the checkout itself is shallow, because a base
with history shares no ancestor with a grafted head, and only then retries. The
base branch ref is the fallback for a server that will not serve an arbitrary
sha, fetched the same way and never as a depth-limited tip, since a branch tip
without its ancestors cannot supply a merge base either. Only after those
attempts does it fall back to running every gate (#752). That fallback is still
the last resort — an unreadable diff must never shrink the gate — but without a
fetch that keeps history it fired on every older branch, and the
`codeql-required` job it woke then spent its full bound waiting for an analysis
CodeQL never starts for an ignored path. The short circuit for a diff that
touches only paths `codeql.yml` ignores is separate and is described under
[Supply-chain gates](#supply-chain-gates).

### Gate integrity: the evaluator runs from the base branch

A pull request decides nothing about itself. Every evaluator is checked out from
the base branch into `base/` and executed from there:

| Job | Runs |
|---|---|
| `changes` | `node base/scripts/ci-changes.mjs --repo . --git-base <base> --git-head <head>` |
| `risk` | `node base/scripts/risk-gate.mjs --repo . --base <ref>` |
| `action-pins` | `node base/scripts/action-pins.mjs --workflows .github/workflows` |
| `workflow-lint` | `node base/scripts/workflow-injection.mjs --workflows .github/workflows --allowlist base/.github/agent/workflow-injection-allowlist.json` |
| `codeql-required` | `node base/scripts/codeql-required.mjs` |
| `ci-ok` (the in-run aggregate, until the follow-up renames it) | `node base/scripts/ci-ok.mjs` |
| `ci-ok` (the publisher's verdict) | `node base/scripts/ci-ok-run.mjs`, run by `ci-ok-publish.yml` |
| CodeQL gate | `node base/scripts/codeql-gate.mjs --sarif codeql-results --baseline base/.github/agent/codeql-baseline.json` |

Only the data under test comes from the head: the diff (`--repo .` names the
checkout that carries the pull request's commits), the workflow files the two
supply-chain checks read, and the SARIF the analysis produced. The CodeQL
baseline and the workflow-injection allowlist are read from `base/`, because a
pull request that could widen either would grade its own work.

The in-run aggregate also prints the blob the base tree holds for the evaluator
it is about to run: `scripts/ci-ok.mjs from the base tree: blob <sha>`. That
line is how a reviewer tells the two copies apart in a run log — the sha named
there is the file the next step executes — so a branch that rewrites
`scripts/ci-ok.mjs` is visible as a mismatch instead of an invisible
substitution. It is evidence, not a gate: the verdict still comes from the base
file.

The `changes` job also runs `scripts/gate-integrity.mjs`, which writes every
gate file in the diff into the job summary. It fails closed when the diff cannot
be read: a summary that says "no gate file" over an unreadable diff would be a
blind gate, not a clean one. The step runs it only when the base tree has the
file (`[ -f base/scripts/gate-integrity.mjs ]`), because the pull request that
introduces the summary runs against a base branch that predates it; the test is
on the base path, so a diff cannot decide whether the summary runs. Nothing
about the merge requirement changes — a diff that edits the gate is still T3 and
still needs a PASS at the tip.

What the checkout split cannot move: for a `pull_request` event GitHub fetches the
workflow YAML itself from the pull request, so a job's own `run:` lines are, by
construction, the head's text. That is why the `ci-ok` verdict also comes from
outside the run. `ci-ok-publish.yml` triggers on the completed `CI` run; GitHub
always loads a `workflow_run` workflow from the default branch, so the file that
decides is never the one under test. It reads the finished run's job results from
the API, re-derives the change flags with the default branch's `ci-changes.mjs`
over the same diff, evaluates the default branch's `REQUIRED_JOBS` and
`SKIP_WHEN`, and creates the `ci-ok` check run itself. The in-run aggregate still
publishes the same context in this step, but it is never read as evidence — the
publisher matches required jobs by name and answers `null` for both `ci-ok` and
`ci-ok-head` — so a head that rewrites its `run:` line to `exit 0` changes only
that job's own result, and every check run at the head sha counts, so the
publisher's red still blocks. A required job the head deletes or renames is
reported missing by name, which is red — the same answer as dropping it from
`needs` inside the run. A run the platform `cancelled` publishes nothing, because
the run that replaced it owns the verdict. A `pull_request` run whose payload no
longer names its base publishes nothing either, but only when the head's own pull
request is closed as merged (#1117): the merge removed the base, there is no merge
candidate left to judge, and a squash merge leaves the head unreachable, so
reachability is not the test — the commit's pull request list is. The same shape
with an unmerged or unfindable pull request still publishes `failure` naming the
missing base, and a run whose evidence cannot be read publishes `failure` with the
reason rather than silence. The skip is logged with the branch of the decision
that fired, so a later reader can tell a skip from a failure.

The trigger reaches the script as one integer: `ci-ok-publish.yml` passes
`CI_OK_RUN_ID` from `github.event.workflow_run.id`, and `runIdFrom` accepts
digits only before the value can enter a request path. Every other fact about the
run comes from the API, and the published body's status and conclusion are
literals from `scripts/lib/ci-ok-run.mjs`, so no file the job can read — the
event payload included — contributes bytes to the request. That is why the
script no longer reads `GITHUB_EVENT_PATH` at all.

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

The reporter itself can fail, and that failure needs its own durable signal
(#929): until it had one, a `main-health` run that crashed after `ci-ok` had
failed — a malformed `gh` answer, a refused write — printed its error, exited 1,
and left nothing, which is the same silence the tracker was built to end. The
runner's catch now opens one label-less issue titled `ci: main-health failed to
report`, naming the commit, the run and the original error, and still exits 1.
Label-less on purpose: a labelled create is rejected before the issue exists
when the label is missing, so it would depend on the same bootstrap that can
fail the reporter, and nothing ever searches for this issue — a human reads it
and closes it. A crash off the default branch writes nothing (the same gate as
the decision), and the signal's own `gh` call is guarded so a signal that
cannot be opened cannot mask the failure it reports.

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

`coverage` enforces two floors, and they answer different questions.

The whole-tree floor is a number in `test:coverage` in `package.json`
(`--test-coverage-lines=84`, measured 84.59% at the commit that introduced it).
It answers "is the tree still covered"; lowering it is a reviewed diff, not an
edit. It cannot answer "is the code *this pull request adds* covered", because a
200-line untested branch is invisible in a percentage over a large, well-covered
`src/**`.

The changed-lines floor is `scripts/coverage-diff.mjs`, run by the `coverage` job
on a pull request after the report is written. It takes the added `src/**` lines
of `git diff <base>...<head>`, joins them to the report Node printed (the
uncovered line ranges, per file), and fails when the added code lines are below
80% covered. `<head>` is the checked-out commit, not the pull request's head sha:
the job's checkout is `refs/pull/<N>/merge` (it sets no `ref:`), so the report is
numbered in the merge tree. The base is that merge's first parent, so the diff is
still the pull request's own change; the two line numbers only agree when both
sides describe the same tree, and with the head sha a base that moved inside a
file the pull request edits made an uncovered line read as covered. Only added
lines under `src/**` are measured, and only ones that can execute: comments,
imports, type declarations, generated files and `*.d.ts` are not counted, because
the report can never list them as uncovered. An uncovered added line is printed
as `path:line` in the step log, so the fix is a test for that line rather than a
request for a higher total. A changed file the report has no row for is the same
failure: Node prints a file only when the suite loaded it, so a new module no test
imports is printed as missing and counts as entirely uncovered.

Two diff shapes used to make the gate skip a file it should have measured, and
both now have a test. A path with a non-ASCII byte is C-quoted by `git diff`
(`+++ "b/src/lib/\346\227\245.ts"`) unless it is told otherwise, so the diff is
read with `-c core.quotePath=false` and the parser unquotes a quoted header too —
quoted, the name starts with `"`, fails the `src/` test and the file is dropped.
An added line whose text begins with `++ ` prints as `+++ …`, which is a file
header only outside a hunk: the parser tracks hunk state, so such a line is
content and the rest of its file is still measured.

A pull request that genuinely cannot test the added lines says so in its body,
on one line of its own:

```
No-test: the branch is unreachable until #700 lands
```

The step prints what waived it. A documentation, config or workflow-only diff
adds no `src/**` line and the gate skips it — that is the classifier's own rule,
not a second switch. The total floor stays in place: this gate is additional, and
`npm run coverage:diff -- --diff <path> --report <path>` runs the same check
locally. The job also writes the report into the run summary — not a pull
request comment, since a fork pull request runs without `pull_request_target`.

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
unrelated reason fails loudly rather than being silently re-labelled. Every open
entry carries `owner` and an ISO `expires`; the gate validates the file before it
compares keys and fails closed on a malformed entry or an expiry in the past,
naming the owner and the date. A dismissed entry carries `dismissed: true` with
its alert-UI rationale and no expiry, so a reviewed false positive never turns red
on a date nobody can act on. `expires` is the only age rule; `recordedAtSha` keeps
its one job as the sha printed in the failure line.
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
no run each fail closed with a message naming which of the five it was. The
fourth is the slot, not the list: `{"runs":[]}` and `{"runs":{}}` are the no-run
shape, while `{"runs":[null]}` — and any other slot that is not a JSON object,
an array included — is refused as `run <n> is not an object`, because the reader
otherwise reaches for `run.tool` and reports zero results for a document no
analysis wrote. The fifth is the list itself: `{"runs":[{}]}` and
`{"runs":[{"results":[]}]}` are both an analysis that really ran and found
nothing, so both pass, while a `results` value that is present and is not a list
— `null`, a number, a string or an object — is refused as
`run <n> results is not a list`, because the reader would otherwise call it
zero findings, crash on it, or iterate a string into one finding per character.

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
required through the aggregate that already gates every merge. The lookup names
the commit in its query (`?head_sha=…&status=completed`) instead of scanning the
workflow's newest runs: on a busy repository a commit's own run falls outside any
fixed window, so a green analysis reads as absent and the gate reds a mergeable
pull request (#585). The exact `head_sha === sha` predicate is unchanged — a row
that merely advertises the commit in `pull_requests[].head.sha` never answers for
it — and an API that ignores the filter is paged inside the same ten-minute
bound, capped at ten pages of a hundred runs. The commit is
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

The gate also reads the change set, because `codeql.yml` filters its own trigger
with `paths-ignore`: a pull request that changes only `docs/`, a Markdown file, a
deploy file or the `Dockerfile` is analysed by nothing, so waiting ten minutes and
then reporting "no analysis" reds a mergeable pull request (#752). When every
changed path matches that list the job answers immediately and says why. The list
is parsed out of `.github/workflows/codeql.yml` as it stands at the **base**
commit rather than copied into the module or read from the checkout, so the policy
cannot drift from the workflow and a pull request that edits the workflow is still
judged by the filter in force before it. Every uncertainty — no inventory, an
unreadable one, an empty change set, a failed read, a compare answer that could be
truncated at the 300-file cap — falls through to the wait, which remains the
answer for any change CodeQL does analyse. A `push` is never excused this way:
that trigger is unfiltered.

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

One exemption is structural and keyed on a **pair**: when the pull request's
author login is exactly `dependabot[bot]` *and* the body's first line starts with
`Bumps `, the four body rules are not asked of it (#982). A generated dependency
bump cannot carry a signature, a `Ran:` line or an issue reference, and nobody
here rewrites a bot's body, so the rules would keep it red forever. The
exemption is the pair and never a label, a branch prefix, or `dependabot`
appearing somewhere in the text — a label is rights a person can grant
themselves, and a human account posting the same body is refused exactly as
before. Every later rule still applies to a bump: the changelog fragment, the
docs obligation, the `Large-PR:` line, the computed tier and its `risk:T*` label,
and the whole `ci-ok`/`review-gate` set. A PASS is still required at the tip for
T2/T3, and a dependency bump that changes a T3 path is judged at T3.

Both checks read the pull request's file and commit lists, and both used to stop
at a fixed page cap. A list longer than the cap was judged from its prefix, which
is enough to hide the only T3 path — or a reviewer-authored commit — past the cap
and let the pull request be classified below the tier it needs (#862). Each list
is now read until the API returns a short page, and both checks prove the read
list whole against the `changed_files` and `commits` counts the pull request
object reports. A short read, a count the API does not send, or a list that only
stops at the absurdity guard is refused by name — "the changed-file list is
incomplete: read N of M" — instead of being classified. `pr-lint` judges
completeness before any rule that reads the paths, so a truncated list is reported
as an incomplete list rather than as a body complaint.

`pr-lint` is its own workflow (`.github/workflows/pr-lint.yml`), so a fixed PR
body repaints that check and nothing else. Its activity types are `opened`,
`synchronize`, `reopened`, `ready_for_review` and `edited`; the review gate
keeps GitHub's default three and is not restarted by a body edit, because
`review-gate` is the check that must move only when a verdict does.

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

`reviewer-authored` runs on `pull_request` (`opened`, `synchronize`, `reopened`) and
fails at the push that makes the condition true: a tip carrying a commit whose
`author.login` is a reviewer identity in `.github/agent/review-policy.json` cannot
be independently reviewed, and no verdict at any SHA can turn that green. It reads
the same `reviewerAuthoredCommit()` the gate reads, from the **base** ref, and it
is an early warning rather than a required context — `review-gate` still decides.
The fix is to re-author the commit (`git commit --amend --author=...`, or a
`filter-branch`/`rebase` over the branch) and push; the trees do not change.
Before this job existed the condition was visible only in the job log of a red
`review-gate` run, which is how `#532`, `#533` and `#618` each spent a review round
on a tip that could never merge.

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

- a PASS re-runs the failed runs whose own job of that context failed, for every
  required context a verdict can invalidate — `review-gate`, owned by the
  `Review gate` workflow, and `pr-lint`, owned by `.github/workflows/pr-lint.yml`
  since `#753` — which clears the pre-PASS red that would otherwise block the
  merge. No failed suite may be left standing, because that is what the merge gate
  reads. One workflow never repaints another context: re-running `Review gate`
  cannot move `pr-lint`, and a stale red `pr-lint` blocked a merge while the step
  reported the tip was fine until `#770` paired each context with the workflow
  that owns it. A red in a context with no run left below the cap is reported as
  blocked, never passed;
- a rejection re-runs the newest repairable run of the `Review gate` workflow at
  the SHA, so a run that is currently green turns red. A run of any other
  workflow at the same SHA is never a target, and a red `pr-lint` does not count
  as the rejection being visible: re-running another workflow paints no
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
The association gate is per job, not per workflow: any job holding `actions:
write` must test `author_association` on every event a stranger can trigger, and
`review-gate-repair` does the same for `pull_request_review` (reading
`github.event.review.author_association`). The comment job holds no second test of
the comment's shape: a word list in its `if:` was a second definition of "a
verdict" and it drifted — `## REVIEW` started nothing while the parser accepted it
(#931). The job now names only the event and the association, and the guard step
asks `parseConclusion` itself after checking the default branch out, so one
expression decides for both halves and a pull request cannot edit the copy that
decides. `scripts/action-pins.mjs` enforces the
rule for the whole tree — a job with `actions: write` on a stranger-reachable
event without the matching association test reds the required `action-pins` job.
The scan counts the permission in each form it takes: a block mapping, an inline
`{ actions: write }`, `write-all`, and a workflow-level block that a job without
its own inherits. Block indentation is not assumed: the jobs' width is taken from
the first key after `jobs:`, and the events' width from the first key after
`on:`, so a block indented three or four spaces is scanned like any other and a
header with a trailing comment is still a header. A shape the parser cannot read
is a finding rather than a skip — an unreadable `permissions:` value, an empty or
unreadable `jobs:` block, an `on:` value that is neither a list, a block mapping
nor a flow mapping, an entry under `jobs:` or `on:` that does not parse. The same
holds per job: a job holding `actions: write` whose triggers are empty or
unreadable is refused, and so is one on an event this gate cannot classify. The
classifiable events are the association map plus an explicit `SAFE_EVENTS` list of
triggers an outside account cannot start (`push`, `schedule`,
`workflow_dispatch`, `workflow_call`, `workflow_run`, `merge_group`, `release`,
`create`, `delete`, `repository_dispatch`, `deployment`, `deployment_status`,
`page_build`, `status`, `registry_package`, `branch_protection_rule`, `public`) —
any other event name reds until someone classifies it. The association list must
be exactly `OWNER`, `MEMBER` and `COLLABORATOR`: an extra role, a missing role or
a role-name substring is a finding.
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
requests since that tag (number, title, labels, `mergedAt`), how many
`changelog.d/` fragments are pending — a count, and the number the release body
prints — whether a release pull request is open and the existing tags; it
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

The `release` job runs at 10:00 Asia/Shanghai (`0 2 * * *`), again at 11:00
(`0 3 * * *`) as a catch-up for a late or dropped delivery, on
`workflow_dispatch` (default `dry_run: true`) and on a push to `main` that
touches a release-shaped path: `package.json`, `package-lock.json`,
`CHANGELOG.md` or `docker-compose.yml`. The paths filter is the steady-state fix
(#548): an ordinary feature merge changed the pull-request count but started a
full plan job (`fetch-depth: 0`, several API calls) even when the `02:00Z` slot
had already shipped. `changelog.d/**` is deliberately not in the filter, because
almost every feature pull request adds a fragment; including it would put the
per-merge noise back. The catch-up slot and the filtered push still go through the
same trigger predicate, which is unchanged. It collects the state, asks the
planner and the pure `decideDrive()` in `scripts/lib/release-drive.mjs`, and does
exactly one thing per run:

| Situation | Action |
|---|---|
| the rule is met and nothing is in flight | push `release/v<next>` with the mechanical commit and comment on `#80` with the counts, the branch and the pushed sha |
| the same branch already exists with the same tree | `already pushed` — report it and exit 0 |
| the same branch exists with other content | fail; the branch is never overwritten, so a review in progress cannot be discarded |
| a `release/v<next>` branch has no pull request in any state and no tag | `STATE=orphan-branch` in the summary, naming the branch and its sha, and the run is red: this is a slot wedged by an earlier run, and only the owner deletes or adopts that branch |
| a release PR is already open | no push; the drive decision goes to the artifact and the summary, and whoever calls `#187` owns the PR |
| the rule is not met | write the counts and the reason to the job summary and exit 0 |
| the trigger refuses: tag newer than the `02:00Z` boundary, a release branch present, or a release pull request open | no push; the summary names the blocker. Exit 0 only when the Decide step above already cleared the branch: a `release/v<next>` branch with no pull request and no tag is the orphan row, red and named, and no run repairs it |
| a push before today's boundary with the previous boundary unreleased | plan; the summary says `catch-up` |
| a dry run | the same summary and artifact, and no push and no comment |

The state collection measures the changelog fragments with
`scripts/fragment-count.mjs`, the same rule `scripts/changelog.mjs` folds with. A
directory holding only `README.md`, or no markdown at all, is zero fragments — a
legitimate answer the planner turns into its own first reason, not a failed step —
while a directory the process cannot read fails the job (#548). The `Plan`,
`Decide` and `Trigger` steps read the collected state only when the collect step
succeeded, so a missing state file is never dereferenced and the collect failure
is the single report.

A push is a planning trigger only when the paths filter above matched a
release-shaped change; the event name no longer decides. The quantity the rule
counts — merged pull requests since the tag — changes on every merge, but a full
plan job per merge was the steady-state cost #548 removed, so ordinary feature
merges no longer start one. What actually gates an eligible run is the pure
`decideTrigger()` in `scripts/lib/release-trigger.mjs`: it plans only when the
planner's guards pass, no `release/v<next>` branch exists, no release pull request
is open and the newest tag is older than the most recent `02:00Z` boundary. That
boundary is the at-most-once marker: after a plan the branch exists, after the
merge the tag is newer than it, so no run has to remember an earlier one. A push
before today's boundary that finds the previous boundary unreleased fills it and
says `catch-up`, deliberately — a dropped slot must not cost a day. The run prints
`trigger=`, `plan=`, `catchUp=` and `reason=` in the job summary, so a merge that
planned nothing and a slot that was refused are both visible in the run history.

The two `schedule` slots are the dependable planning path: the 02:00Z delivery is
the slot, and the 03:00Z delivery fills it again if the first was late or dropped;
the predicate makes the second run `slot-shipped` when the first already released,
so the catch-up cannot double-release. `workflow_dispatch` is the owner's manual
path. The push stays eligible so a release-shaped merge still reaches the same
predicate and the run history records what it decided; a delivery ratio of one
slot in 68 runs (6h27m late) is why it was made eligible in the first place
(`#315`).

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

The `tag` job runs on the filtered `push` to `main` only: a merged release pull
request always changes `package.json` and `CHANGELOG.md`, so the paths filter
always lets it through. It reads `package.json` at the pushed
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
builds and pushes the image, then creates or edits the GitHub release. Its job
holds the publish scopes, so the checkout that feeds `npm ci` sets
`persist-credentials: false` (#861): a dependency lifecycle script must not be
able to read a token from `.git/config`, and the steps that need the API pass
`secrets.GITHUB_TOKEN` explicitly instead. It never
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
