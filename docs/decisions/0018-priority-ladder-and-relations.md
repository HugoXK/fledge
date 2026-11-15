# 0018 — the queue orders by a stored ladder, and a relation is a row somebody wrote

Status: **accepted** (2026-11-15)
Date: 2026-11-15
Supersedes: nothing; it names the meaning of the `priority` integer and adds one
table

## Context

The claimer has always ordered the instance queue by `priority DESC, queue_seq
ASC`. What a `priority` value *meant* was never written down: the console printed
it as a bare number (`优先级 10`), three scales coexisted (job priority on a
0–30 range, work-item priority on 0–100, and the upstream label mapping that
produced the 30/20/10/0 values), and "this is P0" was a sentence a person could
type with nothing behind it. Two consequences followed:

1. A level could not be shown without inventing a vocabulary at the view layer,
   and a filter could not be built at all, because a half-open range over an
   unnamed scale is a guess.
2. A claim that work is urgent had no evidence standard, so the queue could be
   reordered by an adjective.

The second problem is that a task about a problem that has already been seen is
indistinguishable from a new one. Fledge had no way to say "these two are the
same problem" — only a person's memory across runs, and a title similarity that
is not a decision.

Three things forced schema decisions rather than code ones:

- The stored integer has to stay the ordering key. A live queue is a real
  ordering; a migration that rewrote it, or a level recomputed at read time,
  would re-order work that is already waiting.
- A relation has to survive the job row and be readable back with who claimed it
  and on what evidence, or it is a tooltip rather than a record.
- A relation must not be derivable. If a similarity score can create one, a wrong
  score silently suppresses work.

## Decision

**The ladder is a closed set over the integer that is already stored.**
`src/lib/priority.ts` is the only list: `P0` → 30 (ongoing damage, credential
exposure or an outage), `P1` → 20 (the core goal is blocked), `P2` → 10
(ordinary work, the default), `P3` → 0 (non-core polish). `levelFromRank` reads
any integer into the nearest level, and `PRIORITY_BOUNDS` is the matching
half-open range per level, so the console's label and the SQL filter cannot
disagree.

**A claim of `P0`/`P1` carries evidence; nothing else does.** `validatePriorityClaim`
refuses a save with a reason shorter than 12 characters or with no checkable
evidence: an `http(s)` link, a 7–40 character hex sha, or a number with a unit
(`ms`, `s`, `%`, `x`, `requests`, `errors`, `failures`, `tokens`, `users`,
`jobs`, `CNY`, `USD`). An adjective is a restatement of the claim, not evidence.
Saving the level a row already holds is a no-op and needs nothing, `P2`/`P3` need
nothing, and a platform policy default (an enqueue inheriting a work item's
priority) is not a claim.

**A real change is a new arrival; a no-op is not.** `Store.updateJob` watches the
`priority` key: when the value actually changes it also sets `queue_seq` to
`MAX(queue_seq) + 1`, so the row moves to the tail of its new level rather than
jumping ahead of jobs that are already waiting there. A save of the same level
touches neither value. The claimer reads `queued` rows only, so a `P0` never
preempts a running job; the level is a place in the queue, not a signal to the
runner.

**A relation is its own table.** `task_relations` holds one row per
`(source_job_id, target_job_id, kind)` — `UNIQUE`, so a repeated save is the row
that already exists (`created: false`) instead of a second one. The kinds are
`same_problem`, `related` and `recurrence`. Both ends must be jobs of the same
repository and neither may be the source itself; the store refuses a cross-
project target, a self-relation, a blank kind and a target that does not exist
(`relation_target_missing`) before it writes. Both foreign keys are
`ON DELETE CASCADE` and the database opens with `PRAGMA foreign_keys = ON`, so a
deleted job cannot leave a relation pointing at a missing row. `repo_id` is on
the row so a read is scoped by project without a join.

A relation is a claim too, so it reads the same `hasCheckableEvidence` predicate
as the ladder, with a lower reason minimum (8 characters) because a relation does
not reorder work: the cost of a weak relation is a misleading note, the cost of a
weak `P0` is a displaced queue.

**The follow-up is one bounded decision, and the default is the safe one.**
`src/lib/taskDecision.ts` is the closed set `new` / `supplement` / `related` /
`recurrence`. `new` aimed at an existing task is contradictory — "a separate
task" and "this task" at once — and is repaired once into `related`, because the
answer that names a task is the more specific one. When the decision step is
unavailable the framework default is `new` at `P2`: a follow-up becomes one
ordinary task rather than an open-ended chain. A `related`/`recurrence`/`new`
decision whose target is still running leaves exactly one coordination notice,
which that job takes at its next heartbeat that carries a checkpoint and only
once; a heartbeat without a checkpoint is progress and takes nothing.

## Alternatives considered

- **Recompute the level at read time from labels, issue priority or the goal
  text.** No column, no vocabulary to agree on — but the console, the CSV export
  and the filter would each carry their own mapping, the queue would re-order
  whenever the upstream labels changed, and a stored ticket could not be
  explained after the fact. The integer that already orders the queue is the
  honest storage for the level.
- **A new real/integer column next to `priority`.** Two orderings that can
  disagree, plus a migration that has to decide what every live row means. The
  ladder translates the existing column instead.
- **Reuse `priority` as an enum column (text).** It would invalidate every row
  written before the change and break `priority DESC` in the claimer.
- **A `parent_job_id` field on `jobs` instead of a table.** One task can be both
  source and target of several claims of different kinds, and a parent link would
  read as containment — a job "inside" another job — which is the move, merge or
  suppression this change explicitly refuses. A relation row states two jobs and
  a kind, and nothing is implied beyond that.
- **Derive relations from title or embedding similarity.** A wrong relation is
  invisible to the person reading the page and can suppress real work; a relation
  is only written by a person or by the bounded post-QA decision.
- **Ask for evidence on every level change, including `P3`.** Then the common
  case (demote something, or a policy default) needs a paragraph nobody reads,
  and the evidence bar stops meaning "this is a claim about urgency".

## Consequences

- **No migration is needed for the ladder.** Rows written before this change keep
  their integer and read as the nearest level — a job at 15 shows as `P2`, and a
  work item at 70 shows as `P0`. The filter clause is the matching half-open
  range, so a pre-ladder row is never excluded from every level at once.
- **The queue only ever changes on a real level change**, and then to the tail of
  the new level. Demoting a job puts it behind the jobs already waiting at the
  lower level, which is the same rule as raising it.
- **A deleted job takes its relations with it** (cascade), and a relation that
  names a job which no longer exists cannot be written: the store resolves both
  ends before the insert.
- `task_relations` is additive. A revert leaves an unused table and drops the
  ladder's meaning back to the integer; no data migration is needed in either
  direction.
- The reasons and evidence on a claim are audit rows (`job.priority_changed`),
  so a reordered queue can be explained later without a second store.
- The relation is a record, not an action: nothing in the runner reads
  `task_relations` to move, merge or suppress a job. The one behavioural link is
  the coordination notice a related task leaves for a running target.
