import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// #1312: required check `coverage` reported success on a tree whose suite
// failed, because the step's only pipeline ended in `tee` and no shell option
// made the runner's exit status reach the step. A required check that can be
// green while the thing it measures is red is worse than a missing check.
//
// This is a workflow lint, not a shell unit test: it reads the file a maintainer
// edits, finds every `run:` step that pipes into `tee`, and proves the effective
// shell fails the step when the producer fails. It runs in the normal suite so
// the `workflow-lint` job's `if: changes.workflows` cannot skip it.

const CI = readFileSync(fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url)), 'utf8')

interface Finding {
  job: string
  step: string
  command: string
}

interface ParsedStep {
  job: string
  step: string
  shell: string | null
  run: string
}

interface JobBlock {
  job: string
  lines: string[]
}

// The file is read line by line rather than through a YAML parser because this
// repository has no YAML dependency; the scanner covers the subset ci.yml uses
// (jobs at two spaces, steps at six, step keys at eight, block scalars under a
// key). The vacuous-scan guard below is what stops a broken scanner from passing
// silently: the lint also has to find at least one pipeline into `tee`.
function jobBlocks(workflow: string): JobBlock[] {
  const lines = workflow.split('\n')
  const start = lines.findIndex((line) => line === 'jobs:')
  assert.notEqual(start, -1, 'ci.yml must declare jobs:')
  const blocks: JobBlock[] = []
  let current: JobBlock | null = null
  for (const line of lines.slice(start + 1)) {
    const header = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (header !== null) {
      current = { job: header[1]!, lines: [] }
      blocks.push(current)
      continue
    }
    current?.lines.push(line)
  }
  return blocks
}

// A job's or the workflow's `defaults.run.shell:` block. `defaults:` sits at
// four spaces inside a job (shell at eight) and at the top level (shell at four).
function defaultShell(lines: string[], indent: number): string | null {
  const at = lines.findIndex((line) => line === `${' '.repeat(indent)}defaults:`)
  if (at === -1) return null
  let shell: string | null = null
  for (const line of lines.slice(at + 1)) {
    const match = new RegExp(`^${' '.repeat(indent + 4)}shell:\\s*(.+?)\\s*$`).exec(line)
    if (match !== null) shell = match[1]!
  }
  return shell
}

function stepsOf(job: JobBlock, inheritedShell: string | null): ParsedStep[] {
  const steps: ParsedStep[] = []
  let current: { first: string; lines: string[] } | null = null
  for (const line of job.lines) {
    if (line.startsWith('      - ')) {
      if (current !== null) {
        const step = parseStep(job.job, current.first, current.lines, inheritedShell)
        if (step !== null) steps.push(step)
      }
      current = { first: line.replace(/^      - /, ''), lines: [] }
      continue
    }
    current?.lines.push(line)
  }
  if (current !== null) {
    const step = parseStep(job.job, current.first, current.lines, inheritedShell)
    if (step !== null) steps.push(step)
  }
  return steps
}

function parseStep(job: string, firstLine: string, lines: string[], inheritedShell: string | null): ParsedStep | null {
  const body = [firstLine, ...lines]
  let shell: string | null = null
  let run = ''
  for (let index = 0; index < body.length; index += 1) {
    const line = body[index]!
    const shellLine = /^        shell:\s*(.+?)\s*$/.exec(line)
    if (shellLine !== null) shell = shellLine[1]!
    const runKey = /^        run:\s*(.*)$/.exec(line)
    if (runKey === null) continue
    const inline = runKey[1]!
    if (inline !== '' && !/^[|>]/.test(inline)) {
      run = inline
      continue
    }
    const block: string[] = []
    for (let next = index + 1; next < body.length; next += 1) {
      const content = body[next]!
      if (content.trim() !== '' && !/^ {10}/.test(content)) break
      block.push(content.replace(/^ {10}/, ''))
    }
    run = block.join('\n')
  }
  if (run === '') return null
  // The `name:` key sits on the step's first line (`- name: test`), so it is
  // searched in the whole step body rather than only in the trailing lines.
  const name = [firstLine, ...lines]
    .map((line) => /^ {0,8}name:\s*(.+?)\s*$/.exec(line))
    .find((match) => match !== null)
  return { job, step: name?.[1] ?? firstLine, shell: shell ?? inheritedShell, run }
}

function steps(workflow: string): ParsedStep[] {
  const lines = workflow.split('\n')
  const jobStart = lines.findIndex((line) => line === 'jobs:')
  const workflowShell = defaultShell(lines.slice(0, jobStart === -1 ? lines.length : jobStart), 0)
  return jobBlocks(workflow).flatMap((job) => stepsOf(job, defaultShell(job.lines, 4) ?? workflowShell))
}

function effectiveShell(step: ParsedStep): string {
  return (step.shell ?? 'bash -e {0}').replace(/^['"]|['"]$/g, '').trim()
}

function pipefailFindings(workflow: string): Finding[] {
  const findings: Finding[] = []
  for (const step of steps(workflow)) {
    if (!/(?<!\|)\|(?!\|)\s*tee\b/.test(step.run)) continue
    const shell = effectiveShell(step)
    // GitHub runs `shell: bash` as `bash --noprofile --norc -eo pipefail {0}`,
    // and a custom template that names pipefail says so itself. An in-script
    // `set -o pipefail` (or a combined `set -euo pipefail`) is the third form.
    const shellCarriesPipefail = shell === 'bash' || /\bpipefail\b/.test(shell)
    const scriptSetsPipefail = /(^|\n)\s*set\s+[^\n]*\bpipefail\b/.test(step.run)
    if (shellCarriesPipefail || scriptSetsPipefail) continue
    findings.push({ job: step.job, step: step.step, command: step.run.split('\n')[0] ?? '' })
  }
  return findings
}

test('every ci.yml pipeline into tee fails the step when the producer fails', () => {
  const parsed = steps(CI)
  const piped = parsed.filter((step) => /(?<!\|)\|(?!\|)\s*tee\b/.test(step.run))
  // A scan that finds no pipeline reports no findings for the same reason a
  // broken scanner does; the coverage step is the one this test exists for.
  assert.ok(piped.length > 0, 'the scan must find the ci.yml step that pipes into tee')
  assert.deepEqual(
    pipefailFindings(CI),
    [],
    'a run: step that pipes into tee must make the runner exit status the step status',
  )
})

test('a piped run without pipefail is reported', () => {
  const fixture = [
    'jobs:',
    '  demo:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: test',
    '        run: npm test 2>&1 | tee out.txt',
    '',
  ].join('\n')
  assert.deepEqual(pipefailFindings(fixture), [{ job: 'demo', step: 'test', command: 'npm test 2>&1 | tee out.txt' }])
})

test('an in-script set -o pipefail is accepted', () => {
  const fixture = [
    'jobs:',
    '  demo:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: test',
    '        run: |',
    '          set -o pipefail',
    '          npm test 2>&1 | tee out.txt',
    '',
  ].join('\n')
  assert.deepEqual(pipefailFindings(fixture), [])
})

test('the documented bash shell and a pipefail shell template are accepted', () => {
  const fixture = [
    'jobs:',
    '  demo:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: test',
    '        shell: bash',
    '        run: npm test 2>&1 | tee out.txt',
    '',
  ].join('\n')
  assert.deepEqual(pipefailFindings(fixture), [])
  assert.deepEqual(pipefailFindings(fixture.replace('shell: bash', 'shell: bash -eo pipefail {0}')), [])
})

test('a job-level defaults.run.shell is the step shell', () => {
  const fixture = [
    'jobs:',
    '  demo:',
    '    runs-on: ubuntu-latest',
    '    defaults:',
    '      run:',
    '        shell: bash',
    '    steps:',
    '      - name: test',
    '        run: npm test 2>&1 | tee out.txt',
    '',
  ].join('\n')
  assert.deepEqual(pipefailFindings(fixture), [])
})

test('a tee outside a pipeline is not a pipeline', () => {
  const fixture = [
    'jobs:',
    '  demo:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: test',
    '        run: tee out.txt',
    '',
  ].join('\n')
  assert.deepEqual(pipefailFindings(fixture), [])
})
