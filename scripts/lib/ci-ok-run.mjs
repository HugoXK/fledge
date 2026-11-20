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

/** A superseded run is replaced by a newer one for the same head. */
export function shouldPublish(run) {
  if (run === null || typeof run !== 'object') return false
  return run.conclusion !== 'cancelled'
}

/** The check run body: a reader sees the same lines the in-run job used to log.
 *  Every field is either a literal from this module, a validated number, or a
 *  string the evaluator formatted from the API's job results — no file read
 *  reaches the request. */
export function checkRunPayload({ headSha, result, runId, runUrl, required = REQUIRED_JOBS, policy }) {
  if (typeof headSha !== 'string' || !/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error('the check run needs the judged head as a 40-character lowercase hex sha')
  }
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    throw new Error('the check run needs the judged run id as a positive integer')
  }
  if (policy !== undefined) {
    if (typeof policy?.text !== 'string' || !/^policy: required=[0-9a-f]{12} gate=[0-9a-f]{40}$/.test(policy.text)) {
      throw new Error('a policy identity must carry a well-formed policy line')
    }
  }
  const title = result.ok
    ? `every required job passed (${String(required.length)} required)`
    : `${String(result.problems.length)} required job(s) did not pass`
  const source = typeof runUrl === 'string' && RUN_URL.test(runUrl) ? runUrl : undefined
  const summary = [
    `Verdict computed from the default branch's copy of the gate, not from the pull request's \`ci.yml\` (run #${String(runId)}${source === undefined ? '' : `, ${source}`}).`,
    '',
    // #1116: the policy this verdict was computed under, so a later required-set
    // change is visible as a hash mismatch rather than inferred from a title.
    ...(policy === undefined ? [] : [policy.text, '']),
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
