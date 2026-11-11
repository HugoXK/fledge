import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decision, MAIN_REF, RED_LABEL, RED_TITLE } from '../scripts/lib/main-health.mjs'

// #305: a red `main` was invisible. `ci-ok` computed the commit's health and
// stopped; nothing opened a card, commented or notified anyone, and on
// 2026-11-11 the default branch was red for 83 minutes with nothing in the
// repository saying so. The reporter's whole decision lives in
// `scripts/lib/main-health.mjs` as a pure function so it can be driven from
// fixtures here; the workflow only gathers the input and applies the action.
//
// The eight behavioural cases are the ones the issue lists. The shape assertions
// at the end are not decoration: a behavioural suite alone would still pass for
// a workflow that hands `issues: write` to every job, so the least-privilege and
// pinning claims are pinned as text too.

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

function read(relative: string): string {
  return readFileSync(join(repoRoot, relative), 'utf8')
}

function jobBlock(workflow: string, job: string): string {
  const lines = workflow.split('\n')
  const start = lines.findIndex((line) => line === `  ${job}:`)
  assert.ok(start !== -1, `job ${job} must exist in the workflow`)
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (/^  [a-z][a-z0-9-]*:$/.test(line) || /^\S/.test(line)) {
      end = index
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

const SHA = 'a'.repeat(40)
const RUN_URL = 'https://github.com/HugoXK/fledge/actions/runs/1'
const CLEARING_SHA = 'b'.repeat(40)

function input(overrides: Record<string, unknown> = {}) {
  return {
    conclusion: 'failure',
    eventName: 'push',
    ref: MAIN_REF,
    sha: SHA,
    failingJobs: ['test (24)'],
    runUrl: RUN_URL,
    openTrackers: [],
    ...overrides,
  }
}

const tracker = { number: 41, title: 'renamed by a human', createdAt: '2026-11-11T09:00:00Z' }

test('red on main with no open tracker opens one', () => {
  const result = decision(input())
  assert.equal(result.action, 'create')
  assert.equal(result.issue?.labels[0], RED_LABEL)
  assert.equal(result.issue?.title, RED_TITLE)
  const body = String(result.issue?.body ?? '')
  assert.ok(body.includes(SHA), 'the body names the head sha')
  assert.ok(body.includes('test (24)'), 'the body names the failing job')
  assert.ok(body.includes(RUN_URL), 'the body names the run')
})

test('red with an open tracker comments on it and does not open a second issue', () => {
  const result = decision(input({ openTrackers: [tracker] }))
  assert.equal(result.action, 'comment')
  assert.equal(result.tracker?.number, tracker.number)
  assert.equal(result.issue, undefined)
  assert.ok(String(result.body ?? '').includes(SHA))
})

test('a second red run in the same red state still comments, never creates', () => {
  const first = decision(input({ openTrackers: [tracker] }))
  const second = decision(input({ openTrackers: [tracker], sha: 'c'.repeat(40) }))
  assert.equal(first.action, 'comment')
  assert.equal(second.action, 'comment')
  assert.equal(second.tracker?.number, tracker.number)
  assert.equal(second.issue, undefined)
})

test('a green main closes the tracker with the clearing sha and the run', () => {
  const result = decision(input({ conclusion: 'success', sha: CLEARING_SHA, failingJobs: [], openTrackers: [tracker] }))
  assert.equal(result.action, 'close')
  assert.equal(result.tracker?.number, tracker.number)
  const body = String(result.body ?? '')
  assert.ok(body.includes(CLEARING_SHA), 'the close names the sha that returned main to green')
  assert.ok(body.includes(RUN_URL), 'the close names the run that cleared it')
})

test('a green main with no tracker does nothing', () => {
  assert.equal(decision(input({ conclusion: 'success', failingJobs: [], openTrackers: [] })).action, 'none')
})

test('a red branch that is not main does nothing', () => {
  for (const ref of ['refs/heads/dev1/305-main-health', 'refs/heads/gh-readonly-queue/main/pr-1-abc']) {
    const result = decision(input({ ref }))
    assert.equal(result.action, 'none', `${ref} must not open an issue`)
  }
})

test('a red pull request merge ref does nothing', () => {
  assert.equal(decision(input({ ref: 'refs/pull/123/merge', eventName: 'pull_request' })).action, 'none')
})

test('the nightly run on main is the same event as a push', () => {
  const result = decision(input({ eventName: 'schedule' }))
  assert.equal(result.action, 'create')
})

test('the newest tracker is the one commented on and closed', () => {
  const older = { number: 7, createdAt: '2026-11-11T08:00:00Z' }
  const newest = { number: 9, createdAt: '2026-11-11T09:00:00Z' }
  assert.equal(decision(input({ openTrackers: [older, newest] })).tracker?.number, newest.number)
  assert.equal(decision(input({ conclusion: 'success', openTrackers: [older, newest] })).tracker?.number, newest.number)
})

// --- The workflow half -----------------------------------------------------

const ci = read('.github/workflows/ci.yml')

test('only the reporter job holds issues: write', () => {
  const jobsSection = ci.slice(ci.indexOf('\njobs:\n'))
  const jobs = [...jobsSection.matchAll(/^  ([a-z][a-z0-9-]*):$/gm)].map((match) => match[1]!)
  const writers = jobs.filter((job) => /issues: write/.test(jobBlock(ci, job)))
  assert.deepEqual(writers, ['main-health'], `exactly one job may write issues, found ${writers.join(', ') || 'none'}`)
  for (const job of jobs) {
    const block = jobBlock(ci, job)
    assert.match(block, /^ {4}permissions:$/m, `${job} must declare its own permissions block`)
  }
})

test('the reporter is gated to main, depends on ci-ok and is not itself required', () => {
  const block = jobBlock(ci, 'main-health')
  assert.match(block, /^ {4}if: .*refs\/heads\/main/m, 'the condition must name the default branch, not a wildcard')
  assert.match(block, /^ {4}needs: .*\bci-ok\b/m, 'the reporter reads the aggregate result')
  assert.doesNotMatch(jobBlock(ci, 'ci-ok'), /^ {4}needs:.*\bmain-health\b/m, 'the reporter must never become a required check: a red reporter would block merges')
})

test('the reporter serialises per red state and searches by label', () => {
  const block = jobBlock(ci, 'main-health')
  assert.match(block, /group: ci-main-red/, 'one concurrency group keeps two pushes from both creating')
  assert.match(block, /cancel-in-progress: false/, 'a second push must not cancel the first reporter mid-create')
  assert.match(block, /node scripts\/main-health\.mjs/)
  const runner = read('scripts/main-health.mjs')
  assert.match(runner, /'--label'[^\n]*RED_LABEL/, 'the search must pass the label constant: a human can edit a title')
  assert.match(runner, /'issue', 'list'/, 'the tracker lookup is a label listing, not a text search')
  assert.doesNotMatch(runner, /'--search'/, 'searching by title would open a duplicate after a rename')
})

test('every action in the reporter is pinned to a full commit sha', () => {
  const block = jobBlock(ci, 'main-health')
  const uses = [...block.matchAll(/uses: (\S+)/g)].map((match) => match[1]!)
  assert.ok(uses.length > 0, 'the reporter must check the repository out')
  for (const value of uses) {
    if (value.startsWith('./') || value.startsWith('docker://')) continue
    assert.match(value, /@[0-9a-f]{40}$/, `${value} must be a full 40-hex pin`)
  }
})
