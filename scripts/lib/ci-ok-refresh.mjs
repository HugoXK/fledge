// #1116: a green `ci-ok` is a statement about the policy of the moment it was
// computed, and nothing recomputes it when the required set grows. The publisher
// (`ci-ok-run.mjs`) only runs when a `CI` run completes, so a head whose verdict
// predates a required job keeps its green forever — and a head that renames
// `name: CI` never gets a publisher verdict at all (#1108 hole 2).
//
// This module is the decision half of the out-of-band scanner: given the open
// pull request's head, its check runs, whether the CI workflow finished there and
// whether a publisher run is still in flight, it says whether a red `ci-ok` must
// be published and why. Pure: no network, no clock, no file. The scanner itself
// (`scripts/ci-ok-refresh.mjs`) only fetches and posts.
//
// Two shapes are verdicts: one that names the policy it was computed under
// (`policyIdentity`), and the legacy shape written before that line existed, which
// names no policy but lists the jobs it judged — so it is compared by coverage of
// the current required set rather than by identity. The in-run aggregate is
// neither: it carries no policy line and lists no job, so a head in the window
// between CI completing and the publisher writing is left alone (that window is
// the state the first cut of this module reddened), and a head the publisher never
// reaches is a missing verdict rather than an unreadable one.

import { createHash } from 'node:crypto'

import { REQUIRED_JOBS } from '../ci-ok.mjs'

/** The check run the scanner answers for. */
export const REFRESH_CHECK = 'ci-ok'

/** The line a verdict uses to name the policy it was computed under. */
const POLICY_LINE = /^policy: required=([0-9a-f]{12}) gate=([0-9a-f]{40})$/m

/** A summary line the publisher writes for a job it judged. */
const JOB_LINE = /^([a-z0-9][a-z0-9-]*): (?:success|failure|cancelled|skipped|missing)$/m

const SHA = /^[0-9a-f]{40}$/

function hashOf(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

/**
 * The policy the current default branch defines: a hash of the required-job list
 * (order included — the publisher's order is the reader's) and the blob sha of the
 * evaluator that applies it. Both are stable across runs of the same policy and
 * change when either half does.
 */
export function policyIdentity({ required = REQUIRED_JOBS, gateSha } = {}) {
  if (!Array.isArray(required) || required.length === 0) throw new Error('the required-job list is empty')
  if (typeof gateSha !== 'string' || !SHA.test(gateSha)) throw new Error('the gate blob must be a 40-character lowercase hex sha')
  const requiredHash = hashOf(required.join('\n'))
  return { requiredHash, gateSha, text: `policy: required=${requiredHash} gate=${gateSha}` }
}

/** The identity a published verdict names, or null when it names none. */
export function parsePolicyIdentity(summary) {
  const match = POLICY_LINE.exec(typeof summary === 'string' ? summary : '')
  if (match === null) return null
  return { requiredHash: match[1], gateSha: match[2] }
}

/** The job names a published verdict lists, in the order it listed them. */
export function jobsOf(summary) {
  const text = typeof summary === 'string' ? summary : ''
  const names = []
  for (const line of text.split('\n')) {
    const match = JOB_LINE.exec(line)
    if (match !== null && !names.includes(match[1])) names.push(match[1])
  }
  return names
}

function completedAt(check) {
  const at = Date.parse(String(check?.completed_at ?? ''))
  return Number.isFinite(at) ? at : -1
}

/**
 * Split the completed `ci-ok` runs into the ones that can support a judgement and
 * the ones that are only the in-run aggregate.
 *
 * A verdict is either a run that names the policy it was computed under, or the
 * legacy shape the publisher wrote before that line existed: no policy line, but a
 * job list. Anything else carrying this name — the aggregate `.github/workflows/
 * ci.yml:808` publishes, whose summary is empty — is a second producer of the same
 * context, not a verdict: #855 removed it as evidence, and judging it would redden
 * every legal head in the window between CI completing and the publisher writing.
 */
function classifyVerdicts(checks) {
  const list = Array.isArray(checks) ? checks : []
  const verdicts = []
  let aggregates = 0
  for (const entry of list) {
    if (entry?.name !== REFRESH_CHECK || entry?.status !== 'completed') continue
    const summary = entry?.output?.summary
    const published = parsePolicyIdentity(summary)
    const jobs = jobsOf(summary)
    if (published === null && jobs.length === 0) {
      aggregates += 1
      continue
    }
    verdicts.push({ entry, published, jobs })
  }
  return { verdicts, aggregates }
}

function newestOf(candidates) {
  return candidates.reduce((newest, candidate) => (completedAt(candidate.entry) > completedAt(newest.entry) ? candidate : newest))
}

/**
 * Publish or skip, with the reason a reader can act on.
 *
 * `ciCompleted` is whether a run of `.github/workflows/ci.yml` finished for this
 * head — not whether a run named `CI` finished, because the name is the head's to
 * change. That distinction is what closes #1108 hole 2: a finished CI workflow
 * with no published verdict is a missing verdict, not a head still warming up.
 *
 * `publisherPending` is whether a `ci-ok-publish.yml` run for this head is queued
 * or in progress. While it is, the only `ci-ok` on the head is the in-run
 * aggregate and the verdict is imminent, so the decision is to skip; publishing
 * red there would be permanent, because every check run at the head sha counts.
 *
 * A verdict that names no policy is the legacy shape written before the policy
 * line existed. It is judged by the jobs it lists: covering the current required
 * set makes it current (`legacy-current`, skipped), missing one makes it
 * `stale-policy` naming that job. That is what keeps the first sweep after this
 * module lands from reddening heads whose verdict predates the line but is still
 * correct — the release pull request holding a 20-of-20 green is the live case.
 */
export function refreshDecision({ headSha, policy, checks, ciCompleted, publisherPending = false }) {
  if (typeof headSha !== 'string' || !SHA.test(headSha)) throw new Error('the head must be a 40-character lowercase hex sha')
  if (policy === null || typeof policy !== 'object' || typeof policy.requiredHash !== 'string' || typeof policy.gateSha !== 'string') {
    throw new Error('the current policy identity is required')
  }
  if (ciCompleted !== true) {
    return { publish: false, reason: 'awaiting-ci', detail: 'the CI workflow has not finished for this head, so there is no verdict to judge yet' }
  }
  if (publisherPending === true) {
    // A `ci-ok-publish.yml` run is queued or running for this head: its verdict is
    // about to be written, and the only `ci-ok` that exists now is the in-run
    // aggregate. Publishing red here would be permanent on this repo's rule —
    // every check run at the head sha counts and a later green cannot retire it —
    // so the safe answer is to wait for the verdict instead of judging its shadow.
    return {
      publish: false,
      reason: 'publisher-pending',
      detail: 'a ci-ok-publish run is queued or in progress for this head, so its verdict is imminent and the in-run aggregate is not judged in the meantime',
    }
  }
  const { verdicts, aggregates } = classifyVerdicts(checks)
  const newest = verdicts.length === 0 ? null : newestOf(verdicts)
  if (newest === null) {
    return {
      publish: true,
      reason: 'no-published-verdict',
      detail:
        aggregates === 0
          ? 'the CI workflow finished for this head and no published ci-ok exists: the publisher never ran for it (a renamed workflow name evades it), so there is no verdict to merge on'
          : `the CI workflow finished for this head and no published ci-ok exists: the ${aggregates === 1 ? 'only ci-ok here is the in-run aggregate' : `only ${String(aggregates)} ci-ok runs here are in-run aggregates`}, which names no policy and lists no job, so it is not evidence, and no publisher run is queued or in progress`,
    }
  }
  const { entry: verdict, published, jobs } = newest
  const ran = new Set(jobs)
  const absent = REQUIRED_JOBS.filter((name) => !ran.has(name))
  const absentText = absent.length === 0 ? 'no required job is absent from its job list' : `jobs required now but absent from that verdict: ${absent.join(', ')}`
  if (published === null) {
    // The legacy shape: a publisher verdict written before the policy line existed.
    // It cannot be compared by identity, only by the jobs it lists — so a verdict
    // that already covers every job required now is current and must be left alone.
    // Skipping it is what stops the first sweep after this line lands from reddening
    // heads whose verdict is still correct (a release PR holding a 20-of-20 green,
    // for one); a legacy verdict that misses a job names that job instead.
    if (absent.length === 0) {
      return {
        publish: false,
        reason: 'legacy-current',
        detail: `the newest ci-ok names no policy because it was published before the policy line existed, and it lists every one of the ${String(REQUIRED_JOBS.length)} jobs required now, so it is a current verdict and is not recomputed`,
      }
    }
    return {
      publish: true,
      reason: 'stale-policy',
      detail: `the newest ci-ok names no policy because it was published before the policy line existed, so it is compared by the jobs it lists: it lists ${String(ran.size)} of the ${String(REQUIRED_JOBS.length)} jobs required now; ${absentText}`,
    }
  }
  const samePolicy = published.requiredHash === policy.requiredHash && published.gateSha === policy.gateSha
  if (samePolicy) {
    return verdict.conclusion === 'success'
      ? { publish: false, reason: 'current-policy', detail: `the newest ci-ok was computed under the current policy (required=${policy.requiredHash})` }
      : { publish: false, reason: 'already-refreshed', detail: `the newest ci-ok is already red under the current policy (required=${policy.requiredHash})` }
  }
  return {
    publish: true,
    reason: 'stale-policy',
    detail: `the newest ci-ok was computed under required=${published.requiredHash} gate=${published.gateSha}, the current policy is required=${policy.requiredHash} gate=${policy.gateSha}; ${absentText}`,
  }
}
