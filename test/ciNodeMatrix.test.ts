import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// #642: a source change ran the whole suite three times — `test (22)`,
// `test (24)` and `coverage`, which also runs every test on Node 22. One Node
// 22 execution is enough for the merge decision, and it should be the one that
// also enforces the coverage floor. These cases read `ci.yml` and
// `package.json` as text, because a workflow file is what a maintainer edits:
// a second Node 22 leg, a coverage job that stops running the suite, or a gate
// that stops requiring either job must fail here instead of passing quietly.

const read = (path: string): string => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')

interface Job {
  id: string
  name: string
  body: string
}

// Every job in the workflow, as its id, its `name:` and the text between them.
// Only the shape this file uses is parsed; anything unusual throws rather than
// being guessed, so a block this test cannot read fails instead of matching
// nothing.
function jobs(text: string): Job[] {
  const lines = text.split('\n')
  const start = lines.indexOf('jobs:')
  assert.notEqual(start, -1, 'ci.yml must carry a top-level jobs: block')
  const found: Job[] = []
  let open: { id: string; name: string; lines: string[] } | null = null
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !/^\s/.test(line)) break
    const id = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (id !== null) {
      if (open !== null) found.push({ id: open.id, name: open.name, body: open.lines.join('\n') })
      open = { id: id[1]!, name: id[1]!, lines: [] }
      continue
    }
    if (open === null) continue
    open.lines.push(line)
    const name = /^ {4}name:\s*(.+?)\s*$/.exec(line)
    if (name !== null) open.name = name[1]!
  }
  if (open !== null) found.push({ id: open.id, name: open.name, body: open.lines.join('\n') })
  return found
}

function job(text: string, id: string): Job {
  const found = jobs(text).find((candidate) => candidate.id === id)
  assert.ok(found, `ci.yml must define the ${id} job`)
  return found
}

function matrixNodes(body: string): string[] {
  const block = /^ {6}matrix:\n((?: {8}.+\n?)+)/m.exec(body)?.[1] ?? ''
  const list = /^ {8}node:\s*\[(.*)\]$/m.exec(block)
  assert.ok(list, 'the test job must carry a literal matrix node list')
  return (list[1] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '')
}

const FULL_SUITE = /run: npm test\b|run: npm run test:coverage\b/

test('the test job runs Node 24 only, and coverage is the single Node 22 full-suite run', () => {
  const text = read('.github/workflows/ci.yml')
  const testJob = job(text, 'test')
  assert.equal(testJob.name, 'test (${{ matrix.node }})', 'the matrix job name is what the checks list and ci-ok read; it must stay stable')
  assert.deepEqual(matrixNodes(testJob.body), ['24'], 'Node 22 is proven by coverage; a second matrix leg would run the same suite twice on the same version')
  assert.match(testJob.body, /run: npm test\b/, 'the Node 24 leg must still run the full suite, not a subset')
  assert.doesNotMatch(testJob.body, /node-version: 22/, 'the compatibility leg must not pin Node 22 as well')

  const coverage = job(text, 'coverage')
  assert.match(coverage.body, /node-version: 22/, 'coverage is the Node 22 execution and must stay on Node 22')
  assert.match(coverage.body, /run: npm run test:coverage\b/, 'coverage must run the full suite with the floor, not a subset')
})

test('exactly two jobs run the full suite, so a broken test still fails both remaining runs', () => {
  const text = read('.github/workflows/ci.yml')
  const fullSuite = jobs(text)
    .filter((candidate) => FULL_SUITE.test(candidate.body))
    .map((candidate) => candidate.id)
    .sort()
  assert.deepEqual(fullSuite, ['coverage', 'test'], 'the gate must execute the whole suite once on Node 22 (coverage) and once on Node 24 (test); a third execution is the duplicate this change removes')

  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
  for (const script of ['test', 'test:coverage']) {
    assert.match(pkg.scripts[script] ?? '', /test\/\*\.test\.ts$/, `npm ${script} must run every test file, so one failing test fails the run`)
  }
  assert.match(pkg.scripts['test:coverage'] ?? '', /--test-coverage-lines=84\b/, 'the coverage floor stays at 84 and is not what this change trades away')
})

test('the removed Node 22 leg does not leave a job that a source diff can skip', () => {
  const text = read('.github/workflows/ci.yml')
  // `test` and `coverage` are deliberately unconditional: the suite reads
  // `docs/`, `public/`, `deploy/` and `.github/`, so a diff that skips them can
  // go green over a red suite. That property is what makes the remaining two
  // runs trustworthy after the matrix shrinks.
  for (const id of ['test', 'coverage']) {
    assert.doesNotMatch(job(text, id).body, /^ {4}if:/m, `${id} must stay unconditional`)
  }
})

test('ci-ok-head still requires both remaining full-suite jobs', () => {
  const text = read('.github/workflows/ci.yml')
  const needs = /^ {4}needs:\s*\[([^\]]+)\]$/m.exec(job(text, 'ci-ok-head').body)?.[1] ?? ''
  const names = needs.split(',').map((value) => value.trim())
  for (const id of ['test', 'coverage']) assert.ok(names.includes(id), `ci-ok-head must still need ${id}; a job dropped from the aggregate would make the gate vacuous`)
})
