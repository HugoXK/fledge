#!/usr/bin/env node
// #598: name a reviewer-authored commit on the pull request at the push that
// makes it true, instead of inside the job log of a red `review-gate` run hours
// later. `#532`, `#533` and `#618` each spent a review round on a tip that could
// never merge, because the only record of the condition was that log line.
//
//   GITHUB_TOKEN=... GITHUB_REPOSITORY=HugoXK/fledge node scripts/reviewer-commits.mjs --pr 12
//   node scripts/reviewer-commits.mjs --commits-json fixture.json --policy-json policy.json
//
// The rule is not re-implemented here: `reviewerAuthoredCommit` in
// `scripts/lib/review-gate.mjs` decides, so this signal and the required check
// cannot disagree about what counts as a reviewer-authored commit. What changes
// is when a person hears about it.
//
// The policy is read from the base ref, never from the pull request tree, for the
// same reason the gate does it: a pull request must not be able to weaken the rule
// that judges it. A read that fails exits 1 — "could not read" is never "no
// reviewer commits".

import { readFileSync, appendFileSync } from 'node:fs'
import { reviewerAuthoredCommit } from './lib/review-gate.mjs'
import { apiClient, arg, loadPolicy, pullRequestNumber, readEvent } from './lib/gate-env.mjs'

const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
const REPO = process.env.GITHUB_REPOSITORY ?? ''
const API = process.env.GITHUB_API_URL ?? 'https://api.github.com'
const EVENT = process.env.GITHUB_EVENT_PATH ?? ''
const COMMITS_JSON = arg(process.argv, '--commits-json', '')
const POLICY_JSON = arg(process.argv, '--policy-json', '')

function fail(message) {
  console.error(`reviewer-commits: ${message}`)
  // The summary is a file write, so it carries this fixed line only: the commit
  // sha, the reviewer identity and any API error text come from the network and
  // belong in the job log, where `console.error` already puts them verbatim. A
  // summary that echoed them would copy untrusted text into a file. Same shape as
  // `pr-lint`.
  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, 'reviewer-commits: FAIL — see the job log for the commit and identity.\n')
    } catch {
      // The summary is a convenience; the exit code is the verdict.
    }
  }
  process.exit(1)
}

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`cannot read the ${what} fixture ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// One order, two sources: fixtures for the suite, the API in Actions. The
// pagination matters for the same reason it does in the gate — a reviewer commit
// can sit past page 1 of a long branch.
async function liveCommits(api, repo, prNumber) {
  const commits = []
  for (let page = 1; page <= 30; page += 1) {
    const items = await api(`/repos/${repo}/pulls/${prNumber}/commits?per_page=100&page=${page}`)
    if (!Array.isArray(items)) throw new Error('unexpected commits response')
    commits.push(...items)
    if (items.length < 100) break
  }
  return commits
}

let commits
let policy
if (COMMITS_JSON !== '' || POLICY_JSON !== '') {
  if (COMMITS_JSON === '' || POLICY_JSON === '') fail('--commits-json and --policy-json go together')
  commits = readJson(COMMITS_JSON, 'commits')
  policy = readJson(POLICY_JSON, 'policy')
  if (!Array.isArray(commits)) fail(`the commits fixture ${COMMITS_JSON} is not a list`)
} else {
  if (TOKEN === '') fail('GITHUB_TOKEN is not set')
  if (REPO === '') fail('GITHUB_REPOSITORY is not set')
  const ev = readEvent(EVENT)
  const prNumber = pullRequestNumber(ev, arg(process.argv, '--pr', undefined))
  if (!Number.isInteger(prNumber) || prNumber <= 0) fail('cannot determine the pull request number')
  const api = apiClient({ token: TOKEN, base: API, userAgent: 'fledge-reviewer-commits' })
  policy = await loadPolicy({
    api,
    repo: REPO,
    ev,
    eventPath: EVENT,
    localPolicy: JSON.parse(readFileSync('.github/agent/review-policy.json', 'utf8')),
  }).catch((error) => fail(`cannot read the review policy from the base ref: ${error instanceof Error ? error.message : String(error)}`))
  commits = await liveCommits(api, REPO, prNumber).catch((error) => fail(
    `cannot read the pull request commits, so this tip cannot be called independent of the reviewer: ${error instanceof Error ? error.message : String(error)}`,
  ))
}

const authored = reviewerAuthoredCommit(commits, policy)
const count = Array.isArray(commits) ? commits.length : 0
if (authored === null) {
  console.log(`reviewer-commits: no reviewer-authored commit in ${count} commit(s)`)
  process.exit(0)
}

const at = authored.sha === '' ? '' : `${authored.sha}`
fail(`reviewer-authored commit${at === '' ? '' : ` ${at}`} by ${authored.identity}; re-author it before review, because the reviewer identity cannot PASS work it wrote`)
