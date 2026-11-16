// #590: the issue gate hashes a body and compares it with the hash a PASS named.
// That proves the text is the text the reviewer read; it proves nothing about
// the tree the text cites, so a card whose `path:line` already points past the
// last line of a file — or at a file that no longer exists — still reaches `ok`
// and sends a Dev to a line that is not there.
//
// This module answers the mechanical half of that second question and only that
// half: do the paths and lines the body names exist at the sha the body names?
// It cannot know whether the premise still holds, whether the cited line still
// holds the function the card discusses, or whether the file is the right
// surface. Those stay human catches.
//
// Pure: no HTTP and no clock. The gate supplies the tree and a content reader,
// which is what lets the suite drive it against a fake API.
//
// The four rules, and nothing else:
//
//   1. Only text outside fenced code blocks is scanned. A card that quotes a
//      gate line, a stack trace or an API response must not be judged on it.
//   2. `path:line` and `path:start-end` are collected, path first. A path the
//      same line declares new (`add`, `adds`, `create`, `new`, `introduce`) is
//      skipped, because a card that adds a file cites it before it exists.
//   3. The path resolves exactly at the sha, else as exactly one path ending
//      with `/<path>`. Zero matches is a stale anchor; more than one is a note
//      and never a verdict, because guessing is how a gate cries wolf.
//   4. The last line is the number of `\n` segments minus the trailing empty
//      one, so a file that ends with a newline has 29 lines and not 30.

const FENCE = /^\s*(```|~~~)/
const PIN = /(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/i
const ANCHOR = /([A-Za-z0-9_./-]*[A-Za-z0-9_/-]\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?/g
const DECLARES_NEW = /\b(add|adds|create|new|introduce)\b/i

// Lines outside fenced blocks. The fence lines themselves are dropped with the
// block they open or close.
export function unfencedLines(body) {
  const lines = []
  let fenced = false
  for (const line of String(body ?? '').split(/\r?\n/)) {
    if (FENCE.test(line)) {
      fenced = !fenced
      continue
    }
    if (!fenced) lines.push(line)
  }
  return lines
}

// The sha the body names: the first full 40-hex it writes outside a fence. A
// body that pins nothing is judged at `main`, as it is when the gate runs — that
// is what lets the note on an unpinned card exist at all.
export function pinOf(body) {
  for (const line of unfencedLines(body)) {
    const pin = PIN.exec(line)
    if (pin !== null) return pin[0].toLowerCase()
  }
  return 'main'
}

// Every citation outside a fence, in body order, each as the text the card wrote
// (`ref`) plus the parts the resolver needs.
export function anchorsOf(body) {
  const anchors = []
  for (const line of unfencedLines(body)) {
    if (DECLARES_NEW.test(line)) continue
    for (const match of line.matchAll(ANCHOR)) {
      const path = match[1] ?? ''
      const start = Number(match[2] ?? '')
      const end = match[3] === undefined ? null : Number(match[3])
      if (path === '' || !Number.isInteger(start) || start < 1) continue
      if (end !== null && (!Number.isInteger(end) || end < 1)) continue
      anchors.push({ path, start, end, ref: end === null ? `${path}:${String(start)}` : `${path}:${String(start)}-${String(end)}` })
    }
  }
  return anchors
}

// The number of lines a file has, by the rule the card states: `\n` segments
// minus a trailing empty one, so a file ending with a newline is not one longer.
export function lastLineOf(contents) {
  const segments = String(contents ?? '').split('\n')
  if (segments.at(-1) === '') segments.pop()
  return segments.length
}

// Exact path first, then a unique suffix. `ambiguous` carries its candidates so
// the note can name them.
export function resolvePath(path, paths) {
  if (paths.includes(path)) return { kind: 'exact', path }
  const candidates = paths.filter((entry) => entry.endsWith(`/${path}`))
  if (candidates.length === 1) return { kind: 'suffix', path: candidates[0] }
  if (candidates.length === 0) return { kind: 'missing' }
  return { kind: 'ambiguous', candidates }
}

// The verdict for one anchor given the file's last line: `null` when it
// resolves, else the `found=` value the machine line carries.
export function staleFound(anchor, lastLine) {
  if (anchor.start > lastLine) return `last-line-${String(lastLine)}`
  if (anchor.end !== null && anchor.end > lastLine) return `last-line-${String(lastLine)}`
  return null
}
