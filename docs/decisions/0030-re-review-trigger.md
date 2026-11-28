# 0030 — a re-review is requested by one trigger with two sources: a head that moved after `CHANGES_REQUESTED`, or a maintainer's `Re-review:` comment

Status: **accepted** — the card's issue review passed at body `03d7ec760e8c` and the T3 review at the tip carries the rule; implemented in the same pull request as [`#1274`](https://github.com/HugoXK/fledge/issues/1274)
Date: 2026-11-28
Decision owner: Fledge Platform Lead (sign-off); written by Fledge Platform Dev-1
Settles: [`#1274`](https://github.com/HugoXK/fledge/issues/1274), which records the gap and the four options. It decides the trigger, keeps the reviewer's work out of it, and defers the label form to its own card.
Pin: `a850119c58b0b15a75a85faefa062b814f37d680` — every `file:line` here resolves at it.

## Context

A change request has no re-review trigger. `.github/workflows/review-gate.yml:3-9`
starts the gate on `pull_request`, `pull_request_review`, `merge_group` and
`issue_comment`, and every one of those is an event the reviewer or a person
produces. Nothing reacts to the work a change request causes:

- **A fixed tip.** The blocker is repaired on the same branch and pushed. The
  `synchronize` event starts `CI` and `Review gate` again, but a fresh gate run is
  not a fresh verdict: the newest verdict at the head is still the
  `CHANGES_REQUESTED`, so the pull request waits for the reviewer to happen to look
  again.
- **A body-only evidence edit.** The card's own example: the requested before/after
  pair lands in the pull request body. No commit moves, so no event fires at all.

`scripts/retrigger.mjs:1-8` is the nearest existing mechanism — the `pr-lint`
completion trigger `#1169` added — and it repaints a check, not a review. The same
is true of `scripts/lib/gate-repair.mjs`: it paints the conclusion the newest
verdict implies; it cannot create a verdict. The only existing answer is the
same-tip replacement PASS, and that rule covers a verdict rejected for a
record-only reason, not work that was just finished.

The cost is visible in the queue: a repaired pull request keeps reading
`CHANGES_REQUESTED`, so "still rejected" and "repaired, nobody re-read it" look
identical, and the second one waits indefinitely.

## Decision

One trigger, two sources. `.github/workflows/rereview.yml` runs on
`pull_request: synchronize` and on `issue_comment: created`; the decision is the
pure function in `scripts/lib/rereview.mjs`; the entrypoint is
`scripts/rereview.mjs`.

1. **The head moved after a change request.** The newest `CHANGES_REQUESTED`
   review's commit is not the current head → `request head=<head>`. This also
   covers the case the reviewer's own commit-based verdict could not: the blocker
   was fixed and pushed while the verdict still points at the old tree.
2. **A maintainer wrote `Re-review: <reason>`.** The comment form is the only one
   that works when the tip does not move. Only `OWNER`, `MEMBER` and
   `COLLABORATOR` count; the reason is required — a marker with no reason is
   refused by name.
3. **One request per head.** The request posts one comment
   (`Re-review: <reason> — head <sha>`), asks the policy's `requiredPass` account
   for one review, and re-runs the newest completed `Review gate` run at that head.
   The workflow's job-level concurrency group is the head SHA, and the request job
   re-reads the decision inside the slot, so a second event at the same head finds
   the first request open and writes nothing (`no-op: open request at <sha>`).
4. **A verdict at the head answers the request.** A review submitted at that head
   after the request closes it, and only a verdict state counts (`APPROVED` or
   `CHANGES_REQUESTED`): this repository posts machine `COMMENTED` reviews (CodeQL),
   and a comment-only review is not a conclusion, so it must not close a request and
   let a second one in at the same head. A later repair at the same tip may ask
   again.
5. **No head move is not a request.** A `CHANGES_REQUESTED` already at the head, or
   a head with no change request at all, is a no-op; the card's line is
   `no-op: no change request` / `no-op: no head move`.

The request is never a PASS and carries no evidence. The reviewer still checks out
the head, re-runs the gates and writes the verdict itself; the request only makes
the new read an event instead of a coincidence. The marker is accepted on its own
line anywhere in a comment body — the rule `scripts/lib/rereview.mjs` applies and
the rule the workflow's `issue_comment` guard tests, so a maintainer and the bot
that reads the request share one contract. The request comment is written last,
after the reviewer request and the re-run: the comment is the record that a request
is open, so a failed write leaves no open request behind for the next trigger to
no-op against. The comment is posted through `GITHUB_TOKEN` (the Actions identity)
on behalf of the re-review routine, and its `Written-by:` line names that routine —
the same convention the release routines use for their own routine comments.

## Alternatives

- **Label `review:rereview` + dispatch.** Deferred, not rejected: it needs a
  repository label, its own decision about who may apply it, and a dispatch path
  that the comment form does not. The comment form delivers the same signal with
  no new label, so the label waits for a card that can argue for it.
- **`pull_request_review` event.** It fires on the reviewer's own review, which is
  the event that is missing. Using it would require the reviewer to look first.
- **`synchronize` alone.** Covers the moved tip but not the body-only evidence
  edit, which is the case the replacement-PASS rule exists for; kept as one of two
  sources, not the only one.
- **Automatic PASS or a waiver.** Refused: a request that carries a conclusion
  turns "the reviewer re-read it" into "the bot merged it", and the author of a tip
  may never PASS its own work.

## Consequences

- One more workflow and entrypoint (T3). Every request is attributed, reasoned and
  names its head; the reviewer's verdict is still the only conclusion.
- A stranger's comment cannot reach the write job: the workflow skips a
  non-maintainer comment and a fork's pull request before any write scope is
  granted, and `action-pins`'s actor check holds the same guard on the privileged
  job itself.
- The re-run ceiling is one re-run, held in one place (`RERUN_ATTEMPT_LIMIT` in
  `scripts/lib/rereview.mjs`): only a run at attempt 1 is re-run, so a head reaches
  attempt 2 at most and a request can never re-run a gate in a loop.
- There is no rehearsal of the three writes before merge: the first live exercise
  is the first post-merge event. A pull request event takes this workflow from the
  head while the code it runs is the base checkout, so on the pull request that
  lands this file the base tree carries neither and the plan step names that
  bootstrap and exits 0; a base tree that carries the workflow without its
  entrypoint fails closed.
- Rollback: delete `.github/workflows/rereview.yml` and the entrypoint; the
  repository returns to "the reviewer happens to look", with no data change. No
  label, no `ci-ok` change and no `review-gate` decision logic is touched.
