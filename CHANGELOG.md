# Changelog

All notable changes to Fledge are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project uses semver.

## [Unreleased]

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
