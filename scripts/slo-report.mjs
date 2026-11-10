#!/usr/bin/env node
// Query Prometheus and print the Fledge SLO / error-budget table.
import { formatSloReport, SLO_JOB_STATUSES } from '../dist/lib/slo.js'

const base = (process.env.PROMETHEUS_URL ?? 'http://127.0.0.1:9090').replace(/\/$/, '')
const target = Number(process.env.SLO_SUCCESS_TARGET ?? '0.9')
// One status set, exported and pinned to the alert rule by test/slo-status.test.ts.
// The result is a rate over jobs that ran to success or failure; every other
// terminal status is in neither the numerator nor the denominator.
const counted = SLO_JOB_STATUSES.join('|')

async function query(expr) {
  const url = `${base}/api/v1/query?query=${encodeURIComponent(expr)}`
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`Prometheus ${response.status}`)
  const body = await response.json()
  if (body.status !== 'success') throw new Error(body.error ?? 'Prometheus query failed')
  const value = body.data?.result?.[0]?.value?.[1]
  return value === undefined ? null : Number(value)
}

const input = {
  successRate: await query(`sum(rate(fledge_jobs_total{status="succeeded"}[7d])) / sum(rate(fledge_jobs_total{status=~"${counted}"}[7d]))`),
  queueP95Seconds: await query('histogram_quantile(0.95, sum(rate(fledge_job_queue_seconds_bucket[7d])) by (le))'),
  jobP95Seconds: await query('histogram_quantile(0.95, sum(rate(fledge_job_seconds_bucket[7d])) by (le))'),
  bridgeSuccessRate: await query('sum(rate(fledge_bridge_requests_total{status=~"2.."}[7d])) / sum(rate(fledge_bridge_requests_total[7d]))'),
  github429PerSecond: await query('sum(rate(fledge_github_requests_total{status="429"}[7d]))'),
  openAlerts: await query('fledge_ops_alerts_open'),
}
process.stdout.write(`${formatSloReport(input, target)}\n`)
