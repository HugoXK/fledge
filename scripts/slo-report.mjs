#!/usr/bin/env node
// Query Prometheus and print the Fledge SLO / error-budget table.
import { formatSloReport, SLO_JOB_STATUSES, SLO_SUCCESS_STATUS } from '../dist/lib/slo.js'
import { runPrometheusQueries } from './lib/prometheus-url.mjs'

const target = Number(process.env.SLO_SUCCESS_TARGET ?? '0.9')
// One definition each for the numerator and the set it divides over, both
// exported and pinned to the alert rule by test/slo-status.test.ts. The result is
// a rate over jobs that ran to success or failure; every other terminal status is
// in neither the numerator nor the denominator, so a cancellation or a quota
// refusal cannot move the rate.
const counted = SLO_JOB_STATUSES.join('|')

const exprs = [
  `sum(rate(fledge_jobs_total{status="${SLO_SUCCESS_STATUS}"}[7d])) / sum(rate(fledge_jobs_total{status=~"${counted}"}[7d]))`,
  'histogram_quantile(0.95, sum(rate(fledge_job_queue_seconds_bucket[7d])) by (le))',
  'histogram_quantile(0.95, sum(rate(fledge_job_seconds_bucket[7d])) by (le))',
  'sum(rate(fledge_bridge_requests_total{status=~"2.."}[7d])) / sum(rate(fledge_bridge_requests_total[7d]))',
  'sum(rate(fledge_github_requests_total{status="429"}[7d]))',
  'fledge_ops_alerts_open',
]

// The base URL and whether a credential travels with the request are decided in
// one place; this file only prints the verdict, and it never names the value it
// refused, because Node would print the credential if it did.
const result = await runPrometheusQueries({ env: process.env, exprs, fetchImpl: fetch })
if (result.refusal !== undefined) {
  console.error(`slo-report: ${result.refusal}`)
  process.exit(1)
}
const [successRate, queueP95Seconds, jobP95Seconds, bridgeSuccessRate, github429PerSecond, openAlerts] = result.values
process.stdout.write(
  `${formatSloReport({ successRate, queueP95Seconds, jobP95Seconds, bridgeSuccessRate, github429PerSecond, openAlerts }, target)}\n`,
)
