import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BASELINE_VERSION,
  compareWarnings,
  summarizeWarnings,
  type WarningEntry,
} from '../scripts/lint-warnings.mjs'

// The lint gate has to fail on a *new* warning while the warnings this
// repository already carries keep passing. Both halves are asserted here: the
// pure comparison, and the CLI run against a saved oxlint report, so the red
// half is a test rather than a hand-run workflow.

const root = fileURLToPath(new URL('..', import.meta.url))

function diagnostic(file: string, rule: string, message: string, severity = 'warning', line = 1) {
  return { filename: file, code: rule, message, severity, labels: [{ span: { line, column: 1 } }] }
}

function entry(file: string, rule: string, message: string, count = 1): WarningEntry {
  return { file, rule, message, count }
}

function runGate(args: string[], cwd = root) {
  const result = spawnSync(process.execPath, [join(root, 'scripts/lint-warnings.mjs'), ...args], {
    cwd,
    encoding: 'utf8',
  })
  return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

test('the summary counts one entry per file, rule and message and ignores errors', () => {
  const entries = summarizeWarnings([
    diagnostic('test/a.test.ts', 'unicorn(no-useless-spread)', 'spread', 'warning', 4),
    diagnostic('test/a.test.ts', 'unicorn(no-useless-spread)', 'spread', 'warning', 9),
    diagnostic('src/b.ts', 'eslint(no-unused-vars)', 'unused', 'warning'),
    diagnostic('src/c.ts', 'eslint(no-unused-vars)', 'unused', 'error'),
  ])

  assert.deepEqual(entries, [
    entry('src/b.ts', 'eslint(no-unused-vars)', 'unused'),
    entry('test/a.test.ts', 'unicorn(no-useless-spread)', 'spread', 2),
  ])
})

test('a warning the baseline does not name is a failure; a matching report is not', () => {
  const baseline = [entry('src/b.ts', 'eslint(no-unused-vars)', 'unused')]

  const clean = compareWarnings(baseline, [
    entry('src/b.ts', 'eslint(no-unused-vars)', 'unused'),
  ])
  assert.equal(clean.ok, true, 'the pinned warning must keep passing')
  assert.deepEqual(clean.added, [])

  const raised = compareWarnings(baseline, [
    entry('src/b.ts', 'eslint(no-unused-vars)', 'unused'),
    entry('src/changed.ts', 'eslint(no-console)', 'console'),
  ])
  assert.equal(raised.ok, false)
  assert.deepEqual(
    raised.added.map((item) => `${item.file} ${item.rule}`),
    ['src/changed.ts eslint(no-console)'],
    'a new warning must be reported by file and rule',
  )

  const moreOfTheSame = compareWarnings(baseline, [
    entry('src/b.ts', 'eslint(no-unused-vars)', 'unused', 2),
  ])
  assert.equal(moreOfTheSame.ok, false, 'a second copy of a baselined warning is still a new finding')
  assert.deepEqual(moreOfTheSame.added.map((item) => item.count), [2])
})

test('a baseline entry the tree no longer produces is stale and must be removed', () => {
  const result = compareWarnings(
    [entry('src/b.ts', 'eslint(no-unused-vars)', 'unused'), entry('src/gone.ts', 'eslint(no-unused-vars)', 'unused')],
    [entry('src/b.ts', 'eslint(no-unused-vars)', 'unused')],
  )

  assert.equal(result.ok, false)
  assert.deepEqual(
    result.stale.map((item) => item.file),
    ['src/gone.ts'],
    'a fixed warning has to leave the baseline in the same change',
  )
})

test('the gate fails a fixture with one new warning and passes the pinned report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lint-warnings-'))
  try {
    const baseline = [entry('src/pinned.ts', 'eslint(no-unused-vars)', 'unused')]
    const report = {
      diagnostics: [
        diagnostic('src/pinned.ts', 'eslint(no-unused-vars)', 'unused'),
        diagnostic('src/changed.ts', 'eslint(no-console)', 'Unexpected console statement.'),
      ],
    }
    const baselinePath = join(dir, 'baseline.json')
    const raisedPath = join(dir, 'raised.json')
    const cleanPath = join(dir, 'clean.json')

    writeFileSync(baselinePath, JSON.stringify({ version: BASELINE_VERSION, entries: baseline }))
    writeFileSync(raisedPath, JSON.stringify(report))
    writeFileSync(
      cleanPath,
      JSON.stringify({ diagnostics: [diagnostic('src/pinned.ts', 'eslint(no-unused-vars)', 'unused')] }),
    )

    const raised = runGate(['--diagnostics', raisedPath, '--baseline', baselinePath])
    assert.equal(raised.code, 1, raised.output)
    assert.match(raised.output, /src\/changed\.ts/)
    assert.match(raised.output, /eslint\(no-console\)/)
    assert.match(raised.output, /1 new warning/)

    const clean = runGate(['--diagnostics', cleanPath, '--baseline', baselinePath])
    assert.equal(clean.code, 0, clean.output)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a report with no baseline at all fails loudly instead of passing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lint-warnings-'))
  try {
    mkdirSync(join(dir, 'empty'))
    const report = { diagnostics: [diagnostic('src/changed.ts', 'eslint(no-console)', 'Unexpected console statement.')] }
    const reportPath = join(dir, 'report.json')
    writeFileSync(reportPath, JSON.stringify(report))

    const result = runGate(['--diagnostics', reportPath, '--baseline', join(dir, 'missing.json')])
    assert.equal(result.code, 2, result.output)
    assert.match(result.output, /baseline/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the committed baseline matches the tree, so the current warnings pass', () => {
  const result = runGate([])
  assert.equal(result.code, 0, result.output)
  assert.match(result.output, /match the baseline/)
})
