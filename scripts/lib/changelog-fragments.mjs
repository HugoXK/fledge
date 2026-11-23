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

// #1218: a fragment body is contributor-written free text and both render sites
// put it into the published body as `- ${body}`, which leaves every line after an
// inner break at column 0. The release verifier reads its chain with `/^Image:/m`
// — and `/m` ends a line at `\r`, `\u2028` and `\u2029` exactly as at `\n` — so a
// body that carries its own break and its own `Image:` line used to supply the
// digest the release was judged against, and a body whose line began `## [`
// silently truncated the notes.
//
// The rule is one paragraph, which is what `AGENTS.md` already says a fragment
// is. Folding is the neutralisation that does not need a list of shapes to
// reject: a body with no line break cannot produce a column-0 line at all, so
// the next fragment cannot re-open the hole with a name nobody blacklisted. The
// class below is the parser's own terminator class, not `\n` alone — a fold
// written for `\n` closes one of four entrances.
const LINE_BREAK = /[ \t]*[\r\n\u2028\u2029]+[ \t]*/g
const ANY_LINE_BREAK = /[\r\n\u2028\u2029]/

/** One paragraph: the body as both render sites publish it. */
export function foldFragmentBody(body) {
  return String(body ?? '').replace(LINE_BREAK, ' ').trim()
}

/** Why a body cannot be a fragment, or `null` when it is one paragraph the tools can fold. */
export function fragmentBodyProblem(body) {
  const text = String(body ?? '')
  if (text === '') return 'empty'
  if (ANY_LINE_BREAK.test(text)) return 'one paragraph, no line break'
  if (text.startsWith('- ') || text.startsWith('#')) return 'no heading or leading "- "'
  return null
}
