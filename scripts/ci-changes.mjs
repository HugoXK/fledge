#!/usr/bin/env node
// Write the change flags the workflow uses to skip an inapplicable gate.
//
//   node scripts/ci-changes.mjs --from-file /tmp/changed-paths.txt
//   node scripts/ci-changes.mjs --all
//
// The result is written to stdout as JSON and, when `GITHUB_OUTPUT` is set, as
// one `key=value` line per flag for the `changes` job's outputs. `--all` is the
// non-pull-request path: a push, schedule or manual run verifies the whole tree,
// so no heavy job may be skipped there.

import { appendFileSync, readFileSync } from 'node:fs'
import { allGateChanges, classifyChanges } from './lib/ciChanges.mjs'

function argument(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return ''
  return process.argv[index + 1] ?? ''
}

function fail(message) {
  console.error(`ci-changes: ${message}`)
  process.exit(2)
}

let changes
if (process.argv.includes('--all')) {
  changes = allGateChanges()
} else {
  const file = argument('--from-file')
  if (file === '') fail('usage: node scripts/ci-changes.mjs --from-file <paths.txt> | --all')
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    fail(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  changes = classifyChanges(text.split('\n'))
}

const lines = Object.entries(changes).map(([key, value]) => `${key}=${String(value)}`)
const output = process.env.GITHUB_OUTPUT ?? ''
if (output !== '') appendFileSync(output, `${lines.join('\n')}\n`)
process.stdout.write(`${JSON.stringify(changes)}\n`)
