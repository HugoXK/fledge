#!/usr/bin/env node
// Supply-chain gate 3, run inside the CodeQL job right after `analyze`: read the
// SARIF that run produced and fail when it holds a high or critical result that
// is not in the recorded baseline. The same step runs on a push to `main`, so
// main cannot start accumulating new highs either.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { addedAlerts, alertKey, highAlerts, parseSarif } from './lib/codeql-alerts.mjs'

function argument(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  if (value === undefined) {
    console.error(`codeql-gate: ${name} needs a path`)
    process.exit(1)
  }
  return value
}

const sarifPath = argument('--sarif', 'codeql-results')
const baselinePath = argument('--baseline', '.github/agent/codeql-baseline.json')

function sarifFiles(path) {
  const stats = statSync(path)
  if (stats.isFile()) return [path]
  return readdirSync(path)
    .filter((name) => name.toLowerCase().endsWith('.sarif'))
    .map((name) => join(path, name))
}

let files
let baseline
try {
  files = sarifFiles(sarifPath)
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
} catch (error) {
  // Fail closed: a gate that cannot read its input is not a passing gate.
  console.error(`codeql-gate: cannot read the SARIF or the baseline: ${error.message}`)
  process.exit(1)
}

if (files.length === 0) {
  console.error(`codeql-gate: no SARIF file under ${sarifPath}; the CodeQL run produced nothing to judge`)
  process.exit(1)
}

const alerts = []
for (const file of files) {
  try {
    alerts.push(...parseSarif(JSON.parse(readFileSync(file, 'utf8'))))
  } catch (error) {
    console.error(`codeql-gate: ${file} is not readable SARIF: ${error.message}`)
    process.exit(1)
  }
}

const baselineKeys = (baseline.alerts ?? []).map((alert) => alertKey(alert))
const added = addedAlerts(baselineKeys, alerts)
const highs = highAlerts(alerts)

for (const alert of added) {
  console.error(`codeql-gate: new ${alert.severity} result ${alert.ruleId} at ${alert.path}:${alert.line}`)
}

if (added.length > 0) {
  console.error(`codeql-gate: ${added.length} new high/critical result(s); the baseline at ${baseline.recordedAtSha ?? 'an unrecorded sha'} holds ${baselineKeys.length}`)
  process.exit(1)
}

console.log(
  `codeql-gate: ok (${highs.length} high/critical result(s), all in the baseline of ${baselineKeys.length} recorded at ${baseline.recordedAtSha ?? 'an unrecorded sha'})`,
)
