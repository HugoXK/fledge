#!/usr/bin/env node
// Print the number of changelog fragments a release would fold (#548).
//
//   node scripts/fragment-count.mjs [--dir changelog.d]
//
// It answers 0 for the two empty shapes — a directory holding only `README.md`
// and a directory with no markdown at all — and exits 0 for both, because zero
// fragments is an input to the release planner, not an error. A missing or
// unreadable directory exits non-zero: a count nobody could measure must not
// become a quiet release that never fires again.
//
// A `--dir` with no usable value is a usage error (exit 2), never the default
// directory (#563): a caller that mis-built the argument used to get
// `changelog.d`'s number and exit 0, which is exactly the silent miscount this
// helper exists to prevent. Only an absent `--dir` may default.

import { countFragments } from './lib/changelog-fragments.mjs'

function usage(message) {
  console.error(`fragment-count: ${message}`)
  process.exit(2)
}

const args = process.argv.slice(2)
if (args.some((arg) => arg.startsWith('--dir='))) usage('--dir needs a value: write --dir <path>')

const index = args.indexOf('--dir')
let dir = 'changelog.d'
if (index !== -1) {
  const value = args[index + 1]
  if (value === undefined || value === '' || value.startsWith('-')) usage('--dir needs a value')
  dir = value
}

try {
  process.stdout.write(`${countFragments(dir)}\n`)
} catch (error) {
  console.error(`fragment-count: cannot read ${dir}: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
