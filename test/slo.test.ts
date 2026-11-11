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

test('a quiet window renders n/a in the four cells that can be non-finite', () => {
  // What `sum(rate(...)) / sum(rate(...))` returns when both counters are
  // present and flat, and what `histogram_quantile` returns over an all-zero
  // histogram: NaN, not null, so the `=== null` branch is not taken.
  const quiet = formatSloReport({ successRate: Number.NaN, queueP95Seconds: Number.NaN, jobP95Seconds: Number.NaN, bridgeSuccessRate: Number.NaN, github429PerSecond: 0, openAlerts: 0 })
  assert.equal(quiet.includes('NaN'), false)
  assert.match(quiet, /Job success rate \(7d\) \| n\/a/)
  assert.match(quiet, /Job success error budget \| n\/a/)
  assert.match(quiet, /p95 queue wait \(7d\) \| n\/a/)
  assert.match(quiet, /p95 job duration \(7d\) \| n\/a/)
  assert.match(quiet, /Bridge success rate \(7d\) \| n\/a/)
})

test('a real zero stays a zero in the two cells whose zero is well defined', () => {
  // Guarding these would turn a healthy, measured window into an unmeasured
  // one: a flat 429 counter is a real 0, and a zero gauge is a real 0.
  const healthy = formatSloReport({ successRate: 1, queueP95Seconds: 0, jobP95Seconds: 0, bridgeSuccessRate: 1, github429PerSecond: 0, openAlerts: 0 })
  assert.match(healthy, /GitHub 429 rate \(7d\) \| 0\.000\/s/)
  assert.match(healthy, /Open operational alerts \| 0 \|/)
  assert.equal(healthy.includes('n/a'), false)
})
