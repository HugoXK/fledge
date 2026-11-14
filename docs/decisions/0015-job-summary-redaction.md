# 0015 — a job summary is redacted where it is written and again where it is read

Status: **accepted** (2026-11-13)
Date: 2026-11-13
Supersedes: nothing; it extends the log-only redaction of `redact()` to stored job text

## Context

`redact()` recognised token shapes for the log line, the mailer error and the
approval mail, and stopped there. The job pipeline stores four free-text fields a
runner controls:

- `summary`, written by `updateJob()` on progress and by `claimJobTerminal()` on
  the terminal transition;
- `error`, written on a failed callback;
- `checkpoint`, the runner's resume note;
- the digest's `summary`, `issue_url` and `pr_url`, which `buildCarryOver()` folds
  into the *next* job's goal.

A runner that prints `ghp_…` while debugging therefore parked the token in the
row, on the job page, in the notification mail, and — through the digest — in the
prompt of the following run. Truncation makes it worse rather than better: the
1200- and 220-character slices in `src/jobs/continuity.ts` and the 4000-character
slice in `src/jobs/service.ts` can cut a token so that only `ghp_SYNTHE` survives,
which no pattern matches, so a redaction applied *after* the cut cannot see it.

Two more cases force a decision rather than a one-line patch:

1. A configured secret (SMTP password, model key, session secret) has no shape a
   pattern can recognise. It has to be registered as a literal value.
2. Rows written before this change still hold raw text. A write-side fix alone
   leaves every existing row visible on the job page.

## Decision

Redact at the boundary, not at one call site:

- **Registry.** `registerRedactionSecrets(values)` replaces the literal set;
  `loadConfig()` calls it once with the configured secrets. Values shorter than
  eight characters are ignored, because replacing an ordinary short password
  would shred prose without protecting anything. The set is replaced per call and
  not appended, so repeated `loadConfig()` calls in a test do not accumulate.
- **Before the slice.** `redact()` is applied to the value and the result is then
  cut to its limit. A cut can only ever leave a redaction placeholder.
- **Both writers.** `updateJob()` and `claimJobTerminal()` pass `summary` and
  `error` through one module-level helper before the SQL parameters are built, so
  the control holds for callers that never touch the job service.
- **Render pass.** `jobSummary()` — the single function behind the summary cell
  and the job page body — redacts its text, as do the job page's technical-detail
  block and the admin jobs table. That is what makes a pre-change row safe to
  display, and it is a second line of defence if a future writer forgets.
- **Links.** `issue_url` and `pr_url` can carry a credential in their userinfo or
  query, and they are stored and carried forward, so they go through the same
  redactor.

## Consequences

- A summary that legitimately contains something token-shaped is rewritten to a
  placeholder. That is the intended trade: the console loses one literal and gains
  a guarantee that the value cannot be read back.
- The pattern set is a guess about shapes. A secret with no recognisable prefix is
  only covered when it is a configured value, so a *new* provider key added to the
  config must be added to the `registerRedactionSecrets()` list in the same change.
  `test/secrets.test.ts` pins both halves: shapes are recognised, and a registered
  literal is replaced.
- Redaction is not encryption. The raw value is still in the callback payload and
  in whatever the runner logged locally; this change stops the platform from
  storing and re-publishing it.
- A page-level redaction cannot be tested by asserting that a token is absent from
  the *stored* row alone; `test/jobSummaryRedaction.test.ts` deliberately writes a
  pre-change row with a raw value and asserts on the rendered page.
