# 0021 — a tag's target is re-resolved at write time

Status: **accepted** (2026-11-15)
Date: 2026-11-15
Supersedes: nothing; it fixes where the target commit of a tag written from the
readiness page comes from

## Context

`#546` slice 1 made the release-readiness view a read: it answers whether a
release would go ahead on the default branch, and then makes the maintainer
leave it. The only way to act on that answer is `POST /repos/:id/release`, which
takes a version and a hand-typed full SHA and never looks at the branch again.
The SHA is whatever was pasted, and `main` may have moved since the page was
read. A tag is never moved or deleted, so a wrong target costs a version instead
of a retry.

Slice 2 adds the first write to the readiness page, and the question this record
answers is: what commit does that tag point at, and who decides it?

## Decision

The tag is created for the default branch head **re-read at write time**. The
SHA the page rendered is a precondition, not the target.

- The readiness form carries the full head it rendered and the version the
  maintainer confirmed. It is rendered only when the readiness answer is ready
  and a head was read; a blocked repository renders no form.
- `POST /repos/:id/release-readiness/tag` validates the carried head, requires an
  explicit confirm, and reads the default branch **now**, immediately before the
  write.
- A head that is not the one the form carried is a refusal, not a tag: named
  `branch_moved`, both commits named, nothing written, and the maintainer told
  to re-read the page and confirm the new head.
- Only a matching head reaches the shared `releasePreflight` and
  `createAnnotatedTag`, then one `repo_releases` row and one `release.tagged`
  audit row. The route cannot create a Release object or draft notes; that is
  slice 3.
- A tag that already exists is refused in `planRelease`'s own words, and a 403
  or 404 on the ref write is a named scope refusal that says the installation
  needs `Contents: write` — a 404 names both possible causes rather than
  asserting one it cannot observe. No upstream response body reaches the page.

## Rejected alternative

**Tag the SHA the operator typed (or the one the page rendered) and warn
afterwards.** This is the smallest route and it is what the existing release
form does. It is rejected because a tag is never moved or deleted: a wrong target
costs a version, not a retry, and a warning after the write cannot undo it. A
stale head is also indistinguishable from a deliberate one once the tag exists,
so the record would claim a tree nobody confirmed on that page.

## Cost

- A page the operator left open across a push gets a refusal instead of a tag:
  no write, a re-read, and a second confirmation. That is the price of the
  guarantee, and it is paid exactly in the case the guarantee exists for.
- `branch_moved` is now a refusal class every future tag caller must honour.
  Any new path that writes a tag has to re-resolve the default branch first and
  refuse when it moved, or it reintroduces the defect this slice removes.
- One extra GitHub read (the branch) in front of every tag creation. The page's
  own read is not reused, because it is minutes old by submit time.
- The race is narrowed, not closed: a commit that lands between the re-read and
  the ref write leaves the tag on the commit that was the head when it was
  verified — the SHA the page names — so the record stays true; the route
  refuses when it can see the move and does not claim to make the write atomic.
- The two new sentences live in `releaseRefusals`, and the suite asserts the
  rendered text is **equal** to `releaseRefusals.branchMoved(...)`, so an
  inlined copy fails instead of drifting from the shared table.
- Rollback is one commit: the route, the form, the two sentences and the `status`
  field go, and the existing release route returns to the generic refusal
  sentence.
