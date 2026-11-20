# 0026 — A human merge press is authorized by the actor's role, never by the connection's role

Status: **accepted** (2026-11-20)
Date: 2026-11-20
Settles: `#1132`. Names the follow-ups this decision does not convert.
Depends on: [0007](0007-shared-repositories.md) (shared repositories and member
roles), the #1040/#1081 fix (the page reads the actor's role for the decision
card), `docs/architecture.md` "Repository role".

## Decision

The two human merge entries — `POST /repos/:id/jobs/:jobId/merge` and
`POST /repos/:id/delivery/merge-clean` — decide "may this person merge" from the
role `ownedRepo` resolved for the person pressing: `maintainer` for the
connection owner, otherwise the member row's role. `repo.repo_role` is no longer
read on either press.

The actor role is threaded through the merge path, so the refusal and the audit
row come from the person pressing: `tryMerge(job, prUrl, manual, rethrow,
actorRole)`, `manualMerge(repo, job, { rethrowTransport?, actorRole? })`, and
`mergeCleanPrs(repoId, actorRole)`. The automatic path passes no actor and keeps
reading the column; `manual: false` is unchanged.

## Why the column cannot stand in for the actor

`repo_role` records a **choice** the connection owner made, constrained at
connect time by their GitHub permission (only `admin`/`maintain` may choose
`maintainer`). It is not the permission and not the actor's role: `developer`
means "this connection chose the lower role", and such a connection can still
hold upstream write and merge. Reading it on a press was wrong in both
directions: an invited developer member could merge one or ten pull requests on
a `maintainer` connection, and the owner of a `developer` or never-chosen (NULL)
connection was refused a merge their upstream accepts.

## What this means for the follow-ups

The same wrong source is still read at the sites `#1132` names as follow-ups (the
review job kind, the gate-session confirm/create flags, priority and relations,
the rule-change and plan-decision surfaces, work items, scope/verify, security
findings, the chat `approve` command). Each needs its own card; none of them can
move a pull request upstream without the merge gate this decision fixes, so they
are ordinary authorization cleanups, not a second merge hole.

The capability-checked management command (`task.merge`) deliberately passes no
`actorRole` and keeps the column: `job.merge` is `maintainer`-only in the
capability table, and that path has an actor identity, not a web press. Where
there is no actor at all — the scheduler — the column stays the only source.

## Rejected

- **Actor AND connection for both entries.** Security asked for both, but the
  AND keeps the owner of a `developer` connection refused a merge the upstream
  accepts — the under-grant this card fixes. The AND survives only where there
  is no actor (the scheduler).
- **Widening the route check to `!== 'developer'`.** That turns the
  NULL-connection case green while re-opening exactly the refusal this card
  closes; the role must come from `ownedRepo`, not from a looser string test.
- **A new positional parameter on `manualMerge`.** Its third parameter is
  already an options object that `src/management/catalog.ts` calls with
  `{ rethrowTransport: true }`; a new positional would *be* that object and break
  the caller. The actor role rides inside the same object.
