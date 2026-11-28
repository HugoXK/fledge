import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkArchitecture, checkFileSizes, checkImports } from '../scripts/lib/arch-boundaries.mjs'
import { isPullRequestEvent, readBaseLedger, selectLedger, violationLine } from '../scripts/lib/arch-ledger.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function files(...entries: Array<[string, string]>) {
  return entries.map(([path, content]) => ({ path, content }))
}

test('a view may import a db row type but not the store', () => {
  assert.deepEqual(
    checkImports({ files: files(['src/views/page.ts', "import type { JobRow } from '../db.js'\n"]) }),
    [],
  )
  const violations = checkImports({ files: files(['src/views/page.ts', "import { store } from '../db.js'\n"]) })
  assert.equal(violations.length, 1)
  assert.equal(violations[0]?.rule, 'views-no-store')
  assert.match(String(violations[0]?.reason), /row types/)
})

test('the store must not import the composition root, views or jobs', () => {
  for (const target of ['src/app.ts', 'src/views/pages.ts', 'src/jobs/service.ts']) {
    const specifier = `./${target.slice('src/'.length).replace(/\.ts$/, '.js')}`
    const violations = checkImports({ files: files(['src/db.ts', `import { x } from '${specifier}'\n`]) })
    assert.equal(violations.length, 1, target)
    assert.equal(violations[0]?.rule, 'db-no-outer')
  }
})

test('jobs must not import views, and views may only use the allowed job helpers', () => {
  const fromJobs = checkImports({ files: files(['src/jobs/x.ts', "import { page } from '../views/pages.js'\n"]) })
  assert.equal(fromJobs.length, 1)
  assert.equal(fromJobs[0]?.rule, 'jobs-no-views')

  assert.deepEqual(
    checkImports({ files: files(['src/views/x.ts', "import { carryOverHeaderText } from '../jobs/continuity.js'\n"]) }),
    [],
  )
  const fromService = checkImports({ files: files(['src/views/x.ts', "import { Jobs } from '../jobs/service.js'\n"]) })
  assert.equal(fromService.length, 1)
  assert.equal(fromService[0]?.rule, 'views-no-jobs-service')
})

test('a type-only import from the job service is not runtime coupling', () => {
  assert.deepEqual(
    checkImports({ files: files(['src/views/x.ts', "import type { PlatformStopRecord } from '../jobs/service.js'\n"]) }),
    [],
  )
})

test('external and unresolved imports are not judged', () => {
  assert.deepEqual(
    checkImports({
      files: files(['src/views/x.ts', "import { fastify } from 'fastify'\nimport { gone } from './not-there.js'\n"]),
    }),
    [],
  )
})

test('a new file over the line limit fails, and a grandfathered one may not grow', () => {
  const body = (lines: number): string => 'x\n'.repeat(lines)
  assert.deepEqual(checkFileSizes({ files: files(['src/new.ts', body(1200)]) }), [])
  assert.equal(checkFileSizes({ files: files(['src/new.ts', body(1201)]) })[0]?.rule, 'file-too-large')

  assert.deepEqual(
    checkFileSizes({ files: files(['src/db.ts', body(3)]), grandfather: { 'src/db.ts': 3 }, maxLines: 2 }),
    [],
  )
  assert.equal(
    checkFileSizes({ files: files(['src/db.ts', body(4)]), grandfather: { 'src/db.ts': 3 }, maxLines: 2 })[0]?.rule,
    'grandfathered-growth',
  )
})

test('a grandfathered file at or below the limit must remove its entry', () => {
  const stale = checkFileSizes({ files: files(['src/db.ts', 'x\n'.repeat(1200)]), grandfather: { 'src/db.ts': 1300 } })
  assert.equal(stale[0]?.rule, 'stale-grandfather')
})

test('a runtime import is found at the line that starts it', () => {
  const violations = checkImports({
    files: files(['src/views/x.ts', "// header\n\nimport {\n  store,\n} from '../db.js'\n"]),
  })
  assert.equal(violations[0]?.line, 3)
})

test('the current tree passes the boundary and size gate', () => {
  const run = spawnSync(process.execPath, ['scripts/arch-boundaries.mjs'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr || run.stdout)
})

test('checkArchitecture reports the sizes it checked', () => {
  const result = checkArchitecture({
    files: files(['src/db.ts', 'x\n'.repeat(3)], ['src/app.ts', "import { x } from './db.js'\n"]),
    grandfather: { 'src/db.ts': 3 },
    maxLines: 2,
  })
  assert.deepEqual(result.violations, [])
  assert.equal(result.checked.files, 2)
  assert.equal(result.checked.imports, 1)
  assert.equal(result.checked.grandfathered, 1)
})

test('the size ratchet reads the ceiling from the base ref, not the pull request head', () => {
  const base = JSON.stringify({ 'src/big.ts': 10 })
  const head = JSON.stringify({ 'src/big.ts': 20 })
  const chosen = selectLedger({ baseRef: 'origin/main', baseContent: base, headContent: head })
  assert.equal(chosen.source, 'base:origin/main')
  const files = [{ path: 'src/big.ts', content: Array.from({ length: 15 }, (_, i) => `// ${String(i)}`).join('\n') }]
  const result = checkArchitecture({ files, grandfather: chosen.ledger })
  const growth = result.violations.find((violation) => violation.rule === 'grandfathered-growth')
  assert.ok(growth, 'a file grown past the base ceiling must be refused')
  assert.match(growth.reason, /15 lines, above its recorded 10/)
  // The same tree judged against the head ledger does not see growth at all,
  // which is exactly the bypass this rule removes.
  const headResult = checkArchitecture({ files, grandfather: JSON.parse(head) })
  assert.equal(headResult.violations.some((violation) => violation.rule === 'grandfathered-growth'), false)
})

test('a named base ref that cannot be read fails closed instead of reading the head', () => {
  assert.throws(
    () => selectLedger({ baseRef: 'origin/main', baseContent: null, headContent: JSON.stringify({ 'src/big.ts': 20 }) }),
    /refusing to read the ceiling from the pull request head/,
  )
})

test('a local run with no base ref still reads the head ledger and says so', () => {
  const head = JSON.stringify({ 'src/big.ts': 20 })
  const chosen = selectLedger({ baseRef: null, baseContent: null, headContent: head })
  assert.equal(chosen.source, 'head')
  assert.deepEqual(chosen.ledger, { 'src/big.ts': 20 })
})

function bigFile(lines: number) {
  return [{ path: 'src/big.ts', content: Array.from({ length: lines }, (_, i) => `// ${String(i)}`).join('\n') }]
}

test('a ceiling the base branch already carried is not growth', () => {
  const chosen = selectLedger({ baseRef: 'origin/main', baseContent: JSON.stringify({ 'src/big.ts': 9000 }), headContent: JSON.stringify({ 'src/big.ts': 8999 }) })
  const result = checkArchitecture({ files: bigFile(8999), grandfather: chosen.ledger })
  assert.equal(result.violations.some((violation) => violation.rule === 'grandfathered-growth'), false)
})

test('a tip that deletes its own entry cannot hide growth', () => {
  const chosen = selectLedger({ baseRef: 'origin/main', baseContent: JSON.stringify({ 'src/big.ts': 1000 }), headContent: JSON.stringify({}) })
  const result = checkArchitecture({ files: bigFile(1500), grandfather: chosen.ledger })
  const growth = result.violations.find((violation) => violation.rule === 'grandfathered-growth')
  assert.ok(growth, 'deleting the entry must not remove the ceiling')
  assert.match(growth.reason, /1500 lines, above its recorded 1000/)
})

test('a tip that lowers its own entry cannot make the base refusal disappear', () => {
  const chosen = selectLedger({ baseRef: 'origin/main', baseContent: JSON.stringify({ 'src/big.ts': 5000 }), headContent: JSON.stringify({ 'src/big.ts': 1000 }) })
  const result = checkArchitecture({ files: bigFile(6000), grandfather: chosen.ledger })
  const growth = result.violations.find((violation) => violation.rule === 'grandfathered-growth')
  assert.ok(growth, 'a lowered head entry must not remove the base ceiling')
  assert.match(growth.reason, /6000 lines, above its recorded 5000/)
})

test('the growth refusal names the judging ledger and the head entry', () => {
  const line = violationLine(
    { file: 'src/big.ts', line: 1, rule: 'grandfathered-growth', reason: '3000 lines, above its recorded 5000; split the file instead of raising the entry' },
    { ledgerSource: 'base:origin/main', headLedger: { 'src/big.ts': 6000 } },
  )
  assert.match(line, /ceiling from base:origin\/main/)
  assert.match(line, /head entry 6000/)
})

test('a local run reads the head ledger and the report says so', () => {
  const chosen = selectLedger({ baseRef: null, baseContent: null, headContent: JSON.stringify({ 'src/big.ts': 20 }) })
  assert.equal(chosen.source, 'head')
  assert.equal(violationLine({ file: 'src/big.ts', line: 1, rule: 'grandfathered-growth', reason: 'growth' }, { ledgerSource: chosen.source, headLedger: { 'src/big.ts': 30 } }), 'src/big.ts:1 grandfathered-growth: growth')
})

test('an absent base ref is fetched once and then read', () => {
  let fetches = 0
  let stored: string | null = null
  const content = readBaseLedger({
    ref: 'origin/main',
    readAt: () => stored,
    fetchRef: () => {
      fetches += 1
      stored = JSON.stringify({ 'src/big.ts': 10 })
      return true
    },
  })
  assert.equal(fetches, 1)
  assert.ok(content !== null, 'the fetched base must be readable')
  assert.deepEqual(JSON.parse(content), { 'src/big.ts': 10 })
})

test('a base that cannot be fetched stays unreadable, so the run fails closed', () => {
  let fetches = 0
  const content = readBaseLedger({
    ref: 'origin/main',
    readAt: () => null,
    fetchRef: () => {
      fetches += 1
      return false
    },
  })
  assert.equal(content, null)
  assert.equal(fetches, 1)
})

test('only pull_request and merge_group carry a base branch to judge against', () => {
  assert.equal(isPullRequestEvent({ eventName: 'pull_request', baseRef: 'main' }), true)
  assert.equal(isPullRequestEvent({ eventName: 'merge_group', baseRef: '' }), true)
  // A local run has no event name but may carry a base ref from the caller.
  assert.equal(isPullRequestEvent({ eventName: '', baseRef: 'main' }), true)
  assert.equal(isPullRequestEvent({ eventName: '', baseRef: '' }), false)
  // These three have no base to read and must not fail closed (#1333 hotfix:
  // the nightly CI and the repair dispatch went red on the old "not push" test).
  assert.equal(isPullRequestEvent({ eventName: 'schedule', baseRef: '' }), false)
  assert.equal(isPullRequestEvent({ eventName: 'workflow_dispatch', baseRef: '' }), false)
  assert.equal(isPullRequestEvent({ eventName: 'push', baseRef: '' }), false)
})

test('a schedule run reads the working-tree ledger and exits 0', () => {
  const script = fileURLToPath(new URL('../scripts/arch-boundaries.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'schedule', GITHUB_BASE_REF: '' },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /\(ledger from head\)/)
})

test('a dispatch run reads the working-tree ledger and exits 0', () => {
  const script = fileURLToPath(new URL('../scripts/arch-boundaries.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_BASE_REF: '' },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /\(ledger from head\)/)
})

// #1348: the pull_request refusal and the merge_group base lane are process
// behaviour, not argument behaviour. These fixtures build the two trees the
// script can see in CI — a directory with no repository at all, and a real
// depth-1 clone of a merge commit — so each row asserts an exit code and the
// ledger lane the report names, not only that a helper returned a boolean.

const ARCH_SCRIPT = fileURLToPath(new URL('../scripts/arch-boundaries.mjs', import.meta.url))

const GIT_IDENTITY = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Fledge Test',
  GIT_AUTHOR_EMAIL: 'test@fledge.invalid',
  GIT_COMMITTER_NAME: 'Fledge Test',
  GIT_COMMITTER_EMAIL: 'test@fledge.invalid',
}

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_IDENTITY })
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

function runArch(cwd: string, env: Record<string, string>, argv: string[] = []) {
  return spawnSync(process.execPath, [ARCH_SCRIPT, ...argv], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_BASE_REF: '', ...env },
  })
}

/** A tree with `src/` and no repository: every base read fails, the head lane works. */
function headLaneFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'arch-head-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'plain.ts'), 'export const plain = 1\n')
  return dir
}

/**
 * A real depth-1 clone whose HEAD is a merge commit: first parent is the base
 * tip, and the parent is grafted away exactly as GitHub's `merge_group`
 * checkout has it. Preconditions are asserted, so the fixture cannot quietly
 * degrade into a full clone and make the merge_group test vacuous.
 */
function mergeGroupFixture({ withOrigin = true }: { withOrigin?: boolean } = {}): string {
  const origin = mkdtempSync(join(tmpdir(), 'arch-origin-'))
  git(origin, ['init', '-q'])
  git(origin, ['checkout', '-q', '-B', 'main'])
  mkdirSync(join(origin, 'src'), { recursive: true })
  mkdirSync(join(origin, 'scripts', 'lib'), { recursive: true })
  // The entry must be above the 1200-line limit or the gate reports it as stale,
  // so the fixture file is a real ceiling entry and not a decoration.
  const longFile = Array.from({ length: 1201 }, (_, index) => `export const value${String(index)} = ${String(index)}`).join('\n')
  writeFileSync(join(origin, 'src', 'plain.ts'), `${longFile}\n`)
  writeFileSync(join(origin, 'scripts', 'lib', 'arch-grandfather.json'), '{"src/plain.ts":1201}\n')
  git(origin, ['add', '.'])
  git(origin, ['commit', '-q', '-m', 'base'])
  git(origin, ['checkout', '-q', '-b', 'feature'])
  writeFileSync(join(origin, 'src', 'feature.ts'), 'export const feature = 2\n')
  git(origin, ['add', '.'])
  git(origin, ['commit', '-q', '-m', 'feature'])
  git(origin, ['checkout', '-q', 'main'])
  git(origin, ['merge', '-q', '--no-ff', 'feature', '-m', 'merge feature'])

  const clone = mkdtempSync(join(tmpdir(), 'arch-clone-'))
  git(clone, ['init', '-q'])
  git(clone, ['remote', 'add', 'origin', origin])
  git(clone, ['fetch', '-q', '--depth=1', 'origin', 'main:refs/remotes/origin/main'])
  git(clone, ['checkout', '-q', 'refs/remotes/origin/main'])
  if (!withOrigin) git(clone, ['remote', 'remove', 'origin'])

  assert.equal(git(clone, ['rev-parse', '--is-shallow-repository']).trim(), 'true', 'the merge_group fixture must be shallow')
  assert.notEqual(spawnSync('git', ['rev-parse', '--verify', 'HEAD^1'], { cwd: clone, encoding: 'utf8' }).status, 0,
    'HEAD^1 must be grafted away before the gate deepens the clone')
  return clone
}

test('a pull_request run whose base cannot be read refuses at spawn level', () => {
  const clone = mergeGroupFixture({ withOrigin: false })
  const result = runArch(clone, { GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'nope' })

  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /refusing to judge the pull request against its own ceiling map/)
})

test('a merge_group entry deepens one commit and reads the base lane', () => {
  const clone = mergeGroupFixture()
  const result = runArch(clone, { GITHUB_EVENT_NAME: 'merge_group' })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /\(ledger from base:HEAD\^1\)/)
})

test('a merge_group entry whose deepen cannot run keeps the named refusal', () => {
  const clone = mergeGroupFixture({ withOrigin: false })
  const result = runArch(clone, { GITHUB_EVENT_NAME: 'merge_group' })

  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /refusing to judge the queue entry against its own ceiling map/)
})

test('an option-shaped --base is a revision, never a git option', () => {
  const clone = mergeGroupFixture()
  const escaped = join(clone, 'must-not-exist')

  for (const value of ['--help', `--output=${escaped}:scripts/lib/arch-grandfather.json`]) {
    const result = runArch(clone, { GITHUB_EVENT_NAME: 'push' }, ['--base', value])
    assert.equal(result.status, 1, `${value}: ${result.stdout}`)
    assert.match(result.stderr, /refusing to read the ceiling from the pull request head/, value)
    assert.doesNotMatch(result.stdout + result.stderr, /usage: git/i, `${value} must not reach git's help`)
  }
  assert.equal(existsSync(escaped), false, 'an option-shaped base must not make git write a file')
})

test('the six-row event matrix decides exit code and ledger lane', () => {
  const head = headLaneFixture()
  const group = mergeGroupFixture()
  const orphan = mergeGroupFixture({ withOrigin: false })

  const rows: Array<{ row: string; cwd: string; env: Record<string, string>; status: number; lane: RegExp }> = [
    { row: 'push', cwd: head, env: { GITHUB_EVENT_NAME: 'push' }, status: 0, lane: /\(ledger from head/ },
    { row: 'schedule', cwd: head, env: { GITHUB_EVENT_NAME: 'schedule' }, status: 0, lane: /\(ledger from head/ },
    { row: 'workflow_dispatch', cwd: head, env: { GITHUB_EVENT_NAME: 'workflow_dispatch' }, status: 0, lane: /\(ledger from head/ },
    { row: 'merge_group', cwd: group, env: { GITHUB_EVENT_NAME: 'merge_group' }, status: 0, lane: /\(ledger from base:HEAD\^1\)/ },
    { row: 'pull_request (base readable)', cwd: group, env: { GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'main' }, status: 0, lane: /\(ledger from base:origin\/main\)/ },
    { row: 'pull_request (base unreadable)', cwd: orphan, env: { GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'nope' }, status: 1, lane: /refusing to judge the pull request/ },
  ]

  for (const { row, cwd, env, status, lane } of rows) {
    const result = runArch(cwd, env)
    assert.equal(result.status, status, `${row}: ${result.stdout}${result.stderr}`)
    assert.match(`${result.stdout}${result.stderr}`, lane, row)
  }
})
