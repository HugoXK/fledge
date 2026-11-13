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

import { countFragments } from './lib/changelog-fragments.mjs'

const index = process.argv.indexOf('--dir')
const dir = index === -1 ? 'changelog.d' : process.argv[index + 1] ?? 'changelog.d'

try {
  process.stdout.write(`${countFragments(dir)}\n`)
} catch (error) {
  console.error(`fragment-count: cannot read ${dir}: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
