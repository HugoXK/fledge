#!/usr/bin/env node
// Merge an open T0/T1 pull request whose required checks are green, because a
// `CLEAN` pull request is not a queue entry: `enablePullRequestAutoMerge`
// refuses with "Pull request is in clean status", so a green tip waits for a
// person to press squash. This runs on a schedule and never replaces a review.
//
//   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/merge-clean.mjs
//   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/merge-clean.mjs --dry-run
//
// One pass reads the open pull requests, computes each tier with the same
// `tierForChanges` the gates read, then checks the three required contexts at
// the head SHA. It re-reads the head immediately before deciding, so a push
// that lands while the tier and the checks are read cannot be merged on a stale
// verdict. A T2/T3 tip is never merged here: it still needs a PASS.
//
// The token is read from the environment and used only as a request header; it
// is never printed. A merge is a direct squash merge pinned to the head SHA the
// decision names; when the queue or the API refuses, the run prints one reason
// and ends, it does not retry in a loop.

import { loadRules, tierForChanges } from './lib/risk.mjs'
import { HOLD_LABEL, classifyMergeCandidate } from './lib/merge-clean.mjs'

const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
const REPO = process.env.GITHUB_REPOSITORY ?? ''
const API = process.env.GITHUB_API_URL ?? 'https://api.github.com'
const DRY_RUN = process.argv.includes('--dry-run')

const MAX_PAGES = 3

function fail(message) {
  console.error(`merge-clean: ${message}`)
  process.exit(1)
}

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'fledge-merge-clean',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    signal: AbortSignal.timeout(20_000),
  })
  const text = await response.text()
  return { ok: response.ok, status: response.status, text }
}

async function api(path, options = {}) {
  const answer = await request(path, options)
  if (!answer.ok) throw new Error(`GitHub ${answer.status} ${path}: ${answer.text.slice(0, 200)}`)
  if (answer.text === '') return null
  try {
    return JSON.parse(answer.text)
  } catch {
    throw new Error(`GitHub ${answer.status} ${path} returned non-JSON`)
  }
}

async function openPullRequests() {
  const pullRequests = []
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await api(`/repos/${REPO}/pulls?state=open&per_page=100&page=${page}`)
    if (!Array.isArray(batch)) throw new Error('GET /pulls did not answer a list')
    pullRequests.push(...batch)
    if (batch.length < 100) break
  }
  return pullRequests
}

async function pullRequestFiles(number) {
  const files = []
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await api(`/repos/${REPO}/pulls/${number}/files?per_page=100&page=${page}`)
    if (!Array.isArray(batch)) throw new Error(`GET /pulls/${number}/files did not answer a list`)
    files.push(...batch)
    if (batch.length < 100) break
  }
  return files
}

async function checkRuns(sha) {
  const body = await api(`/repos/${REPO}/commits/${sha}/check-runs?per_page=100`)
  return Array.isArray(body?.check_runs) ? body.check_runs : []
}

async function headOf(number) {
  const body = await api(`/repos/${REPO}/pulls/${number}`)
  return String(body?.head?.sha ?? '')
}

function labelsOf(pr) {
  return Array.isArray(pr?.labels) ? pr.labels.map((label) => String(label?.name ?? '')) : []
}

async function tierOf(number) {
  const files = await pullRequestFiles(number)
  const changes = files.map((file) => ({
    path: String(file?.filename ?? ''),
    patch: file?.patch === undefined ? undefined : String(file.patch),
  }))
  return tierForChanges(changes, loadRules()).tier
}

async function decide(pr) {
  const labels = labelsOf(pr)
  const cheap = classifyMergeCandidate({ pr, tier: '', checks: [], hold: labels.includes(HOLD_LABEL) })
  // A pull request a cheap rule already refuses (draft, queued, hold, not open)
  // needs no tier read and no check-run read.
  if (cheap.reason !== 'tier-unknown') return cheap
  const number = Number(pr.number)
  const tier = await tierOf(number)
  if (tier !== 'T0' && tier !== 'T1') return classifyMergeCandidate({ pr, tier, checks: [] })
  const checks = await checkRuns(String(pr?.head?.sha ?? ''))
  const observedHead = await headOf(number)
  return classifyMergeCandidate({ pr, tier, checks, observedHead })
}

function line(decision) {
  const head = decision.head === '' ? '-' : decision.head
  const tier = decision.tier === '' ? '-' : decision.tier
  const action = decision.action === 'enqueue' ? 'enqueue' : `skip:${decision.reason}`
  return `PR ${decision.number} head=${head} tier=${tier} action=${action}`
}

async function merge(number, sha) {
  const answer = await request(`/repos/${REPO}/pulls/${number}/merge`, {
    method: 'PUT',
    body: JSON.stringify({ sha, merge_method: 'squash' }),
  })
  if (answer.ok) return { ok: true, message: 'merged' }
  if (answer.status === 401 || answer.status === 403) {
    return { ok: false, fatal: true, message: `GitHub ${answer.status}: ${answer.text.slice(0, 160)}` }
  }
  return { ok: false, fatal: false, message: `GitHub ${answer.status}: ${answer.text.slice(0, 160)}` }
}

async function main() {
  if (TOKEN === '') fail('GITHUB_TOKEN is not set')
  if (!/^[^/\s]+\/[^/\s]+$/.test(REPO)) fail('GITHUB_REPOSITORY is not owner/name')

  const pullRequests = await openPullRequests()
  const decisions = []
  for (const pr of pullRequests) decisions.push(await decide(pr))
  for (const decision of decisions) console.log(`merge-clean: ${line(decision)}`)

  if (DRY_RUN) {
    const candidates = decisions.filter((entry) => entry.action === 'enqueue')
    console.log(`merge-clean: dry run, ${candidates.length} candidate(s), no write`)
    return
  }

  for (const decision of decisions) {
    if (decision.action !== 'enqueue') continue
    const result = await merge(decision.number, decision.head)
    if (result.ok) {
      console.log(`merge-clean: PR ${decision.number} head=${decision.head} tier=${decision.tier} merged`)
      continue
    }
    if (result.fatal === true) fail(result.message)
    console.log(`merge-clean: PR ${decision.number} head=${decision.head} merge not taken (${result.message}); the next tick re-reads the head`)
  }

  if (decisions.every((entry) => entry.action !== 'enqueue')) {
    console.log(`merge-clean: no candidate (${pullRequests.length} open)`)
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
