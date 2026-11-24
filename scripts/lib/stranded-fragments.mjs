// #1207: a release's notes are assembled once, when the release pull request is
// built — `scripts/changelog.mjs release` folds every fragment it can see and
// deletes them — and nothing reads `changelog.d/` again before the tag is
// written. So every change merged into `main` while that pull request waited is
// carried by the tag and missing from the notes that tag publishes, and its
// fragment is left in the tree to be folded into a later release as though it
// had shipped then. v0.4.5 shipped three changes that way.
//
// The publish run checks out the tag, so a fragment still present in
// `changelog.d/` there is by construction a change this release carries and its
// notes were assembled too early to name. This module is the one place that
// turns that set into the text the notes gain, so the workflow, the tests and
// the #80 line cannot describe the same change differently.

import { foldFragmentBody } from './changelog-fragments.mjs'

export const STRANDED_HEADING = '## Changes that merged after these notes were assembled'

/**
 * The section a release's notes gain for the fragments the fold could not see.
 *
 * The body is folded here rather than trusted from the caller (#1218): this is
 * one of the two sites that render a fragment body into the published notes, and
 * a body with a line break of its own would put its next line at column 0, where
 * the release verifier reads the chain and where a `## [` line ends the section.
 *
 * @param {{ name: string, body: string }[]} fragments - sorted, as `fragmentNames` returns them.
 * @returns {string} markdown to append, or '' when nothing was stranded.
 */
export function strandedSection(fragments) {
  if (fragments.length === 0) return ''
  const entries = fragments.map((fragment) => `- ${foldFragmentBody(fragment.body)}`)
  return [
    '',
    STRANDED_HEADING,
    '',
    'These changes merged into `main` while this release waited to be merged, so the tag ships them even though the notes above were assembled before they arrived. They are part of this release:',
    '',
    ...entries,
    '',
  ].join('\n')
}
