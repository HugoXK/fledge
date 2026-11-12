import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// This file is the contract between the prose and the paging rules. It reads the
// SLO table in docs/observability.md, the rules in deploy/prometheus/fledge-alerts.yml
// and the metric names the code actually records, then checks that the three
// agree. Nothing here may be satisfied by editing one side alone: a documented
// target with no rule is a false claim of coverage, and a rule whose unit or
// selector differs from its target measures something else.

const root = fileURLToPath(new URL('..', import.meta.url))
const docsPath = join(root, 'docs/observability.md')
const handoffPath = join(root, 'docs/handoff.md')
const alertsPath = join(root, 'deploy/prometheus/fledge-alerts.yml')
const docs = readFileSync(docsPath, 'utf8')
const handoff = readFileSync(handoffPath, 'utf8')
const alerts = readFileSync(alertsPath, 'utf8')

const MARKER = '<!-- slo:reported-only -->'

// Which rule pages on which documented target. The pair is explicit because the
// doc uses prose names and Prometheus uses alert names; what the test enforces is
// that both ends exist and that their numbers, units and selectors agree.
const PAIRS: { row: string; alert: string | null }[] = [
  { row: 'job success rate', alert: 'FledgeJobSuccessRateLow' },
  { row: 'p95 queue wait', alert: 'FledgeQueueWaitHigh' },
  { row: 'p95 job duration', alert: 'FledgeJobDurationHigh' },
  { row: 'merge success after green checks', alert: null },
  { row: 'bridge availability', alert: 'FledgeBridgeFailureRate' },
  { row: 'GitHub 429', alert: 'FledgeGitHubRateLimited' },
]

interface SloRow {
  line: string
  label: string
  target: string
  reportedOnly: boolean
}

function sloRows(): SloRow[] {
  const rows: SloRow[] = []
  const lines = docs.split('\n')
  const start = lines.findIndex((line) => line.trim() === 'Suggested SLOs:')
  assert.notEqual(start, -1, 'docs/observability.md must carry a "Suggested SLOs:" table')
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!
    if (line.trim() === '') {
      if (rows.length > 0) break
      continue
    }
    if (!line.trimStart().startsWith('|')) break
    const cells = line.split('|').map((cell) => cell.trim())
    // cells[0] and cells[last] are empty: the line starts and ends with |.
    if (cells.length < 4) continue
    const label = cells[1]!
    const target = cells[2]!
    if (label === 'SLO' || /^-+$/.test(label)) continue
    rows.push({ line, label, target, reportedOnly: line.includes(MARKER) })
  }
  assert.ok(rows.length >= 4, 'the SLO table must list the documented targets')
  return rows
}

interface AlertRule {
  name: string
  expr: string
}

// Read each `- alert:` block and rebuild its expression. A rule may write the
// expression inline or as a YAML block scalar; both forms have to end up as one
// line here, or a threshold could hide on a continuation line.
function alertRules(text: string): AlertRule[] {
  const lines = text.split('\n')
  const rules: AlertRule[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const header = /^(\s*)- alert:\s*(\S+)\s*$/.exec(lines[index]!)
    if (header === null) continue
    const parts: string[] = []
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]!
      if (/^\s*- alert:/.test(line)) break
      if (/^\s*expr:\s*[|>][-+]?\s*$/.test(line)) {
        // A block scalar ends at the first line indented no deeper than the
        // `expr:` key itself, which is how `for:` and `annotations:` stay out.
        const exprIndent = line.search(/\S/)
        for (let inner = cursor + 1; inner < lines.length; inner += 1) {
          const entry = lines[inner]!
          if (entry.trim() === '') continue
          const entryIndent = entry.search(/\S/)
          if (entryIndent <= exprIndent) break
          parts.push(entry.trim())
          cursor = inner
        }
        continue
      }
      const inline = /^\s*expr:\s*(.+)$/.exec(line)
      if (inline !== null) {
        parts.push(inline[1]!.trim())
        continue
      }
    }
    rules.push({ name: header[2]!, expr: parts.join(' ') })
  }
  return rules
}

type Unit = 'share' | 'per-second' | 'seconds' | 'unknown'

function ruleUnit(expr: string): Unit {
  if (expr.includes('histogram_quantile(')) return 'seconds'
  // A ratio divides a rate by another rate; an absolute rule compares one rate
  // with a plain number. The difference is the unit, not a formatting choice.
  if (/\n\s*\/\s*\n|\)\s*\/\s*sum\(|sum\([^)]*\)\s*\/\s*sum\(/.test(expr)) return 'share'
  if (/rate\([^)]*\)\)*\s*>\s*[0-9.]+/.test(expr)) return 'per-second'
  return 'unknown'
}

function ruleThreshold(expr: string, unit: Unit): number {
  if (unit === 'share' || unit === 'per-second') {
    const match = /([0-9.]+)\)?\s*$/.exec(expr.trim())
    assert.ok(match, `cannot read the threshold from: ${expr}`)
    return Number(match[1])
  }
  const match = /([0-9.]+)\s*$/.exec(expr.trim())
  assert.ok(match, `cannot read the threshold from: ${expr}`)
  return Number(match[1])
}

// Equality selectors only: a negation (`status!~"2.."`) is the complement of a
// set, and forcing the prose to spell that complement out would make the table
// harder to read without making the check stronger.
function ruleSelector(expr: string): string[] {
  const tokens = new Set<string>()
  for (const match of expr.matchAll(/status(=~|=)"([^"]+)"/g)) {
    for (const token of match[2]!.split('|')) tokens.add(token)
  }
  return [...tokens].sort()
}

function docSelector(target: string): string[] {
  const tokens = new Set<string>()
  for (const match of target.matchAll(/(succeeded|failed|429|5xx|4xx)/g)) tokens.add(match[1]!)
  return [...tokens].sort()
}

function docShares(target: string): number[] {
  return [...target.matchAll(/([0-9.]+)\s*%/g)].map((match) => Number(match[1]) / 100)
}

function docRates(target: string): number[] {
  return [...target.matchAll(/([0-9.]+)\s*(?:req\/s|\/s|per second)/g)].map((match) => Number(match[1]))
}

function docSeconds(target: string): number[] {
  const values: number[] = []
  for (const match of target.matchAll(/([0-9.]+)\s*(?:min|minutes?)\b/g)) values.push(Number(match[1]) * 60)
  for (const match of target.matchAll(/([0-9.]+)\s*(?:s|sec|seconds?)\b/g)) values.push(Number(match[1]))
  return values
}

test('every documented SLO has a rule or a reported-only marker, and the pair agrees on unit and selector', () => {
  const rows = sloRows()
  const rules = alertRules(alerts)
  const byName = new Map(rules.map((rule) => [rule.name, rule]))
  // Collect every disagreement before failing: one red run has to say all of
  // what is wrong, or the next reader fixes one row and re-runs to hear the rest.
  const problems: string[] = []
  const matched = new Set<string>()
  for (const row of rows) {
    const pair = PAIRS.find((candidate) => row.label.startsWith(candidate.row))
    if (pair === undefined) {
      problems.push(`the SLO row "${row.label}" has no entry in this test; add it so the target is checked`)
      continue
    }
    if (matched.has(pair.row)) problems.push(`two SLO rows match "${pair.row}"`)
    matched.add(pair.row)

    const rule = pair.alert === null ? undefined : byName.get(pair.alert)
    if (pair.alert !== null && rule === undefined) problems.push(`this test names ${pair.alert} but the rules file has no such alert`)
    if (rule === undefined) {
      if (!row.reportedOnly) problems.push(`"${row.label}" documents a target with no rule; either add the rule or mark the row ${MARKER}`)
      continue
    }
    if (row.reportedOnly) problems.push(`"${row.label}" carries ${MARKER} but ${rule.name} exists; drop the marker`)

    const unit = ruleUnit(rule.expr)
    if (unit === 'unknown') {
      problems.push(`${rule.name} uses a unit this test cannot read; extend the test with the new unit instead of skipping it`)
      continue
    }
    const threshold = ruleThreshold(rule.expr, unit)

    if (unit === 'share') {
      const shares = docShares(row.target)
      // One percentage point, and only between targets that already share a unit
      // and a selector. A wider gap is a different SLO, not rounding.
      if (shares.length === 0) problems.push(`"${row.label}" is a share in ${rule.name} but its target states no percentage: ${row.target}`)
      else if (!shares.some((share) => Math.abs(share - threshold) <= 0.01)) problems.push(`"${row.label}" targets ${row.target} but ${rule.name} pages at ${threshold * 100}%`)
    } else if (unit === 'per-second') {
      const rates = docRates(row.target)
      if (rates.length === 0) problems.push(`"${row.label}" is an absolute rate in ${rule.name} but its target states no req/s value: ${row.target}`)
      else if (!rates.some((rate) => Math.abs(rate - threshold) <= 0.0001)) problems.push(`"${row.label}" targets ${row.target} but ${rule.name} pages at ${threshold} req/s`)
    } else {
      const seconds = docSeconds(row.target)
      if (seconds.length === 0) problems.push(`"${row.label}" is a duration in ${rule.name} but its target states no minutes: ${row.target}`)
      else if (!seconds.some((value) => Math.abs(value - threshold) <= 0.5)) problems.push(`"${row.label}" targets ${row.target} but ${rule.name} pages at ${threshold}s`)
    }

    // The selector may be named in either cell: the label often carries it.
    const documented = docSelector(row.line)
    const paged = ruleSelector(rule.expr)
    if (paged.length > 0 && documented.join('|') !== paged.join('|')) {
      problems.push(`"${row.label}" counts ${documented.join('+') || 'nothing'} but ${rule.name} counts ${paged.join('+')}`)
    }
  }

  for (const pair of PAIRS) {
    if (!matched.has(pair.row)) problems.push(`this test names "${pair.row}" but docs/observability.md has no such SLO row`)
  }
  assert.deepEqual(problems, [], `the SLO table and the alert rules disagree:\n- ${problems.join('\n- ')}`)
})

// The inventory is read in both directions on purpose: a doc row whose series
// does not exist is a lie, and a series the code records but the doc omits is how
// the newest alert ends up depending on something nobody catalogued.
function codeSeries(): string[] {
  const names = new Set<string>()
  const walk = (dir: string): void => {
    // `withFileTypes` answers "file or directory" from the directory listing
    // itself, so this never stats a path and then reads it: a check-then-use on
    // the filesystem is a race CodeQL flags as `js/file-system-race`, and a test
    // has no reason to create one.
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
      const text = readFileSync(path, 'utf8')
      for (const match of text.matchAll(/(?:incCounter|setGauge|observeHistogram)\('([a-z0-9_]+)'/g)) names.add(match[1]!)
    }
  }
  walk(join(root, 'src'))
  return [...names].sort()
}

function docSeries(): string[] {
  const start = docs.indexOf('Core series:')
  assert.notEqual(start, -1, 'docs/observability.md must carry a "Core series:" catalogue')
  const end = docs.indexOf('Suggested SLOs:', start)
  assert.notEqual(end, -1, 'the Core series catalogue must sit before the SLO table')
  const names = new Set<string>()
  for (const match of docs.slice(start, end).matchAll(/fledge_[a-z0-9_]+/g)) names.add(match[0])
  return [...names].sort()
}

test('the Core series catalogue and the series the code records name the same set', () => {
  const documented = docSeries()
  const recorded = codeSeries()
  const missingFromDoc = recorded.filter((name) => !documented.includes(name))
  const missingFromCode = documented.filter((name) => !recorded.includes(name))
  assert.deepEqual(missingFromDoc, [], `the code records series the catalogue omits: ${missingFromDoc.join(', ')}`)
  assert.deepEqual(missingFromCode, [], `the catalogue names series the code does not record: ${missingFromCode.join(', ')}`)
})

test('the handoff states the check it ran without a test count that can rot', () => {
  const claims = handoff.split('\n').filter((line) => /^-\s*`?npm run check/.test(line))
  assert.equal(claims.length, 1, `docs/handoff.md makes the npm run check claim ${claims.length} times`)
  // A count is only honest with the sha it was measured at; "green at the tip"
  // cannot go stale. The old text claimed 359 tests while the tree ran 527.
  assert.doesNotMatch(claims[0]!, /\b\d{2,} tests\b/, 'a test count needs the sha it was measured at, or no count at all')
})
