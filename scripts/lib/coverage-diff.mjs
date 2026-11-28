// #641: the changed-lines half of the coverage gate. The total floor in
// `package.json` measures `src/**` as one number, so a pull request can add an
// untested branch to a large, well-covered tree and still clear it. This module
// joins the pull request's added lines to the coverage report the same run
// produced, and answers one question: are the lines this diff adds covered?
//
// The report is Node's test-runner report. It lists only the *uncovered* lines,
// so a line is judged by that list rather than by a per-line hit count. Which
// changed lines are measured is a line-shape rule, not a promise that the report
// agrees: comments, static imports, declaration heads and declaration members
// whose right-hand side is a type expression are exempt, because no test can
// execute them, while a line that carries a value, a call or an operator is
// measured. ADR 0029 (`docs/decisions/0029-coverage-measurement-semantics.md`)
// records the rule and its residual.
//
// A file with no row at all is the one case the report cannot speak to: Node
// prints a file only when the suite loaded it, so a new module no test imports
// has no row and no uncovered list. That silence is the defect #641 is about, so
// it fails closed — every measured line in such a file is a violation.

const SOURCE = /^src\//
const GENERATED = [/\.d\.[cm]?ts$/, /(?:^|\/)generated\//, /\.generated\.[cm]?ts$/]

function normalize(path) {
  return String(path ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
}

export function isGeneratedPath(path) {
  const normalized = normalize(path)
  return GENERATED.some((pattern) => pattern.test(normalized))
}

// A declaration member: `name: Type`, with optional `readonly` and `?`, and an
// optional `,`/`;` terminator. The right-hand side must parse as a type
// expression, and a custom type name here starts uppercase or is a built-in
// keyword: that is what separates `instancesUsed: boolean` and
// `items: string[]` from a value such as `key: 'instance',` or
// `key: other.value,`. A lowercase right-hand side stays measured, because it is
// far more often a value than a lowercase type alias; the ADR records that
// residual.
const TYPE_NAME =
  '(?:(?:boolean|number|string|any|unknown|never|void|object|symbol|bigint|null|undefined)|[A-Z][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)*)(?:<[^<>]*>)?(?:\\[\\])*'
const DECLARATION_MEMBER = new RegExp(
  `^(?:readonly\\s+)?[A-Za-z_$][A-Za-z0-9_$]*\\??\\s*:\\s*${TYPE_NAME}(?:\\s*\\|\\s*${TYPE_NAME})*\\s*[,;]?$`,
)

// `namespace A { const x = 1 }` runs statements on the same line; the header
// `namespace A {` and the empty `namespace A {}` declare only. The keyword list
// this replaces measured neither, so it hid an executable body.
function namespaceIsDeclaration(trimmed) {
  const open = trimmed.indexOf('{')
  if (open === -1) return true
  return trimmed.slice(open + 1).replace(/\}\s*$/, '').trim() === ''
}

// A line worth measuring. Comments, static imports and declaration heads are
// not executable, and a declaration member is not either. `import(` and
// `import.meta` are expressions, not static imports, so they stay measured.
export function isMeasuredLine(line) {
  const trimmed = String(line ?? '').trim()
  if (trimmed === '') return false
  if (/^(?:\/\/|\/\*|\*(?:\/|\s|$)|\*\/)/.test(trimmed)) return false
  if (/^import\b/.test(trimmed) && !/^import\s*[.(]/.test(trimmed)) return false
  if (/^export\s+(?:type|interface|declare)\b/.test(trimmed)) return false
  if (/^(?:type|interface|declare)\b/.test(trimmed)) return false
  if (/^(?:declare\s+)?namespace\b/.test(trimmed)) return !namespaceIsDeclaration(trimmed)
  if (DECLARATION_MEMBER.test(trimmed)) return false
  if (!/[A-Za-z0-9_$]/.test(trimmed)) return false
  return true
}

// git C-quotes a path that holds a byte it will not print: `"a/src/lib/\346\227\245.ts"`.
// Left quoted, the name starts with `"`, fails the `src/` test, and its whole file
// is dropped — which the gate would report as `skip`, not as a refusal.
function unquotePath(target) {
  const text = String(target ?? '').trim()
  if (!text.startsWith('"')) return text
  const body = text.endsWith('"') ? text.slice(1, -1) : text.slice(1)
  const bytes = []
  const simple = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]
    if (character !== '\\') {
      bytes.push(...Buffer.from(character, 'utf8'))
      continue
    }
    const next = body[index + 1] ?? ''
    if (Object.hasOwn(simple, next)) {
      bytes.push(simple[next])
      index += 1
      continue
    }
    const octal = /^[0-7]{1,3}/.exec(body.slice(index + 1))
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8))
      index += octal[0].length
      continue
    }
    bytes.push(...Buffer.from(next, 'utf8'))
    index += 1
  }
  return Buffer.from(bytes).toString('utf8')
}

// The added lines of a unified diff, per file under `src/**`. `git diff
// --unified=0` is the input: every `+` line is an added line, and its number is
// the running new-file counter of the hunk header. `---`/`+++` are headers and
// `-` lines advance only the old file, so neither is added.
//
// A `+++ ` line is a header only outside a hunk. Inside one it can be content: an
// added line whose text begins with `++ ` prints as `+++ …`, and reading that as
// a header used to reset the path, drop the rest of the file and let the run
// print `skip`. The `inHunk` flag is that state, and `diff --git` is what ends it.
export function addedLinesFromDiff(diffText) {
  const added = {}
  let path = ''
  let line = 0
  let inHunk = false
  for (const raw of String(diffText ?? '').split('\n')) {
    if (!inHunk && raw.startsWith('+++ ')) {
      const target = unquotePath(raw.slice(4)).replace(/^b\//, '')
      const candidate = normalize(target)
      path = target === '/dev/null' || !SOURCE.test(candidate) || isGeneratedPath(candidate) ? '' : candidate
      if (path !== '') added[path] ??= []
      continue
    }
    if (raw.startsWith('diff --git ')) {
      inHunk = false
      path = ''
      continue
    }
    if (raw.startsWith('@@')) {
      const match = /\+(\d+)/.exec(raw)
      line = match === null ? 0 : Number(match[1])
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (raw.startsWith('+')) {
      if (path !== '') added[path].push({ line, text: raw.slice(1) })
      line += 1
      continue
    }
    if (raw.startsWith('-') || raw.startsWith('\\')) continue
    if (raw.startsWith(' ')) {
      line += 1
      continue
    }
    // Not hunk content: the next file's header starts here.
    inHunk = false
    path = ''
  }
  return added
}

// `337-339 347` is one cell: a range of uncovered lines and a single line.
function parseRanges(cell) {
  const lines = []
  for (const token of String(cell ?? '').split(/[\s,]+/).filter((part) => part !== '')) {
    const range = /^(\d+)-(\d+)$/.exec(token)
    if (range !== null) {
      for (let number = Number(range[1]); number <= Number(range[2]); number += 1) lines.push(number)
      continue
    }
    if (/^\d+$/.test(token)) lines.push(Number(token))
  }
  return lines
}

// The report nests directories: `src` is a row, `lib` is a row under it and the
// file is a row under that, so a file's path is the join of its ancestors. The
// `line %` cell is what tells a directory row from a file row — a directory is
// printed with the three percentage cells empty.
export function parseCoverageReport(reportText) {
  const uncovered = {}
  const stack = []
  let inside = false
  for (const raw of String(reportText ?? '').split('\n')) {
    if (raw.includes('start of coverage report')) {
      inside = true
      continue
    }
    if (raw.includes('end of coverage report')) {
      inside = false
      continue
    }
    if (!inside || !raw.includes('|')) continue
    // Node prints the report behind `# ` when stdout is not a terminal and `ℹ `
    // when it is. The spaces after that bullet carry the directory depth.
    const body = raw.replace(/^\s*(?:[#ℹ*]\s?)?/, '')
    const cells = body.split('|')
    if (cells.length < 5) continue
    const rawName = cells[0]
    const name = rawName.trim()
    if (name === '' || name === 'file' || name === 'all files') continue
    const depth = rawName.length - rawName.trimStart().length
    const numeric = cells.slice(1, 4).some((cell) => cell.trim() !== '')
    if (!numeric) {
      stack.length = depth
      stack[depth] = name
      continue
    }
    const full = [...stack.slice(0, depth), name].join('/')
    uncovered[full] = parseRanges(cells[cells.length - 1])
  }
  return uncovered
}

// The waiver is a line of its own in the pull request body: an explicit
// justification a reviewer can read and object to. A body that merely mentions
// the marker does not waive anything.
export function waiverFromBody(body) {
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (/^No-test:\s*\S/.test(trimmed)) return trimmed
    if (/^coverage:no-test\s*(?:[—:-]\s*)?\S/.test(trimmed)) return trimmed
  }
  return null
}

// Join the two inputs and answer. `measured` counts the added lines that are
// code, `covered` the ones the report does not list as uncovered, and a
// violation is a measured line the report does list.
export function evaluateChangedLines({ diff, report, floor = 80 }) {
  const added = addedLinesFromDiff(diff)
  const uncoveredByPath = parseCoverageReport(report)
  let measured = 0
  let covered = 0
  const violations = []
  const missing = []
  for (const [path, entries] of Object.entries(added)) {
    // A missing row is not "fully covered": it means the suite never loaded the
    // file, which is exactly what a changed-lines gate has to refuse.
    const listed = Object.hasOwn(uncoveredByPath, path)
    const uncovered = new Set(uncoveredByPath[path] ?? [])
    if (!listed) missing.push(path)
    for (const entry of entries) {
      if (!isMeasuredLine(entry.text)) continue
      measured += 1
      if (uncovered.has(entry.line) || !listed) violations.push({ path, line: entry.line })
      else covered += 1
    }
  }
  violations.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line)
  const ratio = measured === 0 ? 0 : Math.round((covered / measured) * 1000) / 10
  const ok = measured === 0 || covered * 100 >= floor * measured
  const code = measured === 0 ? 'NO_SOURCE_LINES' : ok ? 'OK' : 'BELOW_FLOOR'
  return { ok, code, measured, covered, ratio, floor, violations, missing }
}
