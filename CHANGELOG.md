# Changelog

All notable changes to Fledge are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project uses semver.

## [Unreleased]

## [0.3.0] — 2026-11-09

### Added

- The admin metrics page now shows attributed versus unattributed model cost, scope/verify/iterate/review job counts, and Lead-only versus grounded-attribution events. Historical ledger rows without a repository or job remain explicitly unattributed.
- The delivery list now has a "merge all clean PRs" action. It re-checks each open Fledge PR and merges the ones that pass the same PR state, checks, commit status, reviews and branch-protection gate, skipping blocked PRs and reporting the counts.
- Failed jobs now show a concrete failure category and a recovery action instead of only a raw error. Fledge classifies quota, GitHub authorization, stage evidence, stalled jobs, timeouts, FlyBot instance, review, branch/upstream, GitHub operation, model and unknown failures; the job page links to re-authorization, settings or the repository as appropriate and keeps the raw message under Technical detail. The admin metrics page adds a failure breakdown for the selected window, and the recent-job tables show the category next to the status.
- Fledge now enforces plan path constraints and verifies pull-request evidence instead of trusting the agent's narrative. A PR that changes a denied or non-allowed path is blocked at merge time and shown as `blocked` with the offending files; verification records the PR head SHA, checks, commit status, reviews and changed files, and the delivery list shows ready / blocked / not-verified with a one-click re-check. A new `POST /repos/:id/jobs/:jobId/recheck` re-runs the same verification on demand.
- Fledge now has an operations baseline: Prometheus `/metrics` with optional OTLP/HTTP traces, a per-token GitHub API budget with Retry-After handling, delivery-id webhook dedupe and replay, graceful shutdown draining, startup orphan cleanup, a CI restore drill, and an auto-merge reconciler that re-checks open Fledge pull requests when checks turn green and on a schedule. The new limits and endpoints are documented in `docs/observability.md`.
- Model providers can be discovered and edited. "Discover models" reads the provider's `/v1/models`, bulk-adds only models that pass a 1-token test, and provider edits re-test every existing model before saving. This removes the need to type model IDs blindly.
- Fledge now records a durable job timeline and exposes windowed delivery metrics. The dashboard shows the signed-in user's own jobs, success rate, PRs, merged PRs, cost, open work items and last job for the last 7 or 30 days; the admin metrics page adds success and PR merge rates, median job/merge/review durations, review scores, cost by repository and model, daily trend buckets, and actionable alerts for stalled jobs, stale PRs, invalid credentials and budgets near their limit. Alerts are localized, sorted by severity and link to the affected repository or job; normal users see only their own alerts on the dashboard, and `/admin/metrics` switches between 7 and 30 days. The repository delivery board links each state to a filtered work-item list. A new read-only `/api/read/metrics` contract serves the same scoped data to an external control room, and the repository page gains a delivery board grouped by work-item state. The database also gains artifact, evaluation and promotion ledgers plus a shadow-evolution ADR and a read-only exporter with a baseline/train-holdout report for held-out, human-approved self-improvement; AgentDescent never runs in the job path or touches user tokens.
- Stalled jobs, stale pull requests, invalid GitHub credentials and budgets near their limit now notify the repository owner in Fledge and through the optional notification webhook. The scheduler deduplicates each alert for `OPS_ALERT_COOLDOWN_MINUTES`, clears the marker when the alert resolves, and exposes `fledge_ops_alerts_open` on `/metrics`.
- Transient job failures (bridge, model, GitHub, timeout and stalled) now schedule a durable retry with bounded exponential backoff, while quota, credential, stage-evidence, review and path failures stay manual. The retry is stored in SQLite and released by the scheduler, carries its attempt count and original job id, and stops after two attempts. Platform concurrency is configurable with `PLATFORM_MAX_ACTIVE_JOBS`.
- Fledge now cross-checks the agent's claimed test evidence against the pull request's check runs. A green test claim with a failing test check is marked contradicted and blocks auto-merge; a claim with no matching test check is left unverified and shown in the job verification card. The verification snapshot records the test evidence state and the green/failing check names.

### Changed

- The console now has a named design-token layer in `public/app.css`: one colour set, a 4px spacing ramp, a six-step type scale, three radii, two motion durations and a 44px touch floor, all consumed through `var()` so no colour literal remains outside `:root`. The 10-13px meta text colour `--muted-2` moves from `#6f7a8a` to `#8b96a6` because the old value was 4.13:1 on the lightest panel and below WCAG AA; the new value clears 4.5:1 on every surface it is painted on and stays dimmer than `--muted`. `docs/ui.md` documents every token, the naming rules and the contrast reasoning.
- Every data region in the console can now say what is happening instead of going blank. One shared state component renders loading (with skeleton placeholders and `aria-busy`), empty, error (with the failure reason and a retry), success and disabled, and the job page, the team panel, the dashboard, the repository work board, the PR list, the API-token list, the audit log, the approval queue and the admin tables all use it. A disabled control now looks inert as a link as well as as a button, and all three live streams (team, Chief, inbox) report connecting, disconnected and recovered through a `aria-live` status line instead of stopping silently.
- The application shell now marks the current section in the main navigation with `aria-current="page"` for both keyboard and screen-reader users, instead of only an `.on` class. Anchor offsets follow the sticky header height (`--header-h`, re-declared at each breakpoint) so a jumped-to section is no longer hidden under the header when it wraps on a narrow screen, and the shell's buttons, navigation links, language switch and sign-out control keep a touch target of at least 44px.
- The owner HugoXK keeps repository merge authority. Fledge now requires a T2/T3 PASS written and posted by the reviewer bot `HugoXK-bot` (`hugo2001xk@gmail.com`), and grants that account a write collaborator invitation so it can post the PASS and merge when delegated. PR bodies may be written by `HugoXK` or the bot; the review policy is read from the base branch so a PR cannot relax its own gate.

### Fixed

- On a phone the recent-jobs table on the dashboard, the repository page and the team console no longer runs past the card that holds it. Below 641px each job row becomes a card, and every cell prints its column name (Job, Status, PR / Issue, Summary) because the header row is gone; the id, the status and the created time are readable without dragging the table sideways. From 641px up the table is unchanged, and it is the same markup at both widths.
- The workspace frame now takes its height from the same measured `--header-h` the sticky header publishes instead of subtracting a fixed 230px, so its bottom lands at the viewport bottom on tall screens instead of leaving a dead band (and no longer runs past the fold on phones). The header updater also re-measures when the rendered header changes height without a window resize, such as a web font swapping in or a longer nav label in the other locale.
- Pages no longer scroll sideways on phones and tablets: the hint tooltip now appears as a bar pinned to the viewport instead of a fixed 270px box hanging off its icon, and console list rows can shrink inside their card instead of forcing the page wider than the screen.
- Token login now follows one rule everywhere: the landing page shows the token form exactly when `POST /auth/token` accepts it, so a deployment that configures OAuth and deliberately keeps the fallback no longer hides a working login path. The OAuth code→token exchange endpoint is configurable with `GITHUB_OAUTH_TOKEN_URL`, which lets the callback be tested against a fake server.
- A failed approval mail is no longer silent: the applicant's status page says the mail did not reach the administrator, the pending list on /admin marks the user as "approval mail not delivered" with a resend button, and the failure is written to the audit log as `approval.mail_failed` with the error redacted. The operator can prove the mail path with `npm run mail:probe -- --to <address>`, which prints only the transport, the host and the elapsed time.
- Opening a page that needs a session while signed out now goes to GitHub sign-in and comes back to the page you asked for, instead of showing a "出错了" 401 error page that dead-ends; API clients and form submissions still get the 401 so a machine caller keeps its status code and a post keeps its body.
- Replaying a job callback no longer fails or repeats work: a second delivery of the same result answers `200 {"ok":true,"duplicate":true}` and runs no second auto-merge, review follow-up or work-item move. A report that contradicts the recorded result still gets `409`, a heartbeat for a job that no worker has started is rejected, and a late final callback past the hard timeout cannot rewrite a timed-out run.
- The restore drill now proves a backup against the copy it restored and that copy's manifest instead of comparing it with the live database, so a healthy copy is no longer reported and renamed as failed just because the instance wrote since the backup was taken. Each backup also writes a manifest next to it (size, sha256, schema version and per-table row counts), a copy without one still restores with a `manifest=missing` warning, and source drift is printed as information; a truncated, corrupt or manifest-mismatched copy still fails and is still renamed `restored.db.failed`.
- Anchor links no longer land under the sticky header. The header height is now measured from the rendered element on load and on resize, and the no-JS fallbacks rise to 90 / 215 / 276 px so a jump target keeps at least a line of body text below the header even without JavaScript.
- The repeated-failure auto-pause now fires even when the ops notice was already sent. A repository with three consecutive failures pauses auto-iterate before the notification dedupe, so an old failure key can no longer keep a broken repository retrying forever.
- After applying a model change, every bot is now updated to its assigned model or the new repository default. Previously an unassigned bot kept its old provider/model reference, so the team could stall after the provider ids changed.
- Credential preflight now checks repository contents in addition to the target branch. A token that can read branches but gets 403 on `/contents/` is marked invalid, auto-iterate is paused and the owner sees a re-authorize banner instead of a job that starts and stalls.
- The restore drill no longer reports `restore-drill: OK` for a backup copy that holds nothing. A copy whose manifest was removed and whose bytes were truncated to 0 used to pass the byte comparison against itself, exit 0 and leave a 0-byte `restored.db` at the path the runbook restores from; it now exits non-zero, names the checks it could not run and leaves the copy as `restored.db.failed`. A manifest-less copy that still carries its schema keeps passing, so backups written before manifests existed are unaffected.

### Security

- Auto-merge is now bound to the pull request the job actually produced. A callback's `prUrl` must be this repository's own pull request — same scheme and host as the recorded repository `html_url`, or as the web host derived from `GITHUB_API_BASE` when no `html_url` was recorded — and the pull request's head branch must be the job's branch against the job's base branch. A URL or PR that does not match is skipped without merging and recorded as `job.merge_skipped` with the specific mismatch, so holding a job callback secret can no longer merge an unrelated green pull request.
- `/lang/:locale?next=` no longer redirects to another host: a value such as `/..//evil.com` was an ordinary path before parsing and `//evil.com` afterwards, so the response carried a protocol-relative `Location`. Every `next=` and `returnTo` value is now checked after normalisation and falls back to the site instead.
- The job callback now stores a `prUrl` or `issueUrl` only when it names this job's own repository on the origin Fledge derives for that repository, and treats a present but unplaceable value as no link. The console, the work-item row and the completion mail can no longer render an off-site URL under a `PR` or `Issue` label.
- Added `scripts/rotate-github-token.mjs` to validate, back up and update the GitHub development PAT in `~/.dsh/bot/secrets.json` without printing it. The owner creates the replacement token in GitHub settings and must revoke the old token; Fledge never mints PATs.


## [0.2.4] — 2026-11-06

### Added

- A repository can assign a selected provider model to each bot role (Chief, Lead, Product, Test, Security, Reviewer, Dev-1, Dev-2). Empty roles follow the default model. Applying models restarts the workspace and Fledge assigns the model through DSH `update-bot`.
- Repository pages now show a delivery list of iterate jobs with open pull requests, including review score, cost, age and a maintainer one-click merge. Merging re-checks the PR state, checks, commit status, reviews and branch protection, updates the linked work item, and records the PR state; a webhook keeps it in sync. The page suggests enabling auto-merge when three PRs are waiting.
- The question inbox now updates over Server-Sent Events at `/api/inbox/events`. Fledge sends the server-rendered inbox when the question set changes, and the browser replaces the section and rebinds the answer forms without a reload.
- Collaborators can drive a work item from the issue thread with `/fledge status`, `/fledge plan`, `/fledge approve` and `/fledge fix`. Fledge checks the author association, dedupes commands by comment id, creates or reuses the work item, and replies with the current state; plan approval remains maintainer-only.
- Settings now uses a provider-to-models model: add an OpenAI-compatible provider (base URL, encrypted key, optional private/HTTP), then add multiple models under it. A repository selects which provider models it may use and the default. Adding a model performs a 1-token test from Fledge and refuses to save on failure.
- Fledge now raises an operational alert after three consecutive failed jobs in one repository: an `ops.repeated_failures` audit entry, one in-app notification and an optional `repo.repeated_failures` webhook. The alert is deduped until a successful job resets it.
- Repositories can now enforce a team stage gate. In `enforced` mode an implement job must report scope, acceptance criteria, a failing test, a passing test and Dev/Test attribution; a review job must report a Reviewer and a score. Missing evidence fails the job with `STAGE_EVIDENCE_MISSING` and blocks auto-merge. `shadow` mode records the same check without blocking.
- Product and Test now run as independent stage jobs. The Product scope job goes to the Product DSH session and returns scope, non-goals, acceptance criteria and a test plan; the Test verify job goes to the Test session and returns failing/passing test evidence. Stage mode queues verification after implementation before review; neither stage creates a branch or PR.

### Changed

- Hardened the merge gates. `main` now requires `ci-ok`, `review-gate` and `pr-lint`; `pr-lint` validates the PR body, changelog/docs obligations and risk labels; review conclusions must carry a matching `Posted-by` account; `/healthz` reads the version from `package.json`; and `scripts/version.mjs check` keeps the package, lockfile, changelog, compose image and release tag in step.
- GitHub issue labels now drive work-item intake: `priority:high|medium|low` (or `p0`–`p3`) sets the work-item priority and an `agent-ready` label moves a proposed item to triaged when the issue is opened, reopened, edited or labeled.
- Repository pages now show an explicit lifecycle banner for disabled repositories, stopped FlyBot instances and invalid credentials, and disable Run/Plan/Review until the state is fixed. A danger zone separates stop scheduling, stop FlyBot and delete; deleting requires typing the repository name and only removes the Fledge connection, instance, jobs and tokens.
- The delivery chain is now Fledge-driven: a successful iterate with a PR queues review when the reviewer is enabled, plan approval moves the work item to assigned, and a review outcome moves it to approved or changes_requested. The work-item table shows the current stage.
- Polished the repository lifecycle, provider cards, per-bot model grid, danger zone and delivery list, and updated the standalone user-view mock with the new provider, delivery and lifecycle screens.
- Every repository owner can now open the branded FlyBot workspace again; the Fledge team console and its live SSE stream remain superadmin-only. The workspace proxy still checks session, ownership and preview on every HTTP and WebSocket request.

### Fixed

- Job attribution is now grounded in the actual per-role call counts: the job page and PR automation comment use only roles that acted, and a claimed role with zero calls is recorded as a mismatch event instead of being presented as team participation.
- Answering a team question now marks the matching question notifications as read; unrelated job, quota and system notifications stay unread.
- Running jobs now fail after `JOB_STALL_MINUTES` (default 30) without a callback instead of blocking the repository for the full 90-minute timeout. A repository token that returns 401/403 marks the connection invalid, pauses auto-iterate and shows a re-authorize banner; three consecutive failures pause auto-iterate until the owner re-enables it.
- Model connections no longer save when the platform-side connection test fails. A failed test returns a concrete error and nothing is stored; HTTP/private targets still require the explicit opt-in and must also pass the test.
- Normal users can now be granted the private/HTTP model permission per account. A superadmin toggles "Allow private models" in Admin; the user's Settings form then shows the private-URL checkbox, and the provider is still saved only after Fledge's connection test succeeds.
- Existing `flybot:<repo>` instance tokens and `job:<id>` tokens are backfilled with their repository id at startup, so new model usage is attributed per repository instead of an unattributed bucket.

### Security

- Added `scripts/rotate-instance-tokens.mjs` to rotate Fledge-managed bridge and per-instance gateway tokens, with a dry-run mode, an active-job guard and rollback on a failed bridge restart. The leaked GitHub development PAT is not managed by this script and must be rotated in GitHub settings.


## [0.2.3] — 2026-11-04

### Added

- Admins can now search jobs and audit entries from a single page, filtered by the same user visibility as the admin panel, and export the current result as CSV. Exports are audited.
- Admins now have a read-only support view for the users they are allowed to see, including that user's repositories, recent jobs and audit entries. The same view opens a job without the control buttons, so support can inspect a run without changing it or triggering new work.
- Added per-job pause, resume and cancel controls. Paused jobs release the repository slot and can be resumed from their checkpoint; cancellation stops active team sessions, revokes the job token and closes the linked work item. Jobs now record priority, and queued jobs show their queue position.
- Operators can configure an optional outbound webhook. Fledge posts a Slack-compatible JSON payload when a job succeeds or fails and when a team asks the user a question; an optional bearer secret signs the request.
- Added plan-first approval. A repository can require a plan before code, maintainers approve or reject the plan with allowed and forbidden path constraints, and execution stays blocked until the plan is approved.
- A repository maintainer can now set an optional rolling 30-day repository budget and a per-job alert threshold. Once the repository budget is reached, new jobs are refused with `REPO_BUDGET_EXHAUSTED`; a job that costs more than its per-job budget produces an audit entry and a quota notification.
- Added repository work items with a triage-to-merge state machine. Work items link issues, pull requests and jobs; maintainers can triage, assign and approve, developers can start and update their own work, and GitHub App issue/PR/review webhooks keep states and PR outcomes in sync. Admin metrics now show open, merged and closed work items.

### Fixed

- GitHub App onboarding and refresh now use the signed-in user's collaborator permission to decide `maintainer` versus `developer`, instead of treating the App installation token as the user's permission. App jobs use the installation token by default; `GITHUB_APP_USER_TOKEN=true` opts in to the broader user OAuth token for attribution.
- Persisted review follow-ups before finalization, resolved a missing PR head SHA server-side, validate follow-up branches, cancel active jobs when a repository or instance stops, add single-flight scheduling with fair due ordering, add bridge health sweeps and `/readyz`, prune old jobs/audit/events/notifications with TTLs, apply GitHub rate-limit backoff, and ship the runtime ops scripts in the Docker image.
- Made job finalization idempotent, preserved the existing branch, PR and base branch when retrying a failed iterate job, returned the full job credential with the job's actual base branch, guarded database migrations against newer schema versions, and added a SQLite busy timeout plus hot-path indexes.
- Added preflight for Flybot iterate jobs: validate the target branch, record the base SHA on the job, warn when the fork is behind upstream, and skip scheduled work while an active work item is open.
- Repository role, reviewer and auto-merge settings can now be changed in one save: selecting maintainer enables the reviewer and auto-merge controls immediately instead of requiring a second page load.

### Security

- Closed an approval bypass where onboarding or rejected accounts could still submit settings, add repositories, start instances or change repository state through CSRF-protected routes. Production config now normalizes `NODE_ENV`, requires an explicit bootstrap admin login, no longer enables the example dev login by default, and the Docker Compose sample binds the app to loopback.
- Moved auto-merge to a server-side gate: Fledge verifies the pull request state, check runs, combined commit status and current review conclusions before performing a squash merge. The agent prompt now always forbids merging, and a stale GitHub permission check is revalidated and downgraded before auto-merge or a scheduled review.
- Added branch protection verification to auto-merge. Fledge reads the target branch protection rule, verifies required status checks and required approvals, supports squash/merge/rebase, and refuses to auto-merge when protection cannot be verified or a required gate is missing.


## [0.2.2] — 2026-11-03

### Added

- Added a repository target branch: maintainers can send PRs to `develop`, a release branch, or another valid upstream branch while Fledge still creates a new working branch. Jobs snapshot the target as their base branch, follow-ups keep the existing PR base, invalid branch names are rejected when saved, and job details show the base branch.
- Added a simplified "talk to the Chief" surface on the repository page. Normal repository owners can send guidance without opening the admin-only team console or choosing an internal role, and the page now shows the Chief's replies, pushed over SSE (with a polling fallback) after reading the DSH session export. Fledge drops internal job prompts, keeps only human/Chief text, masks tokens and audits the message; the composer supports quick prompts, Enter-to-send and optimistic messages, and the question inbox remains the place to answer FlyBot's decisions.
- Added self-selected repository roles. When hosting a repository, Fledge reads the user's GitHub permission and lets the user explicitly choose `maintainer` or `developer`: `admin`/`maintain` may choose either, and every other permission can only choose `developer`. Maintainer enables review/triage maintenance actions and an opt-in auto-merge switch that is off by default; developer runs iterate and plan jobs only. Roles are per repository, never assigned by a platform admin, and a lost GitHub permission downgrades a maintainer to developer on refresh.
- Added a three-level platform role model: normal user, administrator, and owner. The configured primary login becomes the super admin, admins see themselves plus normal users in a scoped management page, only the super admin can promote admins or set unlimited quota, and the super admin keeps the live team console and workspace. The super admin also gets a preview switch that renders the user UI without changing the underlying session permissions.

### Changed

- Tightened the admin user table controls: quota input, unlimited switch and Set quota now stay on one row, role select and Set role stay on one row, and approve/disable actions are grouped below. Wider controls scroll inside the table instead of stretching the page.
- Simplified the default repository experience: the live team console and FlyBot workspace are now admin-only, while normal repository owners keep the repository status, target branch, run/plan controls and the answerable question inbox. Normal users no longer see team roles, session IDs, the full SSE console or the workspace shortcut, and question/job email links and the PR automation block now point to the repository inbox or task/job page instead of the admin-only team console.
- Reworked the question inbox: choices are now large selectable cards, custom answers sit next to the send button, and answers are submitted without a page reload with inline progress and error feedback.

### Fixed

- Improved GitHub App repository attribution: when the user has re-authorized with repo scope, Fledge uses that user token for App-repository writes so issues, PRs and commits are created as the user instead of Fledge-Platform. Repositories without that authorization show a re-authorize notice.
- Fixed GitHub App installation callbacks without installation_id: the installed route now reuses a single bound installation, or finds one unbound installation owned by the signed-in user, and the App callback URL is accepted as an alias. Missing callbacks show an actionable Setup URL message instead of a dead end.
- Fixed the Footer Docs and Status links by preserving their trailing slash, which previously redirected to the server's internal port and failed publicly.
- Kept recent-job summaries inside the layout: the workspace list now truncates visible summary text with an ellipsis, the job table clamps summaries to two lines, and long values stay inside the scroll container instead of stretching to the right.
- Fixed the review loop: the reviewer now posts REQUEST_CHANGES for Fledge PRs that need work, and a follow-up on the same branch is queued after the active review finishes instead of being dropped. Review jobs no longer leave actionable PRs with comments only.
- Strengthened the team playbook so iterate jobs cannot be implemented by the Lead alone: Product scopes, Test owns failing tests and verification, Dev-1/Dev-2 implement, and Reviewer reviews. If a job still reports only Lead activity, Fledge now sends an in-app warning instead of silently accepting it.
- Clarified upstream freshness: iterate jobs now check the latest upstream branch and open issues/PRs before working, skip duplicate work when a fix or PR already exists, and sync a stale fork before creating a working branch.

### Security

- Hardened redirects, form parsing, bearer parsing, rate limits, inbound sender parsing and the FlyBot bridge proxy against the CodeQL findings: validated local redirect paths, constrained form keys, added gateway and callback rate limits, removed regex backtracking, limited bridge proxy URLs to the configured origin and stopped returning stack traces.
- Updated the static-file dependency chain to glob 14.0.3 and minimatch 11.0.4, resolving two medium-severity Dependabot alerts: the glob AbortSignal cancellation bypass and the minimatch globparts amplification denial of service.


## [0.2.1] — 2026-11-02

### Added

- Added inbound email replies: with INBOUND_EMAIL_SECRET set, the daily digest adds a Reply-To token address; a verified reply is cleaned, checked against the user's notification email, and sent to the Lead as guidance. Includes a Cloudflare Email Worker sample.
- Added optional GitHub App onboarding: install the App, bind the installation to the signed-in user, pick repositories and use short-lived installation tokens instead of a PAT. The PAT flow remains available. Added a signed GitHub webhook endpoint and event ingestion as the base for the CI/review follow-up loop.
- Added per-job cost and token accounting, structured job evidence (tests, CI, files, risk, rollback), a job detail page with a one-click retry for failed jobs, and an admin product-metrics funnel. The bridge now uses the job-scoped model token while a job runs so usage is attributed to that job.
- Added per-user email notifications from fledge@hugoxk.online: users can set their own notification address, toggle job/question mail and a daily digest, and send a test email. Job mail covers success/failure and waiting questions; the daily digest summarizes the last 24 hours (jobs, PRs, spend, next runs, open questions) and is sent once per day in the configured timezone. Approval and quota mail are unaffected.
- Added plan-only jobs (inspect and propose a plan without code, branch or PR), an execute-plan action, four goal templates, and checkpoint-based resume: heartbeats store the latest checkpoint and a failed job's retry appends it to the goal.
- Added automatic PR follow-up: a failed check run/suite or a review requesting changes on a Fledge PR enqueues a job on the same branch and PR, with delivery and head-SHA deduplication. Follow-up jobs never open a second PR or issue and are skipped while the repository has an active job.
- Added a live team control surface: the team console now receives Server-Sent Events for role activity, open questions, job progress and quota, answers questions inline without a refresh, and can request a stop. A hard stop is used where DSH exposes one; otherwise the stop is delivered as a message and reported as a request. Guidance, answers and stop actions are audited.
- Added live team observation and effectiveness metrics: the team console shows each role's current tool/step, elapsed time, last activity, a stale-job warning and a recent activity timeline; finished jobs store per-role call statistics, shown on the job page and aggregated in the admin metrics page.
- Added a Fledge-branded agent workspace at /repos/:id/workspace/: an authenticated same-origin proxy to the per-repository FlyBot UI with server-side DSH cookie injection, WebSocket support, HTML rebranding and a 'powered by FlyBot' badge. The raw DSH token is never exposed to the browser and the workspace needs no wildcard DNS.

### Changed

- Moved the task template, goal, auto-iterate interval and reviewer settings into the GitHub App repository picker so both onboarding paths configure repositories the same way, and replaced long inline help with compact hover/focus info icons.
- Paginated the dashboard repositories and jobs, and repository/team job lists at ten per page, and reworked Add repository into a clear two-option flow: GitHub App (recommended) or a collapsed manual fine-grained token form.

### Fixed

- Fixed the workspace and dashboard frontend: job tables now keep PR and Issue links visible instead of cutting off the rightmost column, the workspace shows the latest ten jobs with repository labels and full links, and FlyBot questions that need a human are surfaced as an answerable Fledge inbox on the workspace, dashboard and repository pages. Also replaced CSP-blocked inline confirm/refresh handlers with scripted actions, made the workspace stop button post to a real Fledge route, wrapped every table in a scroll container so info tips and wide tables no longer clip, stabilized live question forms so polling does not erase typed answers, kept the queue total intact during status polling, added API-token copy, a skip link and disabled-control styling, localized redirect messages and team labels, and stripped upstream HTML meta CSP from the proxied workspace.
- Closed a GitHub App installation binding hole: the install state is now only a CSRF check, ownership is verified through the webhook sender, the user's OAuth installations or an individual-account match, and an installation cannot be rebound to another Fledge user.
- Hardened the job lifecycle: final callbacks now keep an earlier branch, PR/Issue links, review score and progress summary when they omit those fields, running callbacks record `started_at` so timed-out jobs are still cleaned up, manual runs respect the platform-wide two-job cap, follow-up dedupe markers are cleared when enqueue fails, daily digests and question mail no longer stop while two jobs are active, scheduler work skips disabled users, approval-mail failures retry from the status page without logging approval tokens, and deleting a repository or rejecting a user revokes active job tokens and frees the running slot.
- Fixed AUTH errors after a job by clearing the job-scoped model token at job finish and falling back to the instance token if the gateway rejects a job token.
- Masked notification emails in Settings instead of rendering the full address, kept a blank field from clearing the custom address, and added an explicit Clear action to fall back to the GitHub email.
- Fixed the workspace proxy returning HTTP 403 / reconnecting forever by rewriting the browser Origin and Referer headers to the per-repo loopback DSH origin; the DSH API and WebSocket now accept workspace requests.


## [0.2.0] — 2026-10-31

### Added

- Added the access application flow: GitHub login, a signed disclaimer and information-security agreement, a live queue/status page that prevents duplicate submissions, and admin review details (signature, timestamps, IP).
- Added the autonomous development workflow: computed risk tiers, a review gate, the `ci-ok` aggregate check, changelog fragments, release automation and the maintenance/release workflow docs.
- Added fork-aware repository onboarding and a reviewer role: Fledge detects or creates the user's fork, pushes iteration branches there while opening issues and PRs on the upstream, and lets upstream maintainers run scheduled FlyBot reviews of every open PR with a score and COMMENT review.
- Launched the hosted service at <https://fledge.hugoxk.online/> with the GitHub token login fallback, and the documentation site at <https://fledge-docs.hugoxk.online/docs/> with a mirror at <https://hugoxk.online/fledge/docs/>.
- Added per-repository FlyBot containers with isolated data, bridge and model proxy, a configurable fixed release image, and an automatically provisioned Chief plus Lead, Product, Test, Security, Reviewer and two-Dev team.
- Added an administrator "Unlimited" quota option: marked users are never blocked by the platform quota and see Unlimited in the interface, while their usage is still recorded in the ledger. A blocked platform request now marks the user's active job `quota_exhausted` immediately instead of leaving it running until the timeout.
- Made the team automation visible on GitHub: each issue, PR and comment carries a compact `<sub>Fledge · team · role · step</sub>` footer, the job callback records the roles that actually claimed, implemented, tested and reviewed the change, and Fledge adds a collapsible automation block to each successful PR with only the steps that happened. The job list shows the same compact attribution.
- Added an authenticated per-repository team console that shows live role activity and open questions from the isolated FlyBot instance and lets the owner send new guidance to the Chief, Lead or any team role without exposing the native FlyBot UI publicly.
- Added a versioned team playbook: every repository team gets explicit hierarchy, ownership and handoff rules plus role-specific guidance generated from the repository goal, and saving a new goal refreshes it. Iterate jobs go to the Chief and then to the Lead, existing instances are refreshed before their next job, running jobs post progress heartbeats, and the default job timeout is 90 minutes. The team console now marks the Reviewer as disabled until review is enabled.
- Added a GitHub token login fallback for deployments without an OAuth App; the token is used only to confirm GitHub identity and is never stored.

### Changed

- The interface now supports Chinese and English with the same language preference as the rest of hugoxk.online, adopts the platform's blue interaction palette, adds a landing-page iteration card and a focused workspace overview, and removes the skip link and service directory.
- Expanded automatic iteration and review cadence options from every 15 minutes to every 30 days, and clarified that the interval is the minimum gap between runs rather than a cap on the number of PRs or issues a repository can produce.

### Fixed

- Fixed platform quota metering for streaming model responses: the gateway now reads the final usage object even when it contains nested token-detail fields, so streamed calls are recorded in the ledger and the displayed remaining quota decreases as expected.


## [0.1.0] — 2026-10-29

### Added

- GitHub OAuth login with a pending-application approval gate.
- Administrator approval email to the configured operator address, with
  single-use approve/reject links valid for 7 days.
- Multi-repository onboarding with per-repo fine-grained GitHub tokens.
- AES-256-GCM encryption for GitHub tokens and user model keys.
- Job queue with a mock runner and a FlyBot bridge contract (credential URL +
  signed callback).
- OpenAI-compatible model gateway with per-user 1 CNY quota, cost metering from
  `x-litellm-response-cost` or token usage, and a structured
  `FLEDGE_QUOTA_EXHAUSTED` 402.
- Own-model fallback with a 1-token connection test and SSRF guard.
- Admin panel (approve/reject, quota), audit log, in-app notifications.
- Dockerfile, docker-compose, CI, unit/integration tests and documentation.
