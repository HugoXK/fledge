# Required checks — the record

**This file is the record, not the gate.** Required status checks live in the
repository's branch protection, and only an owner can write them; editing this
file changes nothing at merge time. It exists so that the set the API enforces is
readable in a diff, and so the next person who wonders "what actually blocks a
merge" does not have to infer it from a red PR.

Names below are **exactly what the checks API reports**, because that is the
string the merge API matches. A job whose `name:` differs from its job id has to
be listed by its `name:`.

## Required on `main`

The branch protection API currently enforces three contexts directly:

| Context | Workflow | What it proves |
|---|---|---|
| `ci-ok` | `ci.yml` | every aggregate job succeeded at the same tip |
| `review-gate` | `review-gate.yml` | a PASS at that tip from the required reviewer |
| `pr-lint` | `review-gate.yml` | the PR body, fragment and docs obligations |

Two more checks are enforced **inside** `ci-ok` rather than as separate required
contexts:

| Context | Where | What it proves |
|---|---|---|
| `dependency-review` | `ci-ok` need | no new high-severity advisory in the pull request diff |
| `codeql-required` / `Analyze JavaScript/TypeScript` | `ci-ok` need + CodeQL analysis | no new high/critical CodeQL result |

`ci-ok` is the aggregate: `changes`, `lint`, `typecheck`, `test` (Node 22 and
24), `coverage`, `build`, `visual` (UI diffs), `docker` (image builds, scans and
starts), `audit` (runtime and full graph), `changelog`, `version`, `risk`,
`restore-drill`, `dependency-review`, `action-pins`, `workflow-lint`,
`secret-scan`, `codeql-required`. The list asserted by the gate is
`REQUIRED_JOBS` in `scripts/ci-ok.mjs`, and `test/ciOk.test.ts` fails when it and
`needs:` in `ci.yml` drift apart.

`changes` is a gate too: it classifies the pull request diff and the heavy jobs
use job-level `if` conditions so an inapplicable job never starts a runner.
`ci-ok` accepts a skipped conditional job only when the matching flag is false
and the event is a pull request or merge-group entry; a push, schedule or manual
run classifies every flag as true, so nothing is skipped there. An unknown path
or an unreadable diff also sets every flag true. The full mapping is
`SKIP_WHEN` in `scripts/ci-ok.mjs`.

## Up-to-date rule: `strict` is conditional

`strict: true` (require branches to be up to date before merging) is **only**
correct when no merge queue is enabled. With one conclusion per tip, `strict:
true` makes every merge to `main` invalidate every open PR's up-to-date status;
the only repair is an "Update branch" commit, which is a new head and voids the
PASS at the old tip — so each intervening merge costs one fresh review of every
open pull request.

Where a merge queue exists, the queue already runs CI against the real merge
result and `strict` is redundant. Prefer the queue.

**Residual risk of `strict: false` with no queue:** `ci-ok` runs on the pull
request head, so once `main` has moved the squash result is a tree no job ever
ran. Two green branches can be red together — a semantic conflict — and nothing
would catch it before the merge. `strict: false` is the current state of `main`;
it is not safe-by-default.

Enabling `strict`, a merge queue, or changing this set is an owner action
through branch protection, never a repository edit.
