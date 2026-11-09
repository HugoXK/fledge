#!/usr/bin/env node
// Make the required `review-gate` check at a PR head carry the conclusion its
// newest verdict implies.
//
//   GITHUB_TOKEN=... node scripts/gate-repair.mjs --pr 12
//
// A verdict posted as a comment or as a review does not, by itself, repaint the
// check run that already sits at the head SHA: a run started by `issue_comment`
// lands its checks on the default branch, and a run started by a review only adds
// a check of its own. So this step evaluates the gate (same code as the required
// check, scripts/lib/review-gate.mjs), reads the standing `review-gate` check at
// the head SHA and the workflow runs there, and takes at most one action:
//
//   - a PASS with a failed run still on attempt 1  -> re-run those runs;
//   - a rejection with no red at the SHA           -> re-run the newest Review gate
//                                                     run there (never another
//                                                     workflow's run, which would
//                                                     paint no review-gate check);
//   - nothing to repaint                           -> exit 0, no write.
//
// It never loops: a re-run is attempt 2 and is never a target again, so a second
// identical verdict makes no API write, and a SHA that cannot be repainted exits 1
// with its name instead of re-running forever.

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { evaluateGate } from './lib/review-gate.mjs'
import { apiClient, arg, loadPolicy, pullRequestNumber, readEvent } from './lib/gate-env.mjs'
import { REQUIRED_CONTEXT, isGateRun, repairPlan } from './lib/gate-repair.mjs'

const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
const REPO = process.env.GITHUB_REPOSITORY ?? ''
const API = process.env.GITHUB_API_URL ?? 'https://api.github.com'
const EVENT = process.env.GITHUB_EVENT_PATH ?? ''
const CURRENT_RUN = process.env.GITHUB_RUN_ID ?? ''

function stop(code, message) {
  const line = `gate-repair: ${message}`
  if (code === 0) console.log(line)
  else console.error(line)
  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    // The summary is markdown rendered on the run page, and `message` can carry a
    // response body from the API. A newline there would render as extra lines, so
    // the summary gets one line with C0 controls replaced; the log above keeps the
    // message unchanged, because sanitising a surface must not hide the error.
    const summary = line.replace(/[\u0000-\u001f]+/g, ' ').trim()
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`)
    } catch {
      // The summary is a convenience; it never changes the outcome.
    }
  }
  process.exit(code)
}

if (TOKEN === '') stop(1, 'GITHUB_TOKEN is not set')
if (REPO === '') stop(1, 'GITHUB_REPOSITORY is not set')

const ev = readEvent(EVENT)
const prNumber = pullRequestNumber(ev, arg(process.argv, '--pr', undefined))
if (!Number.isInteger(prNumber) || prNumber <= 0) stop(1, 'cannot determine the pull request number')

const localPolicy = existsSync('.github/agent/review-policy.json') ? JSON.parse(readFileSync('.github/agent/review-policy.json', 'utf8')) : {}
const api = apiClient({ token: TOKEN, base: API, userAgent: 'fledge-gate-repair' })
const policy = await loadPolicy({ api, repo: REPO, ev, eventPath: EVENT, localPolicy }).catch((error) => stop(1, `cannot read the review policy: ${error.message}`))

const outcome = await evaluateGate({ api, repo: REPO, policy, prNumber, tier: arg(process.argv, '--tier', undefined), sha: arg(process.argv, '--sha', undefined) })
if (!outcome.ok && (outcome.kind === 'error' || outcome.kind === 'hold')) {
  // Nothing valid to re-run: an error would only reproduce itself, and a hold is
  // a maintainer decision rather than a verdict. The recorded conclusion stands.
  stop(0, `skipped — ${outcome.message}`)
}
const expected = outcome.ok ? 'success' : 'failure'

const pr = await api(`/repos/${REPO}/pulls/${prNumber}`).catch((error) => stop(1, `cannot read the pull request: ${error.message}`))
const headSha = String(pr.head?.sha ?? '')
if (headSha === '') stop(1, 'the pull request has no head SHA')

// Check runs answer a wrapper object, not a bare list. `filter=latest` is what
// makes a re-run authoritative: without it the superseded failure from before the
// re-run is still returned and would count as a standing red.
const checkRuns = ((await api(`/repos/${REPO}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(REQUIRED_CONTEXT)}&filter=latest&per_page=100`)
  .catch((error) => stop(1, `cannot read the check runs at ${headSha}: ${error.message}`)))?.check_runs ?? [])
  .filter((check) => check.name === REQUIRED_CONTEXT)
const runs = (await api(`/repos/${REPO}/actions/runs?head_sha=${headSha}&per_page=100`)
  .catch((error) => stop(1, `cannot list the workflow runs at ${headSha}: ${error.message}`)))?.workflow_runs ?? []

// A PASS has to know whether each failed run's own gate job failed, so the jobs
// of every candidate run are read before the plan is made. There are only a few
// gate runs per SHA; the list is bounded by that.
const jobs = new Map()
for (const run of runs.filter((candidate) => isGateRun(candidate) && Number(candidate.run_attempt) === 1 && String(candidate.id) !== CURRENT_RUN)) {
  const listed = await api(`/repos/${REPO}/actions/runs/${run.id}/jobs?per_page=100`)
    .catch((error) => stop(1, `cannot read the jobs of run ${run.id}: ${error.message}`))
  jobs.set(run.id, listed?.jobs ?? [])
}

const plan = repairPlan({ expected, checkRuns, runs, jobsFor: (id) => jobs.get(id) ?? [], currentRunId: CURRENT_RUN })
if (plan.action === 'none') stop(0, `nothing to do — ${plan.reason} (${expected} expected at ${headSha})`)
if (plan.action === 'blocked') stop(1, `${headSha} cannot be repainted — ${plan.reason}`)

for (const id of plan.ids) {
  await api(`/repos/${REPO}/actions/runs/${id}/rerun`, { method: 'POST' })
    .catch((error) => stop(1, `cannot re-run ${id}: ${error.message}`))
}
stop(0, `re-ran ${plan.ids.join(', ')} so ${headSha} shows ${expected}`)
