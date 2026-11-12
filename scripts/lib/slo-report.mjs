// The SLO report's tail, as one importable function.
//
// The pair list decides which field receives which expression's value, and the
// refusal is reported here rather than in the CLI file, so a test can see both
// outputs of the seam without spawning `node` (the CLI imports `../dist` and
// would die with ERR_MODULE_NOT_FOUND before `npm test` builds). Nothing here
// reads the clock or the repository, and the caller injects the fetch.
//
// `pairs` is `[field, expr]`; `result.values` is the answer to `pairs[i][1]` at
// `values[i]`, because `runPrometheusQueries` was handed the expressions in that
// order. There is no second list of field names to fall out of step with it.

import { runPrometheusQueries } from './prometheus-url.mjs'

export function sloInputFromValues(values, pairs) {
  const input = {}
  pairs.forEach(([field], index) => {
    input[field] = values[index] ?? null
  })
  return input
}

// `stdout`, `stderr` and `exit` are injected so the refusal path — the one that
// prints `slo-report: …` and exits 1 — is asserted by a test instead of by hand.
// `formatSloReport` is passed in because the formatter lives in `src/lib` and
// this module must stay importable before `npm run build`.
export async function reportSlo({ env, pairs, fetchImpl, target, formatSloReport, stdout, stderr, exit }) {
  const exprs = pairs.map(([, expr]) => expr)
  const result = await runPrometheusQueries({ env, exprs, fetchImpl })
  if (result.refusal !== undefined) {
    stderr.write(`slo-report: ${result.refusal}\n`)
    exit(1)
    return
  }
  stdout.write(`${formatSloReport(sloInputFromValues(result.values, pairs), target)}\n`)
}
