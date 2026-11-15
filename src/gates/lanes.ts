import type { GatePlan, GatePlanLaneName } from './plan.js'

// #543 second slice: the lane vocabulary is the contract a gate pull request
// installs. It is pure so the four decisions the issue names — an empty lane is
// `not_applicable`, an observe failure is `observe_fail`, a merge queue changes
// the pr-merge trigger, and a check that only sees the merged tree is a gap —
// are testable without a repository, a workflow run or a network.

export const LANE_OUTCOMES = ['pass', 'fail', 'observe_fail', 'not_applicable'] as const
export type LaneOutcome = (typeof LANE_OUTCOMES)[number]

export type LaneTrigger = 'pull_request' | 'merge_group' | 'after_merge' | 'schedule' | 'tag'

export const LANE_TRIGGER_TEXT: Record<LaneTrigger, string> = {
  pull_request: 'every pull request commit',
  merge_group: 'the merge queue (merge_group)',
  after_merge: 'the default branch after merge',
  schedule: 'a daily schedule',
  tag: 'a version tag',
}

/** Which event a lane is meant to run on, given whether a merge queue exists. */
export function laneTrigger(lane: GatePlanLaneName, mergeQueue: boolean): LaneTrigger {
  switch (lane) {
    case 'pr-ready': return 'pull_request'
    case 'pr-merge': return mergeQueue ? 'merge_group' : 'after_merge'
    case 'daily': return 'schedule'
    case 'release': return 'tag'
  }
}

export interface LaneRunFacts {
  commands: readonly string[]
  observe: boolean
  /** Process exit code of the lane; `null` means no command produced one. */
  exitCode: number | null
}

/**
 * The one place a lane turns a run into a verdict.
 *
 * An empty lane has nothing to run: it is `not_applicable`, never `pass`. A
 * missing exit code is a failure, so a lane whose runner never started cannot
 * read as green. A non-zero exit is a `fail` unless the lane is `observe`, in
 * which case it is `observe_fail` — recorded, and not allowed to fail the job.
 */
export function laneResult(facts: LaneRunFacts): LaneOutcome {
  if (facts.commands.length === 0) return 'not_applicable'
  if (facts.exitCode === 0) return 'pass'
  return facts.observe ? 'observe_fail' : 'fail'
}

/**
 * Gaps the installed contract carries in its own right, independent of the
 * analysis gaps the plan already recorded. Each sentence names a lane and why
 * a green run in it would not mean what a reader might assume.
 */
export function contractGaps(plan: GatePlan): string[] {
  const gaps: string[] = []
  const prReady = plan.lanes['pr-ready']
  const prMerge = plan.lanes['pr-merge']

  if (!plan.mergeQueue) {
    gaps.push(
      'No merge queue: pr-merge runs on the default branch after merge, so a check that only runs on the merged tree (the merge preview) is not a pull-request gate and cannot block a pull request.',
    )
  }
  if (prReady.commands.length === 0) {
    gaps.push('pr-ready is empty: it reports not_applicable, never a pass, so no check runs on a pull request.')
  }
  if (plan.mergeQueue && prMerge.commands.length === 0) {
    gaps.push('pr-merge is empty: the merge queue has no command, so it reports not_applicable instead of gating the queue.')
  }
  if (prReady.observe) {
    gaps.push('pr-ready is observe-only: a failure is recorded as observe_fail and does not fail the gate job, so it cannot block a pull request.')
  }
  if (plan.lanes.release.commands.length === 0) {
    gaps.push('release is empty: a tag reports not_applicable, so tagging does not verify the release.')
  }
  return gaps
}

export interface LaneContractEntry {
  commands: string[]
  observe: boolean
  trigger: LaneTrigger
  durationMs?: number
}

export interface LaneContract {
  version: 1
  generatedBy: 'fledge'
  planHash: string
  baseSha: string
  baseBranch: string
  mergeQueue: boolean
  lanes: Record<GatePlanLaneName, LaneContractEntry>
  gaps: string[]
}

/**
 * The `.github/ci-gates.json` document the gate script reads at run time. It
 * repeats the plan's commands and the derived trigger, so a later reader does
 * not need the Fledge database to know what a lane is for.
 */
export function laneContract(input: { plan: GatePlan; planHash: string; baseBranch: string }): LaneContract {
  const lanes = {} as Record<GatePlanLaneName, LaneContractEntry>
  for (const lane of Object.keys(input.plan.lanes) as GatePlanLaneName[]) {
    const entry = input.plan.lanes[lane]
    const contract: LaneContractEntry = {
      commands: [...entry.commands],
      observe: entry.observe,
      trigger: laneTrigger(lane, input.plan.mergeQueue),
    }
    if (entry.durationMs !== undefined) contract.durationMs = entry.durationMs
    lanes[lane] = contract
  }
  return {
    version: 1,
    generatedBy: 'fledge',
    planHash: input.planHash,
    baseSha: input.plan.baseSha,
    baseBranch: input.baseBranch,
    mergeQueue: input.plan.mergeQueue,
    lanes,
    gaps: [...input.plan.gaps, ...contractGaps(input.plan)],
  }
}
