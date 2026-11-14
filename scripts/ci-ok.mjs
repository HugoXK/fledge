#!/usr/bin/env node
// The aggregate required check. `ci-ok` passes only when every required job is
// present in `needs` and reports `success`.
//
// Why this is a script rather than the inline `node -e` it replaces: that one
// accepted `skipped` as a pass (`result !== "success" && result !== "skipped"`),
// so a required job that GitHub never ran — a false condition, an outage, a
// filtered matrix leg — reported green, and a job that had been deleted from
// `needs` was simply absent from the object and never checked at all.
//
//   NEEDS='{"lint":{"result":"success"}}' node scripts/ci-ok.mjs
//   node scripts/ci-ok.mjs --needs needs.json
//
// `--needs` exists so a test can feed a fake `needs` object without a runner.

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Every job the aggregate depends on. `test/ciOk.test.ts` compares this list
// with the `needs:` list in ci.yml, so a job added to one side and not the other
// is caught before it can silently disappear from the gate.
export const REQUIRED_JOBS = [
  // The change classifier is part of the gate: a skipped heavy job is only
  // acceptable when this job succeeded and said the category does not apply.
  'changes',
  'lint',
  'typecheck',
  'test',
  'coverage',
  'build',
  'visual',
  'docker',
  'audit',
  'changelog',
  'version',
  'risk',
  'restore-drill',
  'dependency-review',
  'action-pins',
  'workflow-lint',
  'secret-scan',
  // #304: the CodeQL analysis conclusion, read by `scripts/codeql-required.mjs`.
  // It is deliberately absent from SKIPPABLE_ON: a gate skipped on the event that
  // merges would be vacuous. The change-aware exception is narrower: a docs-only
  // or workflow-only pull request cannot add a JS/TS finding, and the CodeQL
  // workflow filters those paths itself. On `schedule` the job itself exits 0
  // with its reason.
  'codeql-required',
]

// A required job that cannot run on every event, with the events on which
// `skipped` is an acceptable result. On every other event it must be `success`;
// a failure, a cancellation or an absence from `needs` fails on all events.
// `dependency-review` reads the pull request's diff, so it has nothing to
// compare on a push to main, a nightly run or a manual run; the pull request run
// is the gate that counts.
export const SKIPPABLE_ON = {
  'dependency-review': ['push', 'merge_group', 'schedule', 'workflow_dispatch'],
}

// A job that is conditional on a change category. `skipped` is a pass only when
// the category is present and false; a missing category is a failure, so a
// broken or absent classifier cannot turn the gate off.
export const SKIP_WHEN = {
  // `test` and `coverage` are deliberately absent: the suite reads `docs/`,
  // `public/`, `deploy/` and `.github/`, so it runs on every diff and a skipped
  // one is red here whatever the classifier says.
  lint: 'source',
  typecheck: 'source',
  build: 'source',
  visual: 'frontend',
  docker: 'docker',
  audit: 'deps',
  'restore-drill': 'db',
  'action-pins': 'workflows',
  'workflow-lint': 'workflows',
  'codeql-required': 'codeql',
}

function flagIsFalse(changes, name) {
  if (changes === null || typeof changes !== 'object') return false
  const value = changes[name]
  return value === false || value === 'false'
}

function resultOf(value) {
  if (value === null || typeof value !== 'object') return 'missing'
  return typeof value.result === 'string' && value.result !== '' ? value.result : 'missing'
}

export function evaluate(needs, options = {}) {
  const required = options.required ?? REQUIRED_JOBS
  const skippable = options.skippable ?? SKIPPABLE_ON
  const eventName = options.eventName ?? ''
  const changes = options.changes ?? {}
  const lines = []
  const problems = []
  for (const [name, value] of Object.entries(needs)) {
    const result = resultOf(value)
    const requiredHere = required.includes(name)
    lines.push(`${name}: ${result}${requiredHere ? '' : ' (not required)'}`)
  }
  for (const name of required) {
    if (!Object.hasOwn(needs, name)) {
      problems.push(`required job missing from needs: ${name}`)
      continue
    }
    const result = resultOf(needs[name])
    if (result === 'success') continue
    const skippableHere = (skippable[name] ?? []).includes(eventName)
    if (result === 'skipped' && skippableHere) continue
    const condition = (options.skipWhen ?? SKIP_WHEN)[name]
    const conditionalEvent = eventName === 'pull_request' || eventName === 'merge_group'
    if (result === 'skipped' && conditionalEvent && condition !== undefined && flagIsFalse(changes, condition)) continue
    problems.push(`required job did not succeed: ${name} (${result})`)
  }
  return { lines, problems }
}

function readNeeds() {
  const index = process.argv.indexOf('--needs')
  const file = index === -1 ? undefined : process.argv[index + 1]
  const raw = file === undefined ? (process.env.NEEDS ?? '') : readFileSync(file, 'utf8')
  if (raw.trim() === '') throw new Error('no needs object: set NEEDS or pass --needs <file>')
  const parsed = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('needs must be a JSON object')
  return parsed
}

export function main() {
  let needs
  try {
    needs = readNeeds()
  } catch (error) {
    console.error(`ci-ok: cannot read the needs object: ${error.message}`)
    process.exit(1)
  }
  const eventName = process.env.GITHUB_EVENT_NAME ?? ''
  let changes = {}
  try {
    changes = JSON.parse(process.env.CHANGES ?? '{}')
  } catch {
    changes = {}
  }
  const { lines, problems } = evaluate(needs, { eventName, changes })
  for (const line of lines) console.log(line)
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem)
    console.error(`ci-ok: ${String(problems.length)} required job(s) did not pass`)
    process.exit(1)
  }
  console.log(`ci-ok: every required job passed (${String(REQUIRED_JOBS.length)} required)`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
