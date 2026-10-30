#!/usr/bin/env node
// Read the newest conclusion at a PR head and decide whether a T2/T3 tip may
// enter the merge queue.
//
//   GITHUB_TOKEN=... node scripts/review-gate.mjs --pr 12
//   GITHUB_TOKEN=... node scripts/review-gate.mjs --tier T2   # uses the event
//
// The gate is report-only until it is added to the required checks on main; the
// script itself is strict so the same code can enforce later without changes.

import { readFileSync, appendFileSync } from 'node:fs'
import { tierForFiles, loadRules } from './lib/risk.mjs'

const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
const REPO = process.env.GITHUB_REPOSITORY ?? ''
const API = process.env.GITHUB_API_URL ?? 'https://api.github.com'
const EVENT = process.env.GITHUB_EVENT_PATH ?? ''
const POLICY = JSON.parse(readFileSync('.github/agent/review-policy.json', 'utf8'))

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  return process.argv[index + 1] ?? fallback
}

function event() {
  if (EVENT === '') return {}
  try {
    return JSON.parse(readFileSync(EVENT, 'utf8'))
  } catch {
    return {}
  }
}

const ev = event()
const prNumber = Number(
  arg('--pr', ev.pull_request?.number ?? /pr-(\d+)-/.exec(ev.merge_group?.head_ref ?? '')?.[1] ?? /refs\/pull\/(\d+)\//.exec(process.env.GITHUB_REF ?? '')?.[1] ?? '0'),
)

if (TOKEN === '') fail('GITHUB_TOKEN is not set')
if (REPO === '') fail('GITHUB_REPOSITORY is not set')
if (!Number.isInteger(prNumber) || prNumber <= 0) fail('cannot determine the pull request number')

async function api(path) {
  const response = await fetch(`${API}${path}`, {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'fledge-review-gate',
    },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`GitHub ${response.status} ${path}: ${text.slice(0, 200)}`)
  }
  return response.json()
}

async function paginate(path, maxPages = 4) {
  const out = []
  for (let page = 1; page <= maxPages; page += 1) {
    const sep = path.includes('?') ? '&' : '?'
    const items = await api(`${path}${sep}per_page=100&page=${page}`)
    out.push(...items)
    if (items.length < 100) break
  }
  return out
}

function fail(message) {
  console.error(`review-gate: ${message}`)
  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `review-gate: FAIL — ${message}\n`)
  }
  process.exit(1)
}

function pass(message) {
  console.log(`review-gate: PASS — ${message}`)
  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `review-gate: PASS — ${message}\n`)
  }
  process.exit(0)
}

function firstLine(body) {
  return String(body ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '') ?? ''
}

function parseConclusion(body) {
  const head = firstLine(body)
  const fixed = /^Verdict:\s+(PASS|INC|REQUEST_CHANGES)\s+at\s+([0-9a-f]{7,40})\b/i.exec(head)
  if (fixed !== null) return { verdict: fixed[1].toUpperCase(), sha: fixed[2] }
  const heading = /^##\s*Review\s*[—:-]\s*(PASS|FAIL|INC|REQUEST_CHANGES)\b/i.exec(head)
  if (heading !== null) {
    const sha = /\b([0-9a-f]{7,40})\b/i.exec(String(body ?? ''))?.[1]
    return sha === undefined ? null : { verdict: heading[1].toUpperCase(), sha }
  }
  return null
}

function writtenBy(body) {
  const match = /^\s*Written-by:\s*(.+)$/im.exec(String(body ?? ''))
  return match?.[1]?.trim() ?? ''
}

function hasRan(body) {
  const text = String(body ?? '')
  if (/(^|\n)\s*Ran[^\n:]*[:：]\s*(npm|node|npx|docker|git|gh|curl|pnpm|yarn)\b/i.test(text)) return true
  if (/(^|\n)\s*Ran[^\n:]*[:：]\s*\n(?:\s*[-*]\s*|\s*\$ )?.*\b(npm|node|npx|docker|git|gh|curl|pnpm|yarn)\b/i.test(text)) return true
  if (/(^|\n)\s*\$\s+(npm|node|npx|docker|git|gh|curl|pnpm|yarn)\b/i.test(text)) return true
  return false
}

const pr = await api(`/repos/${REPO}/pulls/${prNumber}`).catch((error) => fail(error.message))
const headSha = String(arg('--sha', pr.head?.sha ?? ''))
if (headSha === '') fail('the pull request has no head SHA')

const labels = (pr.labels ?? []).map((label) => label.name)
if (labels.includes('hold')) fail('the pull request carries the hold label')

const files = await paginate(`/repos/${REPO}/pulls/${prNumber}/files`).catch((error) => fail(error.message))
const rules = loadRules()
const computed = tierForFiles(files.map((file) => file.filename), rules)
const tier = String(arg('--tier', computed.tier)).toUpperCase()
if (!['T0', 'T1', 'T2', 'T3'].includes(tier)) fail(`unknown tier ${tier}`)

if (tier === 'T0' || tier === 'T1') pass(`${tier} at ${headSha.slice(0, 12)} needs no PASS`)

const comments = await paginate(`/repos/${REPO}/issues/${prNumber}/comments`).catch((error) => fail(error.message))
const reviews = await paginate(`/repos/${REPO}/pulls/${prNumber}/reviews`).catch((error) => fail(error.message))
const candidates = []
for (const comment of comments) {
  if (!['OWNER', 'MEMBER', 'COLLABORATOR'].includes(comment.author_association)) continue
  const parsed = parseConclusion(comment.body)
  if (parsed === null) continue
  candidates.push({
    at: comment.created_at,
    author: comment.user?.login ?? 'unknown',
    association: comment.author_association,
    body: comment.body,
    ...parsed,
  })
}
for (const review of reviews) {
  if (!['OWNER', 'MEMBER', 'COLLABORATOR'].includes(review.author_association)) continue
  const parsed = parseConclusion(review.body)
  if (parsed === null) continue
  candidates.push({
    at: review.submitted_at ?? review.created_at,
    author: review.user?.login ?? 'unknown',
    association: review.author_association,
    body: review.body,
    ...parsed,
  })
}
candidates.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
const newest = candidates.at(-1)
if (newest === undefined) fail(`no conclusion at ${headSha}; a ${tier} tip needs a PASS`)
if (!headSha.startsWith(newest.sha)) fail(`newest conclusion is for ${newest.sha}, but the head is ${headSha}`)
const writer = writtenBy(newest.body)
if (writer === '') fail('the newest conclusion has no Written-by line')
if (!POLICY.writers.map((name) => name.toLowerCase()).includes(writer.toLowerCase())) fail(`writer "${writer}" is not in the review policy`)
if (newest.verdict !== 'PASS') fail(`newest conclusion is ${newest.verdict} at ${newest.sha}`)
if (!hasRan(newest.body)) fail('the PASS has no real Ran: command; it is not a conclusion')
pass(`${tier} PASS at ${headSha.slice(0, 12)} by ${writer}`)
