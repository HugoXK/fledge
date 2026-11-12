#!/usr/bin/env node
// Supply-chain gate 3, run inside the CodeQL job right after `analyze`: read the
// SARIF that run produced and fail when it holds a high or critical result that
// is not in the recorded baseline. The same step runs on a push to `main`, so
// main cannot start accumulating new highs either.
//
// #307: a result this gate accepts by severity is not always mergeable, because
// the branch also requires conversation resolution. Those results are named on the
// pass path with the `path:line` a maintainer has to resolve; the blocking decision
// stays in `review-gate` (#308), and this gate's exit code never changes.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { acceptedAlerts, addedAlerts, alertKey, highAlerts, parseSarif, threadAt } from './lib/codeql-alerts.mjs'
import { pullRequestNumber, readEvent } from './lib/gate-env.mjs'
import { reviewThreadsClient } from './lib/review-threads.mjs'

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
  let document
  try {
    document = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    console.error(`codeql-gate: ${file} is not readable SARIF: ${error.message}`)
    process.exit(1)
  }
  // #297: `JSON.parse('null')` returns `null`, and reading `runs` off it throws a
  // TypeError, so the gate died with a stack trace instead of naming a refusal.
  // A document with no shape says nothing about analysis runs, so it is refused
  // exactly as an unparseable body is. The predicate stays this narrow on
  // purpose: `[]`, `"x"` and `42` are not plain objects either, yet they already
  // fail closed below with their own named shape, and re-wording a working
  // refusal is not this fix.
  if (document === null) {
    console.error(`codeql-gate: ${file} is not readable SARIF: the document is JSON null`)
    process.exit(1)
  }
  // "Read and found nothing" and "never analysed anything" are different
  // verdicts: only the second is a blind gate.
  const runs = Array.isArray(document.runs) ? document.runs.length : 0
  if (runs === 0) {
    const shape = Array.isArray(document.runs) ? 'runs: 0' : 'runs: missing or not a list'
    console.error(`codeql-gate: ${file} has no analysis run (${shape}); a SARIF that analysed nothing is a blind gate, not a clean one`)
    process.exit(1)
  }
  alerts.push(...parseSarif(document))
}

const baselineKeys = (baseline.alerts ?? []).map((alert) => alertKey(alert))
const added = addedAlerts(baselineKeys, alerts)
const highs = highAlerts(alerts)
// Printed next to every verdict: a run that produced no results and one that
// produced a hundred but called none of them high must not look the same from
// the outside.
const summary = `parsed ${alerts.length} result(s), ${highs.length} high/critical`

for (const alert of added) {
  console.error(`codeql-gate: new ${alert.severity} result ${alert.ruleId} at ${alert.path}:${alert.line}`)
}

if (added.length > 0) {
  console.error(`codeql-gate: ${summary}, ${added.length} added; the baseline at ${baseline.recordedAtSha ?? 'an unrecorded sha'} holds ${baselineKeys.length}`)
  process.exit(1)
}

// #307: the thread state is GraphQL-only and lives in one reader (`#308`). A
// fixture path is the seam the tests drive; in Actions the gate reads the live
// pull request of the run, and when it cannot read that it says so rather than
// implying there is nothing to resolve.
const threadsArgument = argument('--threads', '')
const REPO = process.env.GITHUB_REPOSITORY ?? ''
const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''

async function readThreads() {
  if (threadsArgument !== '') {
    let nodes
    try {
      nodes = JSON.parse(readFileSync(threadsArgument, 'utf8'))
    } catch (error) {
      console.error(`codeql-gate: cannot read the --threads fixture: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    }
    if (!Array.isArray(nodes)) {
      console.error(`codeql-gate: the --threads fixture is not a list of review threads`)
      process.exit(1)
    }
    return nodes
  }
  const prNumber = pullRequestNumber(readEvent(process.env.GITHUB_EVENT_PATH ?? ''), argument('--pr', undefined))
  // Two cases used to collapse into the same silent `null`. A run with no pull
  // request (a push to main, the weekly schedule) really has nothing to read, and
  // saying nothing is the truth. A pull request run whose credential is missing has
  // a thread list this gate cannot see; silencing that is how the advisory stayed
  // dark inside Actions, so it takes the same sentence as a failed request.
  if (!Number.isInteger(prNumber) || prNumber <= 0) return null
  if (REPO === '' || TOKEN === '') {
    const missing = [REPO === '' ? 'GITHUB_REPOSITORY' : '', TOKEN === '' ? 'GITHUB_TOKEN' : ''].filter(Boolean)
    throw new Error(`no ${missing.join(' or ')} in this pull request run, so the review threads of #${prNumber} cannot be read`)
  }
  const read = reviewThreadsClient({
    token: TOKEN,
    base: process.env.GITHUB_API_URL ?? 'https://api.github.com',
    userAgent: 'fledge-codeql-gate',
  })
  return read(REPO, prNumber)
}

let threads = null
try {
  threads = await readThreads()
} catch (error) {
  // Review-gate fails closed on this same read, so the merge is already blocked;
  // this gate's job is the explanation, and "I could not read" is the explanation.
  console.error(`codeql-gate: cannot read the review threads, so accepted-severity results are not named here: ${error instanceof Error ? error.message : String(error)}`)
}

if (Array.isArray(threads)) {
  for (const alert of acceptedAlerts(alerts)) {
    if (threadAt(alert, threads) === null) continue
    console.log(
      `codeql-gate: accepted-by-severity ${alert.ruleId} at ${alert.path}:${alert.line} — a ${alert.severity} result, passed by severity here; its review thread is unresolved, so review-gate will block the merge until that thread is resolved (advisory, not a failure of this gate)`,
    )
  }
}

console.log(
  `codeql-gate: ok (${summary}, 0 added; all in the baseline of ${baselineKeys.length} recorded at ${baseline.recordedAtSha ?? 'an unrecorded sha'})`,
)
