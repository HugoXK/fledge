import { clearGauge, incCounter, metricsSnapshot, observeHistogram, setGauge } from '../lib/metrics.js'

// #807: the console could say when the last run happened, not whether the
// platform was keeping the team busy. These are the numbers that answer that
// question, and they are recorded from the dispatcher's own decision rather
// than inferred from timestamps, so "idle with work" means the scheduler looked
// at ready work and started nothing.
export type DispatchBlockReason =
  | 'cooldown'
  | 'failure_backoff'
  | 'active_job'
  | 'instance_not_ready'
  | 'user_not_ready'
  | 'quota'

export interface RepoSeries {
  owner: string
  name: string
}

export function repoSeriesLabel(repo: RepoSeries): string {
  return `${repo.owner}/${repo.name}`
}

// When the work a repository is sitting on became dispatchable: the later of the
// oldest ready item and the last run. A run after the item was created restarts
// the wait, because the repository was busy with it rather than idle. The
// scheduler's gauge and the store's alert both call this, so the card and the
// alert cannot disagree about what "waiting" means.
export function readySinceMs(input: { workCreatedAt: string[]; lastRunAt: string | null }): number | null {
  let oldest: number | null = null
  for (const value of input.workCreatedAt) {
    const at = Date.parse(value)
    if (!Number.isFinite(at)) continue
    if (oldest === null || at < oldest) oldest = at
  }
  if (oldest === null) return null
  const lastRun = input.lastRunAt === null ? Number.NaN : Date.parse(input.lastRunAt)
  return Number.isFinite(lastRun) && lastRun > oldest ? lastRun : oldest
}

export function clearIdleWithWork(repo: RepoSeries): void {
  clearGauge('fledge_automation_idle_with_work_seconds', { repo: repoSeriesLabel(repo) })
}

// A ready item that did not start names why. Only the two cooldown reasons mean
// "idle with work": the platform is free and holding the item back on purpose.
// An active job, a missing instance or an exhausted quota is a different
// condition with its own counter, so the idle age is cleared rather than left
// reading as if nothing were happening.
export function recordBlockedDispatch(input: { reason: DispatchBlockReason; repo: RepoSeries; readyAt: number | null; now: number }): void {
  incCounter('fledge_automation_blocked_total', { reason: input.reason }, 1, 'Ready work that did not start, by reason')
  if ((input.reason === 'cooldown' || input.reason === 'failure_backoff') && input.readyAt !== null) {
    setGauge('fledge_automation_idle_with_work_seconds', Math.max(0, Math.round((input.now - input.readyAt) / 1_000)), { repo: repoSeriesLabel(input.repo) }, 'Seconds a repository has had ready work with no active job')
    return
  }
  clearIdleWithWork(input.repo)
}

export function recordDispatched(input: { repo: RepoSeries; kind: string; readyAt: number | null; now: number }): void {
  clearIdleWithWork(input.repo)
  if (input.readyAt === null) return
  // Seconds with the registry's default buckets, like every other histogram
  // here: `test/alertBuckets.test.ts` holds the whole process to that bucket
  // list, because a rule above the top finite boundary could never fire. The
  // console converts to milliseconds for display, where the numbers are small.
  observeHistogram('fledge_automation_dispatch_latency_seconds', Math.max(0, input.now - input.readyAt) / 1_000, { kind: input.kind }, 'Time from ready work to a dispatched job')
}

export interface AutomationHealthSummary {
  /** Repositories that have ready work and no active job, oldest wait first. */
  idleWithWork: Array<{ repo: string; seconds: number }>
  queueDepth: number | null
  activeJobs: number | null
  /** Mean over the samples taken since this process started; null when none. */
  dispatchLatencyMs: number | null
  dispatchSamples: number
}

function gaugeValue(name: string, labels: Record<string, string> = {}): number | null {
  const snapshot = metricsSnapshot()
  for (const entry of snapshot.gauges) {
    if (entry.name !== name) continue
    const keys = Object.keys(labels)
    if (keys.some((key) => String(entry.labels[key]) !== labels[key])) continue
    return entry.value
  }
  return null
}

export function automationHealth(): AutomationHealthSummary {
  const snapshot = metricsSnapshot()
  const idleWithWork = snapshot.gauges
    .filter((entry) => entry.name === 'fledge_automation_idle_with_work_seconds')
    .map((entry) => ({ repo: String(entry.labels.repo ?? ''), seconds: entry.value }))
    .sort((a, b) => b.seconds - a.seconds)
  let sum = 0
  let count = 0
  for (const entry of snapshot.histograms) {
    if (entry.name !== 'fledge_automation_dispatch_latency_seconds') continue
    sum += entry.sum
    count += entry.count
  }
  return {
    idleWithWork,
    queueDepth: gaugeValue('fledge_queue_depth'),
    activeJobs: gaugeValue('fledge_jobs_active'),
    dispatchLatencyMs: count === 0 ? null : Math.round((sum / count) * 1_000),
    dispatchSamples: count,
  }
}
