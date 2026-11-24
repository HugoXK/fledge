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
// name and replace the body (`run: true`), add a job-level `continue-on-error`
// so a failing required job reports `success`, rename a required job while a
// stub takes its old display name, or neuter every `run:` step through a
// top-level `defaults:`/`env:`. These tests drive the comparator over the real
// checked-in workflow and over synthetic texts, and they pin the refusal
// messages: a red that names the job and the key is the evidence a reviewer
// needs, and a silent pass is the bug.
//
// #1282: the aggregate the comparator reads the `needs:`, the evaluator command
// and `path: base` from is looked up by an accepted id set, never by one
// literal. A head that renames it away used to skip those three checks and come
// back green with a line claiming they ran, so the lookup miss is now a refusal
// too — with the id it looked for and the ids the head declares — and a head
// declaring two candidates is refused by both names.

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

// A job added to the head, immediately before the aggregate.
function withJob(text: string, id: string, body: string[]): string {
  return text.replace(`  ${AGGREGATE_JOB}:\n`, [`  ${id}:`, ...body, '', `  ${AGGREGATE_JOB}:`, ''].join('\n'))
}

const STUB_ROWS = ['    runs-on: ubuntu-latest', '    steps:', '      - run: true']

// A head that renames the aggregate away from `ci-ok-head`. The aggregate is not in
// `REQUIRED_JOBS` — it is the aggregate, looked up on its own — so moving the id
// is the shape that used to lose the `needs:`/evaluator/`path: base` checks.
function aggregateRename(id: string): string {
  return editJob(ci, AGGREGATE_JOB, (block) => [
    `  ${id}:`,
    ...block.slice(1).map((line) => (line === `    name: ${AGGREGATE_JOB}` ? `    name: ${id}` : line)),
  ])
}

// The same loss with no rename at all: the aggregate job is deleted.
function aggregateDeleted(): string {
  return editJob(ci, AGGREGATE_JOB, () => [])
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

// Security's PoC: the real job is renamed and a stub takes the name the
// publisher matches against the required list.
function renamedAndSubstituted(): string {
  const renamed = editJob(ci, 'mock-check', (block) =>
    block.map((line) => (line === '    name: mock-check' ? '    name: mock-check (real)' : line)),
  )
  return withJob(renamed, 'mock-check-stub', ['    name: mock-check', ...STUB_ROWS])
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
  assert.match(result.lines[0]!, /`ci-ok-head` runs `node base\/scripts\/ci-ok\.mjs`/, 'the line names the id it checked')
})

test('the accepted aggregate ids are explicit data, and the publisher reads the same two names', async () => {
  // Read the set through `import()` so this pin fails as an assertion on the
  // unbroken tip instead of as a module-load error that hides the four
  // acceptance cases below.
  const module: Record<string, unknown> = await import('../scripts/lib/gate-compare.mjs')
  assert.deepEqual(module.AGGREGATE_JOBS, ['ci-ok-head', 'ci-ok'], 'the transition set is exact: nothing outside it may pass')
  assert.equal(AGGREGATE_JOB, 'ci-ok-head', 'the base tree declares `ci-ok-head` after #1273 renamed the in-run aggregate')
  const publisher = read('scripts/lib/ci-ok-run.mjs')
  assert.match(publisher, /export const HEAD_AGGREGATE_JOB = 'ci-ok-head'/, 'the publisher and the comparator agree on the new id')
  assert.match(publisher, /export const REQUIRED_CHECK = 'ci-ok'/, 'and on the old one')
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
  assert.match(text, /`ci-ok-head`/)
})

test('acceptance 3: a head that adds its own job and waits on it is allowed', () => {
  const withExtraJob = ci.replace(
    `  ${AGGREGATE_JOB}:\n`,
    `  extra-gate:\n    name: extra-gate\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n\n  ${AGGREGATE_JOB}:\n`,
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

test('only `timeout-minutes:` may change: the display name is pinned and the allowlist is exact', () => {
  const slower = editJob(ci, 'mock-check', (block) =>
    block.map((line) => (line === '    timeout-minutes: 5' ? '    timeout-minutes: 9' : line)),
  )
  assert.equal(compareGate({ base: ci, head: slower }).ok, true, 'a longer timeout cannot flip a conclusion')

  const renamed = editJob(ci, 'mock-check', (block) =>
    block.map((line) => (line === '    name: mock-check' ? '    name: mock-check (verbose)' : line)),
  )
  const refused = compareGate({ base: ci, head: renamed })
  assert.equal(refused.ok, false, '`name:` is what the publisher matches, so it is compared, not allowlisted')
  assert.match(refused.problems.join('\n'), /changes `name:`/)

  assert.deepEqual([...GATE_COMPARE_ALLOWED_KEYS], ['timeout-minutes'], 'widening the allowlist must break this test')
})

test('security: renaming a required job and substituting a stub under its old name is refused', () => {
  const head = renamedAndSubstituted()
  assert.notEqual(head, ci)
  const result = compareGate({ base: ci, head })
  assert.equal(result.ok, false, 'the rename plus a same-named stub must not be a pass')
  const text = result.problems.join('\n')
  assert.match(text, /changes `name:`/, 'the rename is refused by key')
  assert.match(
    text,
    /lets job `mock-check-stub` claim the display name of required job `mock-check`/,
    'and the substituted name is refused as a collision',
  )
})

test('security: an extra job claiming a required display name is refused even when the real job is intact', () => {
  const head = withJob(ci, 'mock-check-stub', ['    name: mock-check', ...STUB_ROWS])
  const result = compareGate({ base: ci, head })
  assert.equal(result.ok, false)
  assert.match(
    result.problems.join('\n'),
    /lets job `mock-check-stub` claim the display name of required job `mock-check`/,
  )
})

test('security: a matrix-shaped required name cannot be claimed by a new leg', () => {
  const head = withJob(ci, 'test-docs', ['    name: test (docs)', ...STUB_ROWS])
  const result = compareGate({ base: ci, head })
  assert.equal(result.ok, false)
  assert.match(result.problems.join('\n'), /claim the display name of required job `test`/)
})

test('two jobs with one display name are refused, because the publisher would merge their results', () => {
  const head = withJob(ci, 'twin-a', ['    name: twin', ...STUB_ROWS]).replace(
    `  ${AGGREGATE_JOB}:\n`,
    ['  twin-b:', '    name: twin', ...STUB_ROWS, '', `  ${AGGREGATE_JOB}:`, ''].join('\n'),
  )
  const result = compareGate({ base: ci, head })
  assert.equal(result.ok, false)
  assert.match(result.problems.join('\n'), /gives jobs `twin-a` and `twin-b` the same display name/)
})

test('every refusal names the reviewed-change path, and the verdict stays red', () => {
  const result = compareGate({ base: ci, head: stepLevelContinueOnError() })
  assert.equal(result.ok, false, 'the label is a record, not a pass: the verdict stays red')
  const text = result.problems.join('\n')
  assert.match(text, new RegExp(`\`${WORKFLOW_CHANGE_LABEL}\``))
  assert.match(text, /T3 path/)
  assert.match(text, /`Security:`/)
  assert.match(text, /stays red/)
  assert.match(text, /merge the base branch into the head/, 'a stale head is told to merge the base tree')
})

test('no top-level block may change, be added or be lost', () => {
  const defaults = ci.replace(/^jobs:\n/m, 'defaults:\n  run:\n    shell: "true {0}"\njobs:\n')
  const environment = ci.replace(/^jobs:\n/m, 'env:\n  NODE_OPTIONS: --require ./x.js\njobs:\n')
  const permissions = ci.replace('permissions:\n  contents: read', 'permissions:\n  contents: write')
  const noOn = mini((text) => text.replace('on:\n  pull_request:\n', ''))

  for (const [label, head, expected] of [
    ['added defaults', defaults, /gains a top-level `defaults:` block/],
    ['added env', environment, /gains a top-level `env:` block/],
    ['changed permissions', permissions, /changes the top-level `permissions:` block/],
    ['lost on', noOn, /loses the top-level `on:` block/],
  ] as const) {
    const result = compareGate({ base: label === 'lost on' ? MINI : ci, head, required: label === 'lost on' ? ['build'] : REQUIRED_JOBS })
    assert.equal(result.ok, false, `${label} must be refused`)
    assert.match(result.problems.join('\n'), expected, label)
  }

  const text = compareGate({ base: ci, head: defaults }).problems.join('\n')
  assert.doesNotMatch(text, /true \{0\}/, 'a top-level value is not echoed into the refusal')
  assert.doesNotMatch(text, /NODE_OPTIONS|--require/, 'an env value is not echoed into the refusal')
})

test('a required job missing from `ci-ok-head.needs` is refused, naming the dependency', () => {
  const head = editJob(ci, AGGREGATE_JOB, (block) =>
    block.map((line) => (line.startsWith('    needs: ') ? line.replace('mock-check, ', '') : line)),
  )
  const result = compareGate({ base: ci, head })
  assert.equal(result.ok, false)
  assert.match(result.problems.join('\n'), /`ci-ok-head` does not depend on required job `mock-check`/)
})

test('the `path: base` checkout is pinned: removing it is a refusal', () => {
  const head = editJob(ci, AGGREGATE_JOB, (block) => block.filter((line) => line.trim() !== 'path: base'))
  const result = compareGate({ base: ci, head })
  assert.equal(result.ok, false)
  assert.match(result.problems.join('\n'), /does not check the gate out under `path: base`/)
})

test('acceptance 1: an aggregate id outside the accepted set is refused, naming what it looked for and what the head declares', () => {
  for (const [label, head] of [
    ['renamed to an unknown id', aggregateRename('ci-ok-v2')],
    ['deleted', aggregateDeleted()],
  ] as const) {
    assert.notEqual(head, ci, `${label}: the fixture changed the aggregate`)
    const result = compareGate({ base: ci, head })
    assert.equal(result.ok, false, `${label} must not skip the three aggregate checks`)
    const text = result.problems.join('\n')
    assert.match(text, /declares no aggregate job the gate accepts/, label)
    assert.match(text, /looked for `ci-ok-head` or `ci-ok`/, `${label}: the ids it looked for are named`)
    assert.match(text, /the head declares /, `${label}: the ids the head does declare are named`)
    assert.equal(result.lines.length, 0, `${label}: a refusal carries no line that could be read as a pass`)
    assert.doesNotMatch(text, /`ci-ok` runs /, `${label}: the success line cannot claim a check that did not run`)
  }
  const renamed = compareGate({ base: ci, head: aggregateRename('ci-ok-v2') }).problems.join('\n')
  assert.match(renamed, /the head declares [^)]*`ci-ok-v2`/, 'the id the head declares instead is named in the refusal')
})

test('acceptance 2: a head declaring both accepted aggregate ids is refused, naming both', () => {
  const head = withJob(ci, 'ci-ok', ['    name: ci-ok', ...STUB_ROWS])
  assert.notEqual(head, ci, 'the fixture added the second candidate')
  const result = compareGate({ base: ci, head })
  assert.equal(result.ok, false, 'two candidates for one aggregate is not a pass')
  const text = result.problems.join('\n')
  assert.match(text, /more than one aggregate job/)
  assert.match(text, /`ci-ok-head` and `ci-ok`/, 'both declared ids are named')
  assert.equal(result.lines.length, 0)
})

test('acceptance 3: a head that still declares the old id while the base declares ci-ok-head is checked under it', () => {
  const head = aggregateRename('ci-ok')
  const result = compareGate({ base: ci, head })
  assert.equal(result.ok, true, result.problems.join('\n'))
  assert.equal(result.lines.length, 1)
  assert.match(result.lines[0]!, /`ci-ok` runs `node base\/scripts\/ci-ok\.mjs`/, 'the green line names the id it read')
  assert.doesNotMatch(result.lines[0]!, /`ci-ok-head` runs /, 'a green line cannot credit an id that was not read')
})

test('acceptance 4: the three aggregate checks follow the accepted id the head declares', () => {
  const renamed = aggregateRename('ci-ok')
  const droppedNeeds = editJob(renamed, 'ci-ok', (block) =>
    block.map((line) => (line.startsWith('    needs: ') ? line.replace('mock-check, ', '') : line)),
  )
  const noEvaluator = editJob(renamed, 'ci-ok', (block) =>
    block.map((line) => (line.trim() === `run: ${REQUIRED_EVALUATOR}` ? '        run: exit 0' : line)),
  )
  const noCheckout = editJob(renamed, 'ci-ok', (block) => block.filter((line) => line.trim() !== 'path: base'))

  for (const [label, head, expected] of [
    ['needs', droppedNeeds, /`ci-ok` does not depend on required job `mock-check`/],
    ['evaluator', noEvaluator, /`ci-ok` does not run the base evaluator/],
    ['path: base', noCheckout, /`ci-ok` does not check the gate out under `path: base`/],
  ] as const) {
    const result = compareGate({ base: ci, head })
    assert.equal(result.ok, false, `${label} must still be refused when the aggregate id is renamed`)
    assert.match(result.problems.join('\n'), expected, label)
  }
})

test('acceptance 5: a duplicated job, a duplicated key or an unreadable line is refused, not skipped', () => {
  const duplicateJob = mini((text) => text.replace('  ci-ok:\n', '  build:\n    name: build\n  ci-ok:\n'))
  const duplicateKey = mini((text) => text.replace('    runs-on: ubuntu-latest\n', '    runs-on: ubuntu-latest\n    runs-on: ubuntu-24.04\n'))
  const badIndent = mini((text) => text.replace('    name: build\n', '   name: build\n'))
  const noJobs = mini((text) => text.replace(/jobs:[\s\S]*$/, 'permissions:\n  contents: read\n'))
  const emptyMapping = mini((text) => text.replace(/jobs:[\s\S]*$/, 'jobs:\n'))
  const duplicateTopKey = mini((text) => `${text}name: CI again\n`)
  const empty = ''

  for (const [label, text, expected] of [
    ['duplicate job', duplicateJob, /declares job `build` twice/],
    ['duplicate key', duplicateKey, /declares `runs-on:` twice/],
    ['unreadable line', badIndent, /cannot read/],
    ['no jobs mapping', noJobs, /no top-level `jobs:` mapping/],
    ['empty mapping', emptyMapping, /mapping is empty/],
    ['duplicate top-level key', duplicateTopKey, /declares `name:` at the top level twice/],
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
  assert.equal(text.includes(marker), false, 'a value from the workflow text never reaches the refusal')
  assert.equal(text.includes(GATE_COMPARE_FILE), true, 'the refusal names the compared file')
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

test('the publisher runs the comparison for pull requests only, reads both texts through the API, and reads no label', () => {
  const cli = read('scripts/ci-ok-run.mjs')
  assert.match(cli, /if \(run\.event === 'pull_request'\) \{/, 'only a pull request has a head and a base to compare')
  assert.match(cli, /gateComparison\(run\)/)
  assert.match(cli, /contents\/\$\{GATE_COMPARE_FILE\}/, 'both workflow texts come from the contents API')
  // The run object's `repository` is slim and carries no `default_branch`
  // (verified against run 44670966564), so reading the branch there refuses
  // every pull request. The repository endpoint answers with the branch.
  assert.match(cli, /api\(`\/repos\/\$\{REPO\}`\)/, 'the base ref comes from the repository API')
  assert.doesNotMatch(cli, /run\.repository\?\.default_branch|run\.head_repository\?\.default_branch/, 'the run object has no default_branch to read')
  // The `ci-workflow-change` label only changed the wording of a refusal, so
  // the publisher does not read it: reading a pull request needs a scope, and a
  // sentence is not worth one.
  assert.doesNotMatch(cli, /\/pulls\/\$\{String\(number\)\}/, 'a pull request scope is not requested for wording')
  assert.doesNotMatch(cli, /readFileSync/, 'no checkpoint text is read from a file, so a file byte cannot reach the request')
  const publish = read('.github/workflows/ci-ok-publish.yml')
  assert.doesNotMatch(publish, /pull-requests: read|issues: read/, 'the comparator adds no permission for wording')
})
