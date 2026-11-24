import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALLOWLIST_FILE, approvedUnusedExpiryProblems, checkActorGates, checkWorkflow, readAllowlist, readAllowlistFile, repositoryOf, scanActorGates, scanWorkflows } from '../scripts/lib/action-pins.mjs'

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

test('a privileged job on a finished run must name the head repository', () => {
  // #1169: `workflow_run` sits in SAFE_EVENTS because the runs a stranger starts
  // here need write access — but the *event* is reachable from a fork, and a job
  // holding `actions: write` on it can POST a re-run against this repository on
  // someone else's branch. The head-repository comparison is the missing gate, so
  // it is a finding here rather than a sentence in the docs.
  const guarded = workflow(
    '  workflow_run:',
    privilegedJob('retrigger', `github.event_name == 'workflow_run' && github.event.workflow_run.head_repository.full_name == github.repository`),
  )
  assert.deepEqual(checkActorGates(guarded, 'fixture.yml'), [], 'the head-repository test clears a privileged job on a finished run')

  const unguarded = workflow('  workflow_run:', privilegedJob('retrigger', null))
  assert.deepEqual(checkActorGates(unguarded, 'fixture.yml'), [
    { file: 'fixture.yml', line: 5, job: 'retrigger', event: 'workflow_run', problem: 'missing-head-repository-gate' },
  ])

  // It has to compare this repository's name: a guard written against the run's
  // own `repository` field says nothing about where the head lives.
  const wrongField = workflow(
    '  workflow_run:',
    privilegedJob('retrigger', `github.event.workflow_run.repository.full_name == github.repository`),
  )
  assert.deepEqual(checkActorGates(wrongField, 'fixture.yml').map((finding) => finding.problem), ['missing-head-repository-gate'])
})

function jobWith(header: string, lines: string[]): string {
  return [`  ${header}:`, ...lines, ''].join('\n')
}

test('write-all, an inline mapping and an unparsed permissions value all count as actions: write', () => {
  const shape = (permissions: string, name = 'repair') => workflow('  pull_request_review:', jobWith(name, [
    "    if: always() && github.event_name == 'pull_request_review'",
    `    permissions: ${permissions}`,
    '    runs-on: ubuntu-latest',
    '    steps:',
    RUNNER,
  ]))

  for (const permissions of ['write-all', '{ actions: write }', '{contents: read, actions: write}']) {
    assert.deepEqual(
      checkActorGates(shape(permissions), 'fixture.yml').map((finding) => finding.problem),
      ['missing-association-gate'],
      `${permissions} grants actions: write and must be counted`,
    )
  }

  for (const permissions of ['read-all', 'none', '{}', '{ actions: read }']) {
    assert.deepEqual(checkActorGates(shape(permissions), 'fixture.yml'), [], `${permissions} grants no write scope`)
  }

  // The invariant: a value the parser does not understand reds the gate instead
  // of skipping the job, so the next YAML form someone writes cannot exempt it.
  const unknown = checkActorGates(shape('some-future-form'), 'fixture.yml')
  assert.deepEqual(unknown.map((finding) => finding.problem).sort(), [
    'missing-association-gate',
    'unparsed permissions value "some-future-form"',
  ])
})

test('a job header with a trailing comment is still a job, and a header the parser cannot read fails closed', () => {
  const commented = workflow('  pull_request_review:', jobWith('repair: # review-triggered', [
    "    if: always() && github.event_name == 'pull_request_review'",
    '    runs-on: ubuntu-latest',
    '    permissions:',
    '      actions: write',
    '    steps:',
    RUNNER,
  ]))
  assert.deepEqual(checkActorGates(commented, 'fixture.yml').map((finding) => `${finding.job}:${finding.problem}`), ['repair:missing-association-gate'])

  const quoted = workflow('  pull_request_review:', jobWith('"quoted repair"', [
    '    runs-on: ubuntu-latest',
    '    permissions:',
    '      actions: write',
    '    steps:',
    RUNNER,
  ]))
  assert.deepEqual(checkActorGates(quoted, 'fixture.yml').map((finding) => finding.problem), ['unparsed-job-header'])
})

test('a workflow-level actions: write applies to every job that does not declare its own block', () => {
  const withScope = (jobBlock: string, scope = ['permissions:', '  contents: read', '  actions: write']) => [
    'on:',
    '  pull_request_review:',
    ...scope,
    'jobs:',
    ...jobBlock.split('\n'),
    '',
  ].join('\n')

  const inherited = withScope(jobWith('repair', [
    '    runs-on: ubuntu-latest',
    '    steps:',
    RUNNER,
  ]))
  assert.deepEqual(checkActorGates(inherited, 'fixture.yml').map((finding) => `${finding.job}:${finding.event}:${finding.problem}`), [
    'repair:pull_request_review:missing-association-gate',
  ])

  const gated = withScope(jobWith('repair', [
    `    if: ${GATE}github.event.review.author_association)`,
    '    runs-on: ubuntu-latest',
    '    steps:',
    RUNNER,
  ]))
  assert.deepEqual(checkActorGates(gated, 'fixture.yml'), [], 'a gated job under the workflow block passes')

  const ownBlock = withScope(jobWith('repair', [
    '    permissions:',
    '      actions: read',
    '    runs-on: ubuntu-latest',
    '    steps:',
    RUNNER,
  ]))
  assert.deepEqual(checkActorGates(ownBlock, 'fixture.yml'), [], 'a job with its own read-only block is not widened by the workflow block')
})

test('the association list must be exactly the three roles, not merely contain them', () => {
  const withRoles = (roles: string) => workflow('  pull_request_review:', privilegedJob('repair', `contains(fromJSON('${roles}'), github.event.review.author_association)`))

  const extras = withRoles('["OWNER","MEMBER","COLLABORATOR","FIRST_TIME_CONTRIBUTOR"]')
  assert.deepEqual(checkActorGates(extras, 'fixture.yml').map((finding) => finding.problem), ['missing-association-gate'], 'an extra role admits the strangers the rule bans')

  const substring = withRoles('["OWNER","MEMBER","COLLABORATOR_X"]')
  assert.deepEqual(checkActorGates(substring, 'fixture.yml').map((finding) => finding.problem), ['missing-association-gate'], 'a role name is not a substring match')

  const exactOtherOrder = withRoles('["collaborator","owner","member"]')
  assert.deepEqual(checkActorGates(exactOtherOrder, 'fixture.yml'), [], 'the same three roles in another order and case still gate the actor')
})

// YAML does not fix the indentation of a block: a file whose `jobs:` keys sit at
// four spaces is the same file, and a rule that only sees two-space jobs exempts
// that whole file. These fixtures state the indentation explicitly rather than
// reusing the two-space helpers above.
const FOUR_SPACE_JOB = (condition: string | null, permissions: string[] = ['        permissions:', '            actions: write']) => [
  'jobs:',
  '    repair:',
  ...(condition === null ? [] : [`        if: ${condition}`]),
  '        runs-on: ubuntu-latest',
  ...permissions,
  '        steps:',
  `            - uses: actions/checkout@${PIN} # v4.4.0`,
  '',
]
const withEvents = (events: string[], jobLines: string[]): string => ['on:', ...events, '', ...jobLines].join('\n')

test('a job block indented four spaces is scanned, not exempted', (t) => {
  const ungated = withEvents(['    pull_request_review:'], FOUR_SPACE_JOB("always() && github.event_name == 'pull_request_review'"))
  assert.deepEqual(
    checkActorGates(ungated, 'fixture.yml').map((finding) => `${finding.job}:${finding.event}:${finding.problem}`),
    ['repair:pull_request_review:missing-association-gate'],
    'a four-space jobs block is still a jobs block',
  )

  const gated = withEvents(['    pull_request_review:'], FOUR_SPACE_JOB(`always() && ${GATE}github.event.review.author_association)`))
  assert.deepEqual(checkActorGates(gated, 'fixture.yml'), [], 'a gated four-space job passes, so the finding above is about the gate and not the layout')

  const readOnly = withEvents(['    pull_request_review:'], FOUR_SPACE_JOB("always() && github.event_name == 'pull_request_review'", ['        permissions:', '            actions: read']))
  assert.deepEqual(checkActorGates(readOnly, 'fixture.yml'), [], 'a four-space job without actions: write needs no association gate, so the shape itself is not a false red')

  // The count is the only signal that a scan saw anything, so the same file must
  // also be counted as one privileged job rather than zero.
  const dir = mkdtempSync(join(tmpdir(), 'action-pins-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'four-space.yml'), gated)
  const report = scanActorGates(dir)
  assert.deepEqual(report.findings, [])
  assert.equal(report.checked, 1, 'the four-space job is counted as privileged, not skipped')
})

test('the on: map is read at its own indentation too', () => {
  const onAtFour = ['on:', '    pull_request_review:', '', 'jobs:', privilegedJob('repair', "always() && github.event_name == 'pull_request_review'"), ''].join('\n')
  assert.deepEqual(
    checkActorGates(onAtFour, 'fixture.yml').map((finding) => `${finding.job}:${finding.event}:${finding.problem}`),
    ['repair:pull_request_review:missing-association-gate'],
    'a four-space on: map still names its events, so the job is judged on pull_request_review',
  )

  const gated = ['on:', '    pull_request_review:', '', 'jobs:', privilegedJob('repair', `always() && ${GATE}github.event.review.author_association)`), ''].join('\n')
  assert.deepEqual(checkActorGates(gated, 'fixture.yml'), [], 'the same map with the gate passes')
})

test('an on: value the parser cannot read fails closed instead of yielding no events', () => {
  // Flow mapping: valid YAML that GitHub runs. Its keys are readable, so the job
  // underneath is judged on the event it names rather than skipped.
  const flow = ['on: { pull_request_review: {} }', '', 'jobs:', privilegedJob('repair', "always() && github.event_name == 'pull_request_review'"), ''].join('\n')
  assert.deepEqual(
    checkActorGates(flow, 'fixture.yml').map((finding) => `${finding.job}:${finding.event}:${finding.problem}`),
    ['repair:pull_request_review:missing-association-gate'],
    'a flow mapping names its events, so an ungated privileged job under it must red',
  )

  // A flow value whose entries are not `name:` pairs is not guessed at.
  const unreadableFlow = ['on: { pull_request_review }', '', 'jobs:', privilegedJob('repair', "always() && github.event_name == 'pull_request_review'"), ''].join('\n')
  const flowProblems = checkActorGates(unreadableFlow, 'fixture.yml').map((finding) => finding.problem)
  assert.ok(flowProblems.some((problem) => problem.startsWith('unparsed-on')), `expected an unparsed on: finding, got ${flowProblems.join(', ')}`)
  assert.ok(flowProblems.includes('no-readable-trigger'), `expected the privileged job to be refused, got ${flowProblems.join(', ')}`)

  // An `on:` with no entry at any indentation is the same hole by another shape.
  const empty = ['on:', '', 'jobs:', privilegedJob('repair', null), ''].join('\n')
  const problems = checkActorGates(empty, 'fixture.yml').map((finding) => finding.problem)
  assert.ok(problems.includes('unparsed-on-entries'), `expected an unparsed on: entry finding, got ${problems.join(', ')}`)
  assert.ok(problems.includes('no-readable-trigger'), `expected the privileged job to be refused, got ${problems.join(', ')}`)
})

test('an event the gate cannot classify is a finding until it is classified', () => {
  const unknown = workflow('  pull_request_review_comment:', privilegedJob('repair', null))
  assert.deepEqual(
    checkActorGates(unknown, 'fixture.yml').map((finding) => `${finding.event}:${finding.problem}`),
    ['pull_request_review_comment:unknown-event'],
    'a stranger-reachable event with no association expression must red, not be skipped',
  )

  for (const safe of ['push', 'schedule', 'workflow_dispatch']) {
    assert.deepEqual(checkActorGates(workflow(`  ${safe}:`, privilegedJob('repair', null)), 'fixture.yml'), [], `${safe} cannot be started by an outside account`)
  }
})

// #650: a pin stops a tag from moving; it says nothing about who wrote the
// action. The policy also allows only the actions this project has reviewed, and
// the list is data in the tree so a new action is a reviewable one-line addition
// rather than something a pull request grants itself.
test('an action outside the allowlist is refused even when it is fully pinned', () => {
  const text = `      - uses: stranger/exfiltrate@${PIN} # v1.0.0\n`
  assert.deepEqual(checkWorkflow(text, 'fixture.yml', ['actions/checkout']), [
    { file: 'fixture.yml', line: 1, value: `stranger/exfiltrate@${PIN}`, problem: 'not-allowed' },
  ])
})

test('an allowlisted action passes, and a sub-path belongs to its repository', () => {
  const text = [
    `      - uses: actions/checkout@${PIN} # v4.4.0`,
    `      - uses: github/codeql-action/init@${PIN} # v3.28.1`,
  ].join('\n')
  assert.deepEqual(checkWorkflow(text, 'fixture.yml', ['actions/checkout', 'github/codeql-action']), [])
})

test('the list is what admits an action, so widening it is a visible one-line change', () => {
  const text = `      - uses: newvendor/tool@${PIN} # v2.0.0\n`
  assert.equal(checkWorkflow(text, 'fixture.yml', ['actions/checkout']).length, 1)
  assert.deepEqual(checkWorkflow(text, 'fixture.yml', ['actions/checkout', 'newvendor/tool']), [])
})

test('the workflow tree in this repository passes the allowlist, not just the pin check', () => {
  const allowlist = readAllowlist()
  assert.ok(allowlist.length >= 10, `the reviewed list has shrunk to ${allowlist.length} entries`)
  assert.deepEqual(scanWorkflows('.github/workflows', allowlist).findings, [])
})

// The list is the policy, so drift in either direction is a defect: an action in
// the tree that nobody added to the list (the gate would red the night after the
// merge) and an entry nobody uses (the next reader cannot tell whether it is a
// leftover or a mistake). Both are cheap to assert here and invisible otherwise.
// #1206 adds one legal state to the second direction: a name pre-approved in
// `approved_unused`, which expires on first use — so the moment a workflow uses
// it, the entry has to be gone, and that is asserted rather than remembered.
function usedRepositories(directory: string): Set<string> {
  const used = new Set<string>()
  for (const name of readdirSync(directory)) {
    if (!/\.ya?ml$/i.test(name)) continue
    for (const line of readFileSync(join(directory, name), 'utf8').split(/\r?\n/)) {
      const match = /^\s*(?:-\s*)?uses:\s*(\S+)/.exec(line)
      if (match === null) continue
      const value = match[1]?.replace(/^(['"])(.*)\1$/, '$2') ?? ''
      if (value.startsWith('./') || value.startsWith('docker://')) continue
      used.add(repositoryOf(value))
    }
  }
  return used
}

test('the allowlist and the workflow tree name exactly the same repositories', () => {
  const { allowed_actions: listed, approved_unused: approved } = readAllowlistFile()
  const used = usedRepositories('.github/workflows')
  const exempt = new Set<string>(approved.map((entry: { name: string }) => entry.name.toLowerCase()))
  assert.deepEqual(
    [...used].filter((repo) => !listed.some((name: string) => name.toLowerCase() === repo.toLowerCase())),
    [],
    'a workflow uses an action the list does not name',
  )
  assert.deepEqual(
    [...listed].filter((name: string) => !used.has(name.toLowerCase()) && !exempt.has(name.toLowerCase())),
    [],
    'the list names an action no workflow uses',
  )
  assert.deepEqual(
    approved.filter((entry: { name: string }) => used.has(entry.name.toLowerCase())).map((entry: { name: string; issue: number }) => `${entry.name} (#${entry.issue})`),
    [],
    'an exemption outlived its purpose: a workflow uses the action, so the entry must be deleted in the change that adds the use',
  )
})

test('an exemption is validated like the list it sits beside', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'action-exempt-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const write = (name: string, body: string): string => {
    const path = join(dir, name)
    writeFileSync(path, body)
    return path
  }
  let counter = 0
  const file = (approved: unknown): string =>
    write(`approved-${counter++}.json`, JSON.stringify({ allowed_actions: ['actions/checkout', 'actions/cache'], approved_unused: approved }))
  const entry = { name: 'actions/cache', issue: 1206, expires_at: '0.6.0' }

  assert.deepEqual(readAllowlistFile(file([entry])).approved_unused, [entry])
  // A missing key is an empty one, so every tree that predates the rule keeps working.
  assert.deepEqual(readAllowlistFile(write('none.json', JSON.stringify({ allowed_actions: ['actions/checkout'] }))).approved_unused, [])
  // An exemption for an action the gate refuses pre-approves nothing.
  assert.throws(() => readAllowlistFile(file([{ ...entry, name: 'evil/tool' }])), /not in allowed_actions/)
  // An entry names a repository exactly, never a pattern.
  assert.throws(() => readAllowlistFile(file([{ ...entry, name: 'actions/*' }])), /wildcards are not allowed/)
  // Exactly three fields: a field the reader ignores is one a reviewer may believe.
  assert.throws(() => readAllowlistFile(file([{ ...entry, approved_by: 'me' }])), /not a field of an entry/)
  assert.throws(() => readAllowlistFile(file([{ name: 'actions/cache', expires_at: '0.6.0' }])), /missing issue/)
  assert.throws(() => readAllowlistFile(file([{ ...entry, issue: 0 }])), /issue must be the number/)
  assert.throws(() => readAllowlistFile(file([{ ...entry, expires_at: '0.6.1' }])), /minor release version/)
  assert.throws(() => readAllowlistFile(file([{ ...entry, expires_at: 'latest' }])), /no "no expiry" value/)
  assert.throws(() => readAllowlistFile(file([entry, entry])), /appears more than once in approved_unused/)
  assert.throws(() => readAllowlistFile(write('shape.json', JSON.stringify({ allowed_actions: ['actions/checkout'], approved_unused: 'actions/cache' }))), /must be an array/)
})

test('an exemption lapses at its release version and cannot outrun two minors', () => {
  const entries = (expires_at: string) => [{ name: 'actions/cache', issue: 1206, expires_at }]

  // One minor ahead is the designed case, and two is the far edge.
  assert.deepEqual(approvedUnusedExpiryProblems(entries('0.6.0'), '0.5.0'), [])
  assert.deepEqual(approvedUnusedExpiryProblems(entries('0.7.0'), '0.5.0'), [])
  // A third outlives the review that justified it.
  assert.match(approvedUnusedExpiryProblems(entries('0.8.0'), '0.5.0').join('\n'), /more than two minors beyond this tree's 0\.5\.0/)

  // Equality fails deliberately: the release pull request that reaches `expires_at`
  // is exactly where a person has to delete or renew the entry.
  const lapsed = approvedUnusedExpiryProblems(entries('0.6.0'), '0.6.0')
  assert.equal(lapsed.length, 1)
  assert.match(String(lapsed[0]), /actions\/cache/)
  assert.match(String(lapsed[0]), /#1206/)
  assert.match(String(lapsed[0]), /0\.6\.0/)
  assert.match(String(lapsed[0]), /Delete the entry, or renew it with a new expires_at and a comment on #1206/)

  // A patch version is not a minor release version, and there is no "no expiry".
  assert.match(approvedUnusedExpiryProblems(entries('0.6.1'), '0.5.0').join('\n'), /not a minor release version/)

  // The shipped tree carries no exemption, so nothing lapses at its own version.
  const treeVersion = JSON.parse(readFileSync('package.json', 'utf8')).version as string
  assert.deepEqual(approvedUnusedExpiryProblems(readAllowlistFile().approved_unused, treeVersion), [])
})

test('a malformed allowlist refuses to load instead of allowing everything', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'action-allow-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const write = (name: string, body: string): string => {
    const path = join(dir, name)
    writeFileSync(path, body)
    return path
  }

  assert.deepEqual(readAllowlist(write('ok.json', JSON.stringify({ allowed_actions: ['actions/checkout'] }))), ['actions/checkout'])
  // A wildcard is the hole this list exists to close, so it is not "any action".
  assert.throws(() => readAllowlist(write('wildcard.json', JSON.stringify({ allowed_actions: ['actions/*'] }))), /wildcards are not allowed/)
  assert.throws(() => readAllowlist(write('empty.json', JSON.stringify({ allowed_actions: [] }))), /non-empty array/)
  assert.throws(() => readAllowlist(write('dupe.json', JSON.stringify({ allowed_actions: ['actions/checkout', 'actions/checkout'] }))), /appears more than once/)
  assert.throws(() => readAllowlist(write('missing.json', '')), /must be a JSON file/)
})

test('the shipped allowlist file is where the checker looks by default', () => {
  assert.match(ALLOWLIST_FILE, /^\.github\/agent\/[a-z-]+\.json$/)
  assert.ok(readAllowlist().includes('actions/checkout'), 'the default path must resolve to the reviewed list in this tree')
})
