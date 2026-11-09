#!/usr/bin/env node
// Read the newest conclusion at a PR head and decide whether a T2/T3 tip may
// enter the merge queue.
//
//   GITHUB_TOKEN=... node scripts/review-gate.mjs --pr 12
//   GITHUB_TOKEN=... node scripts/review-gate.mjs --tier T2   # uses the event
//
// The decision itself lives in scripts/lib/review-gate.mjs, so the required
// check and the rollup-repair step (scripts/gate-repair.mjs) judge a tip with one
// implementation. This file only wires the event, the API and the exit code.
//
// By design, not a bug: a PASS that arrives after a REQUEST_CHANGES at the same
// SHA still exits 1 here, because a verdict is only read at the tip and the tip
// did not move. That SHA needs a new commit, or one run at that SHA re-run
// (scripts/gate-repair.mjs), before the required check can turn green.
//
// Nothing from the pull request tree is used: the policy comes from the base ref,
// the tier from the API and the verdicts from the API.

import { readFileSync, appendFileSync } from 'node:fs'
import { evaluateGate } from './lib/review-gate.mjs'
import { apiClient, arg, loadPolicy, pullRequestNumber, readEvent } from './lib/gate-env.mjs'

const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
const REPO = process.env.GITHUB_REPOSITORY ?? ''
const API = process.env.GITHUB_API_URL ?? 'https://api.github.com'
const EVENT = process.env.GITHUB_EVENT_PATH ?? ''

function fail(message) {
  console.error(`review-gate: ${message}`)
  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `review-gate: FAIL — ${message}\n`)
  }
  process.exit(1)
}

const ev = readEvent(EVENT)
const prNumber = pullRequestNumber(ev, arg(process.argv, '--pr', undefined))

if (TOKEN === '') fail('GITHUB_TOKEN is not set')
if (REPO === '') fail('GITHUB_REPOSITORY is not set')
if (!Number.isInteger(prNumber) || prNumber <= 0) fail('cannot determine the pull request number')

const api = apiClient({ token: TOKEN, base: API, userAgent: 'fledge-review-gate' })
const policy = await loadPolicy({
  api,
  repo: REPO,
  ev,
  eventPath: EVENT,
  localPolicy: JSON.parse(readFileSync('.github/agent/review-policy.json', 'utf8')),
}).catch((error) => fail(`cannot read the review policy: ${error instanceof Error ? error.message : String(error)}`))

const outcome = await evaluateGate({
  api,
  repo: REPO,
  policy,
  prNumber,
  tier: arg(process.argv, '--tier', undefined),
  sha: arg(process.argv, '--sha', undefined),
})

const line = `review-gate: ${outcome.ok ? 'PASS' : 'FAIL'} — ${outcome.message}`
if (outcome.ok) console.log(line)
else console.error(line)
if (process.env.GITHUB_STEP_SUMMARY !== undefined) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`)
process.exit(outcome.ok ? 0 : 1)
