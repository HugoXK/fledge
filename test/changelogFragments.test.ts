import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { countFragments, fragmentNames } from '../scripts/lib/changelog-fragments.mjs'
import { planRelease } from '../scripts/release-plan.mjs'

// #548: the release job counted fragments with
//
//   ls changelog.d/*.md 2>/dev/null | grep -v '/README.md$' | wc -l
//
// under `set -euo pipefail`. A release folds every fragment into CHANGELOG.md and
// leaves `changelog.d/README.md` alone, so `grep -v` matched nothing, exited 1,
// `pipefail` failed the `Collect the state` step and the next step died on the
// missing state file. Zero fragments is a legitimate input to the planner — its
// own first reason then decides the night — so the count answers 0 for both empty
// shapes. A directory that cannot be read is *not* zero: it must fail, or a
// release would silently stop firing.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'fledge-fragments-'))
}

function withFragment(dir: string, name: string): void {
  writeFileSync(join(dir, name), 'One paragraph.\n')
}

function runCount(dir: string) {
  return spawnSync(process.execPath, ['scripts/fragment-count.mjs', '--dir', dir], { encoding: 'utf8' })
}

test('a directory holding only README.md counts zero and does not fail', () => {
  const dir = scratch()
  try {
    withFragment(dir, 'README.md')
    assert.equal(countFragments(dir), 0, 'the post-release shape is zero fragments, not an error')
    assert.deepEqual(fragmentNames(dir), [], 'README.md is not a fragment')
    const run = runCount(dir)
    assert.equal(run.status, 0, 'the count exits 0 on the post-release shape')
    assert.equal(run.stdout.trim(), '0', 'and prints the number the planner reads')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a directory with no markdown at all counts zero', () => {
  const dir = scratch()
  try {
    assert.equal(countFragments(dir), 0, 'an empty changelog.d is zero fragments')
    const run = runCount(dir)
    assert.equal(run.status, 0, 'the count exits 0 on an empty directory')
    assert.equal(run.stdout.trim(), '0')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a directory that cannot be read fails instead of counting zero', () => {
  const dir = join(scratch(), 'absent')
  assert.throws(() => countFragments(dir), /ENOENT/, 'an unreadable directory is not "zero fragments"')
  const run = runCount(dir)
  assert.notEqual(run.status, 0, 'the count must exit non-zero when it could not measure')
  assert.match(run.stderr, /cannot read/, 'and it says which directory it could not read')
  assert.equal(run.stdout.trim(), '', 'nothing that reads as a count reaches the planner')
})

test('fragments are counted, README.md is not, and the order is stable', () => {
  const dir = scratch()
  try {
    withFragment(dir, 'README.md')
    withFragment(dir, '390-work-types.added.md')
    withFragment(dir, '548-post-release.fixed.md')
    withFragment(dir, '551-quote.changed.md')
    assert.equal(countFragments(dir), 3, 'the real count is unchanged by the fix')
    assert.deepEqual(fragmentNames(dir), ['390-work-types.added.md', '548-post-release.fixed.md', '551-quote.changed.md'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a post-release night is refused by the planner\'s own first reason, in order', () => {
  const merged = (number: number, title: string) => ({ number, title, labels: [], mergedAt: '2026-11-07T00:00:00Z' })
  const base = {
    lastTag: 'v0.2.4',
    packageVersion: '0.2.4',
    fragments: 0,
    openReleasePr: false,
    existingTags: ['v0.2.4'],
    crossCheck: { logPrNumbers: [] },
  }
  const nine = Array.from({ length: 9 }, (_, index) => merged(index + 1, 'fix: thing'))
  const tenWithFourFeatures = [
    merged(1, 'feat: one'),
    merged(2, 'feat: two'),
    merged(3, 'feat: three'),
    merged(4, 'feat: four'),
    ...Array.from({ length: 6 }, (_, index) => merged(index + 5, 'fix: thing')),
  ]
  const tenWithFiveFeatures = [...tenWithFourFeatures, merged(11, 'feat: five')]

  assert.equal(planRelease({ ...base, prs: nine }).reason, 'not-enough-prs', 'nine merged pull requests is the first reason')
  assert.equal(planRelease({ ...base, prs: tenWithFourFeatures }).reason, 'not-enough-features', 'ten with four features is the next one')
  assert.equal(planRelease({ ...base, prs: tenWithFiveFeatures }).reason, 'no-fragments', 'and only then does the empty fragment directory decide it')
  assert.equal(planRelease({ ...base, prs: nine }).shouldRelease, false, 'a zero count never releases through a short night')
})

test('the release workflow counts with the helper and never dereferences a state file it did not write', () => {
  const workflow = readFileSync('.github/workflows/daily-release.yml', 'utf8')
  assert.doesNotMatch(workflow, /^(?!\s*#).*ls changelog\.d\/\*\.md/m, 'the pipeline that exits 1 on no match is gone')
  assert.doesNotMatch(workflow, /^(?!\s*#).*grep -v/m, 'and so is the matched-nothing exit that failed the step')
  assert.match(workflow, /FRAGMENTS="\$\(node scripts\/fragment-count\.mjs\)"/, 'the count comes from the tested helper')
  assert.doesNotMatch(workflow, /\/tmp\//, 'temporary files live in the runner directory, not a fixed /tmp path')
  assert.match(
    workflow,
    /- name: Trigger\n(?:.*\n)*?\s+if: \$\{\{ steps\.state\.outcome == 'success' \}\}/,
    'the trigger step runs only when the collect step succeeded, never on a stale or defaulted file',
  )
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/, 'a failure is never downgraded to a warning')
})
