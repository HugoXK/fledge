#!/usr/bin/env node
// Recompute an issue body's hash and compare it with the hash the newest
// `Issue-review:` verdict names, so `agent-ready` cannot be added on top of a
// PASS whose body no longer exists.
//
//   GITHUB_TOKEN=... node scripts/issue-gate.mjs --issue 76
//   node scripts/issue-gate.mjs --issue 76 --api-base http://127.0.0.1:1234   # fixtures
//
// The hash is sha256 over the whole decoded body, first 12 hex. Verdicts on the
// board name one of two forms: the raw body, or the body with trailing
// whitespace stripped. Both are honoured, and every line that matched prints
// ` (trimmed)` when the stripped form was the one — a card whose CHANGES was
// written over the trimmed body used to read as `no-pass`, which is a refused
// body looking unblocked. The one definition is `scripts/lib/issue-body-hash.mjs`;
// `scripts/issue-hash.mjs` is the tool a verdict writer records with, so the
// reading and writing sides cannot drift.
//
// One machine line on stdout, one exit code:
//
//   0  issue-gate: ok #<N> <hash>[ (trimmed)]
//   1  issue-gate: stale-pass #<N> passed=<hash> current=<hash>
//   2  issue-gate: no-pass #<N>
//   3  issue-gate: bad-passer #<N> <login>
//   4  issue-gate: changes #<N> <hash>[ (trimmed)]
//   5  issue-gate: corrupt-body #<N>
//   6  the gate could not run (arguments, policy, HTTP, no token)
//   7  issue-gate: hold #<N> <hash>[ (trimmed)]
//   8  issue-gate: stale-anchor #<N> <hash> ref=<path>:<line>[-<end>] found=<missing-path|last-line-<n>>
//
// `stale-anchor` is the second question the gate answers: a body can be the one
// a PASS named and still cite a `path:line` that does not exist at the sha the
// body names. It replaces `ok` and nothing else, exactly as `hold` does, so a
// card refused for a hash reason keeps that line and gains a note naming the
// stale citation instead: the person about to edit the body sees both facts in
// one run. The scan and the resolution are `scripts/lib/issue-anchor.mjs`.
//
// `hold` means approved but not claimable. It replaces `ok` and nothing else:
// a held card whose live verdict is CHANGES still prints `changes` (exit 4), a
// held card with no verdict still prints `no-pass` (exit 2), and a held card
// whose PASS names another body still prints `stale-pass` (exit 1).
//
// Exit 6 exists so a caller can tell "the card is blocked" apart from "the
// check broke"; folding them together would make an outage look like a verdict.
//
// A verdict is a comment whose FIRST LINE is
// `Issue-review: (PASS|CHANGES) at issue #<N> body <12-hex>` — a quoted line
// further down the body is not a verdict. Only `requiredPass` from
// .github/agent/review-policy.json may approve; the author of the body cannot.
//
// The known limit, stated rather than papered over: GitHub exposes no body-edit
// history, so a byte-for-byte revert back to the PASSed text is accepted again.
// The machine half covers every other case; the human rule — a material edit
// voids the approval — covers that window. This gate is not revert-proof.

import { readFileSync } from 'node:fs'
import { bodyHashes, trimmedSuffix } from './lib/issue-body-hash.mjs'
import { anchorsOf, lastLineOf, pinOf, resolvePath, staleFound } from './lib/issue-anchor.mjs'

const DEFAULT_API = 'https://api.github.com'
const VERDICT = /^Issue-review: (PASS|CHANGES) at issue #(\d+) body ([0-9a-f]{12})$/
const MAX_PAGES = 100

function arg(argv, name) {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

function fail(message) {
  console.error(`issue-gate: ${message}`)
  process.exit(6)
}

const issueNumber = Number(arg(process.argv, '--issue'))
const apiBase = (arg(process.argv, '--api-base') ?? process.env.GITHUB_API_URL ?? DEFAULT_API).replace(/\/$/, '')
const policyPath = arg(process.argv, '--policy') ?? '.github/agent/review-policy.json'
const repo = arg(process.argv, '--repo') ?? process.env.GITHUB_REPOSITORY ?? ''
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''

if (!Number.isInteger(issueNumber) || issueNumber <= 0) fail('--issue <number> is required')
if (!/^[^/]+\/[^/]+$/.test(repo)) fail('GITHUB_REPOSITORY or --repo owner/name is required')
if (apiBase === DEFAULT_API && token === '') fail('GITHUB_TOKEN is not set (pass --api-base for a fixture)')

let requiredPass
try {
  requiredPass = JSON.parse(readFileSync(policyPath, 'utf8')).requiredPass
} catch (error) {
  fail(`cannot read the review policy at ${policyPath}: ${error instanceof Error ? error.message : String(error)}`)
}
if (typeof requiredPass !== 'string' || requiredPass === '') fail(`the review policy at ${policyPath} names no requiredPass`)

function requestHeaders() {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'fledge-issue-gate' }
  if (token !== '') headers.authorization = `Bearer ${token}`
  return headers
}

async function getJson(url) {
  let response
  try {
    response = await fetch(url, { headers: requestHeaders(), signal: AbortSignal.timeout(15_000) })
  } catch (error) {
    fail(`cannot reach ${url}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) fail(`GitHub ${response.status} for ${url}`)
  const text = await response.text()
  try {
    return { value: JSON.parse(text), link: response.headers.get('link') }
  } catch {
    fail(`GitHub returned a body that is not JSON for ${url}`)
  }
}

function nextPage(link) {
  if (link === null || link === undefined) return null
  for (const part of link.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part)
    if (match !== null) return match[1]
  }
  return null
}

const root = `${apiBase}/repos/${repo}/issues/${issueNumber}`
const issue = (await getJson(root)).value
if (typeof issue?.body !== 'string') fail(`GitHub returned no body for #${issueNumber}`)
if (issue.body.includes('\uFFFD')) {
  // A body that decoded with a replacement character cannot be hashed the way
  // the PASS hashes were taken, so print no hash at all.
  console.log(`issue-gate: corrupt-body #${issueNumber}`)
  process.exit(5)
}

// #590: the hash proves the text, not the tree. One tree read per ref and one
// blob read per cited path, both cached, so a body citing one file twenty times
// costs one read. A tree that cannot be read, or comes back truncated, is a note
// and never a refusal: a network hiccup is not a defect in the card, and exit 6
// would turn an outage into a verdict.
const treeCache = new Map()
const contentCache = new Map()

async function tryJson(target) {
  try {
    const response = await fetch(target, { headers: requestHeaders(), signal: AbortSignal.timeout(15_000) })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

async function treeAt(ref) {
  if (treeCache.has(ref)) return treeCache.get(ref)
  const value = await tryJson(`${apiBase}/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`)
  const paths = Array.isArray(value?.tree)
    ? value.tree.map((entry) => (entry?.type === 'blob' ? String(entry?.path ?? '') : '')).filter((path) => path !== '')
    : null
  const tree = paths === null ? null : { paths, truncated: value?.truncated === true }
  treeCache.set(ref, tree)
  return tree
}

async function contentsAt(path, ref) {
  const key = `${ref}:${path}`
  if (contentCache.has(key)) return contentCache.get(key)
  const encoded = path.split('/').map((part) => encodeURIComponent(part)).join('/')
  const value = await tryJson(`${apiBase}/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`)
  const text = value?.encoding === 'base64' && typeof value?.content === 'string' ? Buffer.from(value.content, 'base64').toString('utf8') : null
  contentCache.set(key, text)
  return text
}

// Every citation the body makes, resolved against the sha the body names.
// `stale` is the first anchor that does not resolve, in body order; `notes` says
// why, one line per anchor, at most five, because a body with twenty bad anchors
// is one problem and not twenty.
async function anchorCheck(body) {
  const anchors = anchorsOf(body)
  if (anchors.length === 0) return { notes: [], stale: null }
  const note = (message) => `issue-gate: note #${issueNumber} ${message}`
  const ref = pinOf(body)
  const tree = await treeAt(ref)
  if (tree === null) return { notes: [note(`could not read the tree at ${ref}; the citations were not judged`)], stale: null }
  if (tree.truncated) return { notes: [note(`the tree at ${ref} is truncated; the citations were not judged`)], stale: null }

  const notes = []
  let stale = null
  for (const anchor of anchors) {
    const resolved = resolvePath(anchor.path, tree.paths)
    if (resolved.kind === 'ambiguous') {
      notes.push(note(`ambiguous anchor ${anchor.ref} (${String(resolved.candidates.length)} candidates: ${resolved.candidates.join(', ')})`))
      continue
    }
    if (resolved.kind === 'missing') {
      stale ??= { ref: anchor.ref, found: 'missing-path' }
      notes.push(note(`stale anchor ${anchor.ref}, no such path at ${ref}`))
      continue
    }
    const contents = await contentsAt(resolved.path, ref)
    if (contents === null) {
      notes.push(note(`could not read ${resolved.path} at ${ref}; that citation was not judged`))
      continue
    }
    const lastLine = lastLineOf(contents)
    const found = staleFound(anchor, lastLine)
    if (found !== null) {
      stale ??= { ref: anchor.ref, found }
      notes.push(note(`stale anchor ${anchor.ref}, last line ${String(lastLine)}`))
    }
  }
  return { notes: notes.slice(0, 5), stale }
}

const hashes = bodyHashes(issue.body)
const anchorState = await anchorCheck(issue.body)

// The newest verdict may sit on the last page: a single-page read returns an
// older one with no error at all.
const verdicts = []
let url = `${root}/comments?per_page=100`
for (let page = 0; page < MAX_PAGES; page += 1) {
  const { value, link } = await getJson(url)
  if (!Array.isArray(value)) fail(`GitHub returned no comment list for #${issueNumber}`)
  for (const comment of value) {
    const first = String(comment?.body ?? '').split('\n')[0].replace(/\r$/, '')
    const match = VERDICT.exec(first)
    if (match === null) continue
    if (Number(match[2]) !== issueNumber) continue
    verdicts.push({ kind: match[1], hash: match[3], login: String(comment?.user?.login ?? '') })
  }
  const next = nextPage(link)
  if (next === null) break
  url = next
}

const labels = (Array.isArray(issue.labels) ? issue.labels : []).map((label) => (typeof label === 'string' ? label : label?.name ?? ''))
const agentReady = labels.includes('agent-ready')
const held = labels.includes('hold')

function report(code, line, reason) {
  // The anchor notes are printed on every path: a stale citation is worth seeing
  // even when the card is refused for a hash reason, and an ambiguous one is a
  // note that must never become a verdict.
  for (const note of anchorState.notes) console.error(note)
  console.log(line)
  if (agentReady && code !== 0) console.error(`issue-gate: note #${issueNumber} carries agent-ready while ${reason}`)
  process.exit(code)
}

// The latest verdict at the live body decides, whoever wrote it — a later
// refusal beats an earlier approval, which is what makes the Lead's rule safe.
// A verdict matches if it names either form; the form it named is carried so
// every line that matched can say which one it was.
const atBody = verdicts
  .map((verdict) => {
    const form = verdict.hash === hashes.raw ? 'raw' : verdict.hash === hashes.trimmed ? 'trimmed' : null
    return form === null ? null : { ...verdict, form }
  })
  .filter((verdict) => verdict !== null)
const latestAtBody = atBody.at(-1)
if (latestAtBody !== undefined) {
  if (latestAtBody.login !== requiredPass) {
    report(3, `issue-gate: bad-passer #${issueNumber} ${latestAtBody.login}`, `its verdict at the live body came from ${latestAtBody.login}, not ${requiredPass}`)
  }
  if (latestAtBody.kind === 'CHANGES') {
    report(4, `issue-gate: changes #${issueNumber} ${latestAtBody.hash}${trimmedSuffix(latestAtBody.form)}`, 'the live verdict is CHANGES')
  }
  if (held) {
    report(7, `issue-gate: hold #${issueNumber} ${latestAtBody.hash}${trimmedSuffix(latestAtBody.form)}`, 'the card carries hold')
  }
  if (anchorState.stale !== null) {
    report(
      8,
      `issue-gate: stale-anchor #${issueNumber} ${latestAtBody.hash}${trimmedSuffix(latestAtBody.form)} ref=${anchorState.stale.ref} found=${anchorState.stale.found}`,
      `a citation (${anchorState.stale.ref}) does not resolve at the sha the body names`,
    )
  }
  report(0, `issue-gate: ok #${issueNumber} ${latestAtBody.hash}${trimmedSuffix(latestAtBody.form)}`)
}

// No verdict names the live body. A PASS at an older body is the stale approval
// this gate exists to catch; a CHANGES at an older body is out of scope until a
// line that can express it exists, and is reported as no pass.
const latestPass = verdicts.filter((verdict) => verdict.login === requiredPass).at(-1)
if (latestPass !== undefined && latestPass.kind === 'PASS') {
  report(1, `issue-gate: stale-pass #${issueNumber} passed=${latestPass.hash} current=${hashes.raw}`, `its PASS names ${latestPass.hash}, not the live body`)
}
if (latestPass !== undefined) {
  console.error(`issue-gate: note #${issueNumber} the newest verdict is CHANGES at ${latestPass.hash}, which is not the live body`)
}
report(2, `issue-gate: no-pass #${issueNumber}`, 'no PASS names the live body')
