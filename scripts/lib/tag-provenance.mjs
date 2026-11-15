// Decide whether a release tag may publish (issue #648).
//
// Pure: no clock, no network, no repository. The release workflow reads the tag
// object's shape from the checkout it already fetched and makes one API call for
// the release pull request behind the tag's commit; this function decides
// whether that shape is one this repository's routine can have produced.
//
// What made the tag *allowed to exist* is a `creation` rule on the `v*` ruleset
// with a bypass for the release actor. That is repository state, so it cannot be
// made true from a commit; docs/deploy.md records it as the owner action, and
// this check is the half a commit can carry. Refusing here does not undo a tag —
// it refuses to publish from one.

// One capture, so the version is the whole match and not just the major: a
// three-group shape here would compare "0" against "0.3.6" and refuse every tag.
const VERSION_TAG = /^v(\d+\.\d+\.\d+)$/
const SHA = /^[0-9a-f]{40}$/
const RELEASE_PR_TITLE = /^release: v(\d+\.\d+\.\d+)$/

// The identities a release tag may carry. `github-actions[bot]` is the token the
// tag job writes with. The two human names are the documented owner identities
// that produced `v0.2.x` before the routine existed, and they stay allowed
// because re-publishing such a tag is a real recovery step.
//
// A tagger is git text, not an authentication claim: anyone can write a name
// into a tag object. The list is checked because, together with the ruleset
// bypass, it records which identity produced a tag that exists. The load-bearing
// refusal for a forged name is the ruleset, not this list.
export const ROUTINE_TAGGERS = ['github-actions[bot]']
export const OWNER_TAGGERS = ['HugoXK', 'Day Dreamer']

function refuse(reason) {
  return { ok: false, identity: null, reason }
}

// The routine's tag names its own release pull request, so the commit it points
// at must be the one that pull request merged. That is the check a forged tagger
// name cannot produce without also merging a pull request titled for the version.
function releasePullOf(pulls, version, commit, tag) {
  const named = (Array.isArray(pulls) ? pulls : []).filter(
    (pull) => RELEASE_PR_TITLE.exec(String(pull?.title ?? ''))?.[1] === version,
  )
  if (named.length === 0) {
    return refuse(`no pull request titled release: ${tag} is behind ${commit}; the routine's tag names its own release pull request`)
  }
  if (named.length > 1) {
    return refuse(`${String(named.length)} pull requests claim release: ${tag}; not choosing which one this tag came from`)
  }
  const pull = named[0]
  const number = String(pull?.number ?? '?')
  if (Number.isNaN(Date.parse(String(pull?.merged_at ?? '')))) {
    return refuse(`pull request #${number} titled release: ${tag} is not merged`)
  }
  const squash = String(pull?.merge_commit_sha ?? '')
  if (squash !== commit) {
    return refuse(`${tag} points at ${commit}, not at the squash commit of pull request #${number}`)
  }
  return { ok: true, identity: 'routine', reason: `${tag} is the annotated tag the routine created on the squash commit of the merged release pull request #${number}` }
}

export function verifyTagProvenance({ tag, objectType, tagger, onMain, commit, pulls } = {}) {
  const name = String(tag ?? '')
  const version = VERSION_TAG.exec(name)?.[1]
  if (version === undefined) {
    return refuse(`"${name}" is not a vX.Y.Z tag; a release tag is the only name this check can verify`)
  }
  const kind = String(objectType ?? '').trim()
  if (kind !== 'tag') {
    return refuse(`${name} is ${kind === 'commit' ? 'a lightweight tag' : 'not an annotated tag object'}; only an annotated tag carries the tagger that records who created it`)
  }
  if (onMain !== true) {
    return refuse(`${name} does not point at a commit on main; a tag off the release line would publish a commit nobody reviewed`)
  }
  const sha = String(commit ?? '')
  if (!SHA.test(sha)) {
    return refuse(`"${sha}" is not a 40-character commit sha; a short sha is refused, never resolved`)
  }
  const who = String(tagger ?? '').trim()
  if (who === '') {
    return refuse(`${name} carries no tagger; an annotated tag always names one, so an empty field means the object could not be read`)
  }
  if (OWNER_TAGGERS.includes(who)) {
    return { ok: true, identity: 'owner', reason: `${name} was tagged by the documented owner identity ${who}` }
  }
  if (!ROUTINE_TAGGERS.includes(who)) {
    return refuse(`${name} was created by "${who}", which is neither the release routine nor a documented owner identity`)
  }
  return releasePullOf(pulls, version, sha, name)
}
