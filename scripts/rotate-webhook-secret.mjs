#!/usr/bin/env node
// Rotate the GitHub App webhook secret with an overlap window (#466).
//
//   printf '%s\n' "$NEW_SECRET" | node scripts/rotate-webhook-secret.mjs --env-file /etc/fledge/fledge.env
//   GITHUB_APP_WEBHOOK_SECRET_NEW=... node scripts/rotate-webhook-secret.mjs --env-file .env --window-hours 6
//
// The new value never comes from argv: argv is visible to every account on the
// host through /proc. The file is rewritten through a temporary in the same
// directory and renamed over the original, so an interrupted run leaves the old
// file intact; the mode is 0600 because the file holds live secrets. A running
// process cannot change its own environment, so the last step is a restart —
// the runbook is in docs/security.md.

import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const CURRENT_KEY = 'GITHUB_APP_WEBHOOK_SECRET'
const PREVIOUS_KEY = 'GITHUB_APP_WEBHOOK_SECRET_PREVIOUS'
const UNTIL_KEY = 'GITHUB_APP_WEBHOOK_SECRET_PREVIOUS_UNTIL'
const NEW_KEY = 'GITHUB_APP_WEBHOOK_SECRET_NEW'
const DEFAULT_WINDOW_HOURS = 24

function fail(message) {
  console.error(`rotate-webhook-secret: ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const options = { envFile: '.env', windowHours: DEFAULT_WINDOW_HOURS }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--env-file') {
      options.envFile = argv[index + 1] ?? ''
      index += 1
    } else if (arg.startsWith('--env-file=')) {
      options.envFile = arg.slice('--env-file='.length)
    } else if (arg === '--window-hours') {
      options.windowHours = Number(argv[index + 1])
      index += 1
    } else if (arg.startsWith('--window-hours=')) {
      options.windowHours = Number(arg.slice('--window-hours='.length))
    } else {
      fail(`unknown argument ${arg}; the new value is never taken from argv, use stdin or ${NEW_KEY}`)
    }
  }
  if (options.envFile === '') fail('--env-file needs a path')
  if (!Number.isFinite(options.windowHours) || options.windowHours <= 0) fail('--window-hours must be a positive number')
  return options
}

function readNewValue() {
  const fromEnv = (process.env[NEW_KEY] ?? '').trim()
  if (fromEnv !== '') return fromEnv
  if (process.stdin.isTTY) return ''
  try {
    return readFileSync(0, 'utf8').trim()
  } catch {
    return ''
  }
}

// A value has to survive a round trip through the dotenv reader: no newline, no
// surrounding quotes, no trailing whitespace.
function checkValue(name, value) {
  if (value === '') fail(`${name} is required: pipe it on stdin or set ${NEW_KEY}`)
  if (/[\r\n]/.test(value)) fail(`${name} must be a single line`)
  if (value !== value.trim()) fail(`${name} must not have leading or trailing whitespace`)
}

// Keys are rewritten in place, current first, so the three lines that describe
// the rotation stay together; every other line, comment and blank is preserved.
function applyRotation(text, values) {
  const keys = new Set([CURRENT_KEY, PREVIOUS_KEY, UNTIL_KEY])
  const seen = new Set()
  const output = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimStart()
    const equal = line.indexOf('=')
    const key = equal > 0 && !trimmed.startsWith('#') ? line.slice(0, equal).trim() : ''
    if (!keys.has(key)) {
      output.push(line)
      continue
    }
    seen.add(key)
    if (key !== CURRENT_KEY) continue
    output.push(`${CURRENT_KEY}=${values.current}`, `${PREVIOUS_KEY}=${values.previous}`, `${UNTIL_KEY}=${values.until}`)
  }
  for (const key of [CURRENT_KEY, PREVIOUS_KEY, UNTIL_KEY]) {
    if (seen.has(key)) continue
    const value = key === CURRENT_KEY ? values.current : key === PREVIOUS_KEY ? values.previous : values.until
    if (value !== '') output.push(`${key}=${value}`)
  }
  return `${output.join('\n').replace(/\n+$/, '')}\n`
}

const options = parseArgs(process.argv.slice(2))
const path = resolve(options.envFile)
let text
try {
  text = readFileSync(path, 'utf8')
} catch {
  fail(`cannot read ${path}; pass --env-file with the file fledge.service loads`)
}

const currentLine = text.split(/\r?\n/).find((line) => line.trimStart().startsWith(`${CURRENT_KEY}=`))
const current = currentLine === undefined ? '' : currentLine.slice(currentLine.indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
if (current === '') fail(`${CURRENT_KEY} is not set in ${path}; there is nothing to move to the previous slot`)

const fresh = readNewValue()
checkValue(CURRENT_KEY, fresh)
if (fresh === current) fail('the new value equals the current one; nothing would change')

const until = new Date(Date.now() + options.windowHours * 3600_000).toISOString()
const next = applyRotation(text, { current: fresh, previous: current, until })

// Same directory, so the rename is atomic on one filesystem. The temporary is
// 0600 from creation: there is no instant in which it is group or world readable.
const temporary = join(dirname(path), `.${basename(path)}.rotate-${process.pid}.tmp`)
writeFileSync(temporary, next, { mode: 0o600 })
chmodSync(temporary, 0o600)
renameSync(temporary, path)
chmodSync(path, 0o600)

console.log(`rotate-webhook-secret: ${path} now carries a new ${CURRENT_KEY}`)
console.log(`rotate-webhook-secret: the previous value is accepted until ${until}`)
console.log(`rotate-webhook-secret: restart fledge.service to load it, then unset ${PREVIOUS_KEY} once GitHub signs with the new value (docs/security.md)`)
