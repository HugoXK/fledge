// Which workflow run has to be re-run so every required check at a tip carries
// the conclusion its newest verdict implies.
//
// Pure: the caller supplies the check runs and the workflow runs it read from the
// API, plus a lookup for a run's jobs. Five invariants live here:
//
//   - only the workflow that owns a required context is a target for it, and one
//     required check can be owned by exactly one workflow. Re-running another
//     workflow at the SHA paints no check of that context, so it would exit 0
//     while the tip is still unrepainted. `pr-lint` has owned its own workflow
//     since #753; before #770 this planner only ever targeted `Review gate`, so a
//     stale red `pr-lint` blocked the merge while the step said the tip was fine.
//   - standing is per check suite, and the newest attempt stands inside a suite.
//     A check run belongs to the suite of the workflow run that produced it. A
//     re-run replaces the check run inside its own suite, so the superseded
//     conclusion there is history; a *second workflow run* at the same SHA opens
//     a new suite and leaves the earlier suite's conclusion in place. The merge
//     gate reads suites, which is why #175 stayed blocked while the newest check
//     run by name was green: nothing had repainted the failing suite.
//   - a completed run only. A run that is still executing cannot be re-run: the
//     API answers 409, the step exits 1, and the in-flight run may still publish
//     its own conclusion.
//   - an attempt at most MAX_REPAIR_ATTEMPT. #175's failing run had already been
//     re-run by hand and sat on attempt 2, which is exactly the state a PASS can
//     arrive into, so it must stay reachable. The cap is what stops the loop: a
//     re-run raises `run_attempt`, the planner repairs a run once more at most,
//     and anything at the cap is reported as blocked on a new commit instead of
//     being re-run forever.
//   - the run that is currently executing is never a target.
export const REQUIRED_CONTEXT = 'review-gate'
export const GATE_WORKFLOW_NAME = 'Review gate'
export const GATE_WORKFLOW_PATH = '.github/workflows/review-gate.yml'
// Highest `run_attempt` the planner will re-run. One automatic repair on top of
// whatever attempts already exist; after that a red suite needs a new commit.
export const MAX_REPAIR_ATTEMPT = 2

// The required contexts a verdict can make wrong, each with the one workflow whose
// re-run repaints it. `.github/agent/required-checks.md` is the record of the set
// the branch protection enforces; this table is where each of those contexts that
// a verdict can invalidate becomes repaintable. `ci-ok` is absent on purpose: no
// verdict can make a tree check wrong, so it has no stale-verdict case.
export const REPAIRABLE_CONTEXTS = [
  { context: 'review-gate', workflowName: GATE_WORKFLOW_NAME, workflowPath: GATE_WORKFLOW_PATH },
  { context: 'pr-lint', workflowName: 'pr-lint', workflowPath: '.github/workflows/pr-lint.yml' },
]

// A run belongs to a context's workflow, by name or by path: both are what the
// runs API reports, and a renamed workflow keeps its path.
function ownsContext(run, spec) {
  return run?.name === spec.workflowName || run?.path === spec.workflowPath
}

export function isGateRun(run) {
  return ownsContext(run, REPAIRABLE_CONTEXTS[0])
}

function newestFirst(a, b) {
  return Date.parse(b.created_at ?? 0) - Date.parse(a.created_at ?? 0)
}

// A run the plan may re-run for one context: that context's workflow, completed,
// not the run executing right now, and still below the attempt cap. Exported so
// the caller reads the jobs of exactly the runs the plan can choose.
export function isRepairCandidateFor(run, spec, currentRunId) {
  return ownsContext(run, spec)
    && run?.status === 'completed'
    && Number(run.run_attempt ?? 0) <= MAX_REPAIR_ATTEMPT
    && String(run.id) !== String(currentRunId ?? '')
}

export function isRepairCandidate(run, currentRunId) {
  return isRepairCandidateFor(run, REPAIRABLE_CONTEXTS[0], currentRunId)
}

// Every context's candidate in one predicate, so the caller widens the set it
// reads jobs for instead of keeping a second, drifting list.
export function isRepairCandidateForAny(run, currentRunId) {
  return REPAIRABLE_CONTEXTS.some((spec) => isRepairCandidateFor(run, spec, currentRunId))
}

// A run whose jobs the caller has to read even though it is above the cap: the
// above-cap fallback (#341) decides on the red that run owns, and the in-flight
// case needs its status. Exported so the caller widens the same set it widened
// for the cap path instead of keeping a second, drifting list.
export function isBlockingCandidate(run, currentRunId) {
  return isGateRun(run)
    && String(run.id) !== String(currentRunId ?? '')
    && (run?.status !== 'completed' || Number(run.run_attempt ?? 0) > MAX_REPAIR_ATTEMPT)
}

export function isBlockingCandidateForAny(run, currentRunId) {
  return REPAIRABLE_CONTEXTS.some((spec) => ownsContext(run, spec))
    && String(run.id) !== String(currentRunId ?? '')
    && (run?.status !== 'completed' || Number(run.run_attempt ?? 0) > MAX_REPAIR_ATTEMPT)
}

function repairable(runs, currentRunId, spec = REPAIRABLE_CONTEXTS[0]) {
  return (runs ?? []).filter((run) => isRepairCandidateFor(run, spec, currentRunId))
}

function redOfSuite(reds, suiteId) {
  if (suiteId === undefined || suiteId === null) return []
  return reds.filter((check) => String(check?.check_suite?.id ?? '') === String(suiteId))
}

function newestCompletedAt(checks) {
  return [...checks].sort((a, b) => Date.parse(b.completed_at ?? '') - Date.parse(a.completed_at ?? ''))[0]
}

// The run behind a red that the cap would otherwise stop. A red whose suite
// belongs to one of these runs is the one that has to be repainted; when the
// payload does not name suites (a fixture, or an older shape) the newest run in
// the set stands in for it.
function blockingRun(reds, runs, jobsFor, currentRunId) {
  const above = (runs ?? []).filter((run) => isGateRun(run)
    && String(run.id) !== String(currentRunId ?? '')
    && Number(run.run_attempt ?? 0) > MAX_REPAIR_ATTEMPT)
  const failed = above.filter((run) => (jobsFor(run.id) ?? []).some((job) => job.name === REQUIRED_CONTEXT && job.conclusion === 'failure'))
  const pool = failed.length > 0 ? failed : above
  const owning = pool.filter((run) => redOfSuite(reds, run?.check_suite_id).length > 0)
  return [...(owning.length > 0 ? owning : pool)].sort(newestFirst)[0]
}

// #1143: the run that will paint a non-gate context next. Queued or in progress
// at this SHA and created after the standing red started, so a run that predates
// the red cannot be mistaken for its replacement. An unparseable red timestamp
// returns undefined on purpose: without the boundary the plan fails closed to
// `blocked`, never to a wait that would loop on an old run.
function liveRunBehindRed(runs, spec, red, currentRunId) {
  const redAt = Date.parse(String(red?.started_at ?? red?.completed_at ?? ''))
  if (!Number.isFinite(redAt)) return undefined
  const live = (runs ?? []).filter((run) => ownsContext(run, spec)
    && String(run.id) !== String(currentRunId ?? '')
    && (run?.status === 'queued' || run?.status === 'in_progress')
    && Date.parse(String(run?.created_at ?? '')) > redAt)
  return [...live].sort(newestFirst)[0]
}

function startedAt(check) {
  return Date.parse(check.started_at ?? check.completed_at ?? '') || 0
}

// The newest check run of each suite stands at the SHA. Ties break on the id,
// because a re-run can start in the same second as the run it replaces. A payload
// that does not name its suite (an older caller or a fixture) falls back to the
// check name, which is the pre-#179 grouping.
function suiteKey(check) {
  const suite = check?.check_suite?.id
  if (suite !== undefined && suite !== null) return `suite:${suite}`
  return `name:${String(check?.name ?? REQUIRED_CONTEXT)}`
}

export function standingChecks(checkRuns) {
  const standing = new Map()
  for (const check of checkRuns ?? []) {
    const name = suiteKey(check)
    const current = standing.get(name)
    if (current === undefined) {
      standing.set(name, check)
      continue
    }
    const newer = startedAt(check) === startedAt(current)
      ? Number(check.id ?? 0) > Number(current.id ?? 0)
      : startedAt(check) > startedAt(current)
    if (newer) standing.set(name, check)
  }
  return [...standing.values()]
}

// The reds standing for one required context. Scoped per context on purpose: a red
// `pr-lint` is not a red `review-gate`, and reading one as the other is how a
// rejection would look already painted.
function redOfContext(completed, context) {
  return completed.filter((check) => check.name === context && check.conclusion !== 'success' && check.conclusion !== 'skipped')
}

// `expected` is the conclusion the tip deserves: 'success' from a PASS,
// 'failure' from a rejection.
//
// A rejection is satisfied by any completed red standing for `review-gate` at the
// SHA. When none stands yet, the newest repairable run of the gate workflow is
// re-run in full (`rerun`, all jobs): a rejection must be able to repaint a run that
// is currently green, and that is the only way. This path is idempotent — the re-run
// paints the red it was asked for, so a repeated rejection finds that red and writes
// nothing.
//
// A PASS re-runs, for every required context, each failed run of the workflow that
// owns that context whose job of that name failed (`run_attempt <=
// MAX_REPAIR_ATTEMPT`). One action repaints all of them. Every re-run raises
// `run_attempt`, so one failed run is re-run at most twice if the same PASS is
// posted twice (1 -> 2, then 2 -> 3); once it stands above the cap, a red it still
// owns is blocked on a new commit instead of another re-run. That bound is what
// makes this loop terminate. A red in a context with no repairable run behind it is
// reported, never passed silently: the tip is still blocked, and the caller must
// know that.
export function repairPlan({ expected, checkRuns, runs, jobsFor, currentRunId, verdictAt }) {
  const completed = standingChecks(checkRuns).filter((check) => check.status === 'completed')
  const reds = redOfContext(completed, REQUIRED_CONTEXT)

  if (expected === 'failure') {
    if (reds.length > 0) return { action: 'none', ids: [], reason: 'a failed review-gate already stands at this SHA' }
    const newest = [...repairable(runs, currentRunId)].sort(newestFirst)[0]
    if (newest === undefined) return { action: 'blocked', ids: [], reason: 'no Review gate run at this SHA can be re-run to paint a rejection' }
    return { action: 'rerun', ids: [newest.id], reason: 'the rejection is not visible at the head SHA yet' }
  }

  const targets = []
  const repainted = []
  for (const spec of REPAIRABLE_CONTEXTS) {
    const failed = repairable(runs, currentRunId, spec)
      .filter((run) => run.conclusion === 'failure')
      .filter((run) => (jobsFor(run.id) ?? []).some((job) => job.name === spec.context && job.conclusion === 'failure'))
    if (failed.length === 0) continue
    repainted.push(spec.context)
    targets.push(...failed)
  }
  if (targets.length > 0) {
    const ids = [...targets].sort(newestFirst).map((run) => run.id)
    return { action: 'rerun', ids, reason: `a failed run of ${repainted.join(' and ')} at this SHA is still below attempt ${MAX_REPAIR_ATTEMPT + 1}` }
  }
  if (reds.length === 0) {
    for (const spec of REPAIRABLE_CONTEXTS) {
      if (spec.context === REQUIRED_CONTEXT) continue
      const contextReds = redOfContext(completed, spec.context)
      if (contextReds.length === 0) continue
      const red = newestCompletedAt(contextReds)
      // #1143: a run that is queued or running at this SHA has not painted
      // anything yet, but it is coming — so the tip is not "cannot be
      // repainted". Wait, write nothing, and let the run that settles it decide.
      const live = liveRunBehindRed(runs, spec, red, currentRunId)
      if (live !== undefined) {
        return {
          action: 'wait',
          ids: [],
          reason: `run ${live.id} of ${spec.workflowName} is still ${String(live.status)} and was created after the standing ${String(red?.conclusion ?? 'failed')} ${spec.context} (${String(red?.started_at ?? red?.completed_at ?? 'unknown time')}); the result of that run decides again`,
        }
      }
      return { action: 'blocked', ids: [], reason: `a ${String(red?.conclusion ?? 'failed')} ${spec.context} still stands at this SHA and no completed ${spec.workflowName} run below attempt ${MAX_REPAIR_ATTEMPT + 1} can be re-run; a new run of ${spec.workflowPath} is needed` }
    }
    return { action: 'none', ids: [], reason: 'no failed required check at this SHA' }
  }

  // #341: above the cap the attempt count cannot decide, because it cannot tell
  // "this red is older than the standing PASS" from "this run failed after the
  // PASS". The blocking red check's own `completed_at` can, and it is the field
  // that only moves when the gate job itself re-runs. Equality is repaint on
  // purpose: repaint is the harmless branch and blocked is the costly one, so
  // the boundary must never resolve to blocked.
  const blocking = blockingRun(reds, runs, jobsFor, currentRunId)
  if (blocking === undefined) {
    return { action: 'blocked', ids: [], reason: 'a failed review-gate still stands at this SHA and no gate run behind it can be re-run; a new commit is needed' }
  }
  if (blocking.status !== 'completed') {
    // `POST /actions/runs/<id>/rerun` is refused while the run is live, and "a
    // new commit is needed" would be false: the attempt still has to publish its
    // own conclusion. Empty ids keep the caller's rerun loop out of reach.
    return { action: 'wait', ids: [], reason: `run ${blocking.id} (attempt ${blocking.run_attempt}) is still ${String(blocking.status)}; the trigger after it settles decides again` }
  }
  const verdictMs = Date.parse(String(verdictAt ?? ''))
  const red = newestCompletedAt(redOfSuite(reds, blocking?.check_suite_id).length > 0 ? redOfSuite(reds, blocking?.check_suite_id) : reds)
  const redMs = Date.parse(String(red?.completed_at ?? ''))
  if (!Number.isFinite(verdictMs) || !Number.isFinite(redMs)) {
    // Fail closed: comparing against `undefined` would repaint on a belief.
    const missing = Number.isFinite(verdictMs) ? 'the standing red has no completed_at' : 'no verdict timestamp was supplied'
    return { action: 'blocked', ids: [], reason: `cannot compare the standing red to the newest verdict (${missing}); not repainting run ${blocking.id}` }
  }
  if (redMs <= verdictMs) {
    return { action: 'repaint', ids: [blocking.id], runId: blocking.id, attempt: Number(blocking.run_attempt ?? 0), reason: `run ${blocking.id} is above attempt ${MAX_REPAIR_ATTEMPT} and its red completed at ${String(red.completed_at)}, at or before the newest verdict (${String(verdictAt)})` }
  }
  return { action: 'blocked', ids: [], reason: `run ${blocking.id} at attempt ${blocking.run_attempt} failed after the newest verdict (${String(red.completed_at)} > ${String(verdictAt)}); a new commit is needed` }
}
