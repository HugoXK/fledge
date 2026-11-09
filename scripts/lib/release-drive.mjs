// Decide what the daily release run does, from the state the workflow collected.
//
// Pure: the workflow gathers the state (tags, merged PRs, the open release PR, the
// latest ci-ok on main) and this function names exactly one action, so the night's
// behaviour is testable without GitHub, a token or a clock.
//
// Actions:
//   open-pr        the plan says release and nothing is in flight
//   enqueue        a mechanical release PR is already open: enqueue it, never a second one
//   report-blocked a release PR is open but blocked, red, unreadable or not the
//                  mechanical shape: report and stop
//   tag            a merged release PR has no tag yet: tag its squash commit
//   none           no release tonight; the counts go to the summary
//
// A dry run mutates nothing: `workflow_dispatch` defaults `dry_run: true`, so a
// dry run that returned `enqueue` would set auto-merge on the default manual
// dispatch, and one that returned `tag` would publish. Every mutating action is
// reduced to `none` with the action it would have taken.
//
// Everything ambiguous returns an action with a reason rather than a guess.

import { mechanicalRelease } from './mechanical-release.mjs'

const RELEASE_PR_TITLE = /^release: v(\d+\.\d+\.\d+)$/
const RELEASE_PR_BRANCH = /^release\/v(\d+\.\d+\.\d+)$/

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
  const { plan, openReleasePr, tags, ciOk } = state ?? {}

  const tagList = Array.isArray(tags) ? tags : []

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

  // Every merged release PR that has no tag yet, newest first: the last merged PR
  // is not necessarily the release PR — one unrelated merge after it used to mean
  // the tag was silently never created.
  const mergedList = Array.isArray(state?.mergedPrs) ? state.mergedPrs : []
  const pending = mergedList
    .filter((pr) => RELEASE_PR_TITLE.test(String(pr?.title ?? '')))
    .map((pr) => {
      const version = RELEASE_PR_TITLE.exec(String(pr?.title ?? ''))?.[1] ?? ''
      return {
        version,
        tag: `v${version}`,
        branch: String(pr?.headRef ?? ''),
        number: Number(pr?.number ?? 0),
        sha: String(pr?.mergeCommitSha ?? ''),
      }
    })
    .filter((candidate) => !tagList.includes(candidate.tag))
    .sort((left, right) => right.number - left.number)
  if (pending.length > 0) {
    const candidate = pending[0]
    const branchMatch = RELEASE_PR_BRANCH.exec(candidate.branch)
    if (branchMatch === null || branchMatch[1] !== candidate.version) {
      return { action: 'none', reason: `the merged release PR ${candidate.tag} has no readable release branch; not tagging on a guess` }
    }
    if (candidate.sha === '') {
      return { action: 'none', reason: `the merged release PR ${candidate.tag} has no merge commit sha; not tagging HEAD on a guess`, tag: candidate.tag, version: candidate.version }
    }
    return {
      action: 'tag',
      reason: `tag ${candidate.tag} on the squash commit ${candidate.sha} of the merged release PR #${String(candidate.number)}`,
      tag: candidate.tag,
      version: candidate.version,
      sha: candidate.sha,
    }
  }

  if (plan?.shouldRelease !== true) {
    return { action: 'none', reason: `the rule is not met: ${String(plan?.reason ?? 'no plan')}` }
  }
  if (ciOk !== 'success') {
    return { action: 'none', reason: `the latest ci-ok on main is ${String(ciOk === undefined || ciOk === null ? 'unknown' : ciOk)}` }
  }
  return { action: 'open-pr', reason: 'the rule is met: open the mechanical release PR', version: String(plan?.nextVersion ?? '') }
}

// A dry run reports, it does not act. `workflow_dispatch` defaults `dry_run` to
// true, so this is the default path for a manual dispatch: returning `enqueue`
// or `tag` from it would set auto-merge or publish on the first click.
const MUTATING = new Set(['open-pr', 'enqueue', 'tag'])

export function decideDrive(state) {
  const decision = decide(state)
  const dryRun = state?.dryRun === true || state?.dryRun === 'true'
  if (!dryRun) return decision
  if (MUTATING.has(String(decision.action))) {
    return {
      action: 'none',
      reason: `dry run: would have run "${String(decision.action)}" — ${String(decision.reason)}`,
      dryRun: true,
      wouldHave: String(decision.action),
      ...(decision.pr === undefined ? {} : { pr: decision.pr }),
      ...(decision.tag === undefined ? {} : { tag: decision.tag }),
      ...(decision.version === undefined ? {} : { version: decision.version }),
      ...(decision.sha === undefined ? {} : { sha: decision.sha }),
    }
  }
  return { ...decision, dryRun: true }
}
