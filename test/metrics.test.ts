import test from 'node:test'
import assert from 'node:assert/strict'
import { incCounter, metricsSnapshot, observeHistogram, renderMetrics, resetMetrics, setGauge } from '../src/lib/metrics.js'

test('metrics render counters, gauges and histograms in Prometheus format', () => {
  resetMetrics()
  incCounter('fledge_jobs_total', { status: 'succeeded' }, 2, 'Jobs by status')
  setGauge('fledge_jobs_active', 1, {}, 'Active jobs')
  observeHistogram('fledge_job_seconds', 1.5, { kind: 'iterate' }, 'Job duration')
  const text = renderMetrics()
  assert.match(text, /# TYPE fledge_jobs_total counter/)
  assert.match(text, /fledge_jobs_total\{status="succeeded"\} 2/)
  assert.match(text, /fledge_jobs_active 1/)
  assert.match(text, /fledge_job_seconds_bucket\{kind="iterate",le="2.5"\} 1/)
  assert.match(text, /fledge_job_seconds_count\{kind="iterate"\} 1/)
  const snapshot = metricsSnapshot()
  assert.equal(snapshot.counters[0]?.value, 2)
  resetMetrics()
})
