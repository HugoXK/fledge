// Recognise the merged release pull request behind a push to `main` (issue #80),
// and finish the release when only half of it was made (#866).
//
// Pure: no clock, no network, no repository. The tag job collects the API
// payloads — `GET /commits/{sha}/pulls`, `GET /git/matching-refs/tags/v` and the
// GitHub Release for `v<package.json version>` — and this function decides
// whether the commit is the squash of the mechanical release pull request and
// which write, if any, is still owed.
//
// A release has two independent write moments: the tag, and the publish run
// dispatched at it. The tag job used to stop at "the tag exists", so a dispatch
// that failed after the tag was created could never be retried — the tag was
// there, every later run answered `skip`, and no GitHub Release, image or SBOM
// was ever produced. The decisions below keep the two apart:
//
//   create   the tag is missing: create it on the squash commit
//   publish  the tag exists but its GitHub Release does not: dispatch the
//            publish run at the existing tag, and write no tag
//   skip     nothing is owed, or the commit is not the release merge, or a fact
//            needed to act is unreadable
//
// Anything ambiguous returns `skip` with a reason: a tag is a published name, so
// not tagging is the recoverable mistake and guessing is not.

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/
const COMMIT = /^[0-9a-f]{40}$/
const RELEASE_PR_TITLE = /^release: v(\d+\.\d+\.\d+)$/
const RELEASE_PR_BRANCH = /^release\/v(\d+\.\d+\.\d+)$/

function skip(tag, sha, reason) {
  return { tag: tag ?? null, sha: sha === '' ? null : sha, action: 'skip', reason }
}

function tagName(value) {
  return String(value ?? '').replace(/^refs\/tags\//, '')
}

// `GET /commits/{sha}/pulls` returns the pull requests associated with a commit,
// including the one whose squash produced it. `merged_at` is what separates a
// merged release from an open pull request that merely carries the title.
function releasePrOf(pulls, version) {
  if (!Array.isArray(pulls)) return { kind: 'none', reason: `no pull request list for ${version}` }
  const candidates = pulls.filter((pr) => RELEASE_PR_TITLE.exec(String(pr?.title ?? ''))?.[1] === version)
  if (candidates.length === 0) return { kind: 'none', reason: `no merged pull request titled release: v${version}` }
  if (candidates.length > 1) {
    return { kind: 'many', reason: `${String(candidates.length)} pull requests claim release: v${version}; not choosing one` }
  }
  return { kind: 'one', pr: candidates[0] }
}

// #866, the scheduled half: on `schedule` the event's commit is `main`'s tip,
// and `plan()` below requires that commit to be the release pull request's squash
// commit. A merge that lands after the release merge makes the tip a different
// commit, so a scheduled run judged the tip, answered `skip`, and the half-made
// release stayed half-made for as long as main kept moving. The commit the tag
// job is allowed to act on is the merged release pull request's merge commit, and
// that is what a scheduled run resolves. A push keeps the commit that was pushed:
// that push is the release merge itself, and resolving anything else there would
// let a later push act on an older release.
//
// Every unresolvable shape keeps the event's commit, so the identity check in
// `plan()` refuses it with its own reason instead of this function choosing a
// commit to act on.
export function resolveTarget({ eventName, sha, version, releasePrs } = {}) {
  const commit = String(sha ?? '')
  if (eventName !== 'schedule') {
    return { sha: commit, source: 'event', reason: `the ${String(eventName ?? 'push')} event's commit ${commit}` }
  }
  const name = String(version ?? '')
  if (!VERSION.test(name)) {
    return { sha: commit, source: 'event', reason: `no readable version, so no release pull request to resolve; the target stays ${commit}` }
  }
  const wanted = `release: v${name}`
  const candidates = (Array.isArray(releasePrs) ? releasePrs : []).filter((pr) => String(pr?.title ?? '') === wanted)
  if (candidates.length !== 1) {
    return {
      sha: commit,
      source: 'event',
      reason: `no single merged pull request titled ${wanted} (${String(candidates.length)} found); the target stays ${commit}`,
    }
  }
  const pr = candidates[0]
  const merge = String(pr?.mergeCommit?.oid ?? pr?.merge_commit_sha ?? '')
  if (!COMMIT.test(merge)) {
    return { sha: commit, source: 'event', reason: `pull request #${String(Number(pr?.number ?? 0))} has no readable merge commit; the target stays ${commit}` }
  }
  return {
    sha: merge,
    source: 'release-merge',
    reason: `the merged pull request #${String(Number(pr?.number ?? 0))} (${wanted}) produced ${merge}`,
  }
}

export function plan({ pulls, tags, release, packageVersion, sha } = {}) {
  const commit = String(sha ?? '')
  if (!COMMIT.test(commit)) {
    return skip(null, commit, `"${commit}" is not a 40-character sha; a short sha is refused, never resolved`)
  }
  const version = String(packageVersion ?? '')
  if (!VERSION.test(version)) {
    return skip(null, commit, `package.json at ${commit} has no readable version; refusing to guess the tag name`)
  }
  const tag = `v${version}`

  // The identity comes first, and it gates both writes: only the squash of the
  // mechanical release pull request may create a tag, and only it may re-dispatch
  // a publish run. A later ordinary push to `main` that happens to match the
  // paths filter is not the release merge, so it cannot act on the same tag.
  const found = releasePrOf(pulls, version)
  if (found.kind !== 'one') return skip(tag, commit, found.reason)
  const pr = found.pr
  const number = Number(pr?.number ?? 0)

  const mergedAt = Date.parse(String(pr?.merged_at ?? ''))
  if (Number.isNaN(mergedAt)) return skip(tag, commit, `pull request #${String(number)} titled release: ${tag} is not merged`)

  const squash = String(pr?.merge_commit_sha ?? '')
  if (squash === '') return skip(tag, commit, `pull request #${String(number)} has no merge commit sha; not tagging a guess`)
  if (squash !== commit) {
    return skip(tag, commit, `${commit} is not the squash commit of pull request #${String(number)} (${squash})`)
  }

  const branch = String(pr?.head?.ref ?? '')
  const branchMatch = RELEASE_PR_BRANCH.exec(branch)
  if (branchMatch === null || branchMatch[1] !== version) {
    return skip(tag, commit, `pull request #${String(number)} does not come from release/v${version} (${branch === '' ? 'no branch' : branch})`)
  }

  const existing = (Array.isArray(tags) ? tags : []).map(tagName)
  if (existing.includes(tag)) {
    // The half-made release (#866): the tag is written, the publish run is not.
    // A GitHub Release carrying this tag means the chain completed, and a second
    // dispatch would publish twice.
    const published = String(release?.tag_name ?? release?.tag ?? '') === tag
    if (published) return skip(tag, commit, `${tag} and its GitHub Release both exist; nothing to publish`)
    return {
      tag,
      sha: commit,
      action: 'publish',
      reason: `tag ${tag} exists on ${commit} but its GitHub Release does not; dispatching the publish run at the tag`,
    }
  }

  return {
    tag,
    sha: commit,
    action: 'create',
    reason: `tag ${tag} on the squash commit ${commit} of the merged release pull request #${String(number)}`,
  }
}
