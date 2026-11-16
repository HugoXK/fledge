// One answer for the one fact the publish job asks about an image tag: may this
// run move `ghcr.io/<repo>:vX.Y.Z`? (#883)
//
// The version tag is a name a release body and a deploy record point at, so it
// is an alias of a digest rather than an identity of its own. A redispatch that
// re-pushes the same tag with different content silently repoints every record
// that named it — which is what "the tag moved and nobody wrote a release"
// looks like from the outside. The digest is the identity; the alias is created
// once and compared afterwards.
//
// `docker buildx imagetools inspect` is the read. It exits non-zero for "no such
// manifest" and for a dead registry alike, so the exit status alone cannot say
// whether the alias is absent or unreadable; the message is classified instead,
// the way `scripts/lib/release-lookup.mjs` classifies the release lookup:
//
//   same    the alias already names this digest — nothing to write;
//   create  the alias is absent (manifest unknown) — it may be created;
//   refuse  the alias names another digest, or the read is unreadable — the
//           caller must stop rather than overwrite a published name.
export const ALIAS_SAME = 'same'
export const ALIAS_CREATE = 'create'
export const ALIAS_REFUSE = 'refuse'

const ABSENT = /manifest unknown|not found|no such manifest|name unknown/i

export function classifyAlias({ status, existing = '', digest = '' } = {}) {
  if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    return { action: ALIAS_REFUSE, reason: 'the digest this run published is not a sha256 digest' }
  }
  if (status === 0) {
    if (existing === digest) {
      return { action: ALIAS_SAME, reason: `the alias already names ${digest}` }
    }
    return {
      action: ALIAS_REFUSE,
      reason: `the alias already names ${existing === '' ? 'an unreadable digest' : existing}; repointing it would change what every record that named it points at`,
    }
  }
  if (ABSENT.test(String(existing))) {
    // `existing` carries the inspect message on a non-zero exit: the read failed
    // and the message is the only part that says why.
    return { action: ALIAS_CREATE, reason: 'the alias is absent; this run may create it' }
  }
  return {
    action: ALIAS_REFUSE,
    reason: `the alias read failed (exit ${typeof status === 'number' ? String(status) : 'none'}) without a "manifest unknown" answer; an unreadable alias is not an absent one`,
  }
}
