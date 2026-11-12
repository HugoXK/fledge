# Changelog fragments

One file per user-visible change, so two PRs never edit the same lines of
`CHANGELOG.md`.

Name: `changelog.d/<issue-or-slug>.<kind>.md`, with `kind` one of `added`,
`changed`, `deprecated`, `removed`, `fixed`, `security`.

Example: `changelog.d/12-quota-402.fixed.md`.

Content: the entry text only, as one paragraph, with no leading `- ` and no
heading. The release adds the bullet and the `### Fixed` heading.

```sh
node scripts/changelog.mjs check     # CI runs this
node scripts/changelog.mjs preview   # what the fragments will add
```

A change users cannot see needs no fragment. Never edit `CHANGELOG.md` in a
feature PR; the release routine does it.
