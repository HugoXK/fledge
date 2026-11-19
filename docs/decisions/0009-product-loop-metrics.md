# 0009 — Product loop durations extend `/admin/metrics`; the read model is aggregates only

Status: **accepted** (first slice implemented in the same pull request as #635)
Date: 2026-11-19

## Context

`/admin/metrics` already renders `store.productMetrics`: users, approved users,
repositories, jobs, succeeded and failed, users with a job, users with a PR, job
cost and an event-name histogram. Those are counts. They cannot say whether the
loop *works*: a week with thirty connected repositories and no merges and a week
with one connected repository and one merge share every number above except the
first.

The questions that need an order and a duration are: how long does a newly
connected repository take to reach its first merged pull request, and how long
does a ready pull request wait for a human before it merges. `#635` carries the
rest of the loop model (human-rescue rate, weekly returning repositories, evidence
completeness); this decision covers only the first slice, which is the two
durations.

Two facts had to be settled before code: where the read model lives, and what may
leave it.

1. A second product page would duplicate `productMetrics` and give the product a
   third metrics home beside `src/lib/metrics.ts` (operational counters) and the
   `Store` methods (product read models). The card says "extend those counts
   instead of replacing the page", and `#636` has the same `src/metrics/` path
   question.
2. A loop model is where a self-hosted platform usually leaks: per-user rows,
   prompts, code, tokens, e-mails or a repository URL with credentials. "No
   third-party analytics" is not a privacy boundary on its own; the boundary has
   to be the shape of the data the code can see.

## Decision

- **`src/metrics/product.ts` is a pure module of timestamp arithmetic.** It takes
  `{ createdAt, firstMergedAt }` per repository and `{ readyAt, mergedAt }` per
  merged pull request, and returns `{ samples, medianMs }` per metric plus the
  repository count. It imports no store, no config and no HTTP type, so nothing
  that carries an identity can reach it. `loopMetrics` and `median` are the whole
  surface.
- **The page is extended, not replaced.** `store.productMetrics` runs the two
  queries and calls `loopMetrics`, so `/admin/metrics` gains two rows in its
  existing "Delivery efficiency" card. No new route, no new page, no CSV yet.
- **A missing sample is `null`, and the page renders `n/a`.** The sample count is
  printed beside the median, so a reader can tell "no repository has merged yet"
  from "one repository merged instantly". This follows 0008's rule that a quiet
  window says `n/a` instead of a confident zero.
- **A pair that runs backwards is dropped, not clamped.** A merge timestamp
  before the repository's creation is a clock that moved; counting it as `0`
  would quietly bias the median down.
- **Privacy boundary.** The queries select timestamps and a repository id only
  for the grouping; no user id, login, e-mail, prompt, code, token or PR URL is
  selected, returned or stored. There is no new table, so there is nothing to
  retain, redact or delete beyond the rows that already exist, and repository
  deletion keeps cascading through `work_items` and `jobs` as it does today.
- **The window is the repository's creation** for the first-merge metric and the
  merge timestamp for the ready-PR wait, matching what each question asks. A
  repository created before the window but merged inside it is not counted as a
  newly connected repository; that is deliberate and is stated on the page by
  the label, which names the repository count rather than the merge count.

## Consequences

- The two answers are read where a maintainer already looks, and they cost three
  indexed reads (`repos`, `work_items`, `jobs`) on a page only a superadmin
  opens.
- `productMetrics` now returns a nested shape; a caller that ignores the new
  fields is unaffected.
- The rest of #635 — human-rescue actions, weekly returning repositories,
  evidence completeness, the salted event id, CSV export and the optional webhook
  — remains unbuilt and unapproved by this decision. When it arrives, its event
  model should hash the repository id with the `settings` row salt named in the
  card, and it must keep the same property: the read model receives timestamps,
  never an identity.
- A future second metric that needs identity (for example "unique maintainers
  who merged") must either aggregate inside SQL or come back to this decision —
  the pure module cannot express it.
