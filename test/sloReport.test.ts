import test from 'node:test'
import assert from 'node:assert/strict'
import { formatSloReport, SLO_QUERY_PAIRS, type SloInput } from '../src/lib/slo.js'
import { reportSlo } from '../scripts/lib/slo-report.mjs'

// The mapping between an expression and the field it fills is the one thing the
// CLI could get wrong without any test noticing: before `SLO_QUERY_PAIRS`, the
// expressions were one array and the field names another, joined only by a
// positional destructure. These cases drive the real seam with an injected
// client, so a swap between two fields fails here rather than printing a
// plausible report.
//
// Nothing here spawns `scripts/slo-report.mjs` (it imports `../dist` and would
// die before `npm test` builds) and nothing needs a build.

const SENTINEL = { success: 0.8, queue: 2400, job: 60, bridge: 0.5, github: 4, alerts: 3 } as const

// Answer each expression with a value that is only reachable through the metric
// it selects, so a field that receives another expression's answer is visible.
function valueFor(expr: string): number {
  if (/fledge_job_queue_seconds_bucket/.test(expr)) return SENTINEL.queue
  if (/fledge_job_seconds_bucket/.test(expr)) return SENTINEL.job
  if (/fledge_jobs_total/.test(expr)) return SENTINEL.success
  if (/fledge_bridge_requests_total/.test(expr)) return SENTINEL.bridge
  if (/fledge_github_requests_total/.test(expr)) return SENTINEL.github
  if (/fledge_ops_alerts_open/.test(expr)) return SENTINEL.alerts
  throw new Error(`unexpected expression: ${expr}`)
}

function collector() {
  const chunks: string[] = []
  return {
    write: (chunk: string) => {
      chunks.push(chunk)
    },
    text: () => chunks.join(''),
  }
}

function answeringFetch(calls: string[] = []) {
  return async (url: string) => {
    const expr = new URL(url).searchParams.get('query') ?? ''
    calls.push(expr)
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'success', data: { result: [{ value: [0, String(valueFor(expr))] }] } }),
    }
  }
}

test('each field receives its own expression’s data and prints under its own label', async () => {
  const seen: SloInput[] = []
  const stdout = collector()
  const stderr = collector()
  const exits: number[] = []
  const calls: string[] = []
  await reportSlo({
    env: { PROMETHEUS_URL: 'http://127.0.0.1:9090' },
    pairs: SLO_QUERY_PAIRS,
    fetchImpl: answeringFetch(calls),
    target: 0.9,
    formatSloReport: (input, target) => {
      seen.push(input)
      return formatSloReport(input, target)
    },
    stdout,
    stderr,
    exit: (code) => exits.push(code),
  })

  assert.deepEqual(exits, [], 'a complete answer must not exit non-zero')
  assert.equal(stderr.text(), '', 'a complete answer must not write to stderr')
  assert.equal(calls.length, SLO_QUERY_PAIRS.length, 'every pair is queried once')
  assert.deepEqual(seen[0], {
    successRate: SENTINEL.success,
    queueP95Seconds: SENTINEL.queue,
    jobP95Seconds: SENTINEL.job,
    bridgeSuccessRate: SENTINEL.bridge,
    github429PerSecond: SENTINEL.github,
    openAlerts: SENTINEL.alerts,
  })

  // The label the operator reads: a queue wait of 2400 s is 40.0m under the queue
  // row, and 60 s is 1.0m under job duration. This is the swap the review proved
  // invisible — it now moves a number into the wrong row and fails above.
  const report = stdout.text()
  assert.match(report, /p95 queue wait \(7d\) \| 40\.0m/)
  assert.match(report, /p95 job duration \(7d\) \| 1\.0m/)
})

test('a refused base URL writes one line on stderr and exits 1 without querying', async () => {
  const stdout = collector()
  const stderr = collector()
  const exits: number[] = []
  const calls: string[] = []
  await reportSlo({
    env: { PROMETHEUS_URL: 'http://user:prom-sentinel-4f7c1d@prom.example:9090' },
    pairs: SLO_QUERY_PAIRS,
    fetchImpl: answeringFetch(calls),
    target: 0.9,
    formatSloReport,
    stdout,
    stderr,
    exit: (code) => exits.push(code),
  })

  assert.deepEqual(exits, [1], 'a refusal exits 1')
  assert.equal(stdout.text(), '', 'a refusal prints no report')
  assert.match(stderr.text(), /^slo-report: /, 'the refusal is prefixed as coming from this command')
  assert.match(stderr.text(), /PROMETHEUS_URL/, 'the operator is told which variable was refused')
  assert.equal(stderr.text().includes('prom-sentinel-4f7c1d'), false, 'the credential is never printed')
  assert.deepEqual(calls, [], 'a refusal is decided before any request')
})

test('the pair list names every reported field exactly once', () => {
  const fields = SLO_QUERY_PAIRS.map(([field]) => field)
  assert.deepEqual(
    [...fields].sort(),
    ['bridgeSuccessRate', 'github429PerSecond', 'jobP95Seconds', 'openAlerts', 'queueP95Seconds', 'successRate'],
    'a field added to SloInput without a pair would print n/a forever; a duplicate would overwrite a series',
  )
  for (const [, expr] of SLO_QUERY_PAIRS) assert.ok(expr.trim() !== '', 'every pair carries an expression')
})
