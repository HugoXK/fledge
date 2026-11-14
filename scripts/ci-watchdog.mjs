#!/usr/bin/env node
// Dispatch `ci.yml` at the head of an open same-repo pull request that has no
// `CI` workflow run at all (neither active nor completed).
//
//   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/ci-watchdog.mjs
//   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/ci-watchdog.mjs --dry-run
//
// This is the durable backstop for a branch or pull request created with the
// automatic `GITHUB_TOKEN`, whose `push` and `pull_request` events start no
// workflow. The token is read from the environment and used only as a request
// header; it is never printed. `workflow_dispatch` is the documented exception to
// the token-suppression rule, which is why a dispatched run still starts.
//
// One pass reads the open pull requests, then the workflow runs for each
// same-repo head (a fork has nothing to dispatch). The decision is based on the
// `CI` workflow, not on check runs: CodeQL or a review bot can leave a check on
// a tip that CI never visited.

import {
  CI_WORKFLOW_FILE,
  DEFAULT_DISPATCH_LIMIT,
  isSameRepoPullRequest,
  planCiWatchdog,
} from './lib/ci-watchdog.mjs'

const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
const REPO = process.env.GITHUB_REPOSITORY ?? ''
const API = process.env.GITHUB_API_URL ?? 'https://api.github.com'
const DRY_RUN = process.argv.includes('--dry-run')
const LIMIT = (() => {
  const index = process.argv.indexOf('--limit')
  if (index === -1 || process.argv[index + 1] === undefined) return DEFAULT_DISPATCH_LIMIT
  const value = Number(process.argv[index + 1])
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_DISPATCH_LIMIT
})()

const MAX_PAGES = 10

function fail(message) {
  console.error(`ci-watchdog: ${message}`)
  process.exit(1)
}

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'fledge-ci-watchdog',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    signal: AbortSignal.timeout(20_000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`GitHub ${response.status} ${path}: ${text.slice(0, 200)}`)
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`GitHub ${response.status} ${path} returned non-JSON`)
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

async function workflowRuns(sha) {
  const body = await api(`/repos/${REPO}/actions/runs?head_sha=${sha}&per_page=100`)
  return Array.isArray(body?.workflow_runs) ? body.workflow_runs : []
}

async function dispatch(branch) {
  await api(`/repos/${REPO}/actions/workflows/${CI_WORKFLOW_FILE}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref: branch }),
  })
}

function headOf(entry) {
  const branch = entry.branch === '' ? '(no branch)' : entry.branch
  const sha = entry.sha === '' ? '(no sha)' : entry.sha.slice(0, 7)
  return `${branch}@${sha}`
}

async function main() {
  if (TOKEN === '') fail('GITHUB_TOKEN is not set')
  if (!/^[^/\s]+\/[^/\s]+$/.test(REPO)) fail('GITHUB_REPOSITORY is not owner/name')

  const pullRequests = await openPullRequests()
  const entries = []
  for (const pr of pullRequests) {
    const sha = String(pr?.head?.sha ?? '')
    if (!isSameRepoPullRequest(pr) || sha === '') {
      entries.push({ pr, runs: [] })
      continue
    }
    entries.push({ pr, runs: await workflowRuns(sha) })
  }

  const plan = planCiWatchdog({ entries, limit: LIMIT })
  const selected = new Set(plan.dispatches.map((entry) => entry.number))
  let failed = false

  for (const decision of plan.decisions) {
    const head = headOf(decision)
    if (decision.action === 'skip') {
      console.log(`ci-watchdog: PR #${decision.number} ${head} — skipped (${decision.reason})`)
      continue
    }
    if (!selected.has(decision.number)) {
      console.log(`ci-watchdog: PR #${decision.number} ${head} — over the ${plan.cap}-dispatch cap; next tick`)
      continue
    }
    if (DRY_RUN) {
      console.log(`ci-watchdog: PR #${decision.number} ${head} — would dispatch ${CI_WORKFLOW_FILE}`)
      continue
    }
    try {
      await dispatch(decision.branch)
      console.log(`ci-watchdog: PR #${decision.number} ${head} — dispatched ${CI_WORKFLOW_FILE}`)
    } catch (error) {
      failed = true
      console.error(`ci-watchdog: PR #${decision.number} ${head} — dispatch failed: ${error.message}`)
    }
  }

  if (plan.dispatches.length === 0) {
    console.log(`ci-watchdog: no pull request needs CI (${pullRequests.length} open, cap ${plan.cap})`)
  }
  if (failed) process.exitCode = 1
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
