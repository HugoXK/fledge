# Changelog

All notable changes to Fledge are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project uses semver.

## [Unreleased]

## [0.2.0] — 2026-10-31

### Added

- Added the access application flow: GitHub login, a signed disclaimer and information-security agreement, a live queue/status page that prevents duplicate submissions, and admin review details (signature, timestamps, IP).
- Added the autonomous development workflow: computed risk tiers, a review gate, the `ci-ok` aggregate check, changelog fragments, release automation and the maintenance/release workflow docs.
- Added fork-aware repository onboarding and a reviewer role: Fledge detects or creates the user's fork, pushes iteration branches there while opening issues and PRs on the upstream, and lets upstream maintainers run scheduled FlyBot reviews of every open PR with a score and COMMENT review.
- Launched the hosted service at <https://fledge.hugoxk.online/> with the GitHub token login fallback, and the documentation site at <https://fledge-docs.hugoxk.online/docs/> with a mirror at <https://hugoxk.online/fledge/docs/>.
- Added per-repository FlyBot containers with isolated data, bridge and model proxy, a configurable fixed release image, and an automatically provisioned Chief plus Lead, Product, Test, Security, Reviewer and two-Dev team.
- Added an administrator "Unlimited" quota option: marked users are never blocked by the platform quota and see Unlimited in the interface, while their usage is still recorded in the ledger. A blocked platform request now marks the user's active job `quota_exhausted` immediately instead of leaving it running until the timeout.
- Made the team automation visible on GitHub: issues, pull requests and comments now carry a role signature, the job callback records who wrote, claimed, implemented, tested and reviewed the change, and Fledge posts a summary comment on each successful PR with the job, team and attribution. The job list also shows the recorded attribution.
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
