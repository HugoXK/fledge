#!/usr/bin/env node
// Compute Fledge's risk tier from the changed files and the diff.
//
//   node scripts/risk-gate.mjs --base origin/main
//   node scripts/risk-gate.mjs --base <sha> --head HEAD --json
//
// The script reports; it never blocks by itself. CI writes the machine line to
// the job summary, and review-gate uses the same rules over the PR file list.

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { classify, limitsFor, loadRules, matchesPath } from './lib/risk.mjs'

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  return process.argv[index + 1] ?? fallback
}

const base = arg('--base', process.env.RISK_BASE ?? 'origin/main')
const head = arg('--head', 'HEAD')
const json = process.argv.includes('--json')

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

let files = []
let diff = ''
try {
  files = git(['diff', '--name-only', `${base}...${head}`]).split('\n').filter((line) => line !== '')
  diff = git(['diff', '--unified=0', `${base}...${head}`])
} catch (error) {
  console.error(`risk-gate: cannot diff ${base}...${head}: ${error.message}`)
  process.exit(1)
}

const rules = loadRules()
const result = classify(files, diff, rules)
const limits = limitsFor(result.tier, rules)
const lines = []
lines.push('Fledge risk tier')
lines.push(`base: ${base}`)
lines.push(`head: ${head}`)
lines.push(`changed files: ${files.length}`)
lines.push('')
for (const tier of ['T3', 'T2', 'T1', 'T0']) {
  const matched = files.filter((file) => (rules.tiers?.[tier]?.paths ?? []).some((pattern) => matchesPath(file, pattern)))
  if (matched.length > 0) lines.push(`${tier}: ${matched.join(', ')}`)
}
if (limits !== null) lines.push(`limits: ${limits.files} files / ${limits.lines} lines (advisory)`)
lines.push('')
lines.push(`risk-tier: ${result.tier}; basis: ${result.basis}`)
const report = lines.join('\n')
if (json) {
  console.log(JSON.stringify({ tier: result.tier, basis: result.basis, files, report }, null, 2))
} else {
  console.log(report)
}
if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`)
}

