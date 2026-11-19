# Notifications: one decision, one action

Fledge should interrupt a maintainer when it needs a decision, not when a state
machine moved. This is the first slice of that promise: the `action_needed`
projection, the in-app row that renders it, the action id the mail shares with
that row, and the rule that no notice carries a machine's raw error.

## The closed vocabulary

An action is one of six kinds (`src/lib/actionsNeeded.ts`):

| Kind | The decision |
|---|---|
| `question` | The workspace is waiting on an answer. |
| `plan` | A plan is waiting for approval. |
| `review` | A pull request, or a Lead-only run, is waiting on a review. |
| `failed` | A job failed and can be retried. |
| `release` | A release is waiting on a person. |
| `quota` | Platform quota is exhausted. |

The tree already writes two notice kinds outside this list: `team` (only the
Lead took part) projects to `review`, and `ops` (an operator alert) projects to
`failed`. Mapping them keeps the vocabulary closed; a page cannot invent a
seventh reason to interrupt someone.

## One id per decision

The id is derived, not minted: `act_` plus twelve hex characters of
`sha256(kind, repoId, objectId)`. The same decision therefore keeps one id across
repeated events and restarts. `objectId` is the object the decision is about — a
job id, a question id, a pull request URL — so a failure and a review about the
same job are different actions.

`Store.recordAction` inserts an open row once. A repeated event returns the same
row with `created: false`, and the caller sends no second notice. Resolving the
action marks it `resolved`; if the same decision comes back, the row reopens
with `created: true`, because it is news again. Retrying a failed job resolves
its action, because the retry is the decision the action asked for.

## The shared link

The in-app row and the failure mail both carry the action id:

- The in-app row links `/actions/<id>` and shows the action's reason and one
  primary label;
- `jobFailedEmail` carries `actionId` and `actionUrl`, so the mail links
  `/actions/<id>` too;
- `GET /actions/<id>` marks the notification rows that carry the id as read and
  redirects to the object the action describes;
- `POST /actions/<id>/resolve` resolves it.

Reading one therefore marks the same decision everywhere it was delivered. Both
routes are owner-checked: an action belongs to the user who recorded it.

## No leaked error

`Store.notify` stores what the caller passes, so the caller must pass a sentence
a person can read. `sanitizeActionSentence` removes tokens (`ghp_…`,
`github_pat_…`, `Bearer …`), email addresses, absolute and repository-relative
paths, stack frames, `…Error:` prefixes and internal codes
(`BRIDGE_ERROR`, `SKILL_BUNDLE_HELD`, `ENOENT`). A message that is only those
parts becomes a fixed fallback sentence rather than an empty notice. The failure
mail runs the same sanitizer over `error` before it reaches the subject or either
body.

## What this slice does not do

Quiet hours, the `unknown` delivery state for a send that may have crossed the
network boundary, and the lost-send record are the follow-up card. The daily
digest, per-repository cooldown and channel choice also stay there; this slice
records and delivers the decision, and leaves the schedule of delivery alone.
There is no second queue and no exactly-once promise across a network boundary:
the entry is a projection over jobs and notices that already exist.
