import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EXCLUDED_JOB_STATUSES, SLO_JOB_STATUSES, SLO_SUCCESS_STATUS } from '../src/lib/slo.js'

const read = (relative: string): string => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')

test('the alert rules and the report both select the denominator from the one exported status set', () => {
  const expected = [...SLO_JOB_STATUSES].sort()
  const rules = read('deploy/prometheus/fledge-alerts.yml')
  // A recording rule is YAML, so it cannot import the constant: the only honest
  // check is that every regex selector in the file carries exactly that set.
  const selectors = [...rules.matchAll(/status=~"([^"]+)"/g)].map((match) => (match[1] ?? '').split('|').sort())
  assert.equal(selectors.length, 2, 'the job success rule carries two regex selectors')
  for (const selector of selectors) assert.deepEqual(selector, expected)
  const script = read('scripts/slo-report.mjs')
  assert.equal(script.includes('succeeded|failed'), false, 'the report does not carry a second copy of the status set')
  assert.match(script, /SLO_JOB_STATUSES/, 'the report builds its selector from the exported set')
})

test('the numerator is one exported status, and neither file carries it as a second literal', () => {
  // The set is built from the status, not the other way round, so nothing here
  // depends on array order; the membership check is what pins the relationship.
  assert.ok([...SLO_JOB_STATUSES].includes(SLO_SUCCESS_STATUS), 'the success status is one of the counted statuses')
  const script = read('scripts/slo-report.mjs')
  // A mutated numerator (`status="failed"`) has to red: the only shape the script
  // may carry is the interpolation of the constant itself.
  assert.equal(script.includes('status="succeeded"'), false, 'the report does not inline the success status')
  assert.equal(script.includes('status="${SLO_SUCCESS_STATUS}"'), true, 'the report builds its numerator from the exported status')
  const rules = read('deploy/prometheus/fledge-alerts.yml')
  // The exact-match form on the job counter is the numerator: `status=~"..."` is
  // the denominator and is pinned by the test above, and the GitHub 429 selector
  // is another counter, so this pattern cannot see either of them.
  const numerators = [...rules.matchAll(/fledge_jobs_total\{status="([^"]+)"\}/g)].map((match) => match[1] ?? '')
  assert.equal(numerators.length, 1, 'the job success rule carries one numerator selector')
  for (const numerator of numerators) assert.equal(numerator, SLO_SUCCESS_STATUS)
})

test('the operating doc names the statuses the success rate leaves out', () => {
  const doc = read('docs/observability.md')
  // The `n/a` promise stays: a missing series and a quiet window both render it.
  assert.match(doc, /Missing series render as `n\/a`/)
  for (const status of SLO_JOB_STATUSES) assert.ok(doc.includes(status), `docs/observability.md must name ${status} as counted`)
  for (const status of EXCLUDED_JOB_STATUSES) assert.ok(doc.includes(status), `docs/observability.md must name ${status}`)
  assert.match(doc, /numerator and[^.]{0,40}denominator/i)
})
