# Roadmap

## v0.1 — the first vertical slice (this repo)

- [x] GitHub OAuth login, pending application, admin email with approve/reject
- [x] Multi-repository onboarding with fine-grained tokens
- [x] AES-256-GCM token encryption, CSRF, sessions, audit log
- [x] Per-user 1 CNY quota + OpenAI-compatible gateway
- [x] Own-model fallback and 1-token connection test
- [x] Mock runner + FlyBot bridge contract
- [x] Admin panel, job list, notifications
- [x] Docker, CI, tests, docs

## v0.2 — a tighter loop

- [ ] **GitHub App** installation flow (no personal token for the common case),
      with per-repo permissions and short-lived installation tokens.
- [ ] Webhook on PR review/CI: if the PR is red or a reviewer asks for a change,
      enqueue a follow-up job on the same branch.
- [ ] Job cancellation and a visible queue position.
- [ ] Per-repo "only touch these paths" and "never touch these paths" guards.
- [ ] A "dry run" that opens a draft PR with the plan and no code change.

## v0.3 — multi-user operations

- [ ] Per-repo budgets (CNY), separate from the user budget.
- [ ] Team roles: owner / reviewer / viewer per repository.
- [ ] Model routing: let the operator define multiple platform models and map
      users/repos to them.
- [ ] Usage export (CSV) and a monthly summary email.
- [ ] Audit export and retention policy.

## v1.0 — production hardening

- [ ] Postgres option for multi-instance deployments.
- [ ] Worker pool for jobs, with per-worker FlyBot sessions.
- [ ] Structured tracing (OpenTelemetry) and metrics.
- [ ] Backup/restore runbook tested end-to-end.
- [ ] Security review of the bridge and gateway with an external reviewer.

## Non-goals

- Running arbitrary user code inside Fledge.
- Auto-merging PRs.
- A general-purpose CI system.
- Being a GitHub replacement: Fledge is a thin, reviewable layer on top of it.

## Open questions

1. Should a user be able to connect a repository they can only read, for
   analysis-only jobs? (Probably yes, as a separate "observe" mode.)
2. Should the platform quota be per user or per repository for teams?
3. How much of the FlyBot conversation should be surfaced in the PR body?
   Current plan: a compact summary plus the model/cost and a link to the job.
