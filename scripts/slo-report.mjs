#!/usr/bin/env node
// Query Prometheus and print the Fledge SLO / error-budget table.
//
// The field order is not here: `SLO_QUERY_PAIRS` pairs each expression with the
// field it fills, and the tail that walks it lives in `./lib/slo-report.mjs` so a
// test can drive it. This file only wires the real `fetch`, the real streams and
// the real exit into that seam. A refusal is printed there and never names the
// value it refused, because Node would print the credential if it did.
import { formatSloReport, SLO_QUERY_PAIRS } from '../dist/lib/slo.js'
import { reportSlo } from './lib/slo-report.mjs'

await reportSlo({
  env: process.env,
  pairs: SLO_QUERY_PAIRS,
  fetchImpl: fetch,
  target: Number(process.env.SLO_SUCCESS_TARGET ?? '0.9'),
  formatSloReport,
  stdout: process.stdout,
  stderr: process.stderr,
  exit: (code) => process.exit(code),
})
