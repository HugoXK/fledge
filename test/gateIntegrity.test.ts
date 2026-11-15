import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { classifyGateFiles, gateSummary } from '../scripts/lib/gate-integrity.mjs'

// #640: the gate that decides a merge runs from the base branch, so a pull
// request that edits a gate cannot judge itself. The reviewer still has to see
// that the gate itself is in the diff — that is what this summary is for.

const script = fileURLToPath(new URL('../scripts/gate-integrity.mjs', import.meta.url))

test('a docs or source only diff names no gate file', () => {
  assert.deepEqual(classifyGateFiles(['docs/api.md', 'src/app.ts', 'test/ciOk.test.ts']), [])
  assert.equal(gateSummary([]).includes('No gate file'), true)
})

test('every gate file in the diff is named once, sorted, whatever order it arrives in', () => {
  const files = classifyGateFiles([
    'scripts/ci-ok.mjs',
    'src/app.ts',
    '.github/workflows/ci.yml',
    'scripts/lib/ciChanges.mjs',
    '.github/agent/codeql-baseline.json',
    'scripts/ci-ok.mjs',
  ])
  assert.deepEqual(files, [
    '.github/agent/codeql-baseline.json',
    '.github/workflows/ci.yml',
    'scripts/ci-ok.mjs',
    'scripts/lib/ciChanges.mjs',
  ])
  const summary = gateSummary(files)
  for (const file of files) assert.ok(summary.includes(file), `the summary must name ${file}`)
})

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'a',
      GIT_AUTHOR_EMAIL: 'a@example.com',
      GIT_COMMITTER_NAME: 'a',
      GIT_COMMITTER_EMAIL: 'a@example.com',
    },
  })
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`)
}

function repoWithDiff(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-integrity-'))
  git(dir, ['init', '-q', '-b', 'main'])
  mkdirSync(join(dir, 'docs'), { recursive: true })
  writeFileSync(join(dir, 'docs', 'readme.md'), 'base\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'base'])
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(join(dir, 'src', 'app.ts'), 'export const a = 1\n')
  writeFileSync(join(dir, 'scripts', 'ci-ok.mjs'), 'process.exit(0)\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'head'])
  return dir
}

test('the summary names the gate file the pull request changes and stays green', () => {
  const dir = repoWithDiff()
  try {
    const summaryFile = join(dir, 'summary.md')
    const result = spawnSync(
      process.execPath,
      [script, '--repo', dir, '--git-base', 'HEAD~1', '--git-head', 'HEAD'],
      { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: summaryFile } },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /gate-integrity: ok — 1 gate file/)
    const summary = readFileSync(summaryFile, 'utf8')
    assert.ok(summary.includes('scripts/ci-ok.mjs'), 'the job summary must name the gate file in the diff')
    assert.ok(summary.includes('2 path(s) read'), 'the summary must say how many paths the diff held')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unreadable diff fails closed instead of reporting a clean diff', () => {
  const dir = repoWithDiff()
  try {
    const result = spawnSync(
      process.execPath,
      [script, '--repo', dir, '--git-base', '0123456789abcdef0123456789abcdef01234567', '--git-head', 'HEAD'],
      { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } },
    )
    assert.notEqual(result.status, 0, 'a diff that cannot be read must not pass')
    assert.match(result.stderr, /failing closed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
