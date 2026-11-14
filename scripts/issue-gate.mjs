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
//   8  issue-gate: bad-evidence #<N> <hash> ref=<path:line|symbol> expected=<text> found=<none|line>
//
// `hold` means approved but not claimable. It replaces `ok` and nothing else:
// a held card whose live verdict is CHANGES still prints `changes` (exit 4), a
// held card with no verdict still prints `no-pass` (exit 2), and a held card
// whose PASS names another body still prints `stale-pass` (exit 1).
//
// Exit 8 is emitted only after the hash check passes, because a card with no
// PASS at the live body is unbuildable whatever it cites. A body that cites a
// `path:line`, a test line or a symbol tied to one resolves at the sha its
// `main` = <sha> names, and that pin must be an ancestor of the live main; a
// body that cites no such evidence needs no pin and is judged exactly as before.
// `scripts/lib/issue-evidence.mjs` carries the rule and its stated limits.
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
import { resolveEvidence } from './lib/issue-evidence.mjs'

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

const hashes = bodyHashes(issue.body)

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
  // Only now is the body the one a verdict approved, so the evidence it cites is
  // decided here: a ref that does not resolve at the pin, or a symbol claimed at
  // a line that does not define it, is a card whose red test cannot be the one
  // the body describes.
  const evidence = await resolveEvidence({ body: issue.body, apiBase, repo, fetchJson: async (url) => (await getJson(url)).value })
  for (const note of evidence.notes) console.error(`issue-gate: note #${issueNumber} ${note}`)
  if (!evidence.ok) {
    const first = evidence.failures[0]
    for (const rest of evidence.failures.slice(1)) {
      console.error(`issue-gate: note #${issueNumber} also bad: ${rest.ref} expected=${rest.expected} found=${rest.found} — ${rest.detail}`)
    }
    console.error(`issue-gate: note #${issueNumber} ${first.detail}`)
    console.log(`issue-gate: bad-evidence #${issueNumber} ${latestAtBody.hash}${trimmedSuffix(latestAtBody.form)} ref=${first.ref} expected=${first.expected} found=${first.found}`)
    process.exit(8)
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
