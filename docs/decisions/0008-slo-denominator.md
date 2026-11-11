# 0008 — The SLO success rate names its denominator, and a quiet window renders `n/a`

Status: **accepted** (implemented in the same pull request as #196)
Date: 2026-11-10

## Context

`npm run slo:report` printed a 7-day job success rate, and nothing said what that
number was a rate *of*. The job table carries seven terminal-or-not
`JobStatus` values (`src/db.ts`): `queued`, `running`, `succeeded`, `failed`,
`cancelled`, `paused`, `quota_exhausted`. The report divided one `succeeded`
counter by `succeeded|failed`, so a surge of quota refusals or cancellations
shrank the population the percentage was taken over without moving the
percentage, and an operator reading the row could not tell that from a healthy
week. Two copies of the status set existed — `scripts/slo-report.mjs` and the
recording rule in `deploy/prometheus/fledge-alerts.yml` — with only the text of
each file keeping them equal.

The same report printed `NaN` for a quiet window. A window in which the
counters exist but never move is `0/0`, which Prometheus answers as `NaN`; the
formatter tested only for a missing series (`null`), so a quiet week rendered
`NaN%`, `NaNm` and `NaNm` instead of saying there was nothing to measure.

## Decision

**The denominator is `succeeded` + `failed`, and nothing else.** The success rate
is `sum(rate(status="succeeded")) / sum(rate(status=~"succeeded|failed"))` over
the 7-day window. `cancelled`, `paused` and `quota_exhausted` sit in neither the
numerator nor the denominator: a cancellation did not fail and a quota refusal
never ran, so counting them would report a failure that did not happen and
counting them in the denominator only would let one class of refusal reduce the
rate of the other. `queued` and `running` are absent from both because they are
not terminal. The rate is therefore a rate over jobs that *ran* to success or
failure, not over every job Fledge accepted.

**The set lives in one place.** `src/lib/slo.ts` exports `SLO_SUCCESS_STATUS`
(`succeeded`) as the numerator and `SLO_JOB_STATUSES` (`succeeded`, `failed`) as
the set it divides over, built from that status rather than reached into by
position; `EXCLUDED_JOB_STATUSES` (`cancelled`, `paused`, `quota_exhausted`) is
the other half of the definition. `scripts/slo-report.mjs` builds both of its
selectors from those exports, so the script carries no status literal. The
recording rule is YAML and cannot import JavaScript, so it is pinned the only
honest way available: a test reads `deploy/prometheus/fledge-alerts.yml` as text
and holds its exact-match numerator and both of its regex denominators to the
exported values, and separately asserts that the script contains no second copy.

**A quiet window is not an absent one, and both render `n/a`.** A window whose
counters are present and flat has nothing to measure, so the five rows that can
be non-finite print `n/a`: the success rate, the error budget derived from it,
queue p95, job p95 and bridge success. `NaN` is not `null`, so the guard tests
`value !== null && Number.isFinite(value)` rather than `=== null`. The two rows
that read a real zero on that same window — the GitHub 429 rate and the open
alert count — keep `=== null` and keep printing `0.000/s` and `0`: a quiet
window genuinely has zero rate-limited requests and zero open alerts, and
replacing that `0` with `n/a` would delete the only reading those rows exist to
give.

`docs/observability.md` states both halves: the `n/a` promise, now including a
quiet window, and what the percentage divides over and what it leaves out.

## Rejected

- **Leave a literal in the script and pin it with the text test alone.** That is
  two copies that only a test keeps equal, and it is what the issue's acceptance
  rules out; the script builds its selector from the export instead.
- **Count `cancelled` as failure.** It reports a failure that did not happen and
  makes the rate move when a user stops work.
- **Divide over every status, including `quota_exhausted`.** It turns the rate
  into a share of accepted work, so a quota limit reads as a reliability
  regression, and the row would move for a reason no operator can act on as a
  reliability signal.
- **Print `0.00%` for a quiet window.** It is a measurement where none exists,
  and it reads as a total outage.
- **Apply the same `n/a` rule to the 429 rate and the open-alert count.** They
  have a real value on a quiet window; guarding them would hide it.
- **Report the excluded-job count next to the rate.** Useful, but a different
  change: it needs a new query and a new row, and this fix is about stating what
  the existing number means.

## Consequences

The percentage can no longer be read as "share of all accepted jobs": a week of
quota refusals leaves it unchanged, which is the intended meaning and is now
written down in the operating doc. The report prints `n/a` where it used to
print `NaN`, so a quiet window is visibly unmeasured instead of visibly broken.
The two selectors cannot drift without a test failing, and a third selector
added later to the recording rule fails the count assertion until it is added
deliberately. The report does not show how many jobs it left out; that stays
out of scope and is named in the doc.

## Rollback

Revert the pull request. The report returns to a literal selector, the alert
rule is untouched, the doc returns to the missing-series sentence, and `NaN`
again renders as text on a quiet window. No schema, stored data, credential or
config changes, so the revert is complete on its own.

## Non-goals

- No change to which statuses the auto-merge or any other job rule accepts.
- No change to the alert thresholds, the 7-day window, or the recording rule's
  value other than the selector's definition.
- No new endpoint, no new metric, no new stored state: the set is a constant and
  the report is derived on every run.
