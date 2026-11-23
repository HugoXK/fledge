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
// two empty shapes answer 0, and an unreadable `changelog.d` throws so the
// release step fails loudly instead of reporting a count nobody measured.
//
// #1218: "cannot be read" is not "does not exist". A tag cut before
// `changelog.d` existed (`v0.1.0`) carries no fragments, and ENOENT is the one
// code that says so; the release step has to report zero stranded changes rather
// than fail a publish for a directory that tag never had. That is the only code
// answered 0 here — EACCES, EPERM, ENOTDIR and anything else still throw, so an
// unreadable tree keeps failing the step (#548) and a blanket `catch {}` cannot
// pass the pair of tests that pin both halves.

import { readdirSync } from 'node:fs'

/** Sorted fragment file names (`*.md`, never `README.md`). Answers `[]` when the directory does not exist; throws for every other read failure. */
export function fragmentNames(dir = 'changelog.d') {
  let names
  try {
    names = readdirSync(dir)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
  return names
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .sort()
}

/** How many fragments a release would fold. Zero when the directory is absent; throws when it cannot be read. */
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
