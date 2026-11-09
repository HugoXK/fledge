import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { buildState, latestConclusion } from '../scripts/lib/release-state.mjs'

// The daily release used to assemble its state in one `jq` expression inside the
// workflow, and `gh api --paginate ... --slurp | jq -s 'add'` produced an array of
// page arrays: selecting `.title` aborted the step before the planner ran, and no
// test could see it because the suite grepped YAML. These cases execute the code
// that now does the assembly, with the payload shape the workflow actually writes.

const execFileAsync = promisify(execFile)
const scriptPath = fileURLToPath(new URL('../scripts/release-state.mjs', import.meta.url))
const workflow = await import('node:fs').then(({ readFileSync }) =>
  readFileSync(new URL('../.github/workflows/daily-release.yml', import.meta.url), 'utf8'),
)

const PAGE_ONE = [
  { number: 11, title: 'feat: one', merged_at: '2026-11-01T10:00:00Z' },
  { number: 12, title: 'feat: two', merged_at: '2026-11-02T10:00:00Z' },
]
const PAGE_TWO = [{ number: 13, title: 'release: v0.3.0', merged_at: '2026-11-03T10:00:00Z' }]

function writeJson(dir: string, name: string, value: unknown): string {
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify(value))
  return path
}

async function runState(args: string[]): Promise<string> {
  const result = await execFileAsync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' })
  return result.stdout
}

test('the slurped page shape is flattened, so the open release PR is found', async () => {
  // `jq -s .` over two gh pages gives [[...],[...]]; `--slurp` gives the same.
  const dir = mkdtempSync(join(tmpdir(), 'fledge-state-'))
  try {
    const prs = writeJson(dir, 'prs.json', [PAGE_ONE, PAGE_TWO])
    const open = writeJson(dir, 'open.json', [[{ number: 20, title: 'feat: not a release' }], [{ number: 21, title: 'release: v0.3.0', head: { ref: 'release/v0.3.0' } }]])
    const checks = writeJson(dir, 'checks.json', { total_count: 1, check_runs: [{ id: 1, name: 'ci-ok', conclusion: 'success' }] })
    const out = await runState(['--prs', prs, '--open', open, '--checks', checks, '--tags-json', '["v0.2.4"]'])
    const state = JSON.parse(out) as { openPr: { number: number } | null; lastMerged: { number: number } | null; mergedPrs: unknown[] }
    assert.equal(state.openPr?.number, 21, 'the open release PR must be found across pages')
    assert.equal(state.mergedPrs.length, 3, 'every merged PR from every page counts')
    assert.equal(state.lastMerged?.number, 13, 'the last merged PR is the newest by merged_at')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a title that starts with "release: v" is not the release PR without the release branch', () => {
  // #146 finding 5: a docs-only `release: v9.9.9` on a feature branch must never
  // be picked up as the release PR, because the drive would enqueue it.
  const state = buildState({
    lastTag: 'v0.2.4',
    packageVersion: '0.2.4',
    fragments: 1,
    tags: ['v0.2.4'],
    closedPages: [[]],
    openPages: [[{ number: 41, title: 'release: v9.9.9', head: { ref: 'dev2/docs-only' } }]],
    checks: [],
  })
  assert.equal(state.openPr, null, 'a self-declared release title is not the release PR')
  assert.equal(state.openPrRejected?.number, 41, 'the rejected candidate is recorded rather than silently dropped')
  assert.match(String(state.openPrRejected?.branch ?? ''), /dev2\/docs-only/)
})

test('a single flat page is accepted as well', () => {
  const state = buildState({
    lastTag: 'v0.2.4',
    packageVersion: '0.2.4',
    fragments: '2',
    tags: ['v0.2.4'],
    dryRun: 'true',
    closedPages: PAGE_ONE,
    openPages: [],
    checks: [{ id: 5, name: 'ci-ok', conclusion: 'success' }],
  })
  assert.equal(state.mergedPrs.length, 2)
  assert.equal(state.openPr, null)
  assert.equal(state.ciOk, 'success')
  assert.equal(state.dryRun, true)
  assert.equal(state.fragments, 2)
})

test('the newest ci-ok run wins, not the first in the list', () => {
  // The API lists the oldest run first; after a re-run `first` would read a stale
  // conclusion and could refuse a night that should have released.
  const checks = {
    total_count: 2,
    check_runs: [
      { id: 100, name: 'ci-ok', conclusion: 'failure' },
      { id: 200, name: 'ci-ok', conclusion: 'success' },
    ],
  }
  assert.equal(latestConclusion(checks, 'ci-ok'), 'success')
  assert.equal(latestConclusion({ check_runs: [] }, 'ci-ok'), 'missing')
})

test('a merged pull request without merged_at is not counted', () => {
  const state = buildState({
    closedPages: [[{ number: 1, title: 'feat: closed unmerged', merged_at: null }, ...PAGE_ONE]],
    openPages: [],
    checks: [],
  })
  assert.deepEqual(state.mergedPrs.map((pr) => pr.number), [11, 12])
  assert.equal(state.ciOk, 'missing')
})

test('the workflow runs the tested module instead of an inline jq pipeline', () => {
  assert.match(workflow, /node scripts\/release-state\.mjs/)
  assert.doesNotMatch(workflow, /gh api[^\n]*--slurp/)
  assert.doesNotMatch(workflow, /jq -s 'add/)
})
