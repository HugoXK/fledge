#!/usr/bin/env node
// Turn the API payloads the daily release run fetched into the state JSON the
// planner and the drive decision read.
//
//   node scripts/release-state.mjs --prs /tmp/prs.json --open /tmp/open.json \
//     --checks /tmp/checks.json --tag v0.2.4 --tag-time 2026-11-01T00:00:00Z \
//     --version 0.2.4 --fragments 12 --tags-json '["v0.2.4"]' --dry-run false
//
// Writes the state to stdout so the workflow can keep it in a file, and the suite
// can run exactly this code with fixture payloads instead of reading YAML.

import { readFileSync } from 'node:fs'
import { buildState } from './lib/release-state.mjs'

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  const value = index === -1 ? undefined : process.argv[index + 1]
  return value === undefined ? fallback : value
}

function readJson(path) {
  if (path === '') return []
  return JSON.parse(readFileSync(path, 'utf8'))
}

const tagsJson = arg('--tags-json', '[]')
const state = buildState({
  lastTag: arg('--tag', ''),
  lastTagCommittedAt: arg('--tag-time', ''),
  packageVersion: arg('--version', ''),
  fragments: arg('--fragments', '0'),
  tags: JSON.parse(tagsJson),
  dryRun: arg('--dry-run', 'false'),
  closedPages: readJson(arg('--prs', '')),
  openPages: readJson(arg('--open', '')),
  checks: readJson(arg('--checks', '')),
})

process.stdout.write(`${JSON.stringify(state)}\n`)
