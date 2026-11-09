// The mechanical daily minor release (#80), keyed on identity, never on the file
// set alone.
//
// A PR that only touches CHANGELOG.md, changelog.d/, package.json,
// package-lock.json and docker-compose.yml is not automatically safe: without the
// branch and title key, any PR could claim that shape and merge on a green ci-ok
// with no PASS, which would remove the package.json T3 gate from the repository.
// So all of the following must hold, and the identity is checked first:
//
//   (a) the head branch is release/v<next>
//   (b) the title is exactly "release: v<next>" for the same <next>
//   (c) every changed path is inside the mechanical set
//
// The fourth condition (the version/changelog consistency check) is
// `node scripts/version.mjs check` and `node scripts/changelog.mjs check`, which
// pr-lint runs separately; a caller that skips them must not treat the identity
// alone as a pass.

export const MECHANICAL_PATHS = ['CHANGELOG.md', 'changelog.d/', 'package.json', 'package-lock.json', 'docker-compose.yml']

const RELEASE_TITLE = /^release: v(\d+\.\d+\.\d+)$/
const RELEASE_BRANCH = /^release\/v(\d+\.\d+\.\d+)$/

export function releaseIdentity({ branch, title } = {}) {
  const titleMatch = RELEASE_TITLE.exec(String(title ?? ''))
  if (titleMatch === null) return null
  const branchMatch = RELEASE_BRANCH.exec(String(branch ?? '').replace(/^refs\/heads\//, ''))
  if (branchMatch === null || branchMatch[1] !== titleMatch[1]) return null
  return { version: titleMatch[1] }
}

const FRAGMENT = /^([a-z0-9][a-z0-9._-]*)\.(added|changed|deprecated|removed|fixed|security)\.md$/

export function isMechanicalPath(path) {
  const value = String(path ?? '')
  // changelog.d/ carries fragments and its README only: the directory is not a
  // blanket allowance, so a stray file there cannot ride along on a release.
  if (value.startsWith('changelog.d/')) {
    const rest = value.slice('changelog.d/'.length)
    return rest === 'README.md' || FRAGMENT.test(rest)
  }
  return MECHANICAL_PATHS.some((allowed) => !allowed.endsWith('/') && value === allowed)
}

export function mechanicalRelease({ branch, title, files } = {}) {
  const identity = releaseIdentity({ branch, title })
  if (identity === null) {
    return { mechanical: false, version: '', reason: 'not a release/vX.Y.Z branch with a "release: vX.Y.Z" title' }
  }
  const outside = (Array.isArray(files) ? files : []).map(String).filter((path) => !isMechanicalPath(path))
  if (outside.length > 0) {
    const shown = outside.slice(0, 5).join(', ')
    return { mechanical: false, version: identity.version, reason: `${String(outside.length)} path(s) outside the mechanical set: ${shown}` }
  }
  return { mechanical: true, version: identity.version, reason: `mechanical release v${identity.version}` }
}
