import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { checkActorGates, scanActorGates } from '../scripts/lib/action-pins.mjs'
import { TRIGGERING_CONCLUSIONS, execRetrigger, refusalFor } from '../scripts/retrigger.mjs'

// #1169: the gate is decided only by events a person or a verdict produces, so a
// `pr-lint` run that settles *after* the gate has finished can never bring it
// back. These tests pin the trigger that closes that gap and the three guards
// that keep it from becoming a write path a stranger can drive:
//
//   - the job is skipped for a run that is not this repository's, before it can
//     use `actions: write` (the guard is in the job's `if:`, not in the script);
//   - a `cancelled` completion resolves nothing: the run that replaced it owns
//     the answer, and a superseded lint must not start a repair;
//   - one repair per head at a time, and no check published under a reserved
//     context by a job that merely exists.
//
// The repair itself stays in `scripts/gate-repair.mjs` and its plan in
// `test/reviewGate.test.ts`: this file owns the trigger, never a second
// implementation of the repair.

const read = (path: string): string => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')
const workflow = read('.github/workflows/review-gate.yml')

function jobBlock(text: string, id: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line === `  ${id}:`)
  assert.notEqual(start, -1, `the workflow has no ${id} job`)
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}[a-z][a-z0-9-]*:$/.test(lines[index]!)) {
      end = index
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

function ifLineOf(block: string): string {
  const line = block.split('\n').find((entry) => /^\s+if:/.test(entry))
  assert.ok(line !== undefined, 'the job must carry an if: guard')
  return line
}

function declaredNames(text: string): string[] {
  return [...text.matchAll(/^ {4}name: (.+)$/gm)].map((match) => match[1]!.trim())
}

const RETRIGGER = 'review-gate-retrigger'
const HEAD_REPOSITORY_GUARD = 'github.event.workflow_run.head_repository.full_name == github.repository'
const PULL_REQUEST_RUN = `github.event.workflow_run.event == 'pull_request'`

function runPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: 'pull_request',
    conclusion: 'success',
    head_sha: 'a'.repeat(40),
    head_repository: { full_name: 'HugoXK/fledge' },
    ...overrides,
  }
}

// One recorded call per API read: the count is the evidence that a refused
// completion touched nothing, so a test that only checks the returned number
// cannot see a stray request.
function recordingApi(pulls: unknown, record: string[]): (path: string) => Promise<unknown> {
  return async (path: string) => {
    record.push(path)
    if (pulls instanceof Error) throw pulls
    return pulls
  }
}

test('the gate is woken by a lint completion', () => {
  const onBlock = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\njobs:'))
  assert.match(onBlock, /^ {2}workflow_run:$/m, 'the gate must be woken by a finished run')
  const trigger = onBlock.slice(onBlock.indexOf('  workflow_run:'))
  assert.match(trigger, /workflows: \[pr-lint\]/, 'the finished run it waits for is the lint')
  assert.match(trigger, /types: \[completed\]/, 'a wake-up is for a finished run, never a queued or started one')
})

test('the retrigger job is skipped, not merely refused, for a run from another repository', () => {
  const block = jobBlock(workflow, RETRIGGER)
  const condition = ifLineOf(block)
  // The fork test is the whole payload class: a `workflow_run` fires for a fork's
  // pull request too, and a job that reached `actions: write` would POST a re-run
  // against this repository on someone else's branch.
  assert.ok(condition.includes(HEAD_REPOSITORY_GUARD), 'the job must name the head repository')
  assert.ok(condition.includes(PULL_REQUEST_RUN), 'the job must name the event that produced the run')
  assert.match(condition, /github\.event_name == 'workflow_run'/, 'the event test comes first, so no other event reaches the rest')
  assert.ok(
    condition.indexOf(`github.event_name == 'workflow_run'`) < condition.indexOf(HEAD_REPOSITORY_GUARD),
    'the head repository is tested only for a workflow_run event',
  )
  assert.match(block, /actions: write/, 'the job is privileged, which is why the guard matters')
  const findings = checkActorGates(workflow, 'review-gate.yml')
  assert.deepEqual(findings.map((finding) => `${finding.job} ${finding.problem}`), [], 'the scan over the real file is clean')
})

test('a cancelled lint retriggers nothing and reads nothing', async () => {
  assert.ok(!TRIGGERING_CONCLUSIONS.includes('cancelled'), 'a cancelled run must never be a trigger')
  const record: string[] = []
  const result = await execRetrigger({
    eventName: 'workflow_run',
    event: { workflow_run: runPayload({ conclusion: 'cancelled' }) },
    repository: 'HugoXK/fledge',
    api: recordingApi([{ number: 7, state: 'open', head: { sha: 'a'.repeat(40) } }], record),
  })
  assert.equal(result.number, null, 'a superseded lint resolves no pull request')
  assert.deepEqual(record, [], 'a cancelled completion must reach no API call at all')
  assert.notEqual(refusalFor({ eventName: 'workflow_run', event: { workflow_run: runPayload({ conclusion: 'cancelled' }) }, repository: 'HugoXK/fledge' }), null)
})

test('a run from another repository or another event resolves nothing', async () => {
  const fork: string[] = []
  const forked = await execRetrigger({
    eventName: 'workflow_run',
    event: { workflow_run: runPayload({ head_repository: { full_name: 'someone/fork' } }) },
    repository: 'HugoXK/fledge',
    api: recordingApi([], fork),
  })
  assert.equal(forked.number, null)
  assert.deepEqual(fork, [], "a fork's completion performs no read, let alone a write")

  const push: string[] = []
  const pushed = await execRetrigger({
    eventName: 'workflow_run',
    event: { workflow_run: runPayload({ event: 'push' }) },
    repository: 'HugoXK/fledge',
    api: recordingApi([], push),
  })
  assert.equal(pushed.number, null)
  assert.deepEqual(push, [])

  const other: string[] = []
  const otherEvent = await execRetrigger({
    eventName: 'pull_request',
    event: {},
    repository: 'HugoXK/fledge',
    api: recordingApi([], other),
  })
  assert.equal(otherEvent.number, null)
  assert.deepEqual(other, [], 'the entrypoint only acts on the event it was added for')
})

test('a settled lint resolves the open pull request at its head, in one read', async () => {
  const head = 'b'.repeat(40)
  const record: string[] = []
  const result = await execRetrigger({
    eventName: 'workflow_run',
    event: { workflow_run: runPayload({ head_sha: head }) },
    repository: 'HugoXK/fledge',
    api: recordingApi([
      { number: 7, state: 'open', head: { sha: head } },
      { number: 8, state: 'closed', head: { sha: head } },
      { number: 9, state: 'open', head: { sha: 'c'.repeat(40) } },
    ], record),
  })
  assert.equal(result.number, 7, 'the lookup is by head sha, never by the payload pull_requests array')
  assert.deepEqual(record, [`/repos/HugoXK/fledge/commits/${head}/pulls`])
})

test('a head with no open pull request resolves nothing, and an ambiguous head fails closed', async () => {
  const head = 'd'.repeat(40)
  const none: string[] = []
  const closed = await execRetrigger({
    eventName: 'workflow_run',
    event: { workflow_run: runPayload({ head_sha: head }) },
    repository: 'HugoXK/fledge',
    api: recordingApi([{ number: 7, state: 'closed', head: { sha: head } }], none),
  })
  assert.equal(closed.number, null, 'a merged or closed pull request needs no repair')
  assert.equal(none.length, 1)

  await assert.rejects(
    execRetrigger({
      eventName: 'workflow_run',
      event: { workflow_run: runPayload({ head_sha: head }) },
      repository: 'HugoXK/fledge',
      api: recordingApi([
        { number: 7, state: 'open', head: { sha: head } },
        { number: 8, state: 'open', head: { sha: head } },
      ], []),
    }),
    /2 open pull requests/,
    'two candidates is a shape the trigger must name, not guess',
  )
})

test('one repair per head at a time, and the same group for a re-settling lint', () => {
  const block = jobBlock(workflow, RETRIGGER)
  const group = /concurrency:\n\s+group: (.+)\n/.exec(block)
  assert.ok(group !== null, 'the job must serialise itself per head')
  assert.match(group[1]!, /github\.event\.workflow_run\.head_sha/, 'the group is the head, so two completions cannot race one repair')
  assert.match(block, /cancel-in-progress: false/, 'a later completion must wait, never cancel the repair in flight')
})

test('the retrigger publishes no required context and hands the head to the repair', () => {
  assert.equal(declaredNames(workflow).filter((name) => name === 'review-gate').length, 1, 'exactly one job publishes review-gate')
  const names = declaredNames(workflow)
  assert.ok(names.includes(RETRIGGER), 'the new job carries its own name')
  assert.ok(!names.includes('pr-lint'), 'the retrigger must not publish the lint context')
  const block = jobBlock(workflow, RETRIGGER)
  assert.match(block, /node scripts\/gate-repair\.mjs --pr "\$PULL_REQUEST"/, 'the repair is the one implementation, invoked, never copied')
  assert.match(block, /--sha "\$HEAD_SHA"/, 'the verdict is judged at the finished run head')
  // The head sha comes from a payload, so it reaches the script through the
  // environment: interpolating it into the shell text is the injection shape
  // `test/supplyChain.test.ts` refuses.
  assert.match(block, /HEAD_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/, 'the head sha is passed as an env value')
  assert.doesNotMatch(block, /--sha "\$\{\{/, 'no payload value is written into the shell text')
  const scan = scanActorGates('.github/workflows')
  assert.deepEqual(scan.findings.map((finding) => `${finding.file} ${finding.job} ${finding.problem}`), [])
})

test('the gate job does not run on the retrigger event, so no review-gate check lands on main', () => {
  const gate = ifLineOf(jobBlock(workflow, 'review-gate'))
  assert.match(gate, /github\.event_name != 'issue_comment'/)
  assert.match(gate, /github\.event_name != 'workflow_run'/, 'a workflow_run event has the default branch as its sha')
})
