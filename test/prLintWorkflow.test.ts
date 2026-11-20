import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// #753: `pr-lint` lived at the end of `.github/workflows/review-gate.yml`, and that
// workflow's trigger block is a bare `pull_request:` — GitHub's default activity
// types are `opened`, `synchronize` and `reopened`, so a pull request whose body was
// the only thing wrong never got a second lint run. The fix is a workflow that owns
// `pr-lint` and reads `edited`, and a review gate that no longer owns it.
//
// These cases read the workflow files as text, because a workflow file is what a
// maintainer edits: a trigger block moved into a job, a second workflow that also
// answers a body edit, or a gate that still publishes the check under the old file
// must fail here instead of passing quietly.

const WORKFLOWS = fileURLToPath(new URL('../.github/workflows/', import.meta.url))
const read = (name: string, why: string): string => {
  const path = `${WORKFLOWS}${name}`
  assert.ok(existsSync(path), `${name} must exist: ${why}`)
  return readFileSync(path, 'utf8')
}

interface Trigger {
  event: string
  types: string[] | null
}

// The `on:` block, read by indentation: `on:` at column 0, an event at two spaces,
// its keys (`types:`) at four. Only what these workflows use is parsed; anything
// unusual throws rather than being guessed, so a block this test cannot read fails
// instead of matching nothing.
function triggers(text: string, file: string): Map<string, Trigger> {
  const lines = text.split('\n')
  const start = lines.indexOf('on:')
  assert.notEqual(start, -1, `${file} must carry a top-level on: block`)
  const events = new Map<string, Trigger>()
  let current: Trigger | null = null
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !/^\s/.test(line)) break
    const event = /^  ([A-Za-z_]+):(.*)$/.exec(line)
    if (event !== null) {
      current = { event: event[1]!, types: null }
      events.set(current.event, current)
      const inline = event[2]?.trim() ?? ''
      assert.equal(inline, '', `${file}: ${current.event} must not use an inline block`)
      continue
    }
    const types = /^    types:\s*\[(.*)\]$/.exec(line)
    if (types !== null) {
      assert.ok(current !== null, `${file}: types: outside an event`)
      current.types = (types[1] ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value !== '')
      continue
    }
    // `push:` carries `branches:` and `schedule:` its `cron:`; those events are
    // not what this test reads, so an unread key under them is ignored rather
    // than guessed at.
    assert.doesNotMatch(line, /^    types:/, `${file}: an unreadable types: line: ${line.trim()}`)
  }
  return events
}

// Every job in the file, as `name:` and the text of the job, so a check can talk
// about the required context's name instead of a job id.
function jobs(text: string): { id: string; name: string; body: string }[] {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line === 'jobs:')
  assert.notEqual(start, -1, 'the workflow must carry a top-level jobs: block')
  const found: { id: string; name: string; body: string }[] = []
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
    const name = /^    name:\s*(.+?)\s*$/.exec(line)
    if (name !== null) open.name = name[1]!
  }
  if (open !== null) found.push({ id: open.id, name: open.name, body: open.lines.join('\n') })
  return found
}

test('an edited pull request body re-runs pr-lint, and nothing else', () => {
  const file = 'pr-lint.yml'
  const text = read(file, 'a body edit needs a workflow that answers `edited`')
  const events = triggers(text, file)
  const pullRequest = events.get('pull_request')
  assert.ok(pullRequest, `${file} must answer pull_request`)
  assert.deepEqual(
    pullRequest.types,
    ['opened', 'synchronize', 'reopened', 'ready_for_review', 'edited'],
    'an edited body is the whole point: the types list must name it beside the default ones',
  )
  // A body edit must not start the full suite or the review gate either; the new
  // file answers exactly one event, so a future `push:` here is a red test.
  assert.deepEqual([...events.keys()], ['pull_request'], `${file} must answer pull_request and no other event`)

  const defined = jobs(text)
  assert.equal(defined.length, 1, `${file} must own exactly one job`)
  const job = defined[0]!
  assert.equal(job.name, 'pr-lint', 'the check name is a required context on main and must not change')
  assert.match(job.body, /scripts\/pr-lint\.mjs/, 'the job must run the lint script')
  const permissions = /^    permissions:\n((?:      [A-Za-z-]+:.*\n?)+)/m.exec(job.body)?.[1] ?? ''
  assert.ok(permissions !== '', 'the job must state its own permissions instead of inheriting them')
  assert.doesNotMatch(permissions, /write/, `pr-lint reads the body and the diff; it needs no write scope:\n${permissions}`)
  assert.match(job.body, /ref: \$\{\{ github\.event\.pull_request\.base\.sha/, 'the lint must read the base, never the head it judges')
})

test('the review gate no longer publishes pr-lint', () => {
  const file = 'review-gate.yml'
  const text = read(file, 'the review gate is the file this change edits')
  const names = jobs(text).map((job) => job.name)
  assert.ok(!names.includes('pr-lint'), 'review-gate.yml still defines the pr-lint job')
  assert.doesNotMatch(text, /scripts\/pr-lint\.mjs/, 'review-gate.yml still runs the lint script')
})

test('no other workflow answers an edited body, so a body edit cannot restart ci-ok or the gate', () => {
  const offenders: string[] = []
  for (const file of readdirSync(WORKFLOWS)) {
    if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue
    const events = triggers(read(file, 'every workflow is in scope for the edited-body check'), file)
    for (const [event, trigger] of events) {
      if (event !== 'pull_request' && event !== 'pull_request_target') continue
      if (trigger.types !== null && trigger.types.includes('edited')) offenders.push(`${file}:${event}`)
    }
  }
  assert.deepEqual(offenders, ['pr-lint.yml:pull_request'], 'only pr-lint may listen for an edited body')
})

test('the review gate keeps its own triggers', () => {
  const events = triggers(read('review-gate.yml', 'the review gate must keep its own triggers'), 'review-gate.yml')
  // #1169 added `workflow_run` on `pr-lint`: a lint that settles after the gate
  // has finished is the one verdict path no person-triggered event covered, and
  // the retrigger job is the path that event belongs to. The gate's own job still
  // refuses it (see test/retrigger.test.ts), so the list grows by that one event
  // and no other.
  assert.deepEqual([...events.keys()], ['pull_request', 'pull_request_review', 'merge_group', 'issue_comment', 'workflow_run'])
  assert.equal(events.get('pull_request')?.types, null, 'a body edit must not start the gate, so pull_request stays typeless')
  assert.deepEqual(events.get('pull_request_review')?.types, ['submitted'])
  assert.deepEqual(events.get('issue_comment')?.types, ['created'])
  assert.deepEqual(events.get('workflow_run')?.types, ['completed'])
})
