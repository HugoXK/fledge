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

function thresholdLines(): Array<{ line: string; threshold: number }> {
  return alertsText
    .split('\n')
    .filter((line) => line.includes('histogram_quantile') && / > [0-9.]+\s*$/.test(line))
    .map((line) => ({ line, threshold: Number(/ > ([0-9.]+)\s*$/.exec(line)![1]) }))
}

function thresholdOf(line: string): number {
  return Number(/ > ([0-9.]+)\s*$/.exec(line)![1])
}

test('the highest finite bucket boundary is above every latency alert threshold', () => {
  const buckets = defaultBuckets()
  const top = buckets[buckets.length - 1]!
  const rules = thresholdLines()
  assert.ok(rules.length >= 2, `expected at least two histogram alert rules, found ${rules.length}`)
  for (const rule of rules) {
    // A boundary equal to the threshold still caps the p95 at the threshold,
    // so the comparison has to be strictly greater.
    assert.ok(
      top > rule.threshold,
      `the top finite bucket (${top}s) must be above the alert threshold (${rule.threshold}s) in: ${rule.line.trim()}`,
    )
  }
})

test('the queue-wait and job-duration alerts still read 600s and 1800s', () => {
  const lines = alertsText.split('\n')
  const queue = lines.find((line) => line.includes('histogram_quantile') && line.includes('fledge_job_queue_seconds_bucket'))
  assert.ok(queue, 'deploy/prometheus/fledge-alerts.yml must keep the queue-wait histogram rule')
  assert.equal(thresholdOf(queue!), 600)
  const job = lines.find((line) => line.includes('histogram_quantile') && line.includes('fledge_job_seconds_bucket'))
  assert.ok(job, 'deploy/prometheus/fledge-alerts.yml must keep the job-duration histogram rule')
  assert.equal(thresholdOf(job!), 1800)
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
