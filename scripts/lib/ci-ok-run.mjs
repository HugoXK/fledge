// #855: the verdict that gates a merge is computed outside the run it judges.
//
// `ci-ok` used to be a job inside `ci.yml` and nothing else, and GitHub takes a
// `pull_request` workflow file from the pull request's own tree. A head could
// therefore rewrite the aggregate's `run:` line to `exit 0` and produce a green
// verdict about itself; the base-tree checkout covered the scripts, not the
// workflow that calls them.
//
// `ci-ok-publish.yml` runs on `workflow_run`, so its file always comes from the
// default branch, and it publishes the `ci-ok` check run itself. This module is
// the part that has to be right: the finished run reports job *names*, not the
// `needs` keys `scripts/ci-ok.mjs` evaluates, and the head's own aggregate job
// is evidence about nothing.
//
// The rule that keeps it honest: a required job is matched by the name the base
// branch's copy of `ci.yml` gives it. A head that deletes or renames one is a
// missing required job, which is red — the same answer as deleting it from
// `needs` inside the run.

import { REQUIRED_JOBS, SKIP_WHEN, SKIPPABLE_ON, evaluate } from '../ci-ok.mjs'

/** The required context this module's verdict is published under. */
export const REQUIRED_CHECK = 'ci-ok'

/** The name the in-run aggregate takes once the publisher is installed. Either
 *  name answers `null` below: the head's own aggregate is never evidence. */
export const HEAD_AGGREGATE_JOB = 'ci-ok-head'

/** The one status a published check run carries. The API takes a fixed
 *  vocabulary; this module writes the literal rather than forwarding whatever a
 *  finished run reported. */
export const CHECK_STATUS = 'completed'

/** The only conclusions this publisher may send, keyed by its own verdict. */
export const CHECK_CONCLUSIONS = Object.freeze({ pass: 'success', fail: 'failure' })

// The run id arrives as text (an argument or an env var), so it is parsed here
// once, as digits only, and never becomes part of a request path unvalidated.
const RUN_ID = /^[1-9][0-9]{0,17}$/

// Only a plain https URL may be quoted in the summary.
const RUN_URL = /^https:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]{1,300}$/

/**
 * The run this publisher judges, from `--run <id>` or `CI_OK_RUN_ID`.
 * `ci-ok-publish.yml` sets the variable from `github.event.workflow_run.id`, so
 * the ids come from the workflow that started the job and no file is read.
 */
export function runIdFrom(input = {}) {
  const args = Array.isArray(input.args) ? input.args : []
  const env = input.env ?? {}
  const index = args.indexOf('--run')
  const raw = index !== -1 && args[index + 1] !== undefined
    ? args[index + 1]
    : typeof env.CI_OK_RUN_ID === 'string' ? env.CI_OK_RUN_ID : ''
  if (typeof raw !== 'string' || !RUN_ID.test(raw)) {
    throw new Error(`the triggered run id must be a positive decimal integer, got ${JSON.stringify(String(raw).slice(0, 40))}`)
  }
  const id = Number(raw)
  if (!Number.isSafeInteger(id)) throw new Error('the triggered run id is not a safe integer')
  return id
}

// A matrix leg displays as `test (24)` while `needs` calls it `test`.
const MATRIX_TEST = /^test \(.+\)$/

/**
 * The `needs` key a finished run's job name stands for, or `null` when the job
 * is not one of the required jobs. `ci-ok`/`ci-ok-head` answer `null` on
 * purpose: the head's own aggregate cannot be evidence for the aggregate.
 */
export function jobKey(name, required = REQUIRED_JOBS) {
  if (typeof name !== 'string' || name === '') return null
  if (required.includes(name)) return name
  if (MATRIX_TEST.test(name) && required.includes('test')) return 'test'
  return null
}

// A job that has not finished, or reports no conclusion, is not a pass.
function resultOf(job) {
  if (job === null || typeof job !== 'object') return 'missing'
  if (job.status !== 'completed') return 'missing'
  return typeof job.conclusion === 'string' && job.conclusion !== '' ? job.conclusion : 'missing'
}

// Two legs of one required job must not be able to hide each other's red: the
// worse of them is the one reported. `success` yields to anything, `skipped`
// yields to a real failure, and the first real failure stands.
function worse(left, right) {
  if (left === 'success') return right
  if (right === 'success') return left
  if (left === 'skipped') return right
  if (right === 'skipped') return left
  return left
}

/**
 * Build the `needs` shape `scripts/ci-ok.mjs` evaluates from a finished run's
 * job list. A required job absent from the list stays absent, which the
 * evaluator already reports as missing.
 */
export function needsFromJobs(jobs, required = REQUIRED_JOBS) {
  const needs = {}
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const key = jobKey(job?.name, required)
    if (key === null) continue
    const result = resultOf(job)
    needs[key] = { result: needs[key] === undefined ? result : worse(needs[key].result, result) }
  }
  return needs
}

/**
 * The verdict itself: the base branch's required list over the finished run's
 * job results, with the base branch's classifier deciding whether a skipped
 * job was inapplicable or simply never ran.
 */
export function verdict(input) {
  const required = input.required ?? REQUIRED_JOBS
  const needs = needsFromJobs(input.jobs, required)
  const { lines, problems } = evaluate(needs, {
    required,
    skippable: SKIPPABLE_ON,
    skipWhen: SKIP_WHEN,
    eventName: typeof input.eventName === 'string' ? input.eventName : '',
    changes: input.changes ?? {},
  })
  return { needs, lines, problems, ok: problems.length === 0 }
}

/** The base shas a `pull_request` run says it was measured against. A run that
 *  names none, or more than one, cannot be ranged and is a finding of its own. */
export function baseShas(run) {
  const pulls = Array.isArray(run?.pull_requests) ? run.pull_requests : []
  const shas = new Set()
  for (const pull of pulls) {
    const sha = pull?.base?.sha
    if (typeof sha === 'string' && sha !== '') shas.add(sha)
  }
  return [...shas]
}

/** A `pull_request` run whose payload no longer names exactly one base.
 *  GitHub produces that shape when the pull request merges while its run is in
 *  flight: the run then reports an empty `pull_requests` array, and the base it
 *  was measured against is gone from the payload rather than from the diff. */
export function lostItsBase(run) {
  return run !== null && typeof run === 'object' && run.event === 'pull_request' && baseShas(run).length !== 1
}

/** The merged pull request a candidate describes, or `null` when the candidate
 *  is not one. A closed pull request that was not merged answers `null` on
 *  purpose: its head still had a merge candidate when the run started. */
export function mergedPullRequestOf(candidate) {
  if (candidate === null || typeof candidate !== 'object') return null
  if (typeof candidate.merged_at !== 'string' || candidate.merged_at === '') return null
  const number = Number.isSafeInteger(candidate.number) && candidate.number > 0 ? candidate.number : null
  return { number, mergedAt: candidate.merged_at }
}

/** The reasons a finished run publishes no verdict. Only two of them are not
 *  findings: a run the platform cancelled, and a pull request run whose pull
 *  request merged away before the verdict was computed. */
export const SKIP_REASONS = Object.freeze({
  superseded: 'superseded',
  merged: 'pull-request-merged',
  notARun: 'not-a-run',
})

/**
 * Why this finished run must publish no verdict, or `null` when it must be
 * judged. `mergedCandidate` is the pull request the caller looked up for the
 * head; it is consulted only for the shape that lost its own base, so a run
 * that can still be ranged is always judged — and a lost base with no merged
 * pull request behind it stays a red, because an unreadable base is a finding.
 */
export function skipReason(run, mergedCandidate = null) {
  if (run === null || typeof run !== 'object') return SKIP_REASONS.notARun
  if (run.conclusion === 'cancelled') return SKIP_REASONS.superseded
  if (lostItsBase(run) && mergedPullRequestOf(mergedCandidate) !== null) return SKIP_REASONS.merged
  return null
}

/** The log line's explanation, one branch per reason, so a reader can tell a
 *  skip from a failure and which branch of the decision fired. */
export function skipDetail(run, reason, mergedCandidate = null) {
  if (reason === SKIP_REASONS.superseded) {
    return `concluded ${String(run?.conclusion)}; a newer run for this head supersedes it`
  }
  if (reason === SKIP_REASONS.merged) {
    const merged = mergedPullRequestOf(mergedCandidate)
    const number = merged === null || merged.number === null ? 'unknown number' : `#${String(merged.number)}`
    return `pull request ${number} merged at ${String(merged?.mergedAt)} while the run was in flight; no merge candidate is left to judge`
  }
  return 'the trigger is not a finished run'
}

/** Whether a finished run publishes a verdict at all: a superseded run is
 *  replaced by a newer one for the same head, and a pull request that merged
 *  mid-run has no candidate left to judge (#1117). Everything else is judged. */
export function shouldPublish(run, mergedCandidate = null) {
  return skipReason(run, mergedCandidate) === null
}

/** The check run body: a reader sees the same lines the in-run job used to log.
 *  Every field is either a literal from this module, a validated number, or a
 *  string the evaluator formatted from the API's job results — no file read
 *  reaches the request. */
export function checkRunPayload({ headSha, result, runId, runUrl, required = REQUIRED_JOBS }) {
  if (typeof headSha !== 'string' || !/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error('the check run needs the judged head as a 40-character lowercase hex sha')
  }
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    throw new Error('the check run needs the judged run id as a positive integer')
  }
  const title = result.ok
    ? `every required job passed (${String(required.length)} required)`
    : `${String(result.problems.length)} required job(s) did not pass`
  const source = typeof runUrl === 'string' && RUN_URL.test(runUrl) ? runUrl : undefined
  const summary = [
    `Verdict computed from the default branch's copy of the gate, not from the pull request's \`ci.yml\` (run #${String(runId)}${source === undefined ? '' : `, ${source}`}).`,
    '',
    '```',
    ...result.lines,
    ...result.problems,
    '```',
  ].join('\n')
  return {
    name: REQUIRED_CHECK,
    head_sha: headSha,
    status: CHECK_STATUS,
    conclusion: result.ok ? CHECK_CONCLUSIONS.pass : CHECK_CONCLUSIONS.fail,
    output: { title, summary },
  }
}
