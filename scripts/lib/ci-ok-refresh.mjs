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
// Only a verdict that names its policy is judged: the in-run aggregate publishes
// the same check name and names none, so a head in the window between CI
// completing and the publisher writing is left alone (that window is the state
// the first cut of this module reddened), and a head the publisher never reaches
// is a missing verdict rather than an unreadable one.
//
// The verdict carries the policy it was computed under (`policyIdentity`), so the
// comparison is a hash equality rather than an inference from a title.

import { createHash } from 'node:crypto'

import { REQUIRED_JOBS } from '../ci-ok.mjs'

/** The check run the scanner answers for. */
export const REFRESH_CHECK = 'ci-ok'

/** The published verdict is only evidence when the identity line is present. */
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
 * The newest *published* verdict: a completed `ci-ok` that names the policy it was
 * computed under. At this base `.github/workflows/ci.yml:808` also publishes a
 * job named `ci-ok` — the in-run aggregate — and its summary carries no policy
 * line. It is a second producer of the same context, not a verdict: #855 removed
 * it as evidence, and judging it would redden every legal head in the window
 * between CI completing and the publisher writing, because it is briefly the
 * newest `ci-ok` and can never be "current policy". Filtering on the policy line
 * is therefore what makes the comparison answer the evidence shape the tree
 * actually has, rather than a `ci-ok-head` rename that does not exist yet.
 */
function newestPublishedVerdict(checks) {
  const list = Array.isArray(checks) ? checks : []
  const verdicts = list
    .filter((entry) => entry?.name === REFRESH_CHECK && entry?.status === 'completed')
    .map((entry) => ({ entry, published: parsePolicyIdentity(entry?.output?.summary) }))
    .filter((candidate) => candidate.published !== null)
  if (verdicts.length === 0) return null
  return verdicts.reduce((newest, candidate) => (completedAt(candidate.entry) > completedAt(newest.entry) ? candidate : newest))
}

/** Whether the tree carries any completed `ci-ok` that names no policy. */
function hasPolicyLessVerdict(checks) {
  const list = Array.isArray(checks) ? checks : []
  return list.some((entry) => entry?.name === REFRESH_CHECK && entry?.status === 'completed' && parsePolicyIdentity(entry?.output?.summary) === null)
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
  const newest = newestPublishedVerdict(checks)
  if (newest === null) {
    return {
      publish: true,
      reason: 'no-published-verdict',
      detail: hasPolicyLessVerdict(checks)
        ? 'the CI workflow finished for this head and no published ci-ok names a policy: the only ci-ok here is the in-run aggregate, which names none and is not evidence, and no publisher run is queued or in progress'
        : 'the CI workflow finished for this head and no published ci-ok exists: the publisher never ran for it (a renamed workflow name evades it), so there is no verdict to merge on',
    }
  }
  const { entry: verdict, published } = newest
  const samePolicy = published.requiredHash === policy.requiredHash && published.gateSha === policy.gateSha
  if (samePolicy) {
    return verdict.conclusion === 'success'
      ? { publish: false, reason: 'current-policy', detail: `the newest ci-ok was computed under the current policy (required=${policy.requiredHash})` }
      : { publish: false, reason: 'already-refreshed', detail: `the newest ci-ok is already red under the current policy (required=${policy.requiredHash})` }
  }
  const ran = new Set(jobsOf(verdict?.output?.summary))
  const absent = REQUIRED_JOBS.filter((name) => !ran.has(name))
  const absentText = absent.length === 0 ? 'no required job is absent from its job list' : `jobs required now but absent from that verdict: ${absent.join(', ')}`
  return {
    publish: true,
    reason: 'stale-policy',
    detail: `the newest ci-ok was computed under required=${published.requiredHash} gate=${published.gateSha}, the current policy is required=${policy.requiredHash} gate=${policy.gateSha}; ${absentText}`,
  }
}
