#!/usr/bin/env node
// Gate a systemd unit sample with the static parser (#882).
//
//   node scripts/check-systemd-unit.mjs [deploy/fledge.service]
//
// `deploy-check` used to run `systemd-analyze verify` when the binary was there
// and record a gap when it was not, so on a normal runner the unit sample was
// never checked. This entry point runs everywhere and is a gate: a unit that
// fails the parse exits 1, which fails `deploy-check` and `ci-ok`.
//
// The line it prints says "static unit parser" on purpose: the job summary has
// to separate a real invocation from a static one, and there is no "gap" branch
// left to record.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { parseSystemdUnit } from './lib/systemdUnit.mjs'

const file = process.argv[2] ?? 'deploy/fledge.service'
const label = file

let text
try {
  text = readFileSync(resolve(process.cwd(), file), 'utf8')
} catch (error) {
  console.error(`systemd: ${label} could not be read: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const result = parseSystemdUnit(text)
if (result.errors.length > 0) {
  for (const error of result.errors) console.error(`systemd: ${label}:${error}`)
  console.error(`systemd: ${label} failed the static unit parse`)
  process.exit(1)
}

const sections = result.sections.length
const plural = sections === 1 ? 'section' : 'sections'
console.log(`systemd: ${label} parsed by the static unit parser (${String(sections)} ${plural}, ${String(result.directives)} directives)`)
