import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// #963: a job in any workflow can publish the branch-protection context
// `ci-ok` — a job id, or a `name:` value, is the check run's name, and an
// implicit `success` on the pull request's own tree is indistinguishable from
// the real producer. The scanner is policy and must come from the base tree;
// the workflows are the data under test and come from the head, which is why
// the CLI takes a directory instead of reading its own copy.

const moduleUrl = new URL('../scripts/lib/reserved-contexts.mjs', import.meta.url).href
const cliPath = fileURLToPath(new URL('../scripts/reserved-contexts.mjs', import.meta.url))
const workflowsDir = fileURLToPath(new URL('../.github/workflows', import.meta.url))
const ciPath = fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url))

type Finding = { file: string; line: number; context: string; kind: string }
type Lib = {
  RESERVED_CONTEXTS: Record<string, string[]>
  scanWorkflowText: (text: string, file: string, table?: Record<string, string[]>) => Finding[]
  scanWorkflows: (directory: string, table?: Record<string, string[]>) => { findings: Finding[]; files: string[] }
}

async function lib(): Promise<Lib> {
  return (await import(moduleUrl)) as Lib
}

function fixture(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), 'reserved-contexts-'))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(directory, name), body, 'utf8')
  return directory
}

const SHADOW_JOB_ID = [
  'name: shadow',
  'on: pull_request',
  'permissions:',
  '  contents: read',
  'jobs:',
  '  ci-ok:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - run: "true"',
  '',
].join('\n')

const SHADOW_NAME = [
  'name: shadow',
  'on: pull_request',
  'jobs:',
  '  publish:',
  '    name: ci-ok',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - run: "true"',
  '',
].join('\n')

test('the reserved table allows ci-ok in both canonical producers and the other contexts only in their own file', async () => {
  const { RESERVED_CONTEXTS } = await lib()
  const ciOk = RESERVED_CONTEXTS['ci-ok'] ?? []
  assert.ok(ciOk.includes('ci.yml'), 'the in-run aggregate at ci.yml:808 publishes ci-ok today')
  assert.ok(
    ciOk.includes('ci-ok-publish.yml'),
    'the recorded producer is ci-ok-publish.yml (.github/agent/required-checks.md); an honest sample must not be judged red',
  )
  assert.deepEqual(RESERVED_CONTEXTS['review-gate'], ['review-gate.yml'])
  assert.deepEqual(RESERVED_CONTEXTS['pr-lint'], ['pr-lint.yml'])
})

test('a job id that names a reserved context outside its canonical file is a finding', async () => {
  const { scanWorkflowText } = await lib()
  const findings = scanWorkflowText(SHADOW_JOB_ID, 'shadow.yml')
  assert.equal(findings.length, 1, `one finding expected, got ${JSON.stringify(findings)}`)
  assert.deepEqual(findings[0], { file: 'shadow.yml', line: 6, context: 'ci-ok', kind: 'job-id' })
  assert.equal(SHADOW_JOB_ID.split('\n')[5], '  ci-ok:', 'the line named in the finding is the job id itself')
})

test('a name: value that names a reserved context on another job id is a finding', async () => {
  const { scanWorkflowText } = await lib()
  const findings = scanWorkflowText(SHADOW_NAME, 'shadow.yml')
  assert.equal(findings.length, 1, `one finding expected, got ${JSON.stringify(findings)}`)
  assert.deepEqual(findings[0], { file: 'shadow.yml', line: 5, context: 'ci-ok', kind: 'name' })
})

test('quoted and commented name: values are read as the context they publish', async () => {
  const { scanWorkflowText } = await lib()
  for (const value of ['"ci-ok"', "'ci-ok'", 'ci-ok # the required context', '"ci-ok" # quoted']) {
    const text = ['jobs:', '  publish:', `    name: ${value}`, '    runs-on: ubuntu-latest', ''].join('\n')
    const findings = scanWorkflowText(text, 'shadow.yml')
    assert.equal(findings.length, 1, `${value} must be one finding, got ${JSON.stringify(findings)}`)
    assert.equal(findings[0]?.context, 'ci-ok')
    assert.equal(findings[0]?.line, 3)
  }
})

test('the repository\'s own workflows are the honest sample and produce no findings', async () => {
  const { scanWorkflows } = await lib()
  const report = scanWorkflows(workflowsDir)
  assert.deepEqual(report.findings, [], `the tree at this tip publishes every reserved context only from its canonical file: ${JSON.stringify(report.findings)}`)
  assert.ok(report.files.length >= 10, `every workflow file is read, got ${String(report.files.length)}`)
})

test('a canonical file is allowed and every other file is not', async () => {
  const { scanWorkflowText } = await lib()
  const ci = readFileSync(ciPath, 'utf8')
  const inCi = scanWorkflowText(ci, 'ci.yml')
  assert.deepEqual(inCi.filter((finding) => finding.context === 'ci-ok'), [], 'ci.yml publishes ci-ok legitimately')
  const renamed = scanWorkflowText(ci, 'review-gate.yml')
  assert.deepEqual(
    renamed.filter((finding) => finding.context === 'ci-ok').map((finding) => finding.kind).sort(),
    ['job-id', 'name'],
    'the same text in another file is the shadow this gate exists for',
  )
})

test('review-gate and pr-lint are reserved in their own file and nowhere else', async () => {
  const { scanWorkflowText } = await lib()
  const text = ['jobs:', '  review-gate:', '    name: review-gate', '    runs-on: ubuntu-latest', ''].join('\n')
  const own = scanWorkflowText(text, 'review-gate.yml')
  assert.deepEqual(own, [], 'review-gate.yml may publish review-gate')
  const elsewhere = scanWorkflowText(text, 'ci.yml')
  assert.deepEqual(
    elsewhere.map((finding) => finding.context),
    ['review-gate', 'review-gate'],
    'the same job in ci.yml is two findings, one per spelling',
  )
})

test('a lookalike id is not the context: only the exact name shadows a check', async () => {
  const { scanWorkflowText } = await lib()
  const text = [
    'jobs:',
    '  ci-ok-head:',
    '    name: ci-ok (head)',
    '    runs-on: ubuntu-latest',
    '  ci-ok-publish:',
    '    name: publish ci-ok',
    '    runs-on: ubuntu-latest',
    '',
  ].join('\n')
  assert.deepEqual(scanWorkflowText(text, 'shadow.yml'), [], 'the checks API matches the exact name, so lookalikes publish no reserved context')
})

test('a workflow with no jobs block, and a job-level name before jobs:, are read without inventing findings', async () => {
  const { scanWorkflowText } = await lib()
  const header = ['name: ci-ok', 'on: pull_request', ''].join('\n')
  assert.deepEqual(scanWorkflowText(header, 'shadow.yml'), [], 'a top-level workflow name is not a check run')
  const notAJob = ['on:', '  workflow_run:', '    workflows: [CI]', '', 'jobs:', '  publish:', '    runs-on: ubuntu-latest', ''].join('\n')
  assert.deepEqual(scanWorkflowText(notAJob, 'ci-ok-publish.yml'), [], 'keys under on: are triggers, not jobs')
})

test('a workflow file that cannot be read fails the scan instead of passing it', async () => {
  const { scanWorkflows } = await lib()
  const directory = mkdtempSync(join(tmpdir(), 'reserved-contexts-'))
  writeFileSync(join(directory, 'shadow.yml'), SHADOW_JOB_ID, 'utf8')
  mkdirSync(join(directory, 'broken.yml'))
  await assert.rejects(async () => scanWorkflows(directory), 'an unreadable workflow must throw, so the job cannot pass on a file it never read')
})

test('the CLI exits non-zero on a shadow and names the file and the context', async () => {
  const directory = fixture({ 'shadow.yml': SHADOW_JOB_ID })
  await assert.rejects(
    async () => execFileAsync(process.execPath, [cliPath, '--workflows', directory], { encoding: 'utf8' }),
    (error: NodeJS.ErrnoException & { code?: number; stderr?: string }) => {
      assert.equal(error.code, 1, `the gate is the exit code, got ${String(error.code)}`)
      const stderr = String(error.stderr ?? '')
      assert.match(stderr, /shadow\.yml:6/, 'the finding must point at the file and line to open')
      assert.match(stderr, /ci-ok/, 'the finding must name the context it publishes')
      return true
    },
  )
})

test('the CLI exits zero and prints the count for a directory with no shadow', async () => {
  const directory = fixture({ 'honest.yml': ['jobs:', '  lint:', '    runs-on: ubuntu-latest', ''].join('\n') })
  const { stdout } = await execFileAsync(process.execPath, [cliPath, '--workflows', directory], { encoding: 'utf8' })
  assert.match(stdout, /reserved-contexts: ok \(1 workflow file\(s\), 3 context\(s\) reserved\)/)
})

test('the CLI exits non-zero for an unreadable workflow file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reserved-contexts-'))
  mkdirSync(join(directory, 'broken.yml'))
  await assert.rejects(
    async () => execFileAsync(process.execPath, [cliPath, '--workflows', directory], { encoding: 'utf8' }),
    (error: NodeJS.ErrnoException & { code?: number; stderr?: string }) => {
      assert.equal(error.code, 1)
      assert.match(String(error.stderr ?? ''), /cannot read/)
      return true
    },
  )
})

test('ci.yml runs the base-tree scanner over the head workflows and ci-ok requires it', async () => {
  const workflow = readFileSync(ciPath, 'utf8')
  const start = workflow.indexOf('\n  reserved-contexts:')
  assert.ok(start !== -1, 'ci.yml must declare the reserved-contexts job')
  const rest = workflow.slice(start + 1)
  const next = rest.search(/\n  [a-z][a-z0-9-]*:\n/)
  const block = next === -1 ? rest : rest.slice(0, next)
  assert.match(block, /^    needs: changes$/m, 'the job waits on the classifier like the other workflow checks')
  assert.match(block, /^    if: needs\.changes\.outputs\.workflows == 'true'$/m, 'a shadow can only arrive in a diff that touches .github/workflows/')
  assert.match(block, /path: base/, 'the scanner is policy and comes from the base tree')
  assert.match(
    block,
    /\[ -f base\/scripts\/reserved-contexts\.mjs \]/,
    'the bootstrap is guarded on the base copy, so the pull request that introduces the scanner still runs',
  )
  assert.match(
    block,
    /node base\/scripts\/reserved-contexts\.mjs --workflows \.github\/workflows/,
    'the base copy of the scanner reads the head workflows, which is the only split that can see the shadow',
  )
  assert.match(
    block,
    /node scripts\/reserved-contexts\.mjs --workflows \.github\/workflows/,
    'while the base tree predates the scanner, the introducing pull request runs the head copy once',
  )

  const { REQUIRED_JOBS } = (await import('../scripts/ci-ok.mjs')) as { REQUIRED_JOBS: string[] }
  assert.ok(REQUIRED_JOBS.includes('reserved-contexts'), 'ci-ok must fail when the new job fails')
  const ciOkStart = workflow.indexOf('\n  ci-ok:')
  const needsMatch = /needs:\s*\[([^\]]*)\]/.exec(workflow.slice(ciOkStart))
  assert.ok(needsMatch !== null, 'ci-ok must declare needs as an inline list')
  assert.ok(
    (needsMatch[1] ?? '').split(',').map((entry) => entry.trim()).includes('reserved-contexts'),
    'ci-ok cannot pass while the new job is red or absent',
  )
})

test('the ci-ok list in docs/autonomous-dev.md names the new job', () => {
  const doc = readFileSync(fileURLToPath(new URL('../docs/autonomous-dev.md', import.meta.url)), 'utf8')
  assert.ok(doc.includes('`reserved-contexts`'), 'the ci-ok list is the documentation a reviewer reads')
})
