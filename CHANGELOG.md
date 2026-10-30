# Changelog

All notable changes to Fledge are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project uses semver.

## [Unreleased]

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
