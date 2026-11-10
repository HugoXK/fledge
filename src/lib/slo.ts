import type { JobStatus } from '../db.js'

export interface SloInput {
  successRate: number | null
  queueP95Seconds: number | null
  jobP95Seconds: number | null
  bridgeSuccessRate: number | null
  github429PerSecond: number | null
  openAlerts: number | null
}

// The statuses the job success rate divides over. `succeeded` is the numerator;
// both members are the denominator. One definition, so the report and the alert
// rule cannot drift: the rule is YAML and cannot import this, so
// test/slo-status.test.ts reads that file as text and pins it to this list.
export const SLO_JOB_STATUSES = ['succeeded', 'failed'] as const satisfies readonly JobStatus[]

// Terminal `JobStatus` values left out of numerator and denominator alike, so
// the rate is over jobs that ran, not over every job. A cancellation did not
// fail and a quota refusal never ran. Nothing at runtime reads this list: it is
// the other half of the definition, exported so the doc that names it
// (docs/observability.md) is pinned by the same test as the selectors. `queued`
// and `running` are absent from both lists because they are not terminal.
export const EXCLUDED_JOB_STATUSES = ['cancelled', 'paused', 'quota_exhausted'] as const satisfies readonly JobStatus[]

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
