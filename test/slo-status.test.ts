import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EXCLUDED_JOB_STATUSES, SLO_JOB_STATUSES } from '../src/lib/slo.js'

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

test('the operating doc names the statuses the success rate leaves out', () => {
  const doc = read('docs/observability.md')
  // The `n/a` promise stays: a missing series and a quiet window both render it.
  assert.match(doc, /Missing series render as `n\/a`/)
  for (const status of SLO_JOB_STATUSES) assert.ok(doc.includes(status), `docs/observability.md must name ${status} as counted`)
  for (const status of EXCLUDED_JOB_STATUSES) assert.ok(doc.includes(status), `docs/observability.md must name ${status}`)
  assert.match(doc, /numerator and[^.]{0,40}denominator/i)
})
