# 0020 — the owner surface and the operator surface are two pages with distinct jobs

Status: **accepted** (2026-11-15)
Date: 2026-11-15
Supersedes: nothing; it fixes the boundary between `/dashboard` and `/console` and
moves the advanced repository policy behind one disclosure on the settings card

## Context

Two pages grew into the same job. `/dashboard` is what an owner opens: one next
action (`#230`), the first-run checklist (`#227`), this month's cost and the
state of the repositories. `/console` is what an operator opens: every
repository, the job queue, quota and the inbox. Both are reachable, both are
linked from the header, and neither is gated beyond "approved user", so an
approved user sees the owner home and the operator workspace side by side with
no statement of which one is the default.

The repository settings card carried the same confusion at a smaller scale. One
form held the loop controls an owner tunes while reading the page — goal, target
branch, role, auto-iterate, discovery interval, PR reviewer, auto-merge,
plan-first — together with the operator policy: allowed and forbidden paths, the
merge method, the team stage gate, branch protection, monthly and per-job
budgets, the available providers and the per-bot model assignment. An owner
arriving for the first time met roughly twenty controls to set a goal and a
schedule, and the two halves could not be told apart by reading.

## Decision

The owner surface is the default and the operator surface is a separate page:

- `/dashboard` is the owner's home. It leads with one next action, then the
  first-run checklist, cost and status.
- `/console` is the operator workspace. It lists every repository, job, quota
  and inbox.
- The two pages are not merged. `/dashboard` already answers "what should I do
  now", and folding the operator inventory into it would put the queue in front
  of the one next action.
- No URL is renamed, removed or re-gated. Navigation keeps both links, and
  `/dashboard` stays the landing page after sign-in. An owner who prefers one
  page with two modes can read the operator surface as the second half of the
  same workflow; the record is amended if that preference becomes the default.

On the repository page, the settings card keeps the loop on screen and puts the
operator policy behind one closed disclosure:

- The visible form keeps the goal, target branch, role, auto-iterate, enabled,
  discovery interval, PR reviewer and its interval, auto-merge, plan-first and
  Save.
- `Advanced: operator settings (paths, stage gate, budgets, models)` is one
  `<details data-advanced="repo-settings">`, rendered closed, inside the same
  form. It holds the allowed and forbidden paths, the merge method, the team
  stage gate and its explanation, branch protection, the monthly and per-job
  budgets with this month's spend, the available models, the allowed providers
  and region, the default model and each bot's model.
- The field names and the form action do not change. A `<details>` still
  submits its inputs, so `POST /repos/:id/settings` and every role and permission
  check behind it are the same code as before. The per-bot model restart stays a
  separate form (`POST /repos/:id/models/apply`) and therefore outside the
  settings form; a form cannot be nested inside another.

## Consequences

A settings POST remains the single write path for the repository policy, so the
recent-authentication gate, the audit row and the authorization rules are
untouched. The disclosure is presentation only: no new role, no server-side
"advanced mode" flag, and no JavaScript, because `<details>` opens without it.
The label is bilingual and uses the existing `advanced-help` style. A test in
`test/ownerSurfaces.test.ts` renders the card in both locales and fails if an
operator field escapes the disclosure or a loop field is hidden inside it, so a
later card that adds an operator control has to decide where it belongs. Screen
reader users meet a collapsed group with a name instead of twenty fields in a
row, and a keyboard user reaches it with Tab and opens it with Enter or Space.
