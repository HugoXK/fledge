import test from 'node:test'
import assert from 'node:assert/strict'
import { errorBudget, formatSloReport } from '../src/lib/slo.js'

test('error budget and SLO report are explicit about missing data', () => {
  assert.ok(Math.abs((errorBudget(0.95, 0.9) ?? 0) - 0.5) < 1e-9)
  assert.equal(errorBudget(0.85, 0.9), 0)
  assert.equal(errorBudget(null, 0.9), null)
  const report = formatSloReport({ successRate: 0.95, queueP95Seconds: 120, jobP95Seconds: 600, bridgeSuccessRate: 1, github429PerSecond: 0, openAlerts: 0 })
  assert.match(report, /Job success error budget \| 50\.0%/)
  assert.match(report, /p95 queue wait \(7d\) \| 2\.0m/)
  const missing = formatSloReport({ successRate: null, queueP95Seconds: null, jobP95Seconds: null, bridgeSuccessRate: null, github429PerSecond: null, openAlerts: null })
  assert.match(missing, /n\/a/)
})
