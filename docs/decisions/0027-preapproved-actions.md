# 0027 — a reviewed action may be pre-approved for one change, bounded by a release, guarded in its own tree first and by the base checker from the merge onward

Status: **Proposed — awaiting the owner**
Date: 2026-11-21
Decision owner: HugoXK
Depends on: [`#650`](https://github.com/HugoXK/fledge/issues/650) (the allowlist, and the base-branch read that makes "reviewed first" an executable order), `docs/security.md:1035` ("Allowed GitHub Actions")
Settles: [`#1206`](https://github.com/HugoXK/fledge/issues/1206). It records the mechanism `#1206` chose and settles the three questions the seat left open: what bounds an exemption that otherwise only expires on first use, where that bound is enforced, and in which order enforcement moves from the pull request's tree to the base branch.
Pin: `044c7515a6111560bf96cdd20e8c724535cefc0a` — every `file:line` in this document resolves at it.
Security: the Gate Security seat's first pass is on `#1206` (comment `7067735330`, `Date: Sat, 21 Nov 2026 19:04:05Z`). Its three findings are requirements here, not commentary; its verdict is held for this text.

## Context

The section both forbids an unused entry — "a name in the list that no workflow uses is a test failure too" (`docs/security.md:1049-1050`), and step 2's "the suite's both-directions test must still pass, so a list entry that no workflow uses cannot ride along" (`docs/security.md:1080-1083`) — and requires that entry to land before its use: "the list entry lands first, in its own reviewed change, and the workflow that uses the action comes after" (`docs/security.md:1052-1056`), with the steps at `docs/security.md:1084-1086`. No change can satisfy both, so **no action can be added by the documented procedure at all**. The implementation is not the defect; the written order is.

Two jaws hold it, and each is doing its job:

- **The head tree forbids the entry.** `test/actionPins.test.ts:403-419` asserts the two sets are equal in both directions; `:416` reads the list with `readAllowlist()` against its default path, which is the pull request's own tree, and `:418` fails with `the list names an action no workflow uses`. A name added to `.github/agent/action-allowlist.json` with no workflow using it fails on the pull request that adds it.
- **The gate reads the base list.** The `action-pins` job checks the base sha into `base/` (`.github/workflows/ci.yml:546-553`, whose comment says the gate's code comes from the base branch and never from the pull request it judges) and runs `node base/scripts/action-pins.mjs --workflows .github/workflows` (`.github/workflows/ci.yml:559`). The allowlist path resolves next to that base copy (`scripts/action-pins.mjs:19`, `scripts/lib/action-pins.mjs:31-37`), so a use added in the same change is judged against a list that does not contain it.

Both legal moves are refusals: entry alone, the head suite reds; entry and use together, `action-pins` reds. Measured on `#1206`, not argued: one line `"actions/cache"` produced `not ok 1 - the allowlist and the workflow tree name exactly the same repositories` / `the list names an action no workflow uses`, actual `['actions/cache']`, expected `[]` (Dev-1, comment `7067263694`).

The consequence is not "the checker is inconvenient". It is that the procedure `docs/security.md` documents cannot be executed, and every new action — `actions/cache` is only the first that came up — is blocked behind a contradiction in our own policy.

## Decision

`.github/agent/action-allowlist.json` gains one reviewed key, `approved_unused`, holding actions that are on the reviewed list while no workflow uses them yet, each carrying the issue that pre-approves it and a release version by which it expires. `allowed_actions` keeps its meaning and its validation; the grant path is unchanged.

**This lands as two cards, and the order is the decision, not a scheduling preference.**

- **Card one — this one, `#1206` — is a bootstrap.** It carries the key, its validation and its expiry assertion **in the pull request's own tree**, and it is backed by the T3 review and the owner's yes. On card one's own diff the base checker at `044c7515` knows nothing about the key: `readAllowlist` returns `allowed_actions` and never looks at anything else (`scripts/lib/action-pins.mjs:41-62`), and `scripts/action-pins.mjs:22` reads exactly that. So the base cannot enforce anything about `approved_unused` in the change that introduces it.
- **Card two — no number yet, filed after card one merges — moves the exemption-versus-tree check into the checker that runs from the base branch.** Only after it lands does deleting the rule require a separate reviewed change, because only then does `main` already know the key and can judge a pull request's exemption with code the pull request cannot edit. Card two cannot be opened first: a pull request that asks the base checker to validate a key the base does not know recreates the deadlock in a new place.

The owner's line, which this document must make literally true, not approximately:

> approve a pre-authorisation mechanism that is auditable and separately revocable; this PR carries its own validation and expiry assertion; removing the rule itself needs a separate reviewed change (the next card moves it into the base checker).

It is true in this shape, clause by clause: *auditable* — every entry names the issue that pre-approved it and a release version it expires at, and the list is data in the tree, so the decision is a one-line reviewed diff; *separately revocable* — deleting an entry is a one-line change to the same file and affects nothing else, and it is deletable even while a use exists, because the use stays refused by the list's normal path until the entry is gone; *carries its own validation and expiry assertion* — both are in card one, as written below; *removing the rule needs a separate reviewed change* — true from card two onward, and from card one onward removal is at least a reviewed change, just one that a single pull request can currently bundle with its own exemption. That last gap is the subject of the first paragraph of Consequences and is the whole reason card two exists.

### What card one must carry

1. `.github/agent/action-allowlist.json`: the new `approved_unused` key, starting as `[]`. `allowed_actions` untouched.
2. Validation of the key, in the change that introduces it — see Validation below. A `"actions/*"` sitting in a key that looks reviewed is worse than no key at all, so this is not deferred to prose or to a later card.
3. `test/actionPins.test.ts`: the three assertions `#1206` specified, plus the expiry assertion, so a lapse is a test failure and not a comment somebody is supposed to remember.
4. `docs/security.md`: the procedure paragraph, written for the two-card order — what the exemption is, that its entry is a named reviewed line carrying an issue, that it expires at a release version, and that until card two lands the rule lives in the tree, so removing it is a reviewed change but not yet one the base branch can compel.
5. `changelog.d/1206.changed.md`: one paragraph.

Card one does **not** carry: `actions/cache` itself, any workflow change, any change to the checker's behaviour for unlisted actions, and any enforcement that pretends to come from the base branch.

### Shape

```json
{
  "allowed_actions": ["actions/attest-build-provenance", "actions/cache", "actions/checkout", "…"],
  "approved_unused": [
    { "name": "actions/cache", "issue": 1206, "expires_at": "0.6.0" }
  ]
}
```

A missing `approved_unused` is an empty `approved_unused`. An entry is an object with exactly `name`, `issue` and `expires_at`; extra fields fail, because a field the reader ignores is a field a reviewer may believe.

### Validation

Enforced in card one, in the tree the pull request carries:

1. `name` must match `ACTION_REPOSITORY` (`scripts/lib/action-pins.mjs:29`) — an exact `owner/repo`, no wildcard, no prefix, no sub-path. A `"actions/*"` is malformed, not broad.
2. `name` must be a member of `allowed_actions` in the same file, compared as an exact lowercased set. An exemption may not name something the gate would refuse.
3. Duplicates fail, in `approved_unused` as they already do in `allowed_actions` (`scripts/lib/action-pins.mjs:52-56`).
4. A non-array `approved_unused`, a bare string, a null element, a missing required field, a non-string `name`, an `issue` that is not a positive integer, and a malformed `expires_at` all fail. Unknown top-level keys stay ignored, as today, so the key remains data.
5. An exempted name must **not** be used by any workflow. The exemption expires on first use, so a use that arrives while the exemption is still listed is a failure, and the fix is to delete the exemption in the same change that adds the use — which is legal, because the name is already in `allowed_actions` on `main` and `scripts/action-pins.mjs:22` reads it there.

### Where each half is read

`allowed_actions` comes from the base copy of the checker (`scripts/action-pins.mjs:19`, `:22`), which is what makes "the entry lands first" an order rather than a convention. `approved_unused` is read from the head file — the tree under review — because it is a statement about *this* tree's unused names; read from the base, it would judge today's tree with yesterday's exemption. For the introducing pull request the base has no rule for the key at all, so the head test is the only enforcer and the base says nothing about `approved_unused`; after that pull request merges, the base copy knows the key, the base judge becomes the enforcement for every later pull request, and the head test drops back to a fast local signal that fails earlier and in a more readable place.

## What bounds an exemption that only expires on first use

The expiry bound is a **release version, not a calendar date**, and it is enforced by the suite that card one already touches.

1. `expires_at` is a minor release version — `x.y.0`; a patch version, a prerelease suffix or `latest` fails.
2. It may be at most two minors beyond the tree's `package.json` version at review time. One minor would lapse before a single release could carry the follow-up; three would outlive the review that justified it.
3. The assertion fails when the tree's `package.json` version is greater than or equal to `expires_at`. Equality fails deliberately: the release pull request that bumps to `expires_at` is exactly the moment a person must decide.
4. A missing, empty or unparsable `expires_at` fails; there is no "no expiry" value.
5. The failure message names the entry, its `issue` and its `expires_at`, and names the two legal moves: delete the entry, or renew it with a new `expires_at` and a comment on the issue saying why the pre-approval still stands.

### Who fails when it lapses, and what "lapse" does not mean

The failing run is the suite in `test/actionPins.test.ts`, which CI runs on every pull request, every push to `main`, and the nightly `cron: '17 19 * * *'` (`.github/workflows/ci.yml:3-13`). The run that matters is the **release pull request that bumps `package.json` to `expires_at`**: that pull request cannot go green, so the version that would declare the exemption expired cannot merge while the exemption is still there. That is the bound doing its work — the lapse lands on a release, where a person is already reading the file.

But `expires_at` does not retract anything by itself, and this document will not let a version number imply a sweep:

- Nothing deletes an entry. There is no scheduled job and no bot that removes a lapsed exemption; the version number makes a tree **fail**, and only a human, in a reviewed change, removes or renews the entry.
- An exemption whose follow-up change never comes therefore survives until a release pull request bumps across its `expires_at`, and that pull request stops. The two outcomes are both explicit: the release is blocked until someone deletes or renews the entry, or the entry is renewed and the pre-approval continues under a new deadline with a new justification attached to the issue.
- A lapse discovered on a tree that is not a release pull request — a doctored head-side file, a branch that deleted the assertion — reds on the next change that runs the suite against that tree, not before. Until then it lingers, and the record of it is the entry itself.
- The residual accepted: between the two cards, a reviewer who wants to remove an exemption has to win a review, not a mechanical check. After card two, the check runs from the base and cannot be removed by the change it governs.

## Blast radius

The protective direction — an action that a workflow uses must be on the reviewed list — is unchanged: `readAllowlist` validates only `allowed_actions` (`scripts/lib/action-pins.mjs:41-62`), `scripts/action-pins.mjs:22` reads that from the base copy, and a workflow using an action present only in `approved_unused` still exits 1 with "not on the reviewed list" (measured by the Gate Security seat). Only the reverse drift direction — a name listed and not yet used — becomes an explicit, reviewed, expiring state instead of an impossible one.

## Alternatives considered

- **Withdraw the work and leave `actions/cache` unusable.** `#787` is closed and `#1205` is parked, so this is a real option, not a straw man. Rejected: the deadlock is in the documented procedure, not in the cache card, so withdrawing the cache leaves every future action blocked behind the same contradiction, and the next team to hit it will resolve it by weakening the list instead of by making the order executable.
- **A per-workflow bypass flag.** Rejected: a flag that says "this workflow may use an unlisted action" is exactly the hole the allowlist exists to close, and it would be set once and never read again. The exemption does the opposite — it keeps the name inside the list and the use subject to the list's normal path.
- **Let the checker read the head tree's allowlist when the same diff edits it.** Rejected by the Gate Security seat: it is the one shape that lets a pull request grant itself an action in the change that uses it, and it silently converts every allowlist edit into a change judged by its own author's copy.
- **A union of base and head inside `readAllowlist`/`checkWorkflow`.** Rejected for the same reason: the union makes the head half authoritative whenever it is wider, and a malformed head file would then be read where a malformed base file is refused.
- **Point the pre-existing `--allowlist` flag at the pull request's own file.** No caller passes that flag today (`.github/workflows/ci.yml:559`), so this is a one-line change away from being a bypass. Rejected as a bypass shape and named here so a future change cannot adopt it while thinking it is a convenience.
- **Leave the rule only in `test/actionPins.test.ts`, with no statement anywhere else.** Rejected as an end state, and adopted only for card one: the test is the enforcement on the introducing pull request, and it is deletable by the change it governs — which is why card two exists. The ADR records the weakness instead of presenting the test as the settled design.
- **Exempt-until-used with no bound.** Rejected: a name nobody ever uses would stay pre-granted forever, and the list would stop describing a decision. The release-version bound costs one line per entry and makes every exemption end in front of a person.
- **A calendar review date instead of a release version.** Rejected: a date expires in the middle of a normal week and forces a change nobody scheduled, while nothing in the release path notices it. The version bound puts the lapse exactly where a person is already reading the file — the release pull request.
- **One card that both introduces the key and enforces it from the base.** Rejected because it is not available: the base that judges the introducing pull request is `044c7515`, whose `readAllowlist` (`scripts/lib/action-pins.mjs:41-62`) returns `allowed_actions` and never sees a second key. Enforcing from the base can only begin in a checker that already knows the key, which means the change after the one that adds it.

## Consequences

The introducing pull request is the one place this document's strongest guarantee does not hold: for `#1206` itself the base copy predates the key and cannot enforce anything about `approved_unused`, so in that single change the guards are the head test, the T3 review and the owner's yes. From that merge onward every later pull request is judged by a base copy that knows the key — which is where "a pull request cannot delete the rule that governs its own exemption" becomes true. Until card two lands, that sentence is a property of the merged tree, not of the change that created it.

- `#1206`'s body currently says the checker changes are "unchanged matching, unchanged refusal message" and that acceptance is "the same shape of report as today". Item 2 of what card one must carry makes both false, because validating the key is a change to the reader and to what it refuses. This is recorded on the card (comment `7067831407`) and is corrected once, in the edit that lands the final scope after the owner's yes — not while the card is frozen and not twice.
- `docs/security.md` must be edited in card one to describe this order. Until it is, the file keeps asserting that both directions are untouchable and that the entry lands first, which nothing can satisfy.
- The list stops being "exactly the set of actions the tree uses" and becomes "the set the tree uses, plus the names a reviewed change has pre-approved". The both-directions test keeps its message for the non-exempted case, so a forgotten entry still fails with `the list names an action no workflow uses`.
- Removing an exemption is a one-line reviewed change in both cards, and nothing about the exemption can make a workflow run an unlisted action: the use still resolves through `allowed_actions` only.
- Card two is a real migration, not a formality: once it lands, an exemption that is malformed, lapsed or still used fails every pull request, not just the change that wrote it, and the reader in the base must stay backward-compatible with trees that do not carry the key.
- The residual accepted in both cards: an exemption can outlive its justification by up to two minor releases, and between the cards a pull request that removes the assertion together with its exemption is stopped only by review.

## Evidence

- `docs/security.md:1035` — the section heading; `:1049-1050` and `:1080-1083` — the unused-entry prohibition; `:1052-1056` and `:1084-1086` — the ordering that requires the entry first.
- `test/actionPins.test.ts:403-419` — the both-directions assertion; `:416` reads the list from the pull request's own tree; `:418` carries the message `the list names an action no workflow uses`.
- `scripts/lib/action-pins.mjs:29` (`ACTION_REPOSITORY`), `:31-37` (why the list resolves beside the checker), `:41-62` (`readAllowlist` reads only `allowed_actions`), `:52-56` (per-entry validation, and duplicates), `:100` (exact lowercased set membership).
- `scripts/action-pins.mjs:16` (`--workflows`), `:17-18` (the list is read from the base checkout), `:19` (`--allowlist` defaults to the base copy), `:22` (the only read of the list).
- `.github/workflows/ci.yml:546-553` (the base checkout, and the comment that the gate's code comes from the base), `:559` (the run line, and no caller passing `--allowlist`), `:3-13` (pull request, push to `main`, and the nightly schedule that runs the suite).
- `.github/agent/action-allowlist.json:2-13` — ten names today; the key does not exist anywhere in the pinned tree.
- Measured: `#1206` body `a38f35d41127` (3,763 bytes), Gate Security's first pass comment `7067735330` (`Date: Sat, 21 Nov 2026 19:04:05Z`), Dev-1's reproduction comment `7067263694`, the seat's review PASS `7067505308` at that body.
- Number and duplicate check, read at `Date: Sat, 21 Nov 2026 19:11:33 GMT`: `docs/decisions/` at `044c7515` holds 29 files and stops at `0026-merge-press-actor-role.md`, so `0027` is free; no open issue, pull request or branch claims this number or this decision, and the only matches for `approved_unused` are `#1206`, `#1208` and closed `#787`.
