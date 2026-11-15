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

// #758 finding: `setGauge` published whatever number it was given, so a `NaN`
// reached the scrape as the literal `fledge_clock_skew_seconds NaN`, which
// Prometheus stores as a sample and a dashboard draws as a number. A gauge
// carries a measurement; a non-finite value is not one, and the next caller
// will not remember this conversation — so the guard lives here, next to the
// write, exactly like the finite guard `observeHistogram` already has.
test('a non-finite gauge is unknown, so the series is absent rather than NaN', () => {
  resetMetrics()
  setGauge('fledge_clock_skew_seconds', 42, {}, 'Seconds ahead')
  assert.match(renderMetrics(), /^fledge_clock_skew_seconds 42$/m)
  setGauge('fledge_clock_skew_seconds', Number.NaN, {}, 'Seconds ahead')
  assert.doesNotMatch(renderMetrics(), /fledge_clock_skew_seconds/, 'a NaN gauge was published')
  setGauge('fledge_clock_skew_seconds', Number.POSITIVE_INFINITY, {}, 'Seconds ahead')
  assert.doesNotMatch(renderMetrics(), /fledge_clock_skew_seconds/, 'an infinite gauge was published')
  setGauge('fledge_clock_skew_seconds', 7, {}, 'Seconds ahead')
  assert.match(renderMetrics(), /^fledge_clock_skew_seconds 7$/m)
  resetMetrics()
})
