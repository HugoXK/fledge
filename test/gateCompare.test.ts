import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { REQUIRED_JOBS } from '../scripts/ci-ok.mjs'
import { verdict } from '../scripts/lib/ci-ok-run.mjs'
import {
  AGGREGATE_JOB,
  GATE_COMPARE_ALLOWED_KEYS,
  GATE_COMPARE_FILE,
  REQUIRED_EVALUATOR,
  WORKFLOW_CHANGE_LABEL,
  compareGate,
  parseWorkflowJobs,
} from '../scripts/lib/gate-compare.mjs'

// #1108: the publisher matches a required job by name, so a head could keep the
// name and replace the body (`run: true`), or add a job-level `continue-on-error`
// so a failing required job reports `success`. These tests drive the comparator
// over the real checked-in workflow and over two synthetic texts, and they pin
// the refusal messages: a red that names the job and the key is the evidence a
// reviewer needs, and a silent pass is the bug.

const read = (path: string): string => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')
const ci = read(GATE_COMPARE_FILE)

interface Span {
  start: number
  end: number
}

function jobSpan(text: string, id: string): Span {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line === `  ${id}:`)
  assert.notEqual(start, -1, `the workflow has no ${id} job`)
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [a-z][a-z0-9-]*:$/.test(lines[index]!)) {
      end = index
      break
    }
  }
  return { start, end }
}

function editJob(text: string, id: string, edit: (block: string[]) => string[]): string {
  const lines = text.split('\n')
  const { start, end } = jobSpan(text, id)
  return [...lines.slice(0, start), ...edit(lines.slice(start, end)), ...lines.slice(end)].join('\n')
}

// Acceptance 1: the job keeps its name and its body becomes a no-op.
function stubbedRequiredJob(): string {
  return editJob(ci, 'mock-check', (block) => {
    const at = block.findIndex((line) => line === '        run: |')
    assert.notEqual(at, -1)
    const after = block.findIndex((line, index) => index > at && !line.startsWith('          '))
    assert.notEqual(after, -1)
    return [...block.slice(0, at), '        run: true', ...block.slice(after)]
  })
}

// Acceptance 2: the aggregate's own step stops running the base evaluator.
function stubbedAggregate(): string {
  return editJob(ci, AGGREGATE_JOB, (block) =>
    block.map((line) => (line.trim() === `run: ${REQUIRED_EVALUATOR}` ? '        run: exit 0' : line)),
  )
}

// Acceptance 3a: a step-level key that turns a failed step's conclusion green.
function stepLevelContinueOnError(): string {
  return editJob(ci, 'mock-check', (block) => {
    const at = block.findIndex((line) => line.trim() === 'run: |')
    assert.notEqual(at, -1)
    return [...block.slice(0, at), '        continue-on-error: true', ...block.slice(at)]
  })
}

const MINI = [
  'name: CI',
  'on:',
  '  pull_request:',
  'jobs:',
  '  build:',
  '    name: build',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - run: npm run build',
  '  ci-ok:',
  '    name: ci-ok',
  '    needs: [build]',
  '    timeout-minutes: 5',
  '    steps:',
  '      - uses: actions/checkout@0000000000000000000000000000000000000000',
  '        with:',
  '          path: base',
  '      - run: node base/scripts/ci-ok.mjs',
  '',
].join('\n')

const mini = (edit: (text: string) => string): string => edit(MINI)

test('the checked-in workflow is its own base, so an untouched pull request is allowed', () => {
  const result = compareGate({ base: ci, head: ci })
  assert.equal(result.ok, true, result.problems.join('\n'))
  assert.deepEqual(result.problems, [])
  assert.equal(result.lines.length, 1)
  assert.match(result.lines[0]!, /gate-compare/)
  assert.match(result.lines[0]!, new RegExp(String(REQUIRED_JOBS.length)))
})

test('acceptance 1: a required job stubbed to `run: true` is refused, naming the job and the body', () => {
  const result = compareGate({ base: ci, head: stubbedRequiredJob() })
  assert.equal(result.ok, false)
  const text = result.problems.join('\n')
  assert.match(text, /`mock-check`/, 'the refusal names the required job')
  assert.match(text, /`run:`/, 'the refusal names the differing body key')
  assert.equal(result.lines.length, 0, 'a refusal carries no informational line that could be read as a pass')
})

test('acceptance 2: an aggregate step that no longer runs the base evaluator is refused by name', () => {
  const result = compareGate({ base: ci, head: stubbedAggregate() })
  assert.equal(result.ok, false)
  const text = result.problems.join('\n')
  assert.match(text, new RegExp(`does not run the base evaluator \`${REQUIRED_EVALUATOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``))
  assert.match(text, /`ci-ok`/)
})

test('acceptance 3: a head that adds its own job and waits on it is allowed', () => {
  const withExtraJob = ci.replace(
    '  ci-ok:\n',
    '  extra-gate:\n    name: extra-gate\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n\n  ci-ok:\n',
  )
  assert.notEqual(withExtraJob, ci, 'the fixture inserted a job')
  const head = editJob(withExtraJob, AGGREGATE_JOB, (block) =>
    block.map((line) => (line.startsWith('    needs: ') ? line.replace('mock-check, ', 'mock-check, extra-gate, ') : line)),
  )
  const result = compareGate({ base: ci, head })
  assert.equal(result.ok, true, result.problems.join('\n'))
})

test('acceptance 3a: a step-level `continue-on-error: true` is refused, and the message names it', () => {
  const head = stepLevelContinueOnError()
  const result = compareGate({ base: ci, head })
  assert.equal(result.ok, false)
  assert.match(result.problems.join('\n'), /`continue-on-error:`/)
  assert.match(result.problems.join('\n'), /`mock-check`/, 'the key is named together with the job it would hide')
})

test('acceptance 3b: only `timeout-minutes:` (and `name:`) may change, and the allowlist is exact', () => {
  const head = editJob(ci, 'mock-check', (block) =>
    block.map((line) => {
      if (line === '    timeout-minutes: 5') return '    timeout-minutes: 9'
      if (line === '    name: mock-check') return '    name: mock-check (verbose)'
      return line
    }),
  )
  assert.notEqual(head, ci, 'the fixture changed the allowlisted keys')
  const result = compareGate({ base: ci, head })
  assert.equal(result.ok, true, result.problems.join('\n'))
  assert.deepEqual([...GATE_COMPARE_ALLOWED_KEYS], ['name', 'timeout-minutes'], 'widening the allowlist must break this test')
})

test('acceptance 4: a labelled workflow change is still a refusal that names the T3 path', () => {
  const head = stepLevelContinueOnError()
  const result = compareGate({ base: ci, head, labelled: true })
  assert.equal(result.ok, false, 'the label is a record, not a pass: the verdict stays red')
  const text = result.problems.join('\n')
  assert.match(text, new RegExp(`\`${WORKFLOW_CHANGE_LABEL}\` is set`))
  assert.match(text, /T3 path/)
  assert.match(text, /`Security:`/)
  assert.doesNotMatch(text, /merge the base branch into the head/, 'the labelled wording is the reviewed one; the unlabelled one tells a stale head to merge the base')
})

test('an unlabelled refusal tells a stale head to merge the base tree, and names the label door', () => {
  const result = compareGate({ base: ci, head: stepLevelContinueOnError() })
  const text = result.problems.join('\n')
  assert.match(text, /merge the base branch into the head/)
  assert.match(text, new RegExp(`the owner applies \`${WORKFLOW_CHANGE_LABEL}\``))
})

test('a required job missing from `ci-ok.needs` is refused, naming the dependency', () => {
  const head = editJob(ci, AGGREGATE_JOB, (block) =>
    block.map((line) => (line.startsWith('    needs: ') ? line.replace('mock-check, ', '') : line)),
  )
  const result = compareGate({ base: ci, head })
  assert.equal(result.ok, false)
  assert.match(result.problems.join('\n'), /`ci-ok` does not depend on required job `mock-check`/)
})

test('the `path: base` checkout is pinned: removing it is a refusal', () => {
  const head = editJob(ci, AGGREGATE_JOB, (block) => block.filter((line) => line.trim() !== 'path: base'))
  const result = compareGate({ base: ci, head })
  assert.equal(result.ok, false)
  assert.match(result.problems.join('\n'), /does not check the gate out under `path: base`/)
})

test('acceptance 5: a duplicated job, a duplicated key or an unreadable line is refused, not skipped', () => {
  const duplicateJob = mini((text) => text.replace('  ci-ok:\n', '  build:\n    name: build\n  ci-ok:\n'))
  const duplicateKey = mini((text) => text.replace('    runs-on: ubuntu-latest\n', '    runs-on: ubuntu-latest\n    runs-on: ubuntu-24.04\n'))
  const badIndent = mini((text) => text.replace('    name: build\n', '   name: build\n'))
  const noJobs = mini((text) => text.replace(/jobs:[\s\S]*$/, 'permissions:\n  contents: read\n'))
  const emptyMapping = mini((text) => text.replace(/jobs:[\s\S]*$/, 'jobs:\n'))
  const empty = ''

  for (const [label, text, expected] of [
    ['duplicate job', duplicateJob, /declares job `build` twice/],
    ['duplicate key', duplicateKey, /declares `runs-on:` twice/],
    ['unreadable line', badIndent, /cannot read/],
    ['no jobs mapping', noJobs, /no top-level `jobs:` mapping/],
    ['empty mapping', emptyMapping, /mapping is empty/],
    ['empty text', empty, /no top-level `jobs:` mapping/],
  ] as const) {
    const result = compareGate({ base: MINI, head: text, required: ['build'] })
    assert.equal(result.ok, false, `${label} must be refused`)
    assert.match(result.problems.join('\n'), expected, label)
  }
  assert.equal(compareGate({ base: MINI, head: MINI, required: ['build'] }).ok, true, 'the control fixture itself is allowed')
})

test('a refusal quotes no file content: only the file name, a job id and a plain key name', () => {
  const marker = 'SHOULD-NOT-LEAK-0123456789'
  const head = editJob(ci, 'mock-check', (block) =>
    block.map((line) => (line === '        run: |' ? `        run: echo ${marker}` : line)),
  )
  const result = compareGate({ base: ci, head })
  assert.equal(result.ok, false)
  const text = result.problems.join('\n')
  assert.doesNotMatch(text, new RegExp(marker), 'a value from the workflow text never reaches the refusal')
  assert.match(text, new RegExp(GATE_COMPARE_FILE.replace(/[.]/g, '\\.')))
  assert.doesNotMatch(text, /npm run mock:check/, 'the base command text is not echoed either')
})

test('the publisher-level verdict goes red when the comparison refuses, even with every job green', () => {
  const jobs = REQUIRED_JOBS.map((name) => ({ name, status: 'completed', conclusion: 'success' }))
  const green = verdict({ jobs, eventName: 'pull_request', changes: { source: true } })
  assert.equal(green.ok, true, 'the job list alone is green: that is the shape this card closes')
  const comparison = compareGate({ base: ci, head: stubbedRequiredJob() })
  assert.equal(comparison.ok, false)
  const published = {
    lines: [...green.lines, ...comparison.lines],
    problems: [...green.problems, ...comparison.problems],
    ok: green.ok && comparison.ok,
  }
  assert.equal(published.ok, false)
  assert.match(published.problems.join('\n'), /`mock-check`/)
})

test('the parser reads the real workflow into the required jobs it names', () => {
  const jobs = parseWorkflowJobs(ci)
  for (const id of REQUIRED_JOBS) assert.equal(jobs.has(id), true, `${id} is parsed from ${GATE_COMPARE_FILE}`)
  const keyNames = [...(jobs.get('mock-check')?.keys.keys() ?? [])]
  assert.deepEqual(keyNames, ['name', 'needs', 'runs-on', 'timeout-minutes', 'permissions', 'steps'])
})

test('the publisher runs the comparison for pull requests only, and reads both texts through the API', () => {
  const cli = read('scripts/ci-ok-run.mjs')
  assert.match(cli, /if \(run\.event === 'pull_request'\) \{/, 'only a pull request has a head and a base to compare')
  assert.match(cli, /gateComparison\(run\)/)
  assert.match(cli, /contents\/\$\{GATE_COMPARE_FILE\}/, 'both workflow texts come from the contents API')
  // The run object's `repository` is slim and carries no `default_branch`
  // (verified against run 44670966564), so reading the branch there refuses
  // every pull request. The repository endpoint answers with the branch.
  assert.match(cli, /api\(`\/repos\/\$\{REPO\}`\)/, 'the base ref comes from the repository API')
  assert.doesNotMatch(cli, /run\.repository\?\.default_branch|run\.head_repository\?\.default_branch/, 'the run object has no default_branch to read')
  // The label is read from the pull request the run names (`pull-requests:
  // read`), only after the comparison has refused, and a failed read keeps the
  // unlabelled wording instead of turning the verdict green.
  assert.match(cli, /api\(`\/repos\/\$\{REPO\}\/pulls\/\$\{String\(number\)\}`\)/, 'the label is read from the named pull request')
  assert.match(cli, /if \(comparison\.ok\) return comparison/, 'the label is not read when the workflow already matches')
  assert.match(cli, /labelled = false/, 'a failed label read is "not labelled", not a pass')
  assert.doesNotMatch(cli, /readFileSync/, 'no checkpoint text is read from a file, so a file byte cannot reach the request')
})
