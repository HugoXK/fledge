import type { JobStatus } from '../db.js'

export interface SloInput {
  successRate: number | null
  queueP95Seconds: number | null
  jobP95Seconds: number | null
  bridgeSuccessRate: number | null
  github429PerSecond: number | null
  openAlerts: number | null
}

// The numerator of the job success rate, named on its own so neither the report
// nor the alert rule has to reach into the set by position: `SLO_JOB_STATUSES`
// is built from this, not the other way round. One definition, so the report and
// the alert rule cannot drift: the rule is YAML and cannot import this, so
// test/slo-status.test.ts reads that file as text and pins both of its selectors
// to these values.
export const SLO_SUCCESS_STATUS = 'succeeded' as const satisfies JobStatus

// The statuses the job success rate divides over. `SLO_SUCCESS_STATUS` is the
// numerator; both members are the denominator.
export const SLO_JOB_STATUSES = [SLO_SUCCESS_STATUS, 'failed'] as const satisfies readonly JobStatus[]

// Terminal `JobStatus` values left out of numerator and denominator alike, so
// the rate is over jobs that ran, not over every job. A cancellation did not
// fail and a quota refusal never ran. Nothing at runtime reads this list: it is
// the other half of the definition, exported so the doc that names it
// (docs/observability.md) is pinned by the same test as the selectors. `queued`
// and `running` are absent from both lists because they are not terminal.
export const EXCLUDED_JOB_STATUSES = ['cancelled', 'paused', 'quota_exhausted'] as const satisfies readonly JobStatus[]

// The six queries the report runs, each paired with the field it fills. The
// pairing lives here, once, so the CLI cannot label one series with another: it
// sends `pair[1]` and fills `pair[0]`, and no second list of names exists to
// drift out of order. Before this list the CLI built the six expressions and then
// read the answers back by position at a destructure that named the fields
// separately, so swapping two names there printed a plausible, wrong report and
// left every test green.
export const SLO_QUERY_PAIRS = [
  [
    'successRate',
    `sum(rate(fledge_jobs_total{status="${SLO_SUCCESS_STATUS}"}[7d])) / sum(rate(fledge_jobs_total{status=~"${SLO_JOB_STATUSES.join('|')}"}[7d]))`,
  ],
  ['queueP95Seconds', 'histogram_quantile(0.95, sum(rate(fledge_job_queue_seconds_bucket[7d])) by (le))'],
  ['jobP95Seconds', 'histogram_quantile(0.95, sum(rate(fledge_job_seconds_bucket[7d])) by (le))'],
  [
    'bridgeSuccessRate',
    'sum(rate(fledge_bridge_requests_total{status=~"2.."}[7d])) / sum(rate(fledge_bridge_requests_total[7d]))',
  ],
  ['github429PerSecond', 'sum(rate(fledge_github_requests_total{status="429"}[7d]))'],
  ['openAlerts', 'fledge_ops_alerts_open'],
] as const satisfies readonly (readonly [keyof SloInput, string])[]

export function errorBudget(actual: number | null, target: number): number | null {
  if (actual === null || !Number.isFinite(actual) || target >= 1) return null
  return Math.max(0, Math.min(1, (actual - target) / (1 - target)))
}

// A quiet window is not an absent one: the counters exist and do not move, so
// the rate is 0/0 and Prometheus answers `NaN`. `NaN` is not `null`, so a
// `=== null` test would print `NaN%` / `NaNm`. Only the cells that can be
// non-finite use this guard — the 429 rate and the open-alert gauge read a real
// 0 on the same window and must keep printing it.
function finite(value: number | null): value is number {
  return value !== null && Number.isFinite(value)
}

export function formatSloReport(input: SloInput, target = 0.9): string {
  const rate = finite(input.successRate) ? `${(input.successRate * 100).toFixed(2)}%` : 'n/a'
  const budget = errorBudget(input.successRate, target)
  const budgetText = budget === null ? 'n/a' : `${(budget * 100).toFixed(1)}%`
  const duration = (value: number | null): string => (finite(value) ? `${(value / 60).toFixed(1)}m` : 'n/a')
  return [
    '| SLO | Value | Target |',
    '|---|---|---|',
    `| Job success rate (7d) | ${rate} | ≥ ${(target * 100).toFixed(0)}% |`,
    `| Job success error budget | ${budgetText} | ≥ 0% |`,
    `| p95 queue wait (7d) | ${duration(input.queueP95Seconds)} | < 10m |`,
    `| p95 job duration (7d) | ${duration(input.jobP95Seconds)} | < 30m |`,
    `| Bridge success rate (7d) | ${finite(input.bridgeSuccessRate) ? `${(input.bridgeSuccessRate * 100).toFixed(2)}%` : 'n/a'} | ≥ 99% |`,
    `| GitHub 429 rate (7d) | ${input.github429PerSecond === null ? 'n/a' : `${input.github429PerSecond.toFixed(3)}/s`} | < 0.1/s |`,
    `| Open operational alerts | ${input.openAlerts === null ? 'n/a' : input.openAlerts} | 0 |`,
  ].join('\n')
}
