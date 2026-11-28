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
import { CHANGES_LABEL, HOLD_LABELS, classifyMergeCandidate } from './lib/merge-clean.mjs'

const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
const REPO = process.env.GITHUB_REPOSITORY ?? ''
const API = process.env.GITHUB_API_URL ?? 'https://api.github.com'
const DRY_RUN = process.argv.includes('--dry-run')

const MAX_FILE_PAGES = 30
const MAX_CHECK_PAGES = 5
const MAX_REVIEW_PAGES = 3

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

async function repository() {
  const body = await api(`/repos/${REPO}`)
  return {
    defaultBranch: String(body?.default_branch ?? ''),
    fullName: String(body?.full_name ?? REPO),
  }
}

async function openPullRequests() {
  const pullRequests = []
  for (let page = 1; page <= 30; page += 1) {
    const batch = await api(`/repos/${REPO}/pulls?state=open&per_page=100&page=${page}`)
    if (!Array.isArray(batch)) throw new Error('GET /pulls did not answer a list')
    pullRequests.push(...batch)
    if (batch.length < 100) break
  }
  return pullRequests
}

// A short page is the end of the list. Hitting the page cap while the pages are
// still full means the list is longer than this drain will read, so the caller
// treats it as truncated instead of tiering an incomplete diff.
async function pullRequestFiles(number) {
  const list = []
  let truncated = false
  for (let page = 1; page <= MAX_FILE_PAGES; page += 1) {
    const batch = await api(`/repos/${REPO}/pulls/${number}/files?per_page=100&page=${page}`)
    if (!Array.isArray(batch)) throw new Error(`GET /pulls/${number}/files did not answer a list`)
    list.push(...batch)
    if (batch.length < 100) return { list, truncated: false }
  }
  truncated = true
  return { list, truncated }
}

async function reviewsOf(number) {
  const reviews = []
  for (let page = 1; page <= MAX_REVIEW_PAGES; page += 1) {
    const batch = await api(`/repos/${REPO}/pulls/${number}/reviews?per_page=100&page=${page}`)
    if (!Array.isArray(batch)) break
    reviews.push(...batch)
    if (batch.length < 100) break
  }
  return reviews
}

async function checkRuns(sha) {
  const runs = []
  for (let page = 1; page <= MAX_CHECK_PAGES; page += 1) {
    const body = await api(`/repos/${REPO}/commits/${sha}/check-runs?per_page=100&page=${page}`)
    const batch = Array.isArray(body?.check_runs) ? body.check_runs : []
    runs.push(...batch)
    if (batch.length < 100) break
  }
  return runs
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
  const changedFiles = Number.isInteger(Number(files.list.length)) ? files.list.length : 0
  const changes = files.list.map((file) => ({
    path: String(file?.filename ?? ''),
    patch: file?.patch === undefined ? undefined : String(file.patch),
  }))
  return { tier: tierForChanges(changes, loadRules()).tier, truncated: files.truncated, changedFiles }
}

async function decide(pr, defaultBranch) {
  const labels = labelsOf(pr)
  const hold = HOLD_LABELS.some((label) => labels.includes(label))
  const labelledChanges = labels.includes(CHANGES_LABEL)
  const cheap = classifyMergeCandidate({ pr, tier: '', checks: [], hold, changesRequested: labelledChanges, defaultBranch })
  // A pull request a cheap rule already refuses (not open, draft, fork, a
  // non-default base, queued, hold, a change request) needs no tier read.
  if (cheap.reason !== 'tier-unknown') return cheap
  const number = Number(pr.number)
  const read = await tierOf(number)
  const reported = Number(pr?.changed_files ?? 0)
  const truncated = read.truncated || (reported > 0 && reported > read.changedFiles)
  if (truncated) {
    return classifyMergeCandidate({ pr, tier: '', checks: [], hold, changesRequested: labelledChanges, defaultBranch, filesTruncated: true })
  }
  if (read.tier !== 'T0' && read.tier !== 'T1') {
    return classifyMergeCandidate({ pr, tier: read.tier, checks: [], hold, changesRequested: labelledChanges, defaultBranch })
  }
  const reviews = await reviewsOf(number)
  const changesRequested = labelledChanges || reviews.some((review) => String(review?.state ?? '') === 'CHANGES_REQUESTED')
  const checks = await checkRuns(String(pr?.head?.sha ?? ''))
  const observedHead = await headOf(number)
  return classifyMergeCandidate({ pr, tier: read.tier, checks, hold, changesRequested, observedHead, defaultBranch })
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

  const repo = await repository()
  if (repo.defaultBranch === '') fail('GET /repos did not name a default branch')

  const pullRequests = await openPullRequests()
  const decisions = []
  for (const pr of pullRequests) decisions.push(await decide(pr, repo.defaultBranch))
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
