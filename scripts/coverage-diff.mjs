#!/usr/bin/env node
// #641: the changed-lines coverage gate. Runs inside the `coverage` job after
// `npm run test:coverage` has written `coverage.txt`, joins the report to the
// pull request's own diff and fails when the lines the diff adds under `src/**`
// are below the floor.
//
//   node scripts/coverage-diff.mjs --diff /tmp/change.diff --report coverage.txt
//   node scripts/coverage-diff.mjs --base "$PR_BASE" --head "$PR_HEAD" --report coverage.txt
//
// The waiver is one line of the pull request body (`No-test: <reason>`), read
// from `PR_BODY`; it is printed so the run log carries what waived it.
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { evaluateChangedLines, waiverFromBody } from './lib/coverage-diff.mjs'

function argument(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  if (value === undefined) {
    console.error(`coverage-diff: ${name} needs a value`)
    process.exit(2)
  }
  return value
}

function fail(message) {
  console.error(`coverage-diff: ${message}`)
  process.exit(2)
}

const reportPath = argument('--report', 'coverage.txt')
const diffPath = argument('--diff', '')
const base = argument('--base', '')
const head = argument('--head', '')
const floor = Number(argument('--floor', '80'))

if (!Number.isInteger(floor) || floor < 0 || floor > 100) fail(`--floor must be a whole percentage, got ${argument('--floor', '80')}`)

let report
try {
  report = readFileSync(reportPath, 'utf8')
} catch (error) {
  fail(`cannot read the coverage report at ${reportPath}: ${error.message}`)
}

// The diff is read from a file when the caller has one (the suite does) and from
// git otherwise. `--unified=0` makes the hunk header count exactly the added
// lines, and `--no-renames` keeps a rename from hiding the lines it adds.
// `-c core.quotePath=false` stops git C-quoting a path that holds a non-ASCII
// byte: `+++ "b/src/lib/\346\227\245.ts"` used to keep a leading quote, fail the
// `src/` test, drop the file and print `skip` with exit 0 — a false PASS. The
// parser unquotes too, so a diff file produced elsewhere reads the same way.
let diff
if (diffPath !== '') {
  try {
    diff = readFileSync(diffPath, 'utf8')
  } catch (error) {
    fail(`cannot read the diff at ${diffPath}: ${error.message}`)
  }
} else if (base !== '' && head !== '') {
  const result = spawnSync('git', ['-c', 'core.quotePath=false', 'diff', '--unified=0', '--no-renames', '--no-color', `${base}...${head}`, '--', 'src'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) fail(`git diff ${base}...${head} failed: ${(result.stderr ?? '').trim()}`)
  diff = result.stdout ?? ''
} else {
  fail('give --diff, or --base and --head')
}

const verdict = evaluateChangedLines({ diff, report, floor })

if (verdict.code === 'NO_SOURCE_LINES') {
  console.log('coverage-diff: skip — no executable changed lines under src/')
  process.exit(0)
}

if (verdict.code === 'OK') {
  console.log(`coverage-diff: ok — ${verdict.covered}/${verdict.measured} changed lines covered (${verdict.ratio}%, floor ${verdict.floor}%)`)
  process.exit(0)
}

const waiver = waiverFromBody(process.env.PR_BODY ?? '')
if (waiver !== null) {
  console.log(`coverage-diff: waived — ${waiver}`)
  process.exit(0)
}

for (const path of verdict.missing) {
  console.error(`coverage-diff: ${path} — the coverage report has no row for this file, so no test loads it`)
}
for (const violation of verdict.violations) {
  console.error(`coverage-diff: ${violation.path}:${violation.line} — added line is not covered`)
}
console.error(
  `coverage-diff: below the floor — ${verdict.covered}/${verdict.measured} changed lines covered (${verdict.ratio}%, floor ${verdict.floor}%)`,
)
console.error('coverage-diff: add a test for those lines, or put one `No-test: <reason>` line in the pull request body')
process.exit(1)
