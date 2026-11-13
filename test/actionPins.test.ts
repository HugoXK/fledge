import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkActorGates, checkWorkflow, scanActorGates, scanWorkflows } from '../scripts/lib/action-pins.mjs'

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

const RUNNER = `      - uses: actions/checkout@${PIN} # v4.4.0`
const GATE = `contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), `
function workflow(events: string, job: string): string {
  return ['on:', events, '', 'jobs:', job, ''].join('\n')
}
function privilegedJob(name: string, condition: string | null, extra = ''): string {
  return [
    `  ${name}:`,
    ...(condition === null ? [] : [`    if: ${condition}`]),
    ...(extra === '' ? [] : [extra]),
    '    runs-on: ubuntu-latest',
    '    permissions:',
    '      contents: read',
    '      actions: write',
    '    steps:',
    RUNNER,
  ].join('\n')
}

test('a privileged job on a review-triggered event must test the review association', () => {
  const ungated = workflow('  pull_request_review:', privilegedJob('repair', "always() && github.event_name == 'pull_request_review'"))
  assert.deepEqual(checkActorGates(ungated, 'fixture.yml'), [
    { file: 'fixture.yml', line: 5, job: 'repair', event: 'pull_request_review', problem: 'missing-association-gate' },
  ])

  const gated = workflow('  pull_request_review:', privilegedJob('repair', `always() && ${GATE}github.event.review.author_association)`))
  assert.deepEqual(checkActorGates(gated, 'fixture.yml'), [])
})

test('the association must come from the event that started the job', () => {
  // The sibling shape: a comment-triggered job gated on the comment's author.
  const comment = workflow('  issue_comment:', privilegedJob('comment', `github.event_name == 'issue_comment' && github.event.issue.pull_request != null && ${GATE}github.event.comment.author_association)`))
  assert.deepEqual(checkActorGates(comment, 'fixture.yml'), [])

  // The same job reading the review object would test an expression that is null
  // for an issue_comment event: gated in shape, open in fact.
  const wrongEvent = workflow('  issue_comment:', privilegedJob('comment', `github.event_name == 'issue_comment' && ${GATE}github.event.review.author_association)`))
  assert.deepEqual(checkActorGates(wrongEvent, 'fixture.yml').map((finding) => finding.problem), ['missing-association-gate'])

  // pull_request_target carries the association on the pull request object.
  const target = workflow('  pull_request_target:', privilegedJob('repair', `${GATE}github.event.pull_request.author_association)`))
  assert.deepEqual(checkActorGates(target, 'fixture.yml'), [])
})

test('a list that omits a role, or a job without actions: write, is judged correctly', () => {
  const partial = workflow('  pull_request_review:', privilegedJob('repair', `contains(fromJSON('["OWNER","MEMBER"]'), github.event.review.author_association)`))
  assert.equal(checkActorGates(partial, 'fixture.yml').length, 1, 'a list missing a role does not gate the actor')

  const readOnly = [
    'on:',
    '  pull_request_review:',
    'jobs:',
    '  repair:',
    '    runs-on: ubuntu-latest',
    '    permissions:',
    '      actions: read',
    '    steps:',
    `      - uses: actions/checkout@${PIN} # v4.4.0`,
    '',
  ].join('\n')
  assert.deepEqual(checkActorGates(readOnly, 'fixture.yml'), [], 'a job without actions: write needs no association gate')
})

test('every workflow in this repository gates its actions: write jobs on the actor', () => {
  // The real tree, not a fixture: the required `action-pins` job runs this same
  // scan, so a workflow that gains a privileged job without the gate reds the
  // repository rather than only a test.
  const report = scanActorGates('.github/workflows')
  assert.deepEqual(
    report.findings.map((finding) => `${finding.file}:${finding.line} ${finding.job} ${finding.event} ${finding.problem}`),
    [],
  )
  assert.ok(report.checked >= 2, `only ${report.checked} actions: write jobs were checked`)
})
