// Decide what the daily release run does, from the state the workflow collected.
//
// Pure: the workflow gathers the state (tags, merged PRs, the open release PR, the
// latest ci-ok on main) and this function names exactly one action, so the night's
// behaviour is testable without GitHub, a token or a clock.
//
// Actions:
//   open-pr        the plan says release and nothing is in flight
//   enqueue        a release PR is already open: enqueue it, never a second one
//   report-blocked a release PR is open but blocked or red: report and stop
//   tag            the last merged PR is a release PR whose tag does not exist yet
//   none           no release tonight; the counts go to the summary
//
// Everything ambiguous returns an action with a reason rather than a guess.

const RELEASE_PR_TITLE = /^release: v(\d+\.\d+\.\d+)$/
const RELEASE_PR_BRANCH = /^release\/v(\d+\.\d+\.\d+)$/

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

export function decideDrive(state) {
  const {
    plan,
    openReleasePr,
    lastMergedPr,
    tags,
    ciOk,
    dryRun,
  } = state ?? {}

  const tagList = Array.isArray(tags) ? tags : []

  if (openReleasePr !== null && openReleasePr !== undefined) {
    const number = Number(openReleasePr.number ?? 0)
    const headSha = String(openReleasePr.headSha ?? '')
    if (headSha === '') return { action: 'report-blocked', reason: `release PR #${String(number)} has no readable head sha`, pr: number }
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

  const lastTitle = String(lastMergedPr?.title ?? '')
  const mergeMatch = RELEASE_PR_TITLE.exec(lastTitle)
  if (mergeMatch !== null) {
    const tag = `v${mergeMatch[1]}`
    const branch = String(lastMergedPr?.headRef ?? '')
    const branchMatch = RELEASE_PR_BRANCH.exec(branch)
    if (tagList.includes(tag)) return { action: 'none', reason: `the release PR for ${tag} is already tagged` }
    if (branchMatch === null || branchMatch[1] !== mergeMatch[1]) {
      return { action: 'none', reason: `the last release PR ${tag} has no readable release branch; not tagging on a guess` }
    }
    return { action: 'tag', reason: `tag ${tag} on the squash commit of the merged release PR`, tag, version: mergeMatch[1] }
  }

  if (plan?.shouldRelease !== true) {
    return { action: 'none', reason: `the rule is not met: ${String(plan?.reason ?? 'no plan')}` }
  }
  if (ciOk !== 'success') {
    return { action: 'none', reason: `the latest ci-ok on main is ${String(ciOk === undefined || ciOk === null ? 'unknown' : ciOk)}` }
  }
  if (dryRun === true) return { action: 'none', reason: 'dry run: the rule is met, nothing is opened', dryRun: true }
  return { action: 'open-pr', reason: 'the rule is met: open the mechanical release PR', version: String(plan?.nextVersion ?? '') }
}
