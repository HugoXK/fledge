#!/usr/bin/env node
// Recompute an issue body's hash and compare it with the hash the newest
// `Issue-review:` verdict names, so `agent-ready` cannot be added on top of a
// PASS whose body no longer exists.
//
//   GITHUB_TOKEN=... node scripts/issue-gate.mjs --issue 76
//   node scripts/issue-gate.mjs --issue 76 --api-base http://127.0.0.1:1234   # fixtures
//
// The hash is sha256 over the whole decoded body, first 12 hex, whitespace
// included. That is the convention every published PASS was written with, so a
// body that only differs in its trailing newline is a different body — and a
// gate that strips it reports false positives on every such card.
//
// One machine line on stdout, one exit code:
//
//   0  issue-gate: ok #<N> <hash>
//   1  issue-gate: stale-pass #<N> passed=<hash> current=<hash>
//   2  issue-gate: no-pass #<N>
//   3  issue-gate: bad-passer #<N> <login>
//   4  issue-gate: changes #<N> <hash>
//   5  issue-gate: corrupt-body #<N>
//   6  the gate could not run (arguments, policy, HTTP, no token)
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

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

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

const bodyHash = createHash('sha256').update(Buffer.from(issue.body, 'utf8')).digest('hex').slice(0, 12)

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

function report(code, line, reason) {
  console.log(line)
  if (agentReady && code !== 0) console.error(`issue-gate: note #${issueNumber} carries agent-ready while ${reason}`)
  process.exit(code)
}

// The latest verdict at the live body decides, whoever wrote it — a later
// refusal beats an earlier approval, which is what makes the Lead's rule safe.
const atBody = verdicts.filter((verdict) => verdict.hash === bodyHash)
const latestAtBody = atBody.at(-1)
if (latestAtBody !== undefined) {
  if (latestAtBody.login !== requiredPass) {
    report(3, `issue-gate: bad-passer #${issueNumber} ${latestAtBody.login}`, `its verdict at the live body came from ${latestAtBody.login}, not ${requiredPass}`)
  }
  if (latestAtBody.kind === 'CHANGES') {
    report(4, `issue-gate: changes #${issueNumber} ${bodyHash}`, 'the live verdict is CHANGES')
  }
  report(0, `issue-gate: ok #${issueNumber} ${bodyHash}`)
}

// No verdict names the live body. A PASS at an older body is the stale approval
// this gate exists to catch; a CHANGES at an older body is out of scope until a
// line that can express it exists, and is reported as no pass.
const latestPass = verdicts.filter((verdict) => verdict.login === requiredPass).at(-1)
if (latestPass !== undefined && latestPass.kind === 'PASS') {
  report(1, `issue-gate: stale-pass #${issueNumber} passed=${latestPass.hash} current=${bodyHash}`, `its PASS names ${latestPass.hash}, not the live body`)
}
if (latestPass !== undefined) {
  console.error(`issue-gate: note #${issueNumber} the newest verdict is CHANGES at ${latestPass.hash}, which is not the live body`)
}
report(2, `issue-gate: no-pass #${issueNumber}`, 'no PASS names the live body')
