import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Issue #648, as a decision with a test per refusal: a `v*` tag is a published
// name, and anything that publishes from it must be able to say which identity
// produced that name and what it points at. The tag object is read from the
// checkout, so its shape is checked offline; the one API read is the release
// pull request behind the commit, which is what separates the routine's tag
// from a name someone with write access chose.
//
// The other half of the card — a `creation` rule on the `v*` ruleset — is
// repository state and cannot be made true by a commit, so it is recorded in
// docs/deploy.md and asserted here only as a documented constant.

import { OWNER_TAGGERS, ROUTINE_TAGGERS, verifyTagProvenance } from '../scripts/lib/tag-provenance.mjs'

const COMMIT = 'aa83dc0b407fb1d9da116663ec4b199734c25ba8'
const OTHER = '9ee9afa5b8d5b6d978a858dbafea1e829ed65e9f'

// The real v0.3.6 shape: an annotated object created by the tag job, pointing at
// the one-parent squash commit of the merged release pull request.
const releasePull = {
  number: 712,
  title: 'release: v0.3.6',
  merged_at: '2026-11-14T20:17:17Z',
  merge_commit_sha: COMMIT,
}

const routineTag = {
  tag: 'v0.3.6',
  objectType: 'tag',
  tagger: 'github-actions[bot]',
  onMain: true,
  commit: COMMIT,
  pulls: [releasePull],
}

// The allowlist is the security surface of this check: a name added here can
// publish a tag. Pinned exactly, so widening it is a visible diff a reviewer has
// to accept, not an edit that slips through beside a behaviour change.
test('the identities allowed to publish a tag are pinned', () => {
  assert.deepEqual([...ROUTINE_TAGGERS], ['github-actions[bot]'])
  assert.deepEqual([...OWNER_TAGGERS], ['HugoXK', 'Day Dreamer'])
})

test('the release routine tag is accepted when its pull request produced the commit', () => {
  const result = verifyTagProvenance(routineTag)
  assert.equal(result.ok, true)
  assert.equal(result.identity, 'routine')
  assert.match(result.reason, /v0\.3\.6/)
  assert.match(result.reason, /#712/)
})

// #0.2.x was tagged by hand before the routine existed. Those tags are still
// re-published on purpose after a bad image, so the documented owner identities
// stay allowed — without a pull request, because there was not one.
test('a documented owner identity is accepted without a release pull request', () => {
  for (const tagger of OWNER_TAGGERS) {
    const result = verifyTagProvenance({ ...routineTag, tagger, pulls: [] })
    assert.equal(result.ok, true, `${tagger} must still be able to publish a tag it made`)
    assert.equal(result.identity, 'owner')
    assert.match(result.reason, new RegExp(tagger))
  }
})

test('a lightweight tag is refused: it carries no tagger and no message to read', () => {
  const result = verifyTagProvenance({ ...routineTag, objectType: 'commit' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /lightweight/)
})

test('a missing or unreadable tag object is refused rather than assumed annotated', () => {
  for (const objectType of [undefined, '', 'blob']) {
    const result = verifyTagProvenance({ ...routineTag, objectType })
    assert.equal(result.ok, false, `objectType ${String(objectType)} must not pass`)
  }
})

test('a name that is not a vX.Y.Z version tag is refused', () => {
  for (const tag of ['release-2026', 'v0.3', 'v0.3.6-rc1', 'latest', '']) {
    const result = verifyTagProvenance({ ...routineTag, tag })
    assert.equal(result.ok, false, `${tag} must not pass as a version tag`)
    assert.equal(result.identity, null)
  }
})

test('a tag that does not point at a commit on main is refused', () => {
  const notOnMain: Array<boolean | undefined> = [false, undefined]
  for (const onMain of notOnMain) {
    const result = verifyTagProvenance({ ...routineTag, onMain })
    assert.equal(result.ok, false, `onMain ${String(onMain)} must not pass`)
    assert.match(result.reason, /main/)
  }
})

test('an identity that is neither the routine nor a documented owner is refused', () => {
  const result = verifyTagProvenance({ ...routineTag, tagger: 'someone-with-push-access' })
  assert.equal(result.ok, false)
  assert.equal(result.identity, null)
  assert.match(result.reason, /someone-with-push-access/)
  assert.match(result.reason, /owner identity/)
})

test('an empty tagger is refused: an annotated tag always names one', () => {
  const result = verifyTagProvenance({ ...routineTag, tagger: '   ' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /no tagger/)
})

test('a routine tag needs the merged release pull request for its own version', () => {
  const absent = verifyTagProvenance({ ...routineTag, pulls: [] })
  assert.equal(absent.ok, false)
  assert.match(absent.reason, /release: v0\.3\.6/)

  const wrongVersion = verifyTagProvenance({
    ...routineTag,
    pulls: [{ ...releasePull, title: 'release: v0.3.5' }],
  })
  assert.equal(wrongVersion.ok, false, 'a pull request for another version does not describe this tag')

  const unmerged = verifyTagProvenance({
    ...routineTag,
    pulls: [{ ...releasePull, merged_at: null }],
  })
  assert.equal(unmerged.ok, false)
  assert.match(unmerged.reason, /not merged/)

  const otherCommit = verifyTagProvenance({
    ...routineTag,
    pulls: [{ ...releasePull, merge_commit_sha: OTHER }],
  })
  assert.equal(otherCommit.ok, false)
  assert.match(otherCommit.reason, /not at the squash commit/)
})

// Two merged pull requests with the same release title is exactly the state the
// tag planner refuses to choose from; publishing from a tag would pick one by
// accident, so it is refused for the same reason.
test('two pull requests claiming the same release are refused, not chosen between', () => {
  const result = verifyTagProvenance({ ...routineTag, pulls: [releasePull, { ...releasePull, number: 713 }] })
  assert.equal(result.ok, false)
  assert.match(result.reason, /2 pull requests/)
})

test('a short or non-hex commit is refused instead of resolved', () => {
  for (const commit of ['aa83dc0', '', 'not-a-sha']) {
    const result = verifyTagProvenance({ ...routineTag, commit })
    assert.equal(result.ok, false, `commit ${commit} must not pass`)
  }
})

test('nothing is accepted from a missing argument list', () => {
  assert.equal(verifyTagProvenance().ok, false)
  assert.equal(verifyTagProvenance({}).ok, false)
})

// The decision is only half of it: the workflow has to run it, and it must keep
// the ancestor check and stay read-only with respect to tags.
const release = readFileSync('.github/workflows/release.yml', 'utf8')

test('release.yml verifies provenance before it builds, using this module', () => {
  assert.match(release, /- name: Verify the tag's provenance/)
  assert.match(release, /scripts\/lib\/tag-provenance\.mjs/)
  assert.match(release, /git cat-file -t "refs\/tags\/\$\{RELEASE_TAG\}"/)
  assert.match(release, /git for-each-ref --format='%\(taggername\)' "refs\/tags\/\$\{RELEASE_TAG\}"/)
  assert.match(release, /commits\/\$\{TAG_COMMIT\}\/pulls/)
  // The ancestor check survives the rewrite: provenance does not replace it.
  assert.match(release, /git merge-base --is-ancestor "refs\/tags\/\$\{RELEASE_TAG\}" origin\/main/)
  // Read-only on tags: the tag write lives in the tag job, never here.
  assert.equal(/git\/tags/.test(release), false)
  assert.equal(/git\/refs/.test(release), false)
  assert.equal(/--method POST|-X POST/.test(release), false)
})

test('the build job declares the pull-requests scope the provenance read needs', () => {
  // #861 split the release run in two: the read-only `build` job keeps the
  // checkout and runs the provenance read, and the writing `release` job never
  // checks anything out. The read therefore keeps its scope here, and the write
  // scopes stay on the job that publishes.
  const build = release.slice(release.indexOf('\n  build:\n'), release.indexOf('\n  release:\n'))
  assert.match(build, /^ {6}pull-requests: read$/m, 'the build job must be able to read the pull request behind the tag')
  assert.match(build, /^ {6}contents: read$/m, 'the provenance read needs no write scope of its own')
  const publish = release.slice(release.indexOf('\n  release:\n'))
  assert.match(publish, /^ {6}contents: write$/m, 'the publish scopes must not be dropped while adding one')
  assert.match(publish, /^ {6}packages: write$/m)
})

test('the provenance step runs before the image is built', () => {
  const step = release.indexOf("- name: Verify the tag's provenance")
  const build = release.indexOf('- name: Build the image')
  assert.ok(step !== -1 && build !== -1)
  assert.ok(step < build, 'a refused tag must stop the run before anything is built')
})
