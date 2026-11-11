# 0009 — A job failure is localized by its code, not by a dictionary row

Status: **accepted** (2026-11-11)
Date: 2026-11-11

## Context

The job service writes the failure sentence itself, in Chinese:
`GitHub token 权限不足，请重新授权这个仓库。` for a revoked credential,
`任务停滞：超过 N 分钟没有心跳。` for a stalled job. The read path had one way to
translate it — `localizeMessage` (`src/i18n.ts`) — which is an exact-match
dictionary plus a handful of regexes and ends `return MESSAGES[message] ?? message`.

So a sentence that nobody had added a row for reached an English reader exactly
as written: Chinese on the job page, Chinese in the dashboard summary, and a
half-translated notification ("The job job_x failed: GitHub token 权限不足…") because
the outer template matched and the interpolated inner sentence did not.

Adding rows was the wrong fix. Each new failure message would have to remember to
add one, and every path that forgot leaks again — the drift, not any single
message, was the defect.

## Decision

A job failure carries a stable **code** in `jobs.error_code` and a notification
can carry one in `notifications.code`. The code comes from a closed vocabulary
(`FAILURE_CODES` in `src/lib/failure.ts`): `REPO_CREDENTIAL_INVALID`,
`JOB_STALLED`, `JOB_LEASE_EXPIRED`, `JOB_TIMEOUT`, `QUOTA_EXHAUSTED`,
`JOB_BUDGET_EXCEEDED`, `DUPLICATE_WORK`, `STAGE_EVIDENCE_MISSING`, `BRIDGE_ERROR`,
`REPO_DISABLED`. Seven of them are written to a row by the job service where the
failure happens — `JOB_STALLED`, `JOB_LEASE_EXPIRED`, `JOB_TIMEOUT`,
`QUOTA_EXHAUSTED`, `STAGE_EVIDENCE_MISSING`, `BRIDGE_ERROR`, `REPO_DISABLED` — and
three are reserved: `REPO_CREDENTIAL_INVALID`, `JOB_BUDGET_EXCEEDED` and
`DUPLICATE_WORK` name refusals that stop an enqueue before a job row exists, so
they reach the reader on the redirect instead, and the vocabulary keeps a row for
them should one ever finish a job.

A refusal is localized the same way. The job service answers an enqueue it will
not start with a code (`QUEUE_FULL`, `QUEUE_LIMIT`, `REPO_BUDGET_EXHAUSTED`,
`REPO_CREDENTIAL_INVALID`, `BRANCH_MISSING`), the route puts the code on the
`error` query parameter (`BRANCH_MISSING` names the branch after a colon), and
`layout()` builds the banner with `failureSentence` rather than echoing the
service's text. A code the sentence table does not know yet renders a sentence
that names the code, so a refusal added later cannot leak either.

The read path localizes by the code: `failureSentence` builds the sentence in the
reader's language for the job-page summary, the dashboard summary and the
notification list. `localizeMessage`'s dictionary stays as the fallback for a
message no code covers, so rows written before the column existed keep rendering
as they did, and a free-text summary that is not a failure still goes through the
dictionary.

The raw text is not replaced. `jobs.error` keeps what the service wrote, it is
what "Technical detail" prints as written — in either locale, not run through the
dictionary — and the notification row keeps its `message`; both are the operator's
copy, alongside the audit log and the API payloads, which this decision does not
translate.

The failure category (`FailureKind`, `classifyFailure`) is now the code's kind,
with the pre-existing regex classifier kept for rows that carry no code. A new
failure message therefore needs a code and a sentence in both languages; it does
not need a new dictionary row.

## Consequences

- A new backend failure path that writes a user-visible sentence must add a code
  and both sentences. `test/jobFailureLocale.test.ts` pins the set the issue
  names and the two-language sentence table, so a missing translation is a red
  test rather than a leak discovered in production.
- `jobs.error_code` and `notifications.code` are nullable and migrated in place
  (`migrateRepoColumns` in `src/db.ts`); old rows are not rewritten.
- A code that is not in the vocabulary is not invented into a failure: on a job
  row the text falls through to the dictionary, and in a banner it renders a
  generic sentence that names the code — an unknown code neither invents a
  sentence nor prints the service's text.
- The vocabulary is closed on purpose. A failure that does not fit any code keeps
  the current behaviour: its text renders as written, which is visible and
  fixable rather than silently generic.
