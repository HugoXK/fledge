export interface SloInput {
  successRate: number | null
  queueP95Seconds: number | null
  jobP95Seconds: number | null
  bridgeSuccessRate: number | null
  github429PerSecond: number | null
  openAlerts: number | null
}

export function errorBudget(actual: number | null, target: number): number | null {
  if (actual === null || !Number.isFinite(actual) || target >= 1) return null
  return Math.max(0, Math.min(1, (actual - target) / (1 - target)))
}

export function formatSloReport(input: SloInput, target = 0.9): string {
  const rate = input.successRate === null ? 'n/a' : `${(input.successRate * 100).toFixed(2)}%`
  const budget = errorBudget(input.successRate, target)
  const budgetText = budget === null ? 'n/a' : `${(budget * 100).toFixed(1)}%`
  const duration = (value: number | null): string => (value === null ? 'n/a' : `${(value / 60).toFixed(1)}m`)
  return [
    '| SLO | Value | Target |',
    '|---|---|---|',
    `| Job success rate (7d) | ${rate} | ≥ ${(target * 100).toFixed(0)}% |`,
    `| Job success error budget | ${budgetText} | ≥ 0% |`,
    `| p95 queue wait (7d) | ${duration(input.queueP95Seconds)} | < 10m |`,
    `| p95 job duration (7d) | ${duration(input.jobP95Seconds)} | < 30m |`,
    `| Bridge success rate (7d) | ${input.bridgeSuccessRate === null ? 'n/a' : `${(input.bridgeSuccessRate * 100).toFixed(2)}%`} | ≥ 99% |`,
    `| GitHub 429 rate (7d) | ${input.github429PerSecond === null ? 'n/a' : `${input.github429PerSecond.toFixed(3)}/s`} | < 0.1/s |`,
    `| Open operational alerts | ${input.openAlerts === null ? 'n/a' : input.openAlerts} | 0 |`,
  ].join('\n')
}
