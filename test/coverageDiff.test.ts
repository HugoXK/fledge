import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addedLinesFromDiff,
  evaluateChangedLines,
  isMeasuredLine,
  parseCoverageReport,
  waiverFromBody,
} from '../scripts/lib/coverage-diff.mjs'
import type { AddedLine } from '../scripts/lib/coverage-diff.mjs'

// The report shape Node's test runner prints, including the nesting it uses for
// directories: `src` at depth 0, `lib` at depth 1, `uncovered.ts` at depth 2. The
// path of a file only exists as the join of those rows, so a parser that reads
// one line in isolation cannot name an uncovered changed line.
const REPORT = `# start of coverage report
# ------------------------------------------------------
# file               | line % | branch % | funcs % | uncovered lines
# ------------------------------------------------------
# src                |        |          |         |
#  lib               |        |          |         |
#   uncovered.ts     |  60.00 |    50.00 |   50.00 | 11-12
#   covered.ts       | 100.00 |   100.00 |  100.00 |
#  app.ts            |  88.53 |    62.85 |   85.92 | 337-339 347
# ------------------------------------------------------
# all files          |  90.59 |    77.11 |   91.63 |
# ------------------------------------------------------
# end of coverage report
`

// A diff that adds an uncovered branch to one file and a covered line to
// another: the two cases the gate has to tell apart.
const DIFF = `diff --git a/src/lib/uncovered.ts b/src/lib/uncovered.ts
index 1111111..2222222 100644
--- a/src/lib/uncovered.ts
+++ b/src/lib/uncovered.ts
@@ -9,0 +10,3 @@ export function f(x: boolean): number {
+  if (x) {
+    return 1
+  }
diff --git a/src/lib/covered.ts b/src/lib/covered.ts
index 3333333..4444444 100644
--- a/src/lib/covered.ts
+++ b/src/lib/covered.ts
@@ -1,2 +1,3 @@
 export const a = 1
+export const b = 2
 export const c = 3
`

const COVERED_DIFF = `diff --git a/src/lib/covered.ts b/src/lib/covered.ts
--- a/src/lib/covered.ts
+++ b/src/lib/covered.ts
@@ -1,2 +1,3 @@
 export const a = 1
+export const b = 2
 export const c = 3
`

const NON_SOURCE_DIFF = `diff --git a/docs/autonomous-dev.md b/docs/autonomous-dev.md
--- a/docs/autonomous-dev.md
+++ b/docs/autonomous-dev.md
@@ -1,0 +2,2 @@
+More prose.
+Another line.
diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -1,0 +2,1 @@
+  # a comment in the workflow
diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -1,0 +2,1 @@
+  "x": "y",
`

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'coverage-diff-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function runGate(diffFile: string, reportFile: string, extra: string[] = [], env: Record<string, string> = {}) {
  const result = spawnSync(
    process.execPath,
    ['scripts/coverage-diff.mjs', '--diff', diffFile, '--report', reportFile, ...extra],
    { encoding: 'utf8', env: { ...process.env, ...env } },
  )
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

function linesIn(added: Record<string, AddedLine[]>, path: string): number[] {
  return (added[path] ?? []).map((entry) => entry.line)
}

test('the diff reader keeps added lines under src and drops the rest', () => {
  const added = addedLinesFromDiff(DIFF)
  assert.deepEqual(linesIn(added, 'src/lib/uncovered.ts'), [10, 11, 12])
  // The text travels with the line number: whether the line is code is a
  // question about its content, and the diff body is the only place it exists.
  assert.equal(added['src/lib/uncovered.ts']?.[0]?.text, '  if (x) {')
  assert.deepEqual(linesIn(added, 'src/lib/covered.ts'), [2])
  // A deletion or a context line is not an added line, and `---`/`+++` are
  // headers: a naive `startsWith('+')` counts all three.
  assert.deepEqual(addedLinesFromDiff(NON_SOURCE_DIFF), {})
})

test('the report reader rebuilds nested paths and reads the uncovered ranges', () => {
  const uncovered = parseCoverageReport(REPORT)
  assert.deepEqual(uncovered['src/lib/uncovered.ts'], [11, 12])
  assert.deepEqual(uncovered['src/lib/covered.ts'], [])
  // `337-339 347`: a range and a single line in one cell.
  assert.deepEqual(uncovered['src/app.ts'], [337, 338, 339, 347])
  // A directory row and the `all files` row carry no path of their own.
  assert.equal(Object.hasOwn(uncovered, 'src'), false)
  assert.equal(Object.hasOwn(uncovered, 'all files'), false)
})

test('only code lines are measured: comments, imports, types and punctuation are not', () => {
  assert.equal(isMeasuredLine('  const x = 1'), true)
  assert.equal(isMeasuredLine('  return compute(x)'), true)
  // The three kinds the issue names as unmeasurable.
  assert.equal(isMeasuredLine(''), false)
  assert.equal(isMeasuredLine('  // a comment'), false)
  assert.equal(isMeasuredLine('  /* a block comment */'), false)
  assert.equal(isMeasuredLine('  import { readFileSync } from "node:fs"'), false)
  assert.equal(isMeasuredLine('  interface Shape {'), false)
  assert.equal(isMeasuredLine('  type Id = string'), false)
  // A line holding only punctuation executes nothing a test can cover.
  assert.equal(isMeasuredLine('  }'), false)
  assert.equal(isMeasuredLine('  ),'), false)
})

// #1302's false positive and #1313's false negative, as line-level cases. The
// classifier must tell a declaration member from a value by the right-hand side
// the line carries, and must measure a one-line namespace body and a dynamic
// import call, which the old keyword list dropped.
test('a declaration member is not measured, while a value and executable keywords are', () => {
  assert.equal(isMeasuredLine('  instancesUsed: boolean'), false, 'an interface member is a declaration')
  assert.equal(isMeasuredLine('  readonly token?: string'), false, 'so is an optional readonly member')
  assert.equal(isMeasuredLine('  items: string[]'), false, 'so is an array type member')
  assert.equal(isMeasuredLine('  onSave: (id: string) => void'), false, 'so is a function-typed member')
  assert.equal(isMeasuredLine("  kind: 'a' | 'b'"), false, 'so is a union of literal types')
  assert.equal(isMeasuredLine('  x: readonly string[]'), false, 'so is a readonly array type')
  assert.equal(isMeasuredLine('  x: A<B<C>>'), false, 'nested generic arguments are a type')
  assert.equal(isMeasuredLine('  x: Map<string, number>'), false, 'generic arguments are a type')
  assert.equal(isMeasuredLine("      key: 'instance',"), true, 'a string value is code, not a type')
  assert.equal(isMeasuredLine('  count: 5,'), true, 'a lone number literal is a value')
  assert.equal(isMeasuredLine('  ok: true,'), true, 'a lone boolean literal is a value')
  assert.equal(isMeasuredLine('  handler: () => save()'), true, 'an arrow value returning a call is code')
  assert.equal(isMeasuredLine('  key: SomeConst,'), false, 'a capitalized value is the residual ADR 0029 records')
  assert.equal(isMeasuredLine('      key: other.value,'), true, 'an identifier value is code')
  assert.equal(isMeasuredLine('namespace Hidden { const value = Math.random() }'), true, 'a one-line namespace body carries code')
  assert.equal(isMeasuredLine('namespace Hidden {'), false, 'a namespace header alone declares')
  assert.equal(isMeasuredLine('namespace Hidden { /* comment */ }'), false, 'a comment-only namespace body declares')
  assert.equal(isMeasuredLine('export namespace Hidden {}'), false, 'an exported empty namespace declares')
  assert.equal(isMeasuredLine('export namespace Hidden { const x = 1 }'), true, 'an exported namespace with statements runs code')
  assert.equal(isMeasuredLine("import('./x.js').then((m) => m.run())"), true, 'a dynamic import call runs code')
  assert.equal(isMeasuredLine('import.meta.url'), true, 'import.meta is a value, not a static import')
  assert.equal(isMeasuredLine('  import { readFileSync } from "node:fs"'), false, 'a static import still does not measure')
})

// The false negative end to end: a diff of code the report lists as uncovered
// must never become the `skip` path, because `skip` exits 0 on a red report.
test('a diff of a one-line namespace body and a dynamic import is measured, not skipped', () => {
  const hidden = `diff --git a/src/lib/hidden.ts b/src/lib/hidden.ts
--- /dev/null
+++ b/src/lib/hidden.ts
@@ -0,0 +1,2 @@
+namespace Hidden { const value = Math.random() }
+import('./x.js').then((m) => m.run())
`
  const report = `# start of coverage report
# ------------------------------------------------------
# file               | line % | branch % | funcs % | uncovered lines
# ------------------------------------------------------
# src                |        |          |         |
#  lib               |        |          |         |
#   hidden.ts        |  50.00 |    50.00 |   50.00 | 1-2
# ------------------------------------------------------
# all files          |  50.00 |    50.00 |   50.00 |
# ------------------------------------------------------
# end of coverage report
`
  const verdict = evaluateChangedLines({ diff: hidden, report, floor: 80 })
  assert.equal(verdict.code, 'BELOW_FLOOR', 'the executable lines must not fall through to the skip path')
  assert.equal(verdict.measured, 2)
  assert.equal(verdict.covered, 0)
  assert.deepEqual(verdict.violations, [
    { path: 'src/lib/hidden.ts', line: 1 },
    { path: 'src/lib/hidden.ts', line: 2 },
  ])
})

// The defect #641 describes: the total stays above 84% because the tree is large
// and well covered, while the branch in the diff has no test at all. The gate
// must fail this diff and pass the one beside it.
test('an added uncovered branch fails the changed-lines gate', () => {
  const verdict = evaluateChangedLines({ diff: DIFF, report: REPORT, floor: 80 })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, 'BELOW_FLOOR')
  // `}` is punctuation, so it is not measured; `if (x) {` is covered by the
  // fixture and `return 1` is the uncovered line the report names.
  assert.equal(verdict.measured, 3)
  assert.equal(verdict.covered, 2)
  assert.deepEqual(verdict.violations, [{ path: 'src/lib/uncovered.ts', line: 11 }])
  assert.equal(verdict.ratio, 66.7)
})

test('a diff that only adds already-covered lines passes', () => {
  const verdict = evaluateChangedLines({ diff: COVERED_DIFF, report: REPORT, floor: 80 })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.code, 'OK')
  assert.equal(verdict.measured, 1)
  assert.equal(verdict.covered, 1)
  assert.deepEqual(verdict.violations, [])
})

// The case my own e2e run found: a new module no test imports is absent from the
// report entirely, and treating silence as "all covered" would pass the one diff
// the gate exists to stop.
test('a changed file the report never lists fails closed', () => {
  const diff = `diff --git a/src/lib/brand-new.ts b/src/lib/brand-new.ts
--- /dev/null
+++ b/src/lib/brand-new.ts
@@ -0,0 +1,3 @@
+export function f(n: number): number {
+  return n + 1
+}
`
  const verdict = evaluateChangedLines({ diff, report: REPORT, floor: 80 })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, 'BELOW_FLOOR')
  assert.deepEqual(verdict.missing, ['src/lib/brand-new.ts'])
  assert.deepEqual(verdict.violations, [
    { path: 'src/lib/brand-new.ts', line: 1 },
    { path: 'src/lib/brand-new.ts', line: 2 },
  ])
})

test('a docs, config or workflow diff is skipped instead of forcing a test', () => {
  const verdict = evaluateChangedLines({ diff: NON_SOURCE_DIFF, report: REPORT, floor: 80 })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.code, 'NO_SOURCE_LINES')
  assert.equal(verdict.measured, 0)
  assert.deepEqual(verdict.violations, [])
})

test('generated files and declarations are outside the measurement', () => {
  const diff = `diff --git a/src/lib/types.d.ts b/src/lib/types.d.ts
--- a/src/lib/types.d.ts
+++ b/src/lib/types.d.ts
@@ -1,0 +2,1 @@
+export declare const x: number
diff --git a/src/lib/generated/api.ts b/src/lib/generated/api.ts
--- a/src/lib/generated/api.ts
+++ b/src/lib/generated/api.ts
@@ -1,0 +2,1 @@
+export const y = 1
`
  const verdict = evaluateChangedLines({ diff, report: REPORT, floor: 80 })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.code, 'NO_SOURCE_LINES')
})

test('the waiver is an explicit line in the pull request body, not any mention of it', () => {
  assert.equal(waiverFromBody('Fixes #641\n\nNo-test: the workflow job is the test\n'), 'No-test: the workflow job is the test')
  assert.equal(waiverFromBody('Fixes #641\n\ncoverage:no-test — generated schema only\n'), 'coverage:no-test — generated schema only')
  // A body that talks about the marker without using it must not waive the gate.
  assert.equal(waiverFromBody('Fixes #641\n\nWe did not write a No-test: line.\n'), null)
  assert.equal(waiverFromBody('No-test:\n'), null)
})

test('the CLI fails on the uncovered diff and passes on the covered one', (t) => {
  const dir = tempDir(t)
  const diffFile = join(dir, 'change.diff')
  const reportFile = join(dir, 'coverage.txt')
  writeFileSync(diffFile, DIFF)
  writeFileSync(reportFile, REPORT)

  const failed = runGate(diffFile, reportFile)
  assert.equal(failed.code, 1)
  assert.match(failed.stderr, /src\/lib\/uncovered\.ts:11/)
  assert.match(failed.stderr, /below the floor/)

  writeFileSync(diffFile, COVERED_DIFF)
  const passed = runGate(diffFile, reportFile)
  assert.equal(passed.code, 0)
  assert.match(passed.stdout, /1\/1 changed lines covered/)
})

test('the CLI reads its waiver from the pull request body it is given', (t) => {
  const dir = tempDir(t)
  const diffFile = join(dir, 'change.diff')
  const reportFile = join(dir, 'coverage.txt')
  writeFileSync(diffFile, DIFF)
  writeFileSync(reportFile, REPORT)

  const waived = runGate(diffFile, reportFile, [], { PR_BODY: 'No-test: the branch is unreachable until #700\n' })
  assert.equal(waived.code, 0)
  assert.match(waived.stdout, /waived/)
  // Without the line, the same inputs fail: the waiver is what decided it.
  assert.equal(runGate(diffFile, reportFile).code, 1)
})

test('the CLI takes the diff from git when it is given a base and a head', (t) => {
  const dir = tempDir(t)
  const reportFile = join(dir, 'coverage.txt')
  writeFileSync(reportFile, REPORT)
  const git = (args: string[]) => {
    const result = spawnSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' },
    })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git(['init', '--quiet'])
  git(['checkout', '-b', 'main'])
  // Nine filler lines put the added branch at 10, and the report lists 11-12.
  const target = join(dir, 'src', 'lib', 'uncovered.ts')
  mkdirSync(join(dir, 'src', 'lib'), { recursive: true })
  writeFileSync(target, `${'// filler\n'.repeat(9)}export function a(): number {\n  return 0\n}\n`)
  git(['add', '.'])
  git(['commit', '--quiet', '-m', 'base'])
  const base = git(['rev-parse', 'HEAD'])
  writeFileSync(target, `${'// filler\n'.repeat(9)}export function a(): number {\n  if (process.env.X) {\n    return 1\n  }\n  return 0\n}\n`)
  git(['add', '.'])
  git(['commit', '--quiet', '-m', 'add an uncovered branch'])
  const head = git(['rev-parse', 'HEAD'])

  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../scripts/coverage-diff.mjs', import.meta.url)), '--base', base, '--head', head, '--report', reportFile],
    { cwd: dir, encoding: 'utf8' },
  )
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /src\/lib\/uncovered\.ts:11 — added line is not covered/)
})

// The review's finding, and the reason the wiring below matters: the coverage
// job checks out `refs/pull/<N>/merge` (its checkout has no `ref:`, so that is
// what the report is measured on), and `git diff base...head.sha` numbers the
// added lines in the *head* tree. The two agree only while nothing moved
// underneath. Here the base gained five lines at the top of the same file, so
// the same added lines are 11-16 in the head tree and 16-21 in the merge tree:
// the head-sha form reports `ok` for a line the report lists as uncovered.
test('a base that gained lines in the same file is measured in the merge tree', (t) => {
  const dir = tempDir(t)
  const reportFile = join(dir, 'coverage.txt')
  // The uncovered line is 18 in the tree the report describes.
  writeFileSync(reportFile, `# start of coverage report
# file               | line % | branch % | funcs % | uncovered lines
# src                |        |          |         |
#  lib               |        |          |         |
#   x.ts             |  90.00 |   100.00 |  100.00 | 18
# end of coverage report
`)
  const git = (args: string[]) => {
    const result = spawnSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' },
    })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git(['init', '--quiet'])
  git(['checkout', '-b', 'main'])
  const target = join(dir, 'src', 'lib', 'x.ts')
  mkdirSync(join(dir, 'src', 'lib'), { recursive: true })
  const ten = Array.from({ length: 10 }, (_, index) => `export const k${index} = ${index}`).join('\n')
  writeFileSync(target, `${ten}\n`)
  git(['add', '.'])
  git(['commit', '--quiet', '-m', 'base'])
  const origin = git(['rev-parse', 'HEAD'])

  // The pull request: six lines appended, and `return 1` is the uncovered one.
  git(['checkout', '-b', 'pr'])
  writeFileSync(target, `${ten}\nexport function f(flag: boolean): number {\n  if (flag) {\n    return 1\n  }\n  return 0\n}\n`)
  git(['add', '.'])
  git(['commit', '--quiet', '-m', 'append a branch'])
  const headSha = git(['rev-parse', 'HEAD'])

  // The base moves underneath, in the same file.
  git(['checkout', 'main'])
  writeFileSync(target, `${Array.from({ length: 5 }, (_, index) => `// note ${index}`).join('\n')}\n${ten}\n`)
  git(['add', '.'])
  git(['commit', '--quiet', '-m', 'base advanced'])
  const baseTip = git(['rev-parse', 'HEAD'])

  // What the job checks out: GitHub's merge of the head into the base tip.
  git(['merge', '--quiet', 'pr', '-m', 'merge'])
  const merge = git(['rev-parse', 'HEAD'])
  assert.equal(git(['rev-list', '--parents', '-n1', 'HEAD']).split(' ').length, 3, 'the checkout must be the merge, not the head')
  const run = (head: string) =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../scripts/coverage-diff.mjs', import.meta.url)), '--base', baseTip, '--head', head, '--report', reportFile],
      { cwd: dir, encoding: 'utf8' },
    )

  const checkedOut = run(merge)
  assert.equal(checkedOut.status, 1, checkedOut.stdout)
  assert.match(checkedOut.stderr, /src\/lib\/x\.ts:18 — added line is not covered/)

  // The ancestor case this suite used to cover passes with either sha; the point
  // of the fixture above is that this one does not. `headSha` is only correct
  // when the base has not moved in the file, which is why the workflow must not
  // hand it the head.
  const headTree = run(headSha)
  assert.equal(headTree.status, 0, headTree.stderr)
  assert.match(headTree.stdout, /4\/4 changed lines covered/)
  assert.notEqual(headSha, merge)
  assert.notEqual(origin, baseTip)
})

// The wiring is what the review found wrong, and a library test cannot see it:
// the gate is only as honest as the tree it diffs. Assert the step hands it the
// checked-out commit, and that the pull request's head sha is not passed at all.
test('the workflow measures the checked-out tree, not the head sha', () => {
  const ci = readFileSync(fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url)), 'utf8')
  const step = ci.indexOf('Enforce the changed-lines floor')
  assert.notEqual(step, -1, 'ci.yml must carry the changed-lines step')
  const invocation = ci.indexOf('scripts/coverage-diff.mjs', step)
  assert.notEqual(invocation, -1, 'the step must run scripts/coverage-diff.mjs')
  const block = ci
    .slice(step, ci.indexOf('\n', invocation))
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
  assert.doesNotMatch(block, /pull_request\.head\.sha|PR_HEAD/)
  assert.match(ci.slice(invocation, ci.indexOf('\n', invocation)), /--head\s+HEAD\b/)
})

// #1335: a `workflow_dispatch` run has no pull-request base or body, so the
// changed-lines step was skipped and the job published a green `coverage`
// conclusion at the dispatched sha. That is a paint: a person with workflow-run
// permission could dispatch at a red pull request's head and leave a success
// where `ci-ok` reads. A dispatched run now fails closed, so the only
// conclusion it can publish under that name is one `ci-ok` never accepts.
test('a dispatched coverage run fails closed instead of publishing a green conclusion', (t) => {
  const dir = tempDir(t)
  const diffFile = join(dir, 'change.diff')
  const reportFile = join(dir, 'coverage.txt')
  writeFileSync(diffFile, COVERED_DIFF)
  writeFileSync(reportFile, REPORT)

  const dispatch = runGate(diffFile, reportFile, ['--event', 'workflow_dispatch'])
  assert.equal(dispatch.code, 1, 'a dispatched run may not pass the floor it cannot enforce')
  assert.match(dispatch.stdout, /coverage: mode=dispatch-fail-closed/)
  assert.doesNotMatch(`${dispatch.stdout}${dispatch.stderr}`, /coverage-diff: ok/)

  // The same fixture on the pull-request path is green and names its mode.
  const pull = runGate(diffFile, reportFile, ['--event', 'pull_request'])
  assert.equal(pull.code, 0, pull.stderr)
  assert.match(pull.stdout, /coverage: mode=pull_request/)
})

// The script-level refusal is only reached if the job routes a dispatched run
// into it, and the step that does so has to be appended: the comparator refuses
// any rewrite of a required job's own step definitions, so the floor step stays
// byte-for-byte the base tree's and the last step carries the refusal.
test('the coverage job routes a dispatched run through the fail-closed step', () => {
  const ci = readFileSync(fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url)), 'utf8')
  const guard = ci.indexOf('Name the coverage mode and refuse a dispatched run')
  assert.notEqual(guard, -1, 'ci.yml must carry the fail-closed dispatch step')
  const invocation = ci.indexOf('scripts/coverage-diff.mjs', guard)
  assert.notEqual(invocation, -1, 'the step must run scripts/coverage-diff.mjs')
  const line = ci.slice(invocation, ci.indexOf('\n', invocation))
  assert.match(line, /--event/)
  assert.match(line, /--mode-only/)
  assert.ok(
    ci.indexOf('Fail when the suite reported a failure') < guard,
    'the refusal is appended after the existing steps, which #1276 allows',
  )

  // The floor step's own definition is the base tree's: changing it in place is
  // refused by the comparator (a required job's steps may only grow at the end).
  const floor = ci.indexOf('Enforce the changed-lines floor')
  assert.notEqual(floor, -1)
  const floorInvocation = ci.indexOf('scripts/coverage-diff.mjs', floor)
  const floorBlock = ci.slice(floor, ci.indexOf('\n', floorInvocation))
  assert.doesNotMatch(floorBlock, /--event|workflow_dispatch/, 'the floor step must stay as the base tree spells it')
})

// `git diff` C-quotes a path that holds a non-ASCII byte unless it is told not
// to. The quoted name starts with `"`, fails the `src/` test, and the whole file
// disappears — which the gate prints as `skip`, exit 0, not as a refusal. The
// parser unquotes, so a diff produced elsewhere is read the same way.
test('a quoted non-ASCII path is unquoted, not dropped', () => {
  const diff = `diff --git "a/src/lib/\\346\\227\\245.ts" "b/src/lib/\\346\\227\\245.ts"
new file mode 100644
--- /dev/null
+++ "b/src/lib/\\346\\227\\245.ts"
@@ -0,0 +1,2 @@
+export const today = 'x'
+export const tomorrow = 'y'
`
  const added = addedLinesFromDiff(diff)
  assert.deepEqual(Object.keys(added), ['src/lib/日.ts'])
  assert.deepEqual(
    (added['src/lib/日.ts'] ?? []).map((entry: AddedLine) => entry.line),
    [1, 2],
  )
  const report = `# start of coverage report
# file               | line % | branch % | funcs % | uncovered lines
# src                |        |          |         |
#  lib               |        |          |         |
#   日.ts            |  50.00 |   100.00 |  100.00 | 2
# end of coverage report
`
  const verdict = evaluateChangedLines({ diff, report, floor: 80 })
  assert.equal(verdict.measured, 2)
  assert.deepEqual(verdict.violations, [{ path: 'src/lib/日.ts', line: 2 }])
})

// The same defect through the CLI and a real repository: with git's default
// quoting the `+++` line is quoted, the file is dropped, and the gate answers
// `skip` for a file whose added line is plainly uncovered. `-c
// core.quotePath=false` is what makes this an exit 1.
test('the CLI measures a non-ASCII path instead of skipping it', (context: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), 'coverage-diff-quote-'))
  context.after(() => rmSync(dir, { recursive: true, force: true }))
  const reportFile = join(dir, 'coverage.txt')
  writeFileSync(
    reportFile,
    `# start of coverage report
# file               | line % | branch % | funcs % | uncovered lines
# src                |        |          |         |
#  lib               |        |          |         |
#   日.ts            |  50.00 |   100.00 |  100.00 | 2
# end of coverage report
`,
  )
  const git = (args: string[]) => {
    const result = spawnSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' },
    })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git(['init', '--quiet'])
  git(['checkout', '-b', 'main'])
  mkdirSync(join(dir, 'src', 'lib'), { recursive: true })
  writeFileSync(join(dir, 'README.md'), 'base\n')
  git(['add', '.'])
  git(['commit', '--quiet', '-m', 'base'])
  const base = git(['rev-parse', 'HEAD'])
  writeFileSync(join(dir, 'src', 'lib', '日.ts'), "export const today = 'x'\nexport const tomorrow = 'y'\n")
  git(['add', '.'])
  git(['commit', '--quiet', '-m', 'add a file with a non-ASCII name'])
  const head = git(['rev-parse', 'HEAD'])

  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../scripts/coverage-diff.mjs', import.meta.url)), '--base', base, '--head', head, '--report', reportFile],
    { cwd: dir, encoding: 'utf8' },
  )
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`)
  assert.doesNotMatch(result.stdout, /skip/)
  assert.match(result.stderr, /src\/lib\/日\.ts:2 — added line is not covered/)
})

// An added line whose text begins with `++ ` prints as `+++ …`. Read as a header
// it resets the path and the rest of the file is dropped, so the file reads as
// untouched and the run prints `skip`. Inside a hunk it is content.
test('an added line that starts with "++ " is content, not a header', () => {
  const diff = `diff --git a/src/lib/counter.ts b/src/lib/counter.ts
--- a/src/lib/counter.ts
+++ b/src/lib/counter.ts
@@ -1,0 +2,3 @@
+++ count
+export const total = 1
+export const doubled = 2
`
  const added = addedLinesFromDiff(diff)
  assert.deepEqual(Object.keys(added), ['src/lib/counter.ts'])
  assert.deepEqual(
    (added['src/lib/counter.ts'] ?? []).map((entry: AddedLine) => entry.line),
    [2, 3, 4],
  )
  const report = `# start of coverage report
# file               | line % | branch % | funcs % | uncovered lines
# src                |        |          |         |
#  lib               |        |          |         |
#   counter.ts       |  66.66 |   100.00 |  100.00 | 3
# end of coverage report
`
  const verdict = evaluateChangedLines({ diff, report, floor: 80 })
  assert.equal(verdict.measured, 3)
  assert.deepEqual(verdict.violations, [{ path: 'src/lib/counter.ts', line: 3 }])
})
