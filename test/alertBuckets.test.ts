import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The two alert rules read p95 from a histogram, and `histogram_quantile`
// returns the highest finite bucket boundary when the quantile falls in
// `+Inf`. So a threshold above the top finite boundary can never fire. These
// checks read the sources as text and compare the numbers, so neither the
// rules file nor the bucket constant can drift unnoticed.
const metricsSource = readFileSync(fileURLToPath(new URL('../src/lib/metrics.ts', import.meta.url)), 'utf8')
const alertsText = readFileSync(fileURLToPath(new URL('../deploy/prometheus/fledge-alerts.yml', import.meta.url)), 'utf8')

function defaultBuckets(): number[] {
  const match = /const DEFAULT_BUCKETS = \[([^\]]*)\]/.exec(metricsSource)
  assert.ok(match, 'src/lib/metrics.ts must declare DEFAULT_BUCKETS as a literal list')
  const values = match[1]!
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => Number(entry))
  assert.ok(values.length > 0, 'DEFAULT_BUCKETS must not be empty')
  for (const value of values) assert.ok(Number.isFinite(value), `DEFAULT_BUCKETS holds a non-number: ${value}`)
  for (let index = 1; index < values.length; index += 1) {
    assert.ok(values[index]! > values[index - 1]!, 'DEFAULT_BUCKETS must be strictly increasing')
  }
  return values
}

// A rule's comparison may sit on its own line when the expression is a YAML
// block scalar (`expr: |`), which this rules file already does for two of its
// rules. Join a block back into one expression, so a threshold cannot dodge the
// guard by moving to a continuation line.
function logicalExpressions(text: string): string[] {
  const expressions: string[] = []
  let block: { indent: number; lines: string[] } | null = null
  const flush = () => {
    if (block) expressions.push(block.lines.join(' '))
    block = null
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    const start = /^(\s*)expr:\s*[|>][-+]?\s*$/.exec(line)
    if (start) {
      flush()
      block = { indent: start[1]!.length, lines: [] }
      continue
    }
    if (block) {
      const trimmed = line.trimStart()
      if (trimmed === '') continue
      if (line.length - trimmed.length > block.indent) {
        block.lines.push(trimmed)
        continue
      }
      flush()
    }
    const inline = /^\s*expr:\s*(.+)$/.exec(line)
    if (inline) expressions.push(inline[1]!.trim())
  }
  flush()
  return expressions
}

function histogramRules(text: string): Array<{ expression: string; operator: string; threshold: number }> {
  const rules: Array<{ expression: string; operator: string; threshold: number }> = []
  for (const expression of logicalExpressions(text)) {
    const at = expression.indexOf('histogram_quantile')
    if (at === -1) continue
    const comparison = /\s(>=?)\s*([0-9]+(?:\.[0-9]+)?)/.exec(expression.slice(at))
    assert.ok(
      comparison,
      `every histogram_quantile rule must keep a "> <threshold>" comparison this guard can read, however it is wrapped: ${expression.trim()}`,
    )
    rules.push({ expression, operator: comparison![1]!, threshold: Number(comparison![2]) })
  }
  assert.equal(
    rules.length,
    (text.match(/histogram_quantile/g) ?? []).length,
    'every histogram_quantile in the rules file must be readable by this guard, so an unparsed form fails instead of passing',
  )
  return rules
}

test('the highest finite bucket boundary can reach every latency alert threshold', () => {
  const buckets = defaultBuckets()
  const top = buckets[buckets.length - 1]!
  const rules = histogramRules(alertsText)
  assert.ok(rules.length >= 2, `expected at least two histogram alert rules, found ${rules.length}`)
  for (const rule of rules) {
    // A boundary equal to a `>` threshold still caps the p95 at the threshold,
    // so the top boundary has to be strictly greater for that rule to fire.
    assert.ok(
      rule.operator === '>' ? top > rule.threshold : top >= rule.threshold,
      `the top finite bucket (${top}s) cannot reach the alert threshold (${rule.operator} ${rule.threshold}s) in: ${rule.expression.trim()}`,
    )
  }
})

test('the queue-wait and job-duration alerts still read 600s and 1800s', () => {
  const rules = histogramRules(alertsText)
  const queue = rules.find((rule) => rule.expression.includes('fledge_job_queue_seconds_bucket'))
  assert.ok(queue, 'deploy/prometheus/fledge-alerts.yml must keep the queue-wait histogram rule')
  assert.equal(queue!.threshold, 600)
  const job = rules.find((rule) => rule.expression.includes('fledge_job_seconds_bucket'))
  assert.ok(job, 'deploy/prometheus/fledge-alerts.yml must keep the job-duration histogram rule')
  assert.equal(job!.threshold, 1800)
})

test('a histogram rule written as a YAML block scalar is read as one expression', () => {
  const fixture = [
    'groups:',
    '  - name: fixture',
    '    rules:',
    '      - alert: FledgeFixtureLatencyHigh',
    '        expr: |',
    '          histogram_quantile(0.95, sum(rate(fledge_job_seconds_bucket[1h])) by (le))',
    '          > 7200',
    '        for: 30m',
    '        labels:',
    '          severity: warning',
  ].join('\n')
  const rules = histogramRules(fixture)
  assert.equal(rules.length, 1, 'the block-scalar expression must be read as one rule')
  assert.equal(rules[0]!.operator, '>')
  assert.equal(rules[0]!.threshold, 7200)
  const buckets = defaultBuckets()
  assert.ok(buckets[buckets.length - 1]! < rules[0]!.threshold, 'the fixture must describe a rule above the top finite bucket')
})

// `observeHistogram` accepts a per-call `buckets` argument, so a future caller
// passing a short list would reopen the hole while the checks above stay green.
function sourceFiles(directory: URL): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = new URL(entry.name, directory)
    if (entry.isDirectory()) files.push(...sourceFiles(new URL(`${entry.name}/`, directory)))
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(fileURLToPath(child))
  }
  return files
}

function splitArguments(source: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!
    if (quote !== '') {
      if (character === '\\') index += 1
      else if (character === quote) quote = ''
      continue
    }
    if (character === "'" || character === '"' || character === '`') quote = character
    else if (character === '(' || character === '[' || character === '{') depth += 1
    else if (character === ')' || character === ']' || character === '}') depth -= 1
    else if (character === ',' && depth === 0) {
      parts.push(source.slice(start, index))
      start = index + 1
    }
  }
  const tail = source.slice(start).trim()
  if (tail !== '') parts.push(tail)
  return parts.map((part) => part.trim()).filter((part) => part !== '')
}

function callArguments(source: string, callee: string): string[][] {
  const calls: string[][] = []
  let index = 0
  while ((index = source.indexOf(`${callee}(`, index)) !== -1) {
    let depth = 0
    let end = -1
    for (let cursor = index + callee.length; cursor < source.length; cursor += 1) {
      const character = source[cursor]
      if (character === '(') depth += 1
      else if (character === ')') {
        depth -= 1
        if (depth === 0) {
          end = cursor
          break
        }
      }
    }
    assert.notEqual(end, -1, `unterminated ${callee}( call in a source file`)
    calls.push(splitArguments(source.slice(index + callee.length + 1, end)))
    index = end
  }
  return calls
}

test('every histogram producer keeps the default bucket list', () => {
  const definition = fileURLToPath(new URL('../src/lib/metrics.ts', import.meta.url))
  const sites: Array<{ file: string; args: string[] }> = []
  for (const file of sourceFiles(new URL('../src/', import.meta.url))) {
    // Skip the definition itself; every other mention is a call site.
    if (file === definition) continue
    for (const args of callArguments(readFileSync(file, 'utf8'), 'observeHistogram')) {
      sites.push({ file, args })
    }
  }
  assert.ok(sites.length >= 5, `expected the known histogram producers, found ${sites.length}`)
  for (const site of sites) {
    assert.ok(
      site.args.length <= 4,
      `${site.file.replace(process.cwd(), '.')} passes a custom bucket list to observeHistogram: ${site.args.join(', ')}`,
    )
  }
  const observed = sites.map((site) => /['"`]([^'"`]+)['"`]/.exec(site.args[0] ?? '')?.[1] ?? '')
  for (const name of ['fledge_job_queue_seconds', 'fledge_job_seconds']) {
    assert.ok(observed.includes(name), `no producer records ${name}, which the alerts read`)
  }
})
