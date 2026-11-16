import test from 'node:test'
import assert from 'node:assert/strict'

import { plan, resolveTarget } from '../scripts/lib/release-tag.mjs'

// #866: a release has two independent write moments, the tag and the publish run
// dispatched at it. The tag job answered `skip` as soon as the tag existed, so a
// dispatch that failed after the tag was created could never be retried — the
// tag was there, every later run skipped, and no GitHub Release, image or SBOM
// was ever produced. These tests pin the decision table: create when the tag is
// missing, publish when the tag exists without its release, and nothing when
// both exist.

const SHA = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)

function releasePr(overrides: Record<string, unknown> = {}) {
  return {
    number: 41,
    title: 'release: v0.3.2',
    merged_at: '2026-11-15T00:00:00Z',
    merge_commit_sha: SHA,
    head: { ref: 'release/v0.3.2' },
    ...overrides,
  }
}

function decide(overrides: Record<string, unknown> = {}) {
  return plan({
    pulls: [releasePr()],
    tags: [],
    release: null,
    packageVersion: '0.3.2',
    sha: SHA,
    ...overrides,
  })
}

test('a missing tag is created on the squash commit of the merged release pull request', () => {
  const result = decide()
  assert.equal(result.action, 'create')
  assert.equal(result.tag, 'v0.3.2')
  assert.equal(result.sha, SHA)
  assert.match(result.reason, /squash commit/)
})

test('a tag that exists without its GitHub Release dispatches the publish run', () => {
  const result = decide({ tags: ['v0.3.2'] })
  assert.equal(result.action, 'publish', 'the half-made release is finished, not skipped')
  assert.equal(result.tag, 'v0.3.2')
  assert.equal(result.sha, SHA)
  assert.match(result.reason, /GitHub Release/)
  assert.equal(/create/.test(result.action), false, 'publish never writes a second tag')
})

test('a tag that already has its release is a no-op, so a second run cannot publish twice', () => {
  const result = decide({ tags: ['v0.3.2'], release: { tag_name: 'v0.3.2', draft: false } })
  assert.equal(result.action, 'skip')
  assert.match(result.reason, /both exist/)
})

test('the identity check gates the publish path, so an ordinary push cannot re-dispatch a release', () => {
  // A push that is not the release merge — here the squash sha differs — must not
  // act on a tag that happens to exist, even though its package.json version is
  // the released one.
  const result = plan({
    pulls: [releasePr({ merge_commit_sha: OTHER })],
    tags: ['v0.3.2'],
    release: null,
    packageVersion: '0.3.2',
    sha: SHA,
  })
  assert.equal(result.action, 'skip')
  assert.match(result.reason, /not the squash commit/)
})

test('a tag ref in its full refs/tags form still counts as the existing tag', () => {
  const result = decide({ tags: ['refs/tags/v0.3.2'] })
  assert.equal(result.action, 'publish')
})

test('the ambiguous shapes are refused instead of guessed', () => {
  assert.equal(decide({ sha: 'a'.repeat(7) }).action, 'skip', 'a short sha is never resolved')
  assert.equal(decide({ packageVersion: '' }).action, 'skip', 'no version is no tag name')
  assert.equal(decide({ pulls: null }).action, 'skip', 'no pull request list is no identity')
  assert.equal(decide({ pulls: [releasePr({ merged_at: null })] }).action, 'skip', 'an unmerged pull request is not a release')
  assert.equal(decide({ pulls: [releasePr({ head: { ref: 'feature/x' } })] }).action, 'skip', 'a branch that is not release/v<version> is not the release')
  assert.equal(decide({ pulls: [releasePr(), releasePr({ number: 42 })] }).action, 'skip', 'two claimants are not resolved by picking one')
})

test('the publish path needs the tag to exist, and the create path needs it to be absent', () => {
  for (const tags of [[], ['v0.3.1'], ['refs/tags/v0.3.1']]) {
    assert.equal(decide({ tags }).action, 'create', `no v0.3.2 in ${JSON.stringify(tags)} means create`)
  }
  assert.equal(decide({ tags: ['v0.3.2'] }).action, 'publish')
  assert.equal(decide({ tags: ['v0.3.2'], release: { tag_name: 'v0.3.2' } }).action, 'skip')
})

// #866, the scheduled half: on `schedule` the event's commit is `main`'s tip,
// and the identity check in `plan()` requires the release pull request's squash
// commit. Once any merge lands after the release merge, those are different
// commits, so a scheduled run could never repair the release it names — the
// nightly answered `skip` forever. `resolveTarget` names the commit the tag job
// is allowed to act on: the event's own commit on a push, the merged release
// pull request's merge commit on a schedule.
test('a push keeps the event commit, and a schedule resolves the release merge', () => {
  const TIP = 'c'.repeat(40)
  const MERGE = 'd'.repeat(40)
  const releasePrs = [{ number: 88, title: 'release: v0.3.2', mergeCommit: { oid: MERGE }, headRefName: 'release/v0.3.2' }]

  const push = resolveTarget({ eventName: 'push', sha: TIP, version: '0.3.2', releasePrs })
  assert.deepEqual({ sha: push.sha, source: push.source }, { sha: TIP, source: 'event' }, 'a push acts on the commit that was pushed')

  const schedule = resolveTarget({ eventName: 'schedule', sha: TIP, version: '0.3.2', releasePrs })
  assert.equal(schedule.sha, MERGE, 'the scheduled run acts on the release merge, not on the tip main has moved to')
  assert.equal(schedule.source, 'release-merge')
  assert.match(schedule.reason, /#88/, 'the reason names the pull request it resolved')

  // Main moved on by one commit, the tag exists, the release does not: this is
  // exactly the half-made release the scheduled slot is meant to finish, and the
  // resolved target is what lets `plan()` reach it.
  const planned = plan({
    pulls: [releasePr({ merge_commit_sha: MERGE })],
    tags: ['v0.3.2'],
    release: null,
    packageVersion: '0.3.2',
    sha: schedule.sha,
  })
  assert.equal(planned.action, 'publish', 'main has moved on, and the scheduled run still finds that release pull request\'s merge sha')
})

test('a schedule that cannot name exactly one release pull request keeps the tip, so the plan refuses it', () => {
  const TIP = 'c'.repeat(40)
  const MERGE = 'd'.repeat(40)
  const cases: Array<[string, unknown]> = [
    ['no list', null],
    ['empty list', []],
    ['another version', [{ title: 'release: v0.3.1', mergeCommit: { oid: MERGE } }]],
    ['two claimants', [
      { title: 'release: v0.3.2', mergeCommit: { oid: MERGE } },
      { title: 'release: v0.3.2', mergeCommit: { oid: 'e'.repeat(40) } },
    ]],
    ['no merge commit', [{ title: 'release: v0.3.2', mergeCommit: {} }]],
    ['a short merge commit', [{ title: 'release: v0.3.2', mergeCommit: { oid: 'abcdef' } }]],
  ]
  for (const [label, releasePrs] of cases) {
    const target = resolveTarget({ eventName: 'schedule', sha: TIP, version: '0.3.2', releasePrs: releasePrs as never })
    assert.equal(target.sha, TIP, `${label}: an unresolvable target stays the tip`)
    assert.equal(target.source, 'event', label)
  }
  assert.equal(resolveTarget({ eventName: 'schedule', sha: TIP, version: '', releasePrs: [] }).sha, TIP, 'no version is no release to resolve')
})

test('the fix does not loosen the identity check: a moved-on tip is still refused', () => {
  const TIP = 'c'.repeat(40)
  const MERGE = 'd'.repeat(40)
  const planned = plan({ pulls: [releasePr({ merge_commit_sha: MERGE })], tags: ['v0.3.2'], release: null, packageVersion: '0.3.2', sha: TIP })
  assert.equal(planned.action, 'skip', 'the tip of a main that moved on is still not the release merge')
  assert.match(String(planned.reason), /not the squash commit/)
})
