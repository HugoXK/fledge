# 0002 — Shared repository members

Status: **proposed** (design only; no implementation yet)
Date: 2026-11-05

## Context

Today a `repos` row has exactly one `user_id`. Another person who wants to work
on the same upstream connects it again in Fledge and gets their own instance,
jobs, PRs, budget and audit trail. That is safe but it does not match the
product promise of one governed repository team.

`repo_role` (maintainer/developer) is per repository connection, not per person,
and the new `repo_id` cost attribution makes it possible to reason about a shared
repository's spend.

## Options

1. **Keep one connection per person (status quo).** No data-model change, but two
   people cannot share one work-item list, review queue or budget.
2. **Add `repo_members` with per-member roles.** A connection owner invites
   GitHub users as `maintainer`, `developer` or `viewer`. All members see the same
   repositories, work items, jobs and audit trail. The connection owner remains
   the credential and billing anchor.
3. **Per-member credentials and budgets.** Every member supplies their own
   GitHub token, FlyBot instance and quota; the shared repository is a grouping
   layer only. Highest flexibility, highest complexity and cost.

## Recommendation

Option 2, with the connection owner's credential as the default. It preserves the
current security model (one encrypted GitHub token per connection) while making
work items, reviews and budgets shared. A member's role is per repository and is
checked by the same GitHub-permission refresh used for `repo_role`.

## Open questions

- Does a job run with the connection owner's GitHub token even when a developer
  triggers it? Default: yes, because the token is the connection's credential,
  and the audit records who triggered the job.
- How is the budget split when multiple people trigger jobs? Default: one
  repository budget, shared by all members.
- Can the last maintainer leave? No; the owner must transfer the connection or
  promote another maintainer first.
- Should a viewer be able to read audit entries and cost without running jobs?
  Default: yes, read-only.

## Non-goals for the first slice

- No per-member FlyBot instances.
- No cross-repository teams or organizations.
- No change to the existing `repos.user_id` owner until the member table and
  transfer path are covered by tests.
