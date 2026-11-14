#!/usr/bin/env node
// Which open pull requests need a fresh CI run because no workflow ever started
// for their head SHA.
//
// Pure: the caller supplies the open pull requests and the check runs and
// workflow runs it read from the API, so every decision is executable in the
// suite without a token, a repository or a clock.
//
// This is a backstop, not the primary path. A branch pushed or a pull request
// opened with the automatic `GITHUB_TOKEN` starts no `push` or `pull_request`
// workflow; a ref written through the Git data API can leave the same shape. A
// pull request with zero check runs and no live `CI` run is the signature, and
// dispatching `ci.yml` at its head branch is the repair.
//
// Invariants:
//   - only a same-repo pull request is a target. A fork ref is not a ref this
//     repository's token can dispatch against.
//   - any check run at the head SHA means a workflow already reached the tip, so
//     the watchdog leaves it alone even when the conclusion is red.
//   - a queued or in-progress `CI` run is not duplicated.
//   - the dispatch list is capped per tick, so a repository-wide outage cannot
//     start an unbounded number of full CI runs from one pass.

export const CI_WORKFLOW_FILE = 'ci.yml'
export const CI_WORKFLOW_NAME = 'CI'
export const CI_WORKFLOW_PATH = '.github/workflows/ci.yml'
export const DEFAULT_DISPATCH_LIMIT = 5

const MAX_DISPATCH_LIMIT = 20
const SHA = /^[0-9a-f]{40}$/
const ACTIVE_STATUSES = new Set(['queued', 'in_progress', 'requested', 'waiting', 'pending'])

function repoOf(pr, side) {
  return String(pr?.[side]?.repo?.full_name ?? '')
}

export function isSameRepoPullRequest(pr) {
  const head = repoOf(pr, 'head')
  const base = repoOf(pr, 'base')
  return head !== '' && base !== '' && head === base
}

export function isCiRun(run) {
  return String(run?.name ?? '') === CI_WORKFLOW_NAME || String(run?.path ?? '') === CI_WORKFLOW_PATH
}

export function activeCiRun(runs) {
  const list = Array.isArray(runs) ? runs : []
  return list.find((run) => isCiRun(run) && ACTIVE_STATUSES.has(String(run?.status ?? ''))) ?? null
}

function decision(pr, action, reason, extra = {}) {
  return {
    action,
    reason,
    number: Number(pr?.number ?? 0),
    branch: String(pr?.head?.ref ?? ''),
    sha: String(pr?.head?.sha ?? ''),
    ...extra,
  }
}

export function classifyPullRequest({ pr, checks = [], runs = [] } = {}) {
  if (pr?.state !== undefined && String(pr.state) !== 'open') return decision(pr, 'skip', 'not-open')
  if (!isSameRepoPullRequest(pr)) return decision(pr, 'skip', 'fork')
  if (!Number.isInteger(Number(pr?.number)) || Number(pr?.number) <= 0) return decision(pr, 'skip', 'no-number')
  if (!SHA.test(String(pr?.head?.sha ?? '')) || String(pr?.head?.ref ?? '') === '') {
    return decision(pr, 'skip', 'no-head')
  }
  if (Array.isArray(checks) && checks.length > 0) return decision(pr, 'skip', 'has-checks')
  const active = activeCiRun(runs)
  if (active !== null) return decision(pr, 'skip', 'active-ci', { activeRunId: Number(active?.id ?? 0) })
  return decision(pr, 'dispatch', 'no-checks')
}

function capOf(limit) {
  const wanted = Number(limit)
  if (!Number.isFinite(wanted) || wanted < 0) return DEFAULT_DISPATCH_LIMIT
  return Math.min(MAX_DISPATCH_LIMIT, Math.trunc(wanted))
}

export function planCiWatchdog({ entries = [], limit = DEFAULT_DISPATCH_LIMIT } = {}) {
  const cap = capOf(limit)
  const list = Array.isArray(entries) ? entries : []
  const decisions = list.map((entry) => classifyPullRequest(entry))
  const dispatches = decisions
    .filter((entry) => entry.action === 'dispatch')
    .sort((a, b) => a.number - b.number || a.branch.localeCompare(b.branch))
    .slice(0, cap)
    .map(({ number, branch, sha }) => ({ number, branch, sha }))
  return { dispatches, decisions, cap }
}
