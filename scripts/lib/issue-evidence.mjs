// Resolve the evidence an issue body cites, so `issue-gate` cannot accept a PASS
// whose body names a `file:line`, a test line or a symbol that is not there.
//
// The gate used to hash the body and check nothing else, so a body could name a
// test file that never renders the page under test, or a localiser the console
// never calls, and still reach `issue-gate: ok #<N> <hash>`. A suggested red
// test that passes while the defect stays is worse than no test, because it buys
// a merge and closes the card (#590).
//
// Two rules, deliberately narrow:
//
//   * a `path:line` (or `path:line-line`) ref must resolve in the tree the body
//     pins — the file exists there and the line is inside it;
//   * when the body claims a symbol is *defined* at that line (`\`x\` defined at
//     \`path:line\``, or `\`path:line\` is the definition of \`x\``), the line
//     must actually define it. An occurrence elsewhere in the file does not
//     count: that is exactly the case an occurrence-in-file rule would pass.
//
// What this does not do, stated rather than papered over: it does not judge
// whether the cited assertion is the *semantically* right one, it does not
// resolve quoted text (a later slice), and it does not search the whole tree for
// a symbol's definition — only the cited line and, for a hint, the cited file.
//
// The pin. Line numbers drift on every merge, so resolving against live `main`
// would fail the same untouched body hours later and teach everyone to ignore
// the check. A ref-bearing body must name `main` = <sha>; refs resolve there,
// and the pin must be an ancestor of the live `main`. A body that cites no ref
// needs no pin and is judged exactly as before.

const EXT = '(?:ts|tsx|js|mjs|cjs|json|md|sql|ya?ml|css|html)'
// A path token, not a URL: the character before it may not be any of `/` `.`
// `-`, a word character or a backtick (backticks are fine — they are stripped
// by the caller), so `https://host/x.ts:3` never looks like a tree path.
const REF = new RegExp(`(?<![\\w/.@-])((?:[\\w.-]+/)*[\\w.-]+\\.${EXT})(?::(\\d+)(?:-(\\d+))?)?(?![\\w])`, 'g')
const PIN = /`?\bmain`?\s*=\s*`?([0-9a-f]{7,40})(?![0-9a-f])/gi
const DEF_AT_LINE = /`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)`[^`\n]{0,48}?(?:is\s+)?(?:defined|declared)\s+(?:at|in|on)\s+`([^`\s]+:\d+)`/g
const LINE_IS_DEF = /`([^`\s]+:\d+(?:-\d+)?)`[^`\n]{0,48}?(?:is\s+)?(?:the\s+)?(?:definition|declaration)\s+of\s+`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)`/g

function lastSegment(symbol) {
  const parts = symbol.split('.')
  return parts[parts.length - 1]
}

function escapeFor(symbol) {
  return symbol.replace(/[$]/g, '\\$')
}

// One definition shape per language the repo actually holds. `class` covers a
// method's owner; the last segment of a dotted symbol is what a definition line
// can be expected to name.
function definesLine(text, symbol) {
  const name = escapeFor(lastSegment(symbol))
  const shapes = [
    `(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${name}\\b`,
    `(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+${name}\\b`,
    `(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*[=:]`,
    `(?:export\\s+)?(?:interface|type|enum)\\s+${name}\\b`,
    `(?:export\\s+)?def\\s+${name}\\b`,
  ]
  return shapes.some((shape) => new RegExp(shape).test(text))
}

// Any line in the file that defines the symbol, so a failure can say where it is
// instead of only where it is not.
function definitionLine(lines, symbol) {
  for (let index = 0; index < lines.length; index += 1) {
    if (definesLine(lines[index], symbol)) return index + 1
  }
  return null
}

export function extractRefs(body) {
  const refs = []
  for (const match of String(body).matchAll(REF)) {
    const path = match[1]
    const start = match[2] === undefined ? undefined : Number(match[2])
    const end = match[3] === undefined ? start : Number(match[3])
    refs.push({ raw: match[0], path, line: start, endLine: end })
  }
  return refs
}

export function extractPins(body) {
  const pins = []
  for (const match of String(body).matchAll(PIN)) pins.push(match[1].toLowerCase())
  return [...new Set(pins)]
}

export function extractSymbolClaims(body) {
  const claims = []
  for (const match of String(body).matchAll(DEF_AT_LINE)) {
    claims.push({ symbol: match[1], ref: match[2], raw: match[0] })
  }
  for (const match of String(body).matchAll(LINE_IS_DEF)) {
    claims.push({ symbol: match[2], ref: match[1], raw: match[0] })
  }
  return claims
}

function splitRef(ref) {
  const index = ref.lastIndexOf(':')
  const range = ref.slice(index + 1)
  const start = Number(range.split('-')[0])
  if (!Number.isInteger(start) || start <= 0) return null
  return { path: ref.slice(0, index), line: start }
}

function decodeContents(payload) {
  if (typeof payload?.content === 'string' && payload.encoding === 'base64') {
    return Buffer.from(payload.content, 'base64').toString('utf8')
  }
  return null
}

/**
 * @param {{ body: string, fetchJson: (url: string) => Promise<any>, apiBase: string, repo: string }} options
 * @returns {Promise<{ ok: boolean, pins: string[], refs: number, failures: { ref: string, expected: string, found: 'none'|'line', detail: string }[], notes: string[] }>}
 */
export async function resolveEvidence({ body, fetchJson, apiBase, repo }) {
  const refs = extractRefs(body)
  const claims = extractSymbolClaims(body)
  const notes = []
  if (refs.length === 0 && claims.length === 0) {
    return { ok: true, pins: [], refs: 0, failures: [], notes }
  }

  const failures = []
  const pins = extractPins(body)
  if (pins.length === 0) {
    const first = refs[0]?.raw ?? claims[0]?.ref ?? 'symbol'
    return {
      ok: false,
      pins,
      refs: refs.length,
      failures: [{ ref: first, expected: 'main=<sha> pin', found: 'none', detail: 'the body cites evidence but names no `main` = <sha> pin, so nothing can be resolved where it was written' }],
      notes,
    }
  }

  // One compare read per distinct pin: a pin is only meaningful if it is an
  // ancestor of the live main, otherwise the body was written against a fork or
  // a commit that never landed.
  const mainSha = String((await fetchJson(`${apiBase}/repos/${repo}/commits/main`))?.sha ?? '')
  if (mainSha === '') {
    return { ok: false, pins, refs: refs.length, failures: [{ ref: pins[0], expected: 'live main', found: 'none', detail: 'cannot read the live main sha' }], notes }
  }
  let pin = pins[0]
  for (const candidate of pins) {
    const compared = await fetchJson(`${apiBase}/repos/${repo}/compare/${candidate}...${mainSha}`)
    const status = String(compared?.status ?? '')
    if (status === 'ahead' || status === 'identical') {
      pin = candidate
      break
    }
    notes.push(`${candidate} is not an ancestor of main ${mainSha} (compare status: ${status === '' ? 'unknown' : status})`)
    pin = ''
  }
  if (pin === '') {
    return {
      ok: false,
      pins,
      refs: refs.length,
      failures: [{ ref: pins[0], expected: 'ancestor of live main', found: 'none', detail: `the body's pin is not an ancestor of main ${mainSha}` }],
      notes,
    }
  }

  // One tree read per sha, one contents read per (sha, path), no matter how many
  // refs point at them.
  const tree = await fetchJson(`${apiBase}/repos/${repo}/git/trees/${pin}?recursive=1`)
  const available = new Set((Array.isArray(tree?.tree) ? tree.tree : []).map((entry) => entry?.path).filter((path) => typeof path === 'string'))
  const fileCache = new Map()

  async function readFile(path) {
    if (fileCache.has(path)) return fileCache.get(path)
    let value = null
    if (available.has(path)) {
      value = decodeContents(await fetchJson(`${apiBase}/repos/${repo}/contents/${path}?ref=${pin}`))
    }
    fileCache.set(path, value)
    return value
  }

  const seen = new Set()
  for (const ref of refs) {
    const key = `${ref.path}:${String(ref.line ?? '')}`
    if (seen.has(key)) continue
    seen.add(key)
    const text = await readFile(ref.path)
    if (text === null) {
      failures.push({ ref: ref.line === undefined ? ref.path : `${ref.path}:${String(ref.line)}`, expected: 'file in the pinned tree', found: 'none', detail: `${ref.path} does not exist at ${pin}` })
      continue
    }
    const lines = text.split('\n')
    const total = lines.length
    if (ref.line === undefined) continue
    if (ref.line > total || (ref.endLine ?? ref.line) > total) {
      failures.push({
        ref: `${ref.path}:${String(ref.line)}`,
        expected: `line<=${String(total)}`,
        found: 'none',
        detail: `${ref.path} has ${String(total)} lines at ${pin}`,
      })
    }
  }

  for (const claim of claims) {
    const parsed = splitRef(claim.ref)
    if (parsed === null) continue
    const text = await readFile(parsed.path)
    if (text === null) {
      failures.push({ ref: claim.symbol, expected: `defined at ${claim.ref}`, found: 'none', detail: `${parsed.path} does not exist at ${pin}` })
      continue
    }
    const lines = text.split('\n')
    if (parsed.line > lines.length) {
      failures.push({ ref: claim.symbol, expected: `defined at ${claim.ref}`, found: 'none', detail: `${parsed.path} has ${String(lines.length)} lines at ${pin}` })
      continue
    }
    const actual = lines[parsed.line - 1]
    if (definesLine(actual, claim.symbol)) continue
    const elsewhere = definitionLine(lines, claim.symbol)
    const where = elsewhere === null ? `\`${claim.symbol}\` is not defined in ${parsed.path}` : `\`${claim.symbol}\` is defined in ${parsed.path}:${String(elsewhere)}`
    failures.push({
      ref: claim.symbol,
      expected: `defined at ${claim.ref}`,
      found: 'line',
      detail: `${claim.ref} is \`${actual.trim().slice(0, 80)}\`; ${where}`,
    })
  }

  return { ok: failures.length === 0, pins, refs: refs.length, failures, notes }
}
