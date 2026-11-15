import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// #640: the gate that decides whether a pull request may merge must not be
// executed from that pull request's own tree. The evaluator runs from the base
// branch; only the diff under test comes from the head. These tests pin both
// halves: the workflow shape (a base checkout plus a `base/scripts/...` call)
// and the behaviour that makes it matter (a stubbed head copy cannot decide).

const ci = readFileSync(fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url)), 'utf8')
const codeql = readFileSync(fileURLToPath(new URL('../.github/workflows/codeql.yml', import.meta.url)), 'utf8')
const scriptsDir = fileURLToPath(new URL('../scripts', import.meta.url))

function jobBlock(text: string, name: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line === `  ${name}:`)
  assert.notEqual(start, -1, `ci.yml has no ${name} job`)
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [a-z][a-z0-9-]*:$/.test(lines[index]!)) {
      end = index
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

const baseRef = 'github.event.pull_request.base.sha'

const evaluators: Array<[string, string]> = [
  ['changes', 'base/scripts/ci-changes.mjs'],
  ['risk', 'base/scripts/risk-gate.mjs'],
  ['action-pins', 'base/scripts/action-pins.mjs'],
  ['workflow-lint', 'base/scripts/workflow-injection.mjs'],
  ['codeql-required', 'base/scripts/codeql-required.mjs'],
  ['ci-ok', 'base/scripts/ci-ok.mjs'],
]

for (const [job, script] of evaluators) {
  test(`${job} evaluates from the base branch tree, not the pull request head`, () => {
    const block = jobBlock(ci, job)
    assert.ok(block.includes(script), `${job} must run ${script}`)
    assert.ok(block.includes('path: base'), `${job} must check the base tree out into base/`)
    assert.ok(block.includes(baseRef), `${job}'s base checkout must name the pull request base sha`)
    assert.ok(!/node scripts\/(?:ci-ok|ci-changes|risk-gate|action-pins|workflow-injection|codeql-required)\.mjs/.test(block), `${job} must not execute the head copy of its evaluator`)
  })
}

test('the CodeQL result gate and its baseline come from the base branch', () => {
  assert.ok(codeql.includes('base/scripts/codeql-gate.mjs'), 'codeql-gate runs from the base tree')
  assert.ok(codeql.includes('--baseline base/.github/agent/codeql-baseline.json'), 'the baseline is the base branch copy, not the pull request copy')
})

test('the change classifier reads the head diff while the classifier code comes from base', () => {
  const block = jobBlock(ci, 'changes')
  assert.ok(block.includes('--repo .'), 'the classifier must be told which checkout holds the head data')
  assert.ok(block.includes('base/scripts/ci-changes.mjs'), 'the classifier itself comes from base')
})

test('the gate-integrity call is guarded against the base tree, so the pull request that introduces it still runs the job', () => {
  const block = jobBlock(ci, 'changes')
  assert.ok(block.includes('[ -f base/scripts/gate-integrity.mjs ]'), 'the guard must test the base copy of the evaluator')
  assert.ok(
    !block.includes('[ -f scripts/gate-integrity.mjs ]'),
    'a guard on the head copy would let the pull request decide whether the summary runs',
  )
  for (const call of ['gate_integrity --all', 'gate_integrity --repo . --git-base']) {
    assert.ok(block.includes(call), `the changes job must call ${call}`)
  }
  assert.ok(!block.includes('node base/scripts/gate-integrity.mjs --repo .'), 'the only invocation is the guarded helper')
})

function run(script: string, needsPath: string) {
  return spawnSync(process.execPath, [script, '--needs', needsPath], { encoding: 'utf8' })
}

test('a pull request that stubs scripts/ci-ok.mjs to exit 0 cannot turn ci-ok green, because the base copy decides', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-base-'))
  try {
    cpSync(scriptsDir, join(dir, 'base', 'scripts'), { recursive: true })
    cpSync(scriptsDir, join(dir, 'head', 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'head', 'scripts', 'ci-ok.mjs'), 'process.exit(0)\n')
    const required = JSON.parse(
      spawnSync(process.execPath, ['-e', `import(${JSON.stringify(join(dir, 'base', 'scripts', 'ci-ok.mjs'))}).then((m) => console.log(JSON.stringify(m.REQUIRED_JOBS)))`], { encoding: 'utf8' }).stdout,
    ) as string[]
    const needs: Record<string, { result: string }> = {}
    for (const name of required) needs[name] = { result: 'success' }
    needs.lint = { result: 'failure' }
    const needsPath = join(dir, 'needs.json')
    writeFileSync(needsPath, JSON.stringify(needs))

    const head = run(join(dir, 'head', 'scripts', 'ci-ok.mjs'), needsPath)
    assert.equal(head.status, 0, 'the attack shape: the head copy of the gate exits 0 over a red suite')
    const base = run(join(dir, 'base', 'scripts', 'ci-ok.mjs'), needsPath)
    assert.equal(base.status, 1, 'the base copy still fails the broken job, so the head cannot decide')
    assert.match(base.stderr, /lint/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the base classifier sees a source diff even when the head copy of the classifier is rewritten to call it docs only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-base-'))
  try {
    const repo = join(dir, 'repo')
    mkdirSync(repo, { recursive: true })
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'a',
      GIT_AUTHOR_EMAIL: 'a@example.com',
      GIT_COMMITTER_NAME: 'a',
      GIT_COMMITTER_EMAIL: 'a@example.com',
    }
    const git = (args: string[]) => {
      const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env })
      assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
    }
    git(['init', '-q', '-b', 'main'])
    mkdirSync(join(repo, 'docs'), { recursive: true })
    writeFileSync(join(repo, 'docs', 'readme.md'), 'base\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'base'])
    mkdirSync(join(repo, 'src'), { recursive: true })
    writeFileSync(join(repo, 'src', 'app.ts'), 'export const a = 1\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'head'])

    cpSync(scriptsDir, join(dir, 'base', 'scripts'), { recursive: true })
    cpSync(scriptsDir, join(dir, 'head', 'scripts'), { recursive: true })
    writeFileSync(
      join(dir, 'head', 'scripts', 'lib', 'ciChanges.mjs'),
      'export function classifyChanges() { return { docsOnly: true, source: false } }\nexport function allGateChanges() { return { docsOnly: true, source: false } }\nexport function changedPathsForPullRequest() { return null }\n',
    )

    const args = ['--repo', repo, '--git-base', 'HEAD~1', '--git-head', 'HEAD']
    const base = spawnSync(process.execPath, [join(dir, 'base', 'scripts', 'ci-changes.mjs'), ...args], { encoding: 'utf8' })
    assert.equal(base.status, 0, base.stderr)
    assert.equal(JSON.parse(base.stdout).source, true, 'the base classifier reads the head diff and sees src/')

    const head = spawnSync(process.execPath, [join(dir, 'head', 'scripts', 'ci-changes.mjs'), ...args], { encoding: 'utf8' })
    assert.equal(head.status, 0, head.stderr)
    assert.equal(JSON.parse(head.stdout).source, false, 'the attack shape: the rewritten head classifier hides the source diff')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
