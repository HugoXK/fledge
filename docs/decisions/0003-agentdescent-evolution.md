# 0003 — Evidence-first evolution with AgentDescent

Status: proposed
Date: 2026-11-06
Owners: platform owner, maintainer

## Context

Fledge already stores the raw material for a learning loop: job goals, branch,
PR, review score, structured evidence, grounded role attribution, team call
statistics, checkpoints, costs and audit events. What it does not have is a
versioned artifact, a held-out evaluation, or a promotion ledger. Every change
to the team playbook, the default goals, the review rubric or the per-repository
policy is still reviewed as ordinary code.

AgentDescent provides the missing layer: artifacts are state, a diff is a
candidate, evidence decides, and a signed ledger records the decision. It is a
research reference implementation, not a production scheduler. Fledge remains
the orchestrator and the only source of truth for jobs.

## Decision

Use AgentDescent as an **offline evolution and evaluation engine**. It never
runs inside the job execution path, never receives a user GitHub token, and
never changes the evaluator, the CI configuration or the merge gate.

The loop is:

```
job traces + GitHub webhooks + audit/events
        -> redacted dataset (train / holdout, split by time and repository)
        -> AgentDescent candidate (FileTree / SingleSlot / KeyedRules)
        -> verifier ensemble (CI + tests + reviewer + evidence completeness + cost)
        -> trust_evidence / promotion
        -> defer by default; promote only with human approval and a canary
        -> promotion ledger + rollback
```

### Evolvable artifacts, in risk order

| Artifact | Source | Default apply path |
|---|---|---|
| Per-repository goal and model assignment | `repos.goal`, `repo_bot_models` | maintainer approval |
| Playbook protocol and role text | `src/flybot/playbook.ts` | shadow, then owner-approved version |
| Default goals and task templates | `src/jobs/service.ts` | shadow, then human review |
| Review rubric and score thresholds | `DEFAULT_REVIEW_GOAL`, merge policy | owner only; never automatic |
| Stage gate logic and merge gate | `src/lib/stages.ts`, `tryMerge` | **frozen** |

The evaluator, authentication, gateway, merge gate and CI configuration are
**frozen paths**. A candidate that changes them is rejected before evaluation.

### Evidence contract

Every evaluation row records the dataset, metric, value, confidence interval
and sample count. A promotion is one of `promote`, `defer`, `reject` or
`rollback`, and carries the evidence hash, the approver and the reason. A
candidate without held-out evidence is deferred, not promoted.

Minimum gate for a promotion:

- at least 30 jobs per arm, or 20 paired comparisons;
- bootstrap 95% lower bound above zero on the chosen metric;
- no regression in merge rate, revert rate, review score or CI first-pass rate;
- cost per merged PR not worse than the current baseline by more than 10%;
- evidence completeness at 100%;
- explicit owner or maintainer approval;
- a canary window with an automatic rollback on regression.

Insufficient data is a valid answer: the decision is `defer`.

### Phases

1. **Shadow (now).** Export traces, build a holdout set, generate candidates and
   produce an evidence report. No write-back.
2. **Gated promotion.** Promote one low-risk artifact (playbook text or a
   per-repository goal) after human approval and a canary.
3. **Continuous learning.** Use the failure flywheel to turn failed jobs and
   review follow-ups into regression tasks; keep an artifact and evaluation
   archive.
4. **Governed autonomy.** Promotion ledger, signed manifests, calibrated deferral
   and rollback metrics. Auto-merge is still controlled by the existing Fledge
   gates, never by an evolution result.

## Storage

Fledge adds three tables, independent of AgentDescent's runtime:

- `artifact_versions` — artifact name, version, content hash, candidate text and
  status;
- `evaluations` — artifact, dataset, metric, value, confidence interval and
  sample count;
- `promotions` — decision, reason, evidence hash and approver.

`job_events` stores the durable timeline that makes a job replayable. The
`scripts/evolution-shadow.mjs` export is read-only and excludes tokens,
callback secrets and API keys. Run `npm run evolution:report` (or pass `--report`) to print the current
baseline (success/merge rate, evidence completeness, median duration) and a
time-ordered train/holdout split before any candidate is generated.

## Security and privacy

- Evolution runs on an explicit, redacted export or a read-only database
  snapshot; it never points at the live database or a user's GitHub token.
- Per-repository data is never mixed into another repository's evaluation set
  without explicit consent.
- The operator can opt out per repository; the default is off.
- A candidate can never modify its own evaluator, the CI configuration or the
  merge policy.

## Consequences

- Fledge gains a defensible improvement loop: every job becomes evidence, and
  every promotion is auditable and reversible.
- The platform can learn per repository without changing global code.
- The cost is operational: a separate offline worker, redaction, evaluation
  storage and a human promotion step. That cost is deliberate; automatic
  self-modification is out of scope.

## Non-goals

- Replacing Fledge's scheduler, bridge or merge gates with AgentDescent.
- Auto-merging a user repository from an evolution result.
- Training on user code without consent.
- Claiming a statistically significant improvement from one run.
