#!/usr/bin/env node
// #1169: the review gate is decided only by events a person or a verdict
// produces — `pull_request`, `pull_request_review`, `merge_group`,
// `issue_comment` — so a `pr-lint` run that settles *after* the gate has finished
// can never bring it back. `scripts/gate-repair.mjs` already knows how to repaint
// the head; nothing woke it. This entrypoint is the missing trigger: the
// `review-gate-retrigger` job runs it on the lint's completion, it resolves the
// pull request the finished run belongs to, and the job hands that number to the
// repair step.
//
// What is decided here rather than in the job's `if:`:
//
//  - The conclusion. `pr-lint.yml` cancels a superseded run (its concurrency
//    group is the pull request number), so the run that replaced it owns the
//    answer — the same rule `ci-ok` applies to a cancelled `CI` run. A
//    `cancelled` completion therefore resolves nothing and makes no API call at
//    all, and a repair started for it would repaint a result nobody stands behind.
//  - The pull request. The `workflow_run` payload's `pull_requests` array is empty
//    for a fork's pull request and can be stale for a head pushed before the run
//    started, so the lookup is by head sha through the API.
//
// The fork guard stays in the job's `if:` and is not repeated here: it has to stop
// the job before it can use `actions: write`, and a script that has already
// started is too late to be that guard.

import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { apiClient, readEvent } from './lib/gate-env.mjs'

// A finished run whose result the repair may act on. `cancelled` and `skipped`
// are absent on purpose: the replacing run, or the event the job never ran for,
// owns the answer.
export const TRIGGERING_CONCLUSIONS = ['success', 'failure', 'timed_out']

// Why this completion is not a trigger, or null when it is. Exported so the
// refusal is testable without a workflow run and so the line the job prints names
// the same reason the test asserts.
export function refusalFor({ eventName, event, repository }) {
  if (eventName !== 'workflow_run') return `the event is ${String(eventName)}, not a workflow_run`
  const run = event?.workflow_run ?? {}
  if (run.event !== 'pull_request') return `the finished run was started by ${String(run.event)}, not a pull request`
  const headRepository = String(run.head_repository?.full_name ?? '')
  if (headRepository !== repository) return `the finished run is from ${headRepository === '' ? 'an unnamed repository' : headRepository}, not ${repository}`
  const conclusion = String(run.conclusion ?? '')
  if (!TRIGGERING_CONCLUSIONS.includes(conclusion)) {
    return `the finished run concluded ${conclusion === '' ? '(none)' : conclusion}; only ${TRIGGERING_CONCLUSIONS.join(', ')} wake the gate`
  }
  return null
}

// The open pull request whose head is exactly this sha. `GET
// /commits/{sha}/pulls` returns the pull requests a commit belongs to; the state
// and head tests keep a merged or superseded one from being repaired. Two open
// pull requests at one head is a shape the trigger names instead of guessing.
export async function resolvePullRequest({ api, repo, headSha }) {
  const pulls = await api(`/repos/${repo}/commits/${headSha}/pulls`)
  const numbers = [
    ...new Set(
      (Array.isArray(pulls) ? pulls : [])
        .filter((pull) => pull?.state === 'open' && pull?.head?.sha === headSha)
        .map((pull) => Number(pull.number))
        .filter((number) => Number.isInteger(number) && number > 0),
    ),
  ]
  if (numbers.length === 0) return null
  if (numbers.length > 1) throw new Error(`${numbers.length} open pull requests at ${headSha}: ${numbers.join(', ')}`)
  return numbers[0]
}

// One call for the whole decision, so a test can count the reads a refused
// completion performs (zero) instead of trusting the returned number.
export async function execRetrigger({ eventName, event, repository, api }) {
  const refusal = refusalFor({ eventName, event, repository })
  if (refusal !== null) return { number: null, reason: refusal }
  const headSha = String(event?.workflow_run?.head_sha ?? '')
  if (!/^[0-9a-f]{40}$/.test(headSha)) return { number: null, reason: `the finished run names no head sha (${headSha === '' ? 'empty' : headSha})` }
  const number = await resolvePullRequest({ api, repo: repository, headSha })
  if (number === null) return { number: null, reason: `no open pull request at ${headSha}` }
  return { number, reason: `pull request ${number} at ${headSha}` }
}

async function main() {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
  const repository = process.env.GITHUB_REPOSITORY ?? ''
  if (token === '' || repository === '') {
    console.error('review-gate-retrigger: GITHUB_TOKEN or GITHUB_REPOSITORY is not set')
    process.exit(1)
  }
  const event = readEvent(process.env.GITHUB_EVENT_PATH ?? '')
  const api = apiClient({ token, base: process.env.GITHUB_API_URL ?? 'https://api.github.com', userAgent: 'review-gate-retrigger' })
  const result = await execRetrigger({
    eventName: process.env.GITHUB_EVENT_NAME ?? '',
    event,
    repository,
    api,
  }).catch((error) => {
    console.error(`review-gate-retrigger: ${error.message}`)
    process.exit(1)
  })
  if (result.number === null) {
    // A refusal is not a failure: the workflow_run trigger fires for every
    // completion of the lint, including the ones whose answer another run owns.
    console.log(`review-gate-retrigger: nothing to retrigger — ${result.reason}`)
    process.exit(0)
  }
  const run = event?.workflow_run ?? {}
  console.log(`review-gate-retrigger: run ${String(run.id)} concluded ${String(run.conclusion)} — repairing ${result.reason}`)
  if (process.env.GITHUB_OUTPUT !== undefined) appendFileSync(process.env.GITHUB_OUTPUT, `number=${result.number}\n`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
