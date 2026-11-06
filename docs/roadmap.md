# Roadmap

Fledge is a **governed hosted repository team**, not another coding agent. The
differentiators are per-repository isolation, an explicit Chief/Lead playbook,
human control at every step, and a reviewable audit/cost trail. The roadmap
follows the patterns that have settled in frontier async-agent products
(GitHub Copilot coding agent, OpenAI Codex, Google Jules, Cursor Background
Agents, Devin, Claude Code subagents) and in agent observability / durable
execution (LangSmith/Langfuse, OpenTelemetry, Temporal/DBOS):

1. asynchronous work with a live control surface;
2. plan and permission gates before risky actions;
3. resumable runs with checkpoints;
4. evidence-first review (diff, tests, CI, risk, cost);
5. isolation, secret brokering, budgets and audit.

## v0.1 — the first vertical slice

- [x] GitHub OAuth login, pending application, admin email with approve/reject
- [x] Multi-repository onboarding with fine-grained tokens
- [x] AES-256-GCM token encryption, CSRF, sessions, audit log
- [x] Per-user platform quota + OpenAI-compatible gateway
- [x] Own-model fallback and 1-token connection test
- [x] Mock runner + FlyBot bridge contract
- [x] Admin panel, job list, notifications
- [x] Docker, CI, tests, docs

## v0.2 — team and governance (shipped)

- [x] Per-repository FlyBot container, bridge and model proxy
- [x] Chief -> Lead -> Product/Test/Security/Reviewer/Dev playbook, refreshed
      from the repository goal
- [x] Team console with role activity and guidance
- [x] Fork/upstream onboarding and an optional Reviewer role
- [x] Quota ledger, unlimited quota, streamed-usage metering
- [x] GitHub role attribution and a compact automation block on PRs
- [x] 90-minute job limit, progress heartbeats and quota-exhausted job cleanup

## v0.2.1 — live control surface (shipped)

- [x] Server-Sent Events from Fledge to the team console: roles, questions,
      jobs, progress, quota; reconnect and polling fallback.
- [x] Open questions render inline and can be answered without a refresh.
- [x] Stop request / pause: hard stop where DSH exposes it, otherwise a stop
      message that takes effect at the next safe point.
- [x] Guidance and stop actions are audited and visible to the job.
- [x] Job detail shows the current step, last heartbeat, cost and attribution.

## v0.2.2 — repository roles (shipped)

- [x] Self-selected `maintainer` / `developer` role from GitHub permission.
- [x] Maintainer-only review and an opt-in auto-merge switch (off by default).
- [x] Refresh downgrades a maintainer when the GitHub permission is lost.

## v0.2.3 — governance and operations (shipped)

- [x] Repository work items with a triage-to-merge state machine.
- [x] Plan-first approval with allowed and forbidden path constraints.
- [x] Upstream preflight, duplicate-work guard and the job base SHA.
- [x] Job pause, resume and cancel controls with queue priority.
- [x] Branch-protection verification before auto-merge.
- [x] Read-only admin support view and audit/job search with CSV export.
- [x] Repository and per-job budgets.
- [x] Optional outbound notification webhook.

## v0.2.4 — model providers, delivery and stage sessions (shipped)

- [x] Team stage evidence gate (`off` / `shadow` / `enforced`).
- [x] Issue labels map priority and `agent-ready` triage.
- [x] Repeated-failure ops alert with dedupe.
- [x] Answering a question marks the matching notification read.
- [x] Issue comment commands (`/fledge plan`, `/fledge fix`, `/fledge status`, `/fledge approve`).
- [x] Realtime inbox SSE at `/api/inbox/events`.
- [x] Provider → models, per-bot model assignment and a mandatory platform connection test.
- [x] Per-user private/HTTP model permission and repository lifecycle/delete.
- [x] PR delivery list and maintainer merge; issue commands and live inbox.
- [x] Fledge-driven delivery chain and independent Product/Test stage sessions.
- [x] Grounded team attribution, token backfill and managed instance-token rotation.
- [ ] Shared repository members (see [decisions/0002](decisions/0002-shared-repo-members.md)).

## v0.3 — branded agent workspace (path workspace shipped)

- [ ] Per-repository authenticated workspace on a subdomain, e.g.
      `<repo>.<user>.agent.fledge.hugoxk.online`.
- [x] Fledge shell around the native FlyBot UI: repo, job, status, cost,
      pause/steer/approve, "Powered by FlyBot" footer; FlyBot/DeepSeek branding
      hidden.
- [x] Short-lived signed ticket, server-side DSH cookie injection, no raw DSH
      token in the browser URL; ownership check, CSP, cookie isolation,
      WebSocket proxy and audit of human actions.
- [ ] Interactive takeover: edit, pause and resume the same session; the job
      records human interventions.
- [x] Optional path proxy fallback for deployments without wildcard DNS.

## v0.4 — durable execution and gates

- [x] Plan-first mode: the agent posts a plan; a human approves before code is
      written.
- [x] Durable job state and checkpoints: resume after timeout, restart or bridge
      failure; idempotent callbacks.
- [x] Tool/path approval and per-repo "only touch / never touch" guards.
- [x] Per-repo budgets, live token/cost display and a monthly summary.
- [ ] Automatic attribution from events, not only the agent's self-report;
      signed audit and session replay.
- [x] GitHub App installation and webhook feedback (red CI / review findings ->
      follow-up job on the same branch).

## v0.5 — evidence and learning (started)

- [x] Durable `job_events` timeline, including per-role team activity.
- [x] Windowed personal and admin delivery metrics, cost by repository/model and alerts.
- [x] Read-only `/api/read/metrics` contract for an external control room.
- [x] Artifact/evaluation/promotion ledger tables and the AgentDescent shadow-evolution ADR.
- [ ] Shadow evaluation of the playbook on a held-out job set.
- [ ] First human-approved, canary-tested playbook promotion.
- [ ] Per-repository policy evolution (goal/model/stage mode) with opt-in.

## v1.0 — production hardening

- [ ] Postgres option for multi-instance deployments.
- [ ] Worker pool for jobs, with per-worker FlyBot sessions.
- [ ] OpenTelemetry traces/metrics and alerting.
- [ ] Backup/restore runbook tested end-to-end.
- [ ] External security review of the bridge, gateway and workspace proxy.
- [ ] Audit export and retention policy; per-repo team roles.

## Non-goals

- Running arbitrary user code inside Fledge.
- Auto-merging without an explicit maintainer opt-in and green required checks.
- A general-purpose CI system.
- Being a GitHub replacement: Fledge is a thin, reviewable layer on top of it.
- Turning the team console into a generic chat product; it exists to govern the
  repository team.

## Open questions

1. Should a user be able to connect a repository they can only read, for
   analysis-only jobs? (Probably yes, as a separate "observe" mode.)
2. Should the platform quota be per user or per repository for teams?
3. How much of the agent conversation should be surfaced in the PR body?
   Current answer: a compact automation block plus a link, never a full log.
4. Which workspace exposure is the long-term default: per-repo subdomain (this
   plan) or a single agent origin with path routing?
