import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_DISPATCH_LIMIT,
  planCiWatchdog,
} from '../scripts/lib/ci-watchdog.mjs'
import type {
  WatchdogCheckRun,
  WatchdogEntry,
  WatchdogPullRequest,
  WatchdogWorkflowRun,
} from '../scripts/lib/ci-watchdog.mjs'

const SHA = 'a'.repeat(40)

function sameRepoPr(number = 1, sha = SHA): WatchdogPullRequest {
  return {
    number,
    state: 'open',
    head: { ref: `feature/${number}`, sha, repo: { full_name: 'owner/repo' } },
    base: { repo: { full_name: 'owner/repo' } },
  }
}

function forkPr(number = 1, sha = SHA): WatchdogPullRequest {
  return {
    number,
    state: 'open',
    head: { ref: `feature/${number}`, sha, repo: { full_name: 'contributor/repo' } },
    base: { repo: { full_name: 'owner/repo' } },
  }
}

function entry(
  pr: WatchdogPullRequest,
  checks: WatchdogCheckRun[] = [],
  runs: WatchdogWorkflowRun[] = [],
): WatchdogEntry {
  return { pr, checks, runs }
}

test('an open same-repo pull request with no checks is selected for dispatch', () => {
  const plan = planCiWatchdog({ entries: [entry(sameRepoPr(614))] })
  assert.deepEqual(plan.dispatches, [{ number: 614, branch: 'feature/614', sha: SHA }])
  assert.equal(plan.decisions[0]?.action, 'dispatch')
})

test('a fork pull request is skipped, because its ref cannot be dispatched', () => {
  const plan = planCiWatchdog({ entries: [entry(forkPr(7))] })
  assert.deepEqual(plan.dispatches, [])
  assert.equal(plan.decisions[0]?.reason, 'fork')
})

test('a pull request that already has a check run is skipped', () => {
  const checks: WatchdogCheckRun[] = [{ name: 'ci-ok', status: 'completed', conclusion: 'failure' }]
  const plan = planCiWatchdog({ entries: [entry(sameRepoPr(8), checks)] })
  assert.deepEqual(plan.dispatches, [])
  assert.equal(plan.decisions[0]?.reason, 'has-checks')
})

test('a pull request with a queued or in-progress CI run is skipped', () => {
  for (const status of ['queued', 'in_progress']) {
    const runs: WatchdogWorkflowRun[] = [{ name: 'CI', status }]
    const plan = planCiWatchdog({ entries: [entry(sameRepoPr(9), [], runs)] })
    assert.deepEqual(plan.dispatches, [], status)
    assert.equal(plan.decisions[0]?.reason, 'active-ci', status)
  }
})

test('a completed CI run is not active, so a zero-check pull request is still selected', () => {
  const runs: WatchdogWorkflowRun[] = [{ name: 'CI', status: 'completed', conclusion: 'success' }]
  const plan = planCiWatchdog({ entries: [entry(sameRepoPr(10), [], runs)] })
  assert.deepEqual(plan.dispatches, [{ number: 10, branch: 'feature/10', sha: SHA }])
})

test('a pull request for another workflow run is not treated as active CI', () => {
  const runs: WatchdogWorkflowRun[] = [{ name: 'Review gate', status: 'in_progress' }]
  const plan = planCiWatchdog({ entries: [entry(sameRepoPr(11), [], runs)] })
  assert.equal(plan.decisions[0]?.action, 'dispatch')
})

test('the per-tick cap bounds the dispatch list and leaves the rest for the next tick', () => {
  const entries = Array.from({ length: 8 }, (_, index) => entry(sameRepoPr(index + 1)))
  const plan = planCiWatchdog({ entries, limit: 3 })
  assert.equal(plan.dispatches.length, 3)
  assert.deepEqual(plan.dispatches.map((dispatch) => dispatch.number), [1, 2, 3])
  assert.equal(plan.decisions.filter((decision) => decision.action === 'dispatch').length, 8)
})

test('the default cap is five even when more pull requests are missing CI', () => {
  const entries = Array.from({ length: 9 }, (_, index) => entry(sameRepoPr(index + 1)))
  const plan = planCiWatchdog({ entries })
  assert.equal(DEFAULT_DISPATCH_LIMIT, 5)
  assert.equal(plan.dispatches.length, DEFAULT_DISPATCH_LIMIT)
})

test('the watchdog workflow runs on a schedule and a manual dispatch with the narrow permissions', () => {
  const workflow = readFileSync('.github/workflows/ci-watchdog.yml', 'utf8')
  assert.match(workflow, /^name: CI watchdog$/m)
  assert.match(workflow, /schedule:/)
  assert.match(workflow, /- cron: '\*\/10 \* \* \* \*'/)
  assert.match(workflow, /workflow_dispatch:/)
  assert.match(workflow, /^permissions:\s*\n\s*contents: read$/m)
  assert.match(workflow, /pull-requests: read/)
  assert.match(workflow, /actions: write/)
  assert.match(workflow, /node scripts\/ci-watchdog\.mjs/)
  for (const line of workflow.split('\n').filter((entry) => entry.trim().startsWith('run:'))) {
    assert.equal(line.includes('${{'), false, `a run body interpolates an expression: ${line.trim()}`)
  }
})
