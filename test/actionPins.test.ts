import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkWorkflow, scanWorkflows } from '../scripts/lib/action-pins.mjs'

// A real pin, the one this repository uses for actions/checkout.
const PIN = '11d5960a326750d5838078e36cf38b85af677262'

test('a floating tag is reported and a full-sha pin with its tag comment passes', () => {
  const text = [
    'jobs:',
    '  build:',
    '    steps:',
    `      - uses: actions/checkout@${PIN} # v4.4.0`,
    '      - uses: actions/setup-node@v4',
  ].join('\n')
  const findings = checkWorkflow(text, 'fixture.yml')
  assert.deepEqual(findings, [
    { file: 'fixture.yml', line: 5, value: 'actions/setup-node@v4', problem: 'not-pinned' },
  ])
})

test('a pin without its tag comment is reported, because a re-pin must stay readable', () => {
  const text = `      - uses: actions/checkout@${PIN}\n`
  assert.deepEqual(checkWorkflow(text, 'fixture.yml'), [
    { file: 'fixture.yml', line: 1, value: `actions/checkout@${PIN}`, problem: 'missing-tag-comment' },
  ])
})

test('a short sha, a branch name and a quoted value are all caught', () => {
  const text = [
    '      - uses: actions/checkout@11d5960 # v4',
    '      - uses: actions/checkout@main # v4.4.0',
    '      - uses: "actions/checkout@v4"',
  ].join('\n')
  assert.equal(checkWorkflow(text, 'fixture.yml').length, 3)
})

test('a local action and a docker reference are out of scope, not silently green', () => {
  const text = [
    '      - uses: ./actions/local',
    '      - uses: docker://alpine:3.20',
  ].join('\n')
  assert.deepEqual(checkWorkflow(text, 'fixture.yml'), [])
})

// The fixtures live in a temporary directory because the checker is the thing
// under test: a regex over the real tree would prove the tree, not the checker.
test('a directory scan reports the unpinned file and counts what it checked', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'action-pins-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'nested'))
  writeFileSync(join(dir, 'good.yml'), `      - uses: actions/checkout@${PIN} # v4.4.0\n`)
  writeFileSync(join(dir, 'bad.yaml'), '      - uses: actions/setup-node@v4\n')
  writeFileSync(join(dir, 'ignored.txt'), '      - uses: actions/setup-node@v4\n')

  const report = scanWorkflows(dir)
  assert.deepEqual(report.findings.map((finding) => `${finding.file.split('/').pop()}:${finding.problem}`), ['bad.yaml:not-pinned'])
  assert.equal(report.checked, 2)
  assert.deepEqual(report.files.map((file) => file.split('/').pop()).sort(), ['bad.yaml', 'good.yml'])
})

test('the workflow tree in this repository is fully pinned', () => {
  const report = scanWorkflows('.github/workflows')
  assert.deepEqual(
    report.findings.map((finding) => `${finding.file}:${finding.line} ${finding.value} ${finding.problem}`),
    [],
  )
  assert.ok(report.checked >= 37, `only ${report.checked} action references were checked`)
})
