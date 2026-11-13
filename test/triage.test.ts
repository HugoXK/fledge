import test from 'node:test'
import assert from 'node:assert/strict'
import { TRIAGE_MAX_ITEMS, TRIAGE_TITLE_MAX, parseTriage, parseTriageJson, triageSummaryLine } from '../src/lib/triage.js'

const BASE = 'https://github.com/o/r/issues'

function item(issue: number, priority = 0, duplicateOf: number | null = null): Record<string, unknown> {
  return { issue, url: `${BASE}/${issue}`, title: `issue ${issue}`, priority, duplicateOf }
}

test('a triage report keeps its ranking and links a duplicate instead of repeating it', () => {
  const report = parseTriage({
    items: [item(12, 30), item(9, 20), item(7, 10, 12)],
    next: { issue: 12, url: `${BASE}/12`, title: 'issue 12' },
  })
  assert.notEqual(report, null)
  assert.equal(report!.schema_version, 1)
  assert.deepEqual(report!.items.map((entry) => entry.issue), [12, 9, 7])
  assert.equal(report!.items[2]!.duplicateOf, 12, 'the duplicate points at the issue that stays open')
  assert.equal(new Set(report!.items.map((entry) => entry.issue)).size, 3, 'one row per issue')
  assert.deepEqual(report!.next, { issue: 12, url: `${BASE}/12`, title: 'issue 12' })
  assert.equal(triageSummaryLine(report!), '3 open, 1 duplicate(s), next #12')
})

test('an empty board is a valid report and proposes nothing', () => {
  const report = parseTriage({ items: [], next: null })
  assert.notEqual(report, null)
  assert.deepEqual(report!.items, [])
  assert.equal(report!.next, null)
  assert.equal(triageSummaryLine(report!), '0 open, 0 duplicate(s), no proposal')
})

test('a malformed report is refused rather than read as an empty board', () => {
  const cases: unknown[] = [
    null,
    undefined,
    'items',
    [],
    {},
    { items: 'x' },
    { items: [{ issue: 1, url: 'http://insecure/1', title: 'x', priority: 0 }] },
    { items: [{ issue: 0, url: `${BASE}/0`, title: 'x', priority: 0 }] },
    { items: [{ issue: 1.5, url: `${BASE}/1`, title: 'x', priority: 0 }] },
    { items: [{ issue: 1, url: `${BASE}/1`, title: '   ', priority: 0 }] },
    { items: [{ issue: 1, url: `${BASE}/1`, title: 'x', priority: 5 }] },
    { items: [{ issue: 1, url: `${BASE}/1`, title: 'x', priority: 0 }, { issue: 1, url: `${BASE}/1`, title: 'x', priority: 0 }] },
    { items: [{ issue: 1, url: `${BASE}/1`, title: 'x', priority: 10 }, { issue: 2, url: `${BASE}/2`, title: 'y', priority: 30 }] },
    { items: [{ issue: 1, url: `${BASE}/1`, title: 'x', priority: 0, duplicateOf: '2' }] },
    { items: [{ issue: 1, url: `${BASE}/1`, title: 'x', priority: 0, duplicateOf: 1 }] },
    { items: [{ issue: 1, url: `${BASE}/1`, title: 'x', priority: 0, duplicateOf: 99 }] },
    { items: [item(1)], next: { issue: 1, url: 'ftp://x/1', title: 'x' } },
    { items: [item(1), item(2, 10)], next: { issue: 2, url: `${BASE}/2`, title: 'issue 2' } },
    { items: [item(1), item(2, 10, 1)], next: { issue: 2, url: `${BASE}/2`, title: 'issue 2' } },
    { items: Array.from({ length: TRIAGE_MAX_ITEMS + 1 }, (_, index) => item(index + 1)) },
  ]
  for (const value of cases) {
    assert.equal(parseTriage(value), null, `refused: ${JSON.stringify(value)?.slice(0, 120)}`)
  }
})

test('an issue URL needs a host, not just the scheme', () => {
  for (const url of ['https://', 'https:///', 'https://#issue', 'https://?q=1']) {
    assert.equal(parseTriage({ items: [{ issue: 1, url, title: 'x', priority: 0 }] }), null, `refused: ${url}`)
  }
  // The host is what makes the link followable; a port and a path are fine.
  assert.notEqual(parseTriage({ items: [{ issue: 1, url: 'https://ghe.example.com:8443/o/r/issues/1', title: 'x', priority: 0 }] }), null)
})

test('a title longer than the limit is refused, not silently shortened', () => {
  const long = 'x'.repeat(TRIAGE_TITLE_MAX + 1)
  // A cut title reads like the issue's real one, so the report fails closed and
  // the job carries `TRIAGE_UNVERIFIED`; the whole row is never half-reported.
  assert.equal(parseTriage({ items: [{ issue: 1, url: `${BASE}/1`, title: long, priority: 0 }] }), null)
  assert.equal(parseTriage({ items: [item(1)], next: { issue: 1, url: `${BASE}/1`, title: long } }), null, 'the proposal is held to the same limit')
  // Exactly the limit is still a title.
  const exact = parseTriage({ items: [{ issue: 1, url: `${BASE}/1`, title: 'y'.repeat(TRIAGE_TITLE_MAX), priority: 0 }] })
  assert.notEqual(exact, null)
  assert.equal(exact!.items[0]!.title.length, TRIAGE_TITLE_MAX)
})

test('parseTriageJson refuses corrupt storage without throwing', () => {
  assert.equal(parseTriageJson(null), null)
  assert.equal(parseTriageJson(''), null)
  assert.equal(parseTriageJson('{not json'), null)
  assert.equal(parseTriageJson('{"items":[]}')?.items.length, 0)
  assert.equal(parseTriageJson(JSON.stringify({ items: [] }))?.schema_version, 1)
})
