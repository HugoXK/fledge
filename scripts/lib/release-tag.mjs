// Recognise the merged release pull request behind a push to `main` (issue #80).
//
// Pure: no clock, no network, no repository. The tag job collects two API
// payloads — `GET /commits/{sha}/pulls` and `GET /git/matching-refs/tags/v` — and
// this function decides whether that push is the squash of the mechanical release
// pull request and whether the tag for it is still missing. Anything ambiguous
// returns `skip` with a reason: a tag is a published name, so not tagging is the
// recoverable mistake and guessing is not.

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

export function plan({ pulls, tags, packageVersion, sha } = {}) {
  const commit = String(sha ?? '')
  if (!COMMIT.test(commit)) {
    return skip(null, commit, `"${commit}" is not a 40-character sha; a short sha is refused, never resolved`)
  }
  const version = String(packageVersion ?? '')
  if (!VERSION.test(version)) {
    return skip(null, commit, `package.json at ${commit} has no readable version; refusing to guess the tag name`)
  }
  const tag = `v${version}`
  const existing = (Array.isArray(tags) ? tags : []).map(tagName)
  if (existing.includes(tag)) return skip(tag, commit, `${tag} already exists; a tag is created once`)

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

  return {
    tag,
    sha: commit,
    action: 'create',
    reason: `tag ${tag} on the squash commit ${commit} of the merged release pull request #${String(number)}`,
  }
}
