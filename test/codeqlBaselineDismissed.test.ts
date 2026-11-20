import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { CodeqlAlert, CodeqlBaselineEntry } from '../scripts/lib/codeql-alerts.mjs'
import { addedAlerts, validateBaseline } from '../scripts/lib/codeql-alerts.mjs'

// #928: the baseline carried four `js/missing-rate-limiting` results as **open**
// with `expires: 2026-12-15`. The alerts themselves are dismissed in the alert
// UI since 2026-11-12 (`fixed_at 2026-11-13T01:32Z`, reason `false positive`),
// and #708's route rate limiting landed (#757, #832, #844), so the entries are
// the only thing left that could redden every pull request on a date.
//
// This is the pin: the four results are recorded the way this file records a
// dismissed result — `dismissed: true`, no owner, no expiry — and the gate
// cannot reach an expired-entry failure for them before or after that date.

type Entry = CodeqlBaselineEntry & { owner?: string; expires?: string }

const baselinePath = fileURLToPath(new URL('../.github/agent/codeql-baseline.json', import.meta.url))
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as { note?: string; alerts?: Entry[] }
const alerts = Array.isArray(baseline.alerts) ? baseline.alerts : []

const KEYS = [
  'js/missing-rate-limiting|src/app.ts|639',
  'js/missing-rate-limiting|src/app.ts|674',
  'js/missing-rate-limiting|src/app.ts|694',
  'js/missing-rate-limiting|src/app.ts|3753',
]

// The same shape `alertKey` builds, without handing every raw JSON entry a
// severity it does not carry.
function keyOf(value: { ruleId: string; path: string; line: number }): string {
  return `${value.ruleId}|${value.path}|${value.line}`
}

function entryFor(key: string): Entry {
  const entry = alerts.find((value) => keyOf(value) === key)
  assert.ok(entry !== undefined, `the baseline must keep ${key} in the known set`)
  return entry
}

test('the four rate-limiting results are dismissed entries with no owner and no expiry', () => {
  for (const key of KEYS) {
    const entry = entryFor(key)
    assert.equal(entry.dismissed, true, `${key} must be recorded as dismissed, not as an accepted open result`)
    assert.equal(entry.owner, undefined, `${key} is dismissed, so it has no owner to renew`)
    assert.equal(entry.expires, undefined, `${key} must not carry an expiry that can redden every pull request`)
    assert.match(String(entry.reason ?? ''), /false positive/i, `${key} must carry the dismissal reason GitHub reports`)
  }
})

test('no entry in the baseline still carries the 2026-12-15 expiry', () => {
  const expiring = alerts.filter((entry) => entry.expires === '2026-12-15')
  assert.deepEqual(expiring, [], 'an open entry with the old expiry is the date-driven red this card exists to remove')
})

test('the gate validates the file before and after that date, with no expired-entry error', () => {
  for (const now of [Date.parse('2026-12-14T00:00:00Z'), Date.parse('2026-12-16T00:00:00Z')]) {
    const validated = validateBaseline(baseline, now)
    assert.deepEqual(validated.errors, [], `the baseline must validate at ${new Date(now).toISOString()}: ${validated.errors.join('; ')}`)
    assert.doesNotMatch(validated.errors.join('; '), /expired on/, 'nothing in this file may expire')
    for (const key of KEYS) {
      const entry = validated.entries.find((value) => keyOf(value) === key)
      assert.ok(entry !== undefined, `${key} must survive validation, so a dismissed result stays in the known set`)
      assert.equal(entry.dismissed, true, `${key} must validate as dismissed`)
    }
  }
})

test('a dismissed result stays known, so the gate never reports it as newly added', () => {
  const known = alerts.map((entry) => keyOf(entry))
  const results: CodeqlAlert[] = KEYS.map((key) => {
    const [ruleId, path, line] = key.split('|')
    return { ruleId: String(ruleId), path: String(path), line: Number(line), severity: 'high' }
  })
  assert.deepEqual(addedAlerts(known, results), [], 'the four results are in the baseline, not new ones to fail the gate on')
})

test('the file note describes the state the file is in', () => {
  const note = String(baseline.note ?? '')
  assert.match(note, /dismissed/i, 'the note must say the four are dismissed')
  assert.doesNotMatch(note, /Nothing is dismissed by this file/, 'the old opening sentence would describe a state the file no longer has')
})
