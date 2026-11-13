// The one rule that says which files in `changelog.d/` are fragments.
//
// #548: the release workflow counted them with
// `ls changelog.d/*.md | grep -v '/README.md$' | wc -l` under `pipefail`. After a
// release folds every fragment into `CHANGELOG.md`, `changelog.d/` holds only
// `README.md`, so `grep -v` matched nothing and exited 1, the count step died and
// the next step dereferenced a state file that was never written.
//
// Zero fragments is a legitimate answer — the planner refuses the night with its
// own first reason — but a directory that cannot be read is not zero: only the
// two empty shapes answer 0, and a missing or unreadable `changelog.d` throws so
// the release step fails loudly instead of reporting a count nobody measured.

import { readdirSync } from 'node:fs'

/** Sorted fragment file names (`*.md`, never `README.md`). Throws when the directory cannot be read. */
export function fragmentNames(dir = 'changelog.d') {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .sort()
}

/** How many fragments a release would fold. Throws, rather than answering 0, when the directory is unreadable. */
export function countFragments(dir = 'changelog.d') {
  return fragmentNames(dir).length
}
