#!/usr/bin/env node
// The lint gate. `oxlint` reports warnings and still exits 0, so a new warning
// lands green and hides the next real finding. This script turns the committed
// baseline into the contract: a warning is allowed only while
// `lint-warnings.baseline.json` names it with the same count, a warning the
// baseline does not name fails, and an entry whose warning is gone fails too so
// the baseline shrinks with the tree instead of rotting.
//
// The comparison is textual on purpose: file + rule + message, no line numbers,
// because lines move under every unrelated edit while a warning does not.
//
//   node scripts/lint-warnings.mjs [targets...]     # the gate (default: src test scripts bridge)
//   node scripts/lint-warnings.mjs --update         # rewrite the baseline, reviewed like any diff
//   node scripts/lint-warnings.mjs --diagnostics report.json [--baseline file]
//                                                   # replay a saved oxlint report (tests, CI artifacts)

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BASELINE_VERSION = 1
export const BASELINE_FILE = 'lint-warnings.baseline.json'
export const DEFAULT_TARGETS = ['src', 'test', 'scripts', 'bridge']
export const BASELINE_POLICY =
  'Warnings in lint-warnings.baseline.json are the pre-existing ones; a new warning or a stale entry fails `npm run lint`. Regenerate with `npm run lint:update` in the same reviewed change that fixes a warning.'

const root = fileURLToPath(new URL('..', import.meta.url))

/** @typedef {{file: string, rule: string, message: string, count: number}} WarningEntry */

function keyOf(entry) {
  return `${entry.file}\u0000${entry.rule}\u0000${entry.message}`
}

function byLocation(a, b) {
  return (
    a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule) || a.message.localeCompare(b.message)
  )
}

/**
 * Collapse an oxlint JSON report into counted entries. Errors are oxlint's own
 * failure and are reported separately, so they are not part of the baseline.
 *
 * @param {Array<{filename?: string, code?: string, message?: string, severity?: string}>} diagnostics
 * @returns {WarningEntry[]}
 */
export function summarizeWarnings(diagnostics) {
  const counts = new Map()
  for (const diagnostic of diagnostics ?? []) {
    if (diagnostic?.severity !== 'warning') continue
    if (!diagnostic.filename || !diagnostic.code || !diagnostic.message) {
      throw new Error(`oxlint reported a warning without a file, rule or message: ${JSON.stringify(diagnostic)}`)
    }
    const key = keyOf({
      file: diagnostic.filename,
      rule: diagnostic.code,
      message: diagnostic.message,
    })
    const seen = counts.get(key)
    if (seen) seen.count += 1
    else {
      counts.set(key, {
        file: diagnostic.filename,
        rule: diagnostic.code,
        message: diagnostic.message,
        count: 1,
      })
    }
  }
  return [...counts.values()].sort(byLocation)
}

function index(entries, label) {
  const map = new Map()
  for (const entry of entries) {
    if (
      typeof entry?.file !== 'string' ||
      typeof entry.rule !== 'string' ||
      typeof entry.message !== 'string' ||
      !Number.isInteger(entry.count) ||
      entry.count < 1
    ) {
      throw new Error(`${label} has a malformed entry: ${JSON.stringify(entry)}`)
    }
    map.set(keyOf(entry), entry)
  }
  return map
}

/**
 * @param {WarningEntry[]} baseline
 * @param {WarningEntry[]} actual
 */
export function compareWarnings(baseline, actual) {
  const expected = index(baseline, 'the baseline')
  const found = index(actual, 'the oxlint report')
  const added = []
  const stale = []

  for (const [key, entry] of found) {
    const known = expected.get(key)
    if (!known) added.push({ ...entry, was: 0 })
    else if (entry.count > known.count) added.push({ ...entry, was: known.count })
  }
  for (const [key, entry] of expected) {
    const seen = found.get(key)
    if (!seen) stale.push({ ...entry, count: 0 })
    else if (seen.count < entry.count) stale.push({ ...entry, count: seen.count })
  }

  return {
    ok: added.length === 0 && stale.length === 0,
    added: added.sort(byLocation),
    stale: stale.sort(byLocation),
  }
}

/** @param {{added: WarningEntry[], stale: WarningEntry[]}} result */
export function formatFailure(result) {
  const lines = []
  if (result.added.length > 0) {
    lines.push(`lint: ${result.added.length} new warning(s) not in ${BASELINE_FILE}`)
    for (const item of result.added) {
      const extra = item.was > 0 ? ` (${item.was} -> ${item.count})` : ''
      lines.push(`  + ${item.file} ${item.rule} — ${item.message}${extra}`)
    }
  }
  if (result.stale.length > 0) {
    lines.push(`lint: ${result.stale.length} stale baseline entr${result.stale.length === 1 ? 'y' : 'ies'} — remove what is fixed`)
    for (const item of result.stale) {
      lines.push(`  - ${item.file} ${item.rule} — ${item.message} (${item.count} left, ${BASELINE_FILE} says 0)`)
    }
  }
  lines.push('Fix the warning, or run `npm run lint:update` and commit the reviewed baseline change in this pull request.')
  return lines.join('\n')
}

function parseArgs(argv) {
  const options = { update: false, diagnostics: null, baseline: join(root, BASELINE_FILE), targets: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--update') options.update = true
    else if (arg === '--diagnostics') options.diagnostics = argv[++i] ?? null
    else if (arg === '--baseline') options.baseline = argv[++i] ?? null
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`)
    else options.targets.push(arg)
  }
  return options
}

function readReport(options) {
  if (options.diagnostics) {
    if (!existsSync(options.diagnostics)) throw new Error(`no such oxlint report: ${options.diagnostics}`)
    return JSON.parse(readFileSync(options.diagnostics, 'utf8'))
  }
  const bin = join(root, 'node_modules', '.bin', 'oxlint')
  if (!existsSync(bin)) throw new Error(`oxlint is not installed at ${bin}; run npm ci`)
  const targets = options.targets.length > 0 ? options.targets : DEFAULT_TARGETS
  const result = spawnSync(bin, ['--format=json', ...targets], { cwd: root, encoding: 'utf8' })
  if (result.error) throw result.error
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(
      `oxlint did not print a JSON report (exit ${result.status}): ${(result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' ')}`,
    )
  }
}

function readBaseline(file) {
  if (!existsSync(file)) throw new Error(`missing baseline ${file}; run npm run lint:update and commit the result`)
  const data = JSON.parse(readFileSync(file, 'utf8'))
  if (data.version !== BASELINE_VERSION) throw new Error(`${file} has version ${data.version}; expected ${BASELINE_VERSION}`)
  if (!Array.isArray(data.entries)) throw new Error(`${file} has no entries array`)
  return data.entries
}

function writeBaseline(file, entries) {
  const data = { version: BASELINE_VERSION, policy: BASELINE_POLICY, entries: [...entries].sort(byLocation) }
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
  return entries.length
}

function main(argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }
  if (options.help) {
    process.stdout.write(`${BASELINE_POLICY}\n\nusage: node scripts/lint-warnings.mjs [--update] [targets...]\n`)
    return 0
  }

  let report
  try {
    report = readReport(options)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  const diagnostics = Array.isArray(report?.diagnostics) ? report.diagnostics : []
  const errors = diagnostics.filter((item) => item?.severity === 'error')
  if (errors.length > 0) {
    process.stderr.write(`lint: ${errors.length} error(s)\n`)
    for (const item of errors.slice(0, 20)) {
      process.stderr.write(`  ! ${item.filename} ${item.code} — ${item.message}\n`)
    }
    return 1
  }

  const actual = summarizeWarnings(diagnostics)

  if (options.update) {
    const count = writeBaseline(options.baseline, actual)
    process.stdout.write(`lint: wrote ${count} baseline entr${count === 1 ? 'y' : 'ies'} to ${options.baseline}\n`)
    return 0
  }

  let baseline
  try {
    baseline = readBaseline(options.baseline)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  const result = compareWarnings(baseline, actual)
  if (!result.ok) {
    process.stderr.write(`${formatFailure(result)}\n`)
    return 1
  }
  const total = actual.reduce((sum, item) => sum + item.count, 0)
  process.stdout.write(
    `lint: ${total} warning(s) in ${actual.length} entr${actual.length === 1 ? 'y' : 'ies'} match the baseline\n`,
  )
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2))
}
