// Which workflow run has to be re-run so the required `review-gate` check at a
// tip carries the conclusion its newest verdict implies.
//
// Pure: the caller supplies the check runs and the workflow runs it read from the
// API, plus a lookup for a run's jobs. Two invariants live here:
//
//   - attempt 1 only. A re-run raises that run to `run_attempt == 2`, the filter
//     stops matching it, and a second identical trigger therefore does nothing.
//     A re-run that fails is still attempt 2 and is never re-run again.
//   - the run that is currently executing is never a target.
export const REQUIRED_CONTEXT = 'review-gate'

function newestFirst(a, b) {
  return Date.parse(b.created_at ?? 0) - Date.parse(a.created_at ?? 0)
}

function repairable(runs, currentRunId) {
  return (runs ?? [])
    .filter((run) => Number(run.run_attempt) === 1)
    .filter((run) => String(run.id) !== String(currentRunId ?? ''))
}

// `expected` is the conclusion the tip deserves: 'success' from a PASS,
// 'failure' from a rejection.
//
// A rejection is satisfied by any completed red at the SHA. When none stands yet,
// the newest attempt-1 run is re-run in full (`rerun`, all jobs): a rejection must
// be able to repaint a run that is currently green, and that is the only way.
//
// A PASS is satisfied only when no failed run is left. Each failed attempt-1 run
// whose own `review-gate` job failed is re-run. Anything still red afterwards is
// blocked on a new commit, not on another re-run.
export function repairPlan({ expected, checkRuns, runs, jobsFor, currentRunId }) {
  const completed = (checkRuns ?? []).filter((check) => check.status === 'completed')
  const reds = completed.filter((check) => check.conclusion !== 'success' && check.conclusion !== 'skipped')
  const candidates = repairable(runs, currentRunId)

  if (expected === 'failure') {
    if (reds.length > 0) return { action: 'none', ids: [], reason: 'a failed review-gate already stands at this SHA' }
    const newest = [...candidates].sort(newestFirst)[0]
    if (newest === undefined) return { action: 'blocked', ids: [], reason: 'no run at this SHA can be re-run to paint a rejection' }
    return { action: 'rerun', ids: [newest.id], reason: 'the rejection is not visible at the head SHA yet' }
  }

  const targets = candidates
    .filter((run) => run.conclusion === 'failure')
    .filter((run) => (jobsFor(run.id) ?? []).some((job) => job.name === REQUIRED_CONTEXT && job.conclusion === 'failure'))
    .sort(newestFirst)
    .map((run) => run.id)
  if (targets.length > 0) return { action: 'rerun', ids: targets, reason: 'a failed review-gate run at this SHA is still on its first attempt' }
  if (reds.length > 0) {
    return { action: 'blocked', ids: [], reason: 'a failed review-gate stands at this SHA and every run there is already re-run; a new commit is needed' }
  }
  return { action: 'none', ids: [], reason: 'no failed review-gate at this SHA' }
}
