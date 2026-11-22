import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// #866: a release is two writes, and the second one used to repeat itself. The
// tag job dispatches `release.yml` at a tag whose GitHub Release is missing, but
// `release.yml` was create-*or-update* and rebuilt and repushed the image before
// it looked — so a second dispatch of one tag republished that image and rewrote
// its notes. The claim in the docs is only true with a guard that runs before the
// build, which is the step this file drives: a release that already exists ends
// the run before the image is built, and every step that would write is gated on
// that answer.
//
// #909: the guard also has to tell "no release yet" from "I could not read it".
// `gh` exits non-zero for 404, 403, 5xx and a dead network alike, and the step
// used to record `published=false` for all of them, so a 403 republished the
// tag's image. Both answers now come from one tested rule
// (`scripts/lib/release-lookup.mjs`), and this file drives its three branches
// through the real guard body: present, absent (404 only), unreadable.

const release = readFileSync('.github/workflows/release.yml', 'utf8')
const daily = readFileSync('.github/workflows/daily-release.yml', 'utf8')
const GUARD = 'Stop when the release already exists'
const WRITE = 'Create the GitHub release'
const GATE = "steps.guard.outputs.published != 'true'"
const LOOKUP = 'scripts/lib/release-lookup.mjs'

function stepBlocks(workflow: string): string[] {
  const start = workflow.indexOf('    steps:\n')
  assert.notEqual(start, -1, 'release.yml has a steps list')
  // #1207 added a second job (`stranded-log`, which posts the #80 line), so the
  // publish job's steps end where the next two-space job key begins. The list
  // below is still exactly the publish job's steps: the guard assertions that
  // read it are unchanged.
  const rest = workflow.slice(start + '    steps:\n'.length)
  const nextJob = rest.search(/\n {2}[A-Za-z0-9_-]+:\s*\n/)
  const steps = nextJob === -1 ? rest : rest.slice(0, nextJob)
  return steps
    .split(/\n      - /)
    .map((block, index) => (index === 0 ? block : `- ${block}`))
    .filter((block) => block.trim() !== '')
}

function stepName(block: string): string {
  const named = /^- name: (.+)$/m.exec(block.replace(/^        /m, ''))
  if (named !== null) return String(named[1]).trim()
  const uses = /uses: ([^\s#]+)/.exec(block)
  if (uses !== null) return `uses ${String(uses[1])}`
  const run = /run: ([^\n]+)/.exec(block)
  if (run !== null) return `run ${String(run[1]).trim()}`
  return block.split('\n')[0] ?? ''
}

function runBody(block: string): string {
  const marker = '        run: |\n'
  const start = block.indexOf(marker)
  assert.notEqual(start, -1, `step "${stepName(block)}" has a run body`)
  const body: string[] = []
  for (const line of block.slice(start + marker.length).split('\n')) {
    // The block handed in runs up to the next step, so the first line indented
    // less than a body line (`      #` for the next step) ends the body.
    if (line !== '' && !line.startsWith('          ')) break
    body.push(line.startsWith('          ') ? line.slice(10) : line)
  }
  return body.join('\n')
}

function stepBlock(name: string): string {
  const block = stepBlocks(release).find((candidate) => stepName(candidate) === name)
  assert.ok(block !== undefined, `release.yml declares the step "${name}"`)
  return block
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

interface StepRun {
  status: number | null
  /** What the step wrote to `$GITHUB_OUTPUT`. */
  output: string
  summary: string
  stdout: string
  stderr: string
  /** Every `gh` invocation the stub received, one per line. */
  commands: string
}

interface GhAnswer {
  exit: number
  stderr?: string
}

// Drive a step body the way a runner would: on PATH there is a stub `gh` whose
// exit status and stderr are the answer under test, and every invocation is
// logged so a test can prove which command ran.
function runStep(block: string, gh: GhAnswer): StepRun {
  const dir = mkdtempSync(join(tmpdir(), 'release-guard-'))
  try {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const commands = join(dir, 'commands')
    writeFileSync(commands, '')
    const stub = [
      '#!/usr/bin/env bash',
      'printf "%s\\n" "$*" >> "$STUB_LOG"',
      gh.stderr === undefined ? '' : `printf "%s\\n" ${shellQuote(gh.stderr)} >&2`,
      // The answer under test is the release lookup; a write the step was not
      // supposed to reach is still logged above, and would fail the assertion.
      'case "$*" in *"release create"*) exit 0 ;; esac',
      `exit ${String(gh.exit)}`,
      '',
    ].join('\n')
    const ghPath = join(bin, 'gh')
    writeFileSync(ghPath, stub)
    chmodSync(ghPath, 0o755)
    const output = join(dir, 'output')
    const summary = join(dir, 'summary.md')
    writeFileSync(output, '')
    writeFileSync(summary, '')
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', runBody(block)], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_REPOSITORY: 'HugoXK/fledge',
        RUNNER_TEMP: dir,
        STUB_LOG: commands,
        RELEASE_TAG: 'v0.3.2',
      },
    })
    return {
      status: result.status,
      output: readFileSync(output, 'utf8'),
      summary: readFileSync(summary, 'utf8'),
      stdout: result.stdout,
      stderr: result.stderr,
      commands: readFileSync(commands, 'utf8'),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a release that already exists ends the run before anything is built', () => {
  const run = runStep(stepBlock(GUARD), { exit: 0 })
  assert.equal(run.status, 0, 'the guard is a clean exit, not a failure')
  assert.match(run.output, /^published=true$/m, 'the run is marked as already published')
  assert.match(run.summary, /already|exists/i, 'the summary says why the run stopped')
})

test('a 404 is the only answer that still publishes', () => {
  const run = runStep(stepBlock(GUARD), { exit: 1, stderr: 'gh: Not Found (HTTP 404)' })
  assert.equal(run.status, 0, 'a missing release is not an error')
  assert.match(run.output, /^published=false$/m, 'the run is marked as not published')
  assert.match(run.summary, /no GitHub Release/, 'the summary names the 404 as absence')
})

test('a 403 stops the run with no "published" answer, so no writer can run', () => {
  const run = runStep(stepBlock(GUARD), { exit: 1, stderr: 'gh: Resource not accessible by integration (HTTP 403)' })
  assert.notEqual(run.status, 0, 'an unreadable lookup is a failure, not a publish')
  assert.doesNotMatch(run.output, /published=/, 'no gate can be satisfied, so no build or push runs')
  assert.match(run.stdout, /::error::/, 'the runner shows an error')
  assert.match(run.stderr, /HTTP 403|unreadable/, 'the reason names the status')
})

test('a 5xx stops the run the same way', () => {
  for (const stderr of ['gh: Server Error (HTTP 502)', 'gh: Internal Server Error (HTTP 500)']) {
    const run = runStep(stepBlock(GUARD), { exit: 1, stderr })
    assert.notEqual(run.status, 0, stderr)
    assert.doesNotMatch(run.output, /published=/, stderr)
    assert.match(run.stdout, /::error::/, stderr)
  }
})

test('a failure without an HTTP status is unreadable, not "not published"', () => {
  for (const stderr of [
    'gh: Post "https://api.github.com/repos/HugoXK/fledge/releases/tags/v0.3.2": dial tcp: i/o timeout',
    'gh: release not found',
    '',
  ]) {
    const run = runStep(stepBlock(GUARD), { exit: 1, stderr })
    assert.notEqual(run.status, 0, `stderr=${stderr}`)
    assert.doesNotMatch(run.output, /published=/, `stderr=${stderr}`)
  }
})

test('the guard runs before the build, and every write after it is gated on the answer', () => {
  const blocks = stepBlocks(release)
  const guardIndex = blocks.findIndex((block) => stepName(block) === GUARD)
  const buildIndex = blocks.findIndex((block) => stepName(block).includes('Build the image'))
  assert.notEqual(guardIndex, -1, 'the guard step exists')
  assert.notEqual(buildIndex, -1, 'the build step exists')
  assert.ok(guardIndex < buildIndex, 'the guard precedes the build, so a published release never reaches it')

  // Every step after the guard either writes the image, the notes or the release,
  // or derives what they use: all of them carry the gate. The assertion is the
  // gate itself, which is what keeps a second dispatch from republishing.
  const after = blocks.slice(guardIndex + 1)
  assert.ok(after.length >= 5, 'the guard sits above the publishing steps')
  for (const block of after) {
    assert.match(block, new RegExp(`if: \\$\\{\\{ ${GATE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\}\\}`), `step "${stepName(block)}" is gated on the guard`)
  }
})

test('the release write creates the release and never edits one it did not create', () => {
  const absent = runStep(stepBlock(WRITE), { exit: 1, stderr: 'gh: Not Found (HTTP 404)' })
  assert.equal(absent.status, 0, 'a 404 at the write step is the expected pre-create answer')
  assert.match(absent.commands, /release create /, 'the release is created')
  assert.doesNotMatch(absent.commands, /release edit/, 'nothing is edited')

  const present = runStep(stepBlock(WRITE), { exit: 0 })
  assert.notEqual(present.status, 0, 'a release that appeared during the run is refused')
  assert.match(present.stdout, /::error::/, 'the refusal is reported')
  assert.doesNotMatch(present.commands, /release (create|edit) /, 'neither a create nor a notes rewrite happens')

  const unreadable = runStep(stepBlock(WRITE), { exit: 1, stderr: 'gh: Server Error (HTTP 502)' })
  assert.notEqual(unreadable.status, 0, 'an unreadable lookup cannot be turned into a create')
  assert.doesNotMatch(unreadable.commands, /release (create|edit) /, 'nothing is written on an unreadable answer')
})

test('both workflows classify the release state through one tested rule, not a grep', () => {
  const guardBody = runBody(stepBlock(GUARD))
  const writeBody = runBody(stepBlock(WRITE))
  const collectStart = daily.indexOf('      - name: Collect the pushed commit')
  assert.notEqual(collectStart, -1, 'the collect step exists')
  const collect = daily.slice(collectStart)
  const runAt = collect.indexOf('        run: |\n')
  assert.notEqual(runAt, -1, 'the collect step has a run body')
  const collectBody: string[] = []
  for (const line of collect.slice(runAt + '        run: |\n'.length).split('\n')) {
    if (line !== '' && !line.startsWith('          ')) break
    collectBody.push(line.startsWith('          ') ? line.slice(10) : line)
  }

  for (const [name, body] of [
    ['the guard', guardBody],
    ['the release write', writeBody],
    ['the collect step', collectBody.join('\n')],
  ] as const) {
    assert.match(body, /classifyReleaseLookup/, `${name} calls the shared rule`)
    assert.ok(body.includes(LOOKUP), `${name} imports the shared rule`)
    assert.doesNotMatch(body, /grep -q/, `${name} does not grep the message`)
  }

  // #918: every lookup builds its path through the shared encoder, so a tag
  // with a slash is one segment instead of a deeper path the API reads as 404.
  for (const [name, body] of [
    ['the guard', guardBody],
    ['the release write', writeBody],
    ['the collect step', collectBody.join('\n')],
  ] as const) {
    assert.match(body, /releaseLookupPath/, `${name} encodes the tag as one path segment`)
    assert.doesNotMatch(body, /releases\/tags\/\$\{/, `${name} does not paste the raw tag into the path`)
  }

  // The old lenient read is gone from both workflows, and no inline grep survives
  // as a second classifier.
  assert.doesNotMatch(release, /gh release view/, 'release.yml reads the release state one way')
  assert.doesNotMatch(daily, /grep -q 'HTTP 404'/, 'daily-release.yml has no inline status grep')
  assert.doesNotMatch(release, /grep -q 'HTTP 404'/, 'release.yml has no inline status grep')
})
