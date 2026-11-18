// Decide what the daily release run does, from the state the workflow collected.
//
// Pure: the workflow gathers the state (tags, the open release PR, the latest
// ci-ok on main) and this function names exactly one action, so the night's
// behaviour is testable without GitHub, a token or a clock.
//
// Actions:
//   open-pr        the plan says release and nothing is in flight
//   enqueue        a mechanical release PR is already open: enqueue it, never a second one
//   report-blocked a release PR is open but blocked, red, unreadable or not the
//                  mechanical shape: report and stop. An orphan `release/v<next>`
//                  branch is the same action with a different reason: it names
//                  the branch and its sha, and the workflow turns it red (#333).
//   wait-ci        the rule is met but `ci-ok` on main has not concluded yet: the
//                  caller re-reads it on a bounded schedule and decides again
//   none           no release tonight; the counts go to the summary
//
// There is deliberately no `tag` action: the tag job is the only tag writer, and
// it repairs a merged release PR without a tag on its own push and schedule runs
// (#866). The action used to exist here but the release job never fed it the
// merged list, so it could neither execute nor be reported.
//
// A dry run mutates nothing: `workflow_dispatch` defaults `dry_run: true`, so a
// dry run that returned `enqueue` would set auto-merge on the default manual
// dispatch. Every mutating action is reduced to `none` with the action it would
// have taken.
//
// Everything ambiguous returns an action with a reason rather than a guess.

import { mechanicalRelease } from './mechanical-release.mjs'

// A release PR is only the release PR when it is the mechanical one. A PR whose
// title merely starts with `release: v` — a docs-only `release: v9.9.9` — must
// never be auto-merged as if the release routine had written it.
function isMechanicalReleasePr(openReleasePr) {
  if (openReleasePr?.sameRepo !== true) {
    return { ok: false, reason: `release PR #${String(openReleasePr?.number ?? '?')} does not come from a branch in this repository` }
  }
  const files = openReleasePr?.files
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, reason: `release PR #${String(openReleasePr?.number ?? '?')} has no file list to judge` }
  }
  const identity = mechanicalRelease({ branch: openReleasePr?.branch, title: openReleasePr?.title, files: files.map((file) => String(file)) })
  return identity.mechanical ? { ok: true, reason: identity.reason, version: identity.version } : { ok: false, reason: identity.reason }
}

// A conclusion that means "not decided yet", never "red": a queued or running
// check run answers `null` for its conclusion, and `latestRun` reports that — and
// "no run of this name at all" — as `missing`.
const NOT_CONCLUDED = new Set(['missing', 'unknown', 'pending', ''])

function ciNotConcluded(conclusion) {
  return NOT_CONCLUDED.has(conclusion)
}

function failingChecks(checks) {
  const list = Array.isArray(checks) ? checks : []
  return list.filter((check) => {
    const status = String(check?.status ?? '')
    const conclusion = String(check?.conclusion ?? '')
    if (status !== '' && status !== 'completed') return true
    // Only `success` is green. This repository fails a required job that was
    // skipped rather than treating it as done, so `skipped` and `neutral` must not
    // let a release PR through either.
    return conclusion !== 'success'
  })
}

function decide(state) {
  const { plan, openReleasePr, ciOk } = state ?? {}

  if (openReleasePr !== null && openReleasePr !== undefined) {
    const number = Number(openReleasePr.number ?? 0)
    const headSha = String(openReleasePr.headSha ?? '')
    if (headSha === '') return { action: 'report-blocked', reason: `release PR #${String(number)} has no readable head sha`, pr: number }
    const identity = isMechanicalReleasePr(openReleasePr)
    if (!identity.ok) {
      return { action: 'report-blocked', reason: `release PR #${String(number)} is not the mechanical release: ${identity.reason}`, pr: number, headSha }
    }
    const nextVersion = String(plan?.nextVersion ?? '')
    if (nextVersion === '' || identity.version !== nextVersion) {
      return {
        action: 'report-blocked',
        reason: `release PR #${String(number)} is v${String(identity.version)} but the computed next is ${nextVersion === '' ? 'unreadable' : `v${nextVersion}`}`,
        pr: number,
        headSha,
      }
    }
    // An empty list is not "all green": the workflow collects these checks before
    // decide runs, so zero of them means the collection did not happen and the
    // drive would enqueue blind.
    if (!Array.isArray(openReleasePr.checks) || openReleasePr.checks.length === 0) {
      return { action: 'report-blocked', reason: `release PR #${String(number)} has no collected checks; refusing to enqueue blind`, pr: number, headSha }
    }
    const red = failingChecks(openReleasePr.checks)
    if (openReleasePr.blocked === true || red.length > 0) {
      const names = red.map((check) => String(check?.name ?? '?')).join(', ')
      return {
        action: 'report-blocked',
        reason: `release PR #${String(number)} is not mergeable${names === '' ? '' : `: ${names}`}`,
        pr: number,
        headSha,
        failing: red.map((check) => String(check?.name ?? '?')),
      }
    }
    return { action: 'enqueue', reason: `enqueue the open release PR #${String(number)}`, pr: number, headSha }
  }

  // A branch the routine itself pushed and then could not open a pull request for
  // is not a "different content" conflict to retry: nothing in the run can clear
  // it, and every later night would die in the push step with a message that does
  // not say what the state is. Naming it here makes the run red for the right
  // reason and stops it before the push (#333).
  const orphans = Array.isArray(state?.orphanBranches) ? state.orphanBranches : []
  if (orphans.length > 0) {
    const nextVersion = String(plan?.nextVersion ?? '')
    const chosen = orphans.find((entry) => String(entry?.version ?? '') === nextVersion) ?? orphans[0]
    const branch = String(chosen?.branch ?? '')
    const sha = String(chosen?.sha ?? '')
    const tag = String(chosen?.tag ?? '')
    return {
      action: 'report-blocked',
      reason: `orphan-branch: ${branch === '' ? 'a release branch' : branch}${sha === '' ? ' (sha unreadable)' : ` at ${sha}`} has no pull request in any state and no ${tag === '' ? 'tag for its version' : tag} tag; the slot is wedged until the owner deletes or adopts it, and nothing in this run may repair it`,
      branch,
      sha,
    }
  }

  if (plan?.shouldRelease !== true) {
    return { action: 'none', reason: `the rule is not met: ${String(plan?.reason ?? 'no plan')}` }
  }

  // Rule 4: only a green `ci-ok` releases. What is *not* green is two facts, not
  // one (#864): a run that has not concluded yet is `missing` — CI was still
  // running when the check-runs request was made — while `failure` is a red tip.
  // Folding the first into `none` is how the 0.3.7 slot was refused; it comes
  // back as `wait-ci`, and the caller re-reads on a bounded schedule.
  const conclusion = String(ciOk ?? 'unknown')
  const run = state?.ciOkRun ?? {}
  const runId = Number(run?.id ?? 0)
  const runNote = Number.isSafeInteger(runId) && runId > 0
    ? ` (run ${String(runId)}${typeof run?.status === 'string' && run.status !== '' ? `, ${run.status}` : ''})`
    : ' (no ci-ok run found)'
  if (ciNotConcluded(conclusion)) {
    return {
      action: 'wait-ci',
      reason: `the latest ci-ok on main is ${conclusion === '' ? 'missing' : conclusion}${runNote}: CI has not concluded yet, so the release waits and re-reads`,
      ciOkRunId: runId,
    }
  }
  if (conclusion !== 'success') {
    return {
      action: 'none',
      reason: `the latest ci-ok on main is ${conclusion}${runNote}: a concluded failure blocks the release`,
      ciOkRunId: runId,
    }
  }
  return { action: 'open-pr', reason: 'the rule is met: open the mechanical release PR', version: String(plan?.nextVersion ?? '') }
}

// A dry run reports, it does not act. `workflow_dispatch` defaults `dry_run` to
// true, so this is the default path for a manual dispatch: returning `enqueue`
// from it would set auto-merge on the first click. A dry run does not wait
// either: sitting on a runner for ten minutes to report a fact it already holds
// would only delay the summary.
const MUTATING = new Set(['open-pr', 'enqueue'])

export function decideDrive(state) {
  const decision = decide(state)
  const dryRun = state?.dryRun === true || state?.dryRun === 'true'
  if (!dryRun) return decision
  if (decision.action === 'wait-ci') {
    return {
      action: 'none',
      reason: `dry run: would have waited for ci-ok — ${String(decision.reason)}`,
      dryRun: true,
      wouldHave: 'wait-ci',
    }
  }
  if (MUTATING.has(String(decision.action))) {
    return {
      action: 'none',
      reason: `dry run: would have run "${String(decision.action)}" — ${String(decision.reason)}`,
      dryRun: true,
      wouldHave: String(decision.action),
      ...(decision.pr === undefined ? {} : { pr: decision.pr }),
      ...(decision.version === undefined ? {} : { version: decision.version }),
    }
  }
  return { ...decision, dryRun: true }
}

// The bound on the re-read (#864): three reads in all — the first is the one the
// workflow's collect step already made — five minutes apart, so the decide step
// sleeps at most ten minutes of a twenty-minute slot. A reader that is injected
// and a wait that is injected keep the loop testable without a clock, which is
// how the `missing -> success` transition is asserted rather than approximated.
export const CI_OK_READS = 3
export const CI_OK_INTERVAL_MS = 5 * 60 * 1000

/**
 * Decide, and when the only thing missing is a conclusion for `ci-ok`, wait and
 * read it again until the bound. Only `wait-ci` re-reads: a `failure` is a
 * decision, and no amount of waiting changes a red tip.
 *
 * `readCiOk` answers the same shape the state carries (`{ ciOk, ciOkRun }`), so
 * the caller decides where the answer comes from — the checks API in the
 * workflow, a fixture in the suite.
 */
export async function decideWithCiRetry({ state, decide = decideDrive, readCiOk, wait, attempts = CI_OK_READS, intervalMs = CI_OK_INTERVAL_MS }) {
  if (typeof readCiOk !== 'function') throw new TypeError('decideWithCiRetry needs readCiOk()')
  if (typeof wait !== 'function') throw new TypeError('decideWithCiRetry needs wait(ms)')
  const total = Number.isSafeInteger(attempts) && attempts > 0 ? attempts : CI_OK_READS
  const paused = Number.isFinite(intervalMs) && intervalMs >= 0 ? intervalMs : CI_OK_INTERVAL_MS
  let current = state
  let reads = 1
  let decision = decide(current)
  while (decision.action === 'wait-ci' && reads < total) {
    await wait(paused)
    const observed = await readCiOk()
    reads += 1
    current = { ...current, ciOk: String(observed?.ciOk ?? 'missing'), ...(observed?.ciOkRun === undefined ? {} : { ciOkRun: observed.ciOkRun }) }
    decision = decide(current)
  }
  if (decision.action !== 'wait-ci') return { ...decision, ciOkReads: reads, ciOkWaitedMs: paused * (reads - 1) }
  // The bound is a conclusion too: name what the last read saw and how many
  // reads produced it, so an operator can tell "CI never finished" from "the
  // reader never looked" without opening the run.
  const minutes = Math.round((paused * (total - 1)) / 60_000)
  const lastRunId = Number(current?.ciOkRun?.id ?? 0)
  const lastNote = Number.isSafeInteger(lastRunId) && lastRunId > 0 ? ` (run ${String(lastRunId)})` : ''
  return {
    action: 'none',
    reason: `the latest ci-ok on main is still ${String(current?.ciOk ?? 'missing')}${lastNote} after ${String(total)} reads over ${String(minutes)} minutes, so no release this slot`,
    ciOkReads: reads,
    ciOkWaitedMs: paused * (reads - 1),
  }
}
