# 0014 — a work type is data, one registry decides what a job's work is worth

Status: **accepted** (2026-11-13)
Date: 2026-11-13
Supersedes: nothing; it separates a job's pipeline (`kind`) from its work type

## Context

Every job in Fledge was `iterate`: the same scope → red test → green test →
review evidence applied to a bug fix, a dependency bump, a security fix, a docs
correction and a migration alike. The evidence that a merge gate needs is not the
same for those, and the platform had exactly one list of what "done" means.

Two things forced a schema decision rather than a code one:

1. The work type has to survive the job row. The job page, a retried job and the
   auto-merge decision all read the row later, so an in-memory value would forget
   what a run was.
2. The issue asked for a registry of eight types while only `iterate` and
   `triage` have a handler in this slice. A registry that declares contracts it
   cannot enforce is how a "dependency job cannot auto-merge" test comes to prove
   nothing.

## Decision

A job gets a second, independent field, `work_type`, next to its `kind`:

- **`kind`** is the pipeline that runs the work (`iterate`, `review`, `plan`,
  `scope`, `verify`, `discover`, `triage`) and stays the value every existing
  branch in `src/jobs/service.ts` already switches on.
- **`work_type`** is the contract the work is held to: allowed stages, required
  evidence, declared risk tier, budget ceiling, whether it may branch and whether
  it may auto-merge. It is a column with a default of `iterate`, so every row
  written before this change keeps its current meaning.

The registry in `src/lib/workTypes.ts` is the only list. It declares all eight
types, and `IMPLEMENTED_WORK_TYPES` names the two this build can run. The enqueue
path refuses an unknown type (`UNKNOWN_WORK_TYPE`) and a declared type with no
handler (`WORK_TYPE_UNSUPPORTED`) before it writes a row — the same refusal, for
the same reason: nothing may run under a contract that is not enforced.

The auto-merge expressions read the registry instead of the kind. Today the gate
is `repo.repo_role === 'maintainer' && repo.auto_merge === 1 && job.kind ===
'iterate'`; it becomes that expression **and** `workTypeMayAutoMerge(job.work_type)`,
so a future dependency, security or docs job cannot inherit iterate's
eligibility by accident. The repository setting stays permission; the registry is
eligibility.

`triage` is the first work type and the reason the schema had to be decided now:
it is read-only, so it needs a job row, a board to store and a page to render,
but no branch. Its report is stored as `triage_json` and parsed strictly — a
successful triage job without a valid report fails as `TRIAGE_UNVERIFIED`, and a
triage callback that carries a branch or a PR fails as `TRIAGE_PR_FORBIDDEN`.
Its first ranked row becomes a work item, which is the existing path the next
scheduled work session already consumes.

## Alternatives considered

- **Reuse `kind` as the work type.** Cheapest migration, but it would collapse
  the pipeline and the contract: `review` and `verify` are stages of iterate
  work, not kinds of work, and the existing `checkStage()` switch depends on the
  kind values. It also makes "the same pipeline, a stricter contract" impossible
  to express.
- **No column; keep the work type in the goal text.** Nothing durable, nothing
  queryable, and the auto-merge decision would parse prose.
- **Declare only the two implemented types.** Then the registry stops being the
  one list the issue asked for, and adding a type changes the file's shape rather
  than adding a row.

## Consequences

- A migration adds two columns (`work_type`, `triage_json`); both default to a
  value every old row can keep.
- `UNKNOWN_WORK_TYPE` and `WORK_TYPE_UNSUPPORTED` are enqueue refusals, not job
  failures: they happen before a row exists, like the other admission refusals.
- The evidence gate for typed work types is wired into the callback but only
  reachable by `triage` (which requires none) until the next type ships; it is
  tested at the unit level and by a direct-row service case, and the issue's
  follow-ups turn it on without touching the callback again.
- Merging still needs the repository's auto-merge setting and a green tip; the
  registry can only ever remove eligibility, never grant it.
