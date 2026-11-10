// Which workflow run has to be re-run so the required `review-gate` check at a
// tip carries the conclusion its newest verdict implies.
//
// Pure: the caller supplies the check runs and the workflow runs it read from the
// API, plus a lookup for a run's jobs. Five invariants live here:
//
//   - only the `Review gate` workflow is a target. Re-running another workflow at
//     the SHA paints no `review-gate` check, so it would exit 0 while the tip is
//     still unrepainted.
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

export function isGateRun(run) {
  return run?.name === GATE_WORKFLOW_NAME || run?.path === GATE_WORKFLOW_PATH
}

function newestFirst(a, b) {
  return Date.parse(b.created_at ?? 0) - Date.parse(a.created_at ?? 0)
}

// A run the plan may re-run: the gate workflow, completed, not the run executing
// right now, and still below the attempt cap. Exported so the caller reads the
// jobs of exactly the runs the plan can choose.
export function isRepairCandidate(run, currentRunId) {
  return isGateRun(run)
    && run?.status === 'completed'
    && Number(run.run_attempt ?? 0) <= MAX_REPAIR_ATTEMPT
    && String(run.id) !== String(currentRunId ?? '')
}

function repairable(runs, currentRunId) {
  return (runs ?? []).filter((run) => isRepairCandidate(run, currentRunId))
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

// `expected` is the conclusion the tip deserves: 'success' from a PASS,
// 'failure' from a rejection.
//
// A rejection is satisfied by any completed red standing at the SHA. When none
// stands yet, the newest repairable run of the gate workflow is re-run in full
// (`rerun`, all jobs): a rejection must be able to repaint a run that is currently
// green, and that is the only way. This path is idempotent — the re-run paints the
// red it was asked for, so a repeated rejection finds that red and writes nothing.
//
// A PASS is satisfied only when no failed run is left standing. Each failed
// repairable gate run (`run_attempt <= MAX_REPAIR_ATTEMPT`) whose own `review-gate`
// job failed is re-run. Every re-run raises `run_attempt`, so one failed run is
// re-run at most twice if the same PASS is posted twice (1 -> 2, then 2 -> 3); once
// it stands above the cap, a red it still owns is blocked on a new commit instead
// of another re-run. That bound is what makes this loop terminate.
export function repairPlan({ expected, checkRuns, runs, jobsFor, currentRunId }) {
  const completed = standingChecks(checkRuns).filter((check) => check.status === 'completed')
  const reds = completed.filter((check) => check.conclusion !== 'success' && check.conclusion !== 'skipped')
  const candidates = repairable(runs, currentRunId)

  if (expected === 'failure') {
    if (reds.length > 0) return { action: 'none', ids: [], reason: 'a failed review-gate already stands at this SHA' }
    const newest = [...candidates].sort(newestFirst)[0]
    if (newest === undefined) return { action: 'blocked', ids: [], reason: 'no Review gate run at this SHA can be re-run to paint a rejection' }
    return { action: 'rerun', ids: [newest.id], reason: 'the rejection is not visible at the head SHA yet' }
  }

  const targets = candidates
    .filter((run) => run.conclusion === 'failure')
    .filter((run) => (jobsFor(run.id) ?? []).some((job) => job.name === REQUIRED_CONTEXT && job.conclusion === 'failure'))
    .sort(newestFirst)
    .map((run) => run.id)
  if (targets.length > 0) return { action: 'rerun', ids: targets, reason: `a failed review-gate run at this SHA is still below attempt ${MAX_REPAIR_ATTEMPT + 1}` }
  if (reds.length > 0) {
    return { action: 'blocked', ids: [], reason: `a failed review-gate still stands at this SHA and the run behind it is already at attempt ${MAX_REPAIR_ATTEMPT + 1}; a new commit is needed` }
  }
  return { action: 'none', ids: [], reason: 'no failed review-gate at this SHA' }
}
