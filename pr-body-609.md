Written-by: HugoXK

Investigates: #538

## What changed

### Repository-owned rules and skills (first slice)

- Added `.fledge/rules.md`, `.fledge/review.md`, `.fledge/develop.md` and `.agents/skills/<name>/SKILL.md` as repository-owned inputs, read from the default branch at the job's fixed commit (`base_sha` for an iterate, the resolved branch head otherwise).
- Added `job_contexts` and `job_context_files`; every job records the commit, rule/skill manifest and per-file SHA-256. The whole set is rejected on a symlink/submodule, NUL byte, oversize file, too many skills or an unreadable rule file.
- Injected the effective rule text into the FlyBot bridge prompt (first 16 KiB) and a skill index. The full skill text is read on demand from `GET /api/jobs/:id/context?path=...` with the job callback secret; the endpoint only serves that job's recorded files and only while the job is queued/running.
- Added a rule-change guard: a PR that changes a rule or skill file is recorded in verification and blocks auto-merge until a maintainer acknowledges that exact head SHA. The acknowledgement is a per-job/per-SHA setting and is invalidated by a new commit. The job page exposes the acknowledgement button.

### Console rule overrides (new in this tip, tip `c9203c43d0a54527c9f1ee510a57ff2b1908d92c`)

- Added `repo_rule_overrides` (`repo_id`, `path`, `content`, `revision`, `updated_by`, `updated_at`, primary key `(repo_id, path)`).
- Added repo-scoped Store reads and revision-fenced writes: `listRepoRuleOverrides`, `getRepoRuleOverride`, `upsertRepoRuleOverride` (revision increments, stale `expected_revision` refused) and `deleteRepoRuleOverride` (clear, also revision-fenced).
- Extended `src/rules.ts` so the effective layer per path is `repository` > `console` > `builtin`. A repository file wins; a console override is used only when the repository has no file at that path; otherwise built-in is implicit. Each job records the effective layer per rule path in `job_contexts.rules_json` and on each rule file.
- Added a maintainer-only console page at `GET /repos/:id/rules` and revision-fenced save/clear routes. The three rule files are editable; `.agents/skills` is rejected in this slice. Every write uses CSRF and `expected_revision`, and every save, clear and refusal is audited.
- Added the repository-page entry point and documented the precedence in `docs/rules.md`; updated the architecture pointer and the changelog fragment.
- Tests cover console override with no repository file, repository file winning, cleared override falling back, stale revision refusal, the effective layer in `job_contexts.rules_json`, the maintainer form (save/stale/clear/audit) and the unchanged rules suites.

## Conflict resolution

- Merged `origin/main` at `4291325` into `feat/538-repo-rules`; no force-push.
- `src/app.ts`: kept both `parseVerification` (this branch) and main's `DEFAULT_TRIAGE_GOAL` / `parseIssueUrl`; both sets of routes remain.
- `src/db.ts`: kept both `job_contexts` / `job_context_files` (this branch) and main's postmortem tables and interfaces.
- `test/rateLimit.test.ts`: the merge has both this branch's `job-context` throttle and main's deployment throttles, so the tip has 19 `.take()` calls (18 on the normalized key, 1 reauth).
- Re-ran the full gates after resolution; all green.

## Ran

- `npm ci` — pass (Node 22.23.2)
- `npm run check` — pass (lint, typecheck, 1,482 tests, build)
- `node scripts/changelog.mjs check` — 22 fragments ok
- `node scripts/version.mjs check` — 0.3.4 ok
- `node scripts/risk-gate.mjs --base origin/main` — T3 (`bridge/flybot-bridge.mjs`)

## Not run

- A real FlyBot bridge/DSH job loading a skill or an override from the context endpoint.
- A real GitHub repository with `.fledge/` files plus a console override.
- Docker isolation tests.

## Risks

- Every FlyBot enqueue still performs up to three contents reads plus one skills-directory read; the per-job commit/override revision cache avoids repeats.
- Console overrides are read at enqueue/dispatch time, not frozen into the job context at enqueue; a change between those points can change what the runner receives. The repository file and its commit remain fixed.
- The rules text is capped at 16 KiB in the prompt; the rest remains available through the context endpoint.
- The PR-change guard adds one changed-file read for jobs that loaded a rule context. Jobs without a context do not pay it.
- This PR still does not close #538.

## Docs

- `docs/rules.md` — paths, precedence (`repository > console > builtin`), console overrides, limits, fixed-commit behavior, context endpoint and the acknowledgement rule.
- `docs/architecture.md` — short pointer to the override layer.

## Remaining on #538

- Console overrides for `.agents/skills` if that is still wanted.
- Enforcement polish beyond the current rule-change acknowledgement.
