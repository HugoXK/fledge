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

const release = readFileSync('.github/workflows/release.yml', 'utf8')
const GUARD = 'Stop when the release already exists'
const GATE = "steps.guard.outputs.published != 'true'"

function stepBlocks(workflow: string): string[] {
  const start = workflow.indexOf('    steps:\n')
  assert.notEqual(start, -1, 'release.yml has a steps list')
  return workflow
    .slice(start + '    steps:\n'.length)
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

function guardBlock(): string {
  const block = stepBlocks(release).find((candidate) => stepName(candidate) === GUARD)
  assert.ok(block !== undefined, `release.yml declares the step "${GUARD}"`)
  return block
}

interface GuardRun {
  status: number | null
  output: string
  summary: string
}

function runGuard(ghStatus: number): GuardRun {
  const dir = mkdtempSync(join(tmpdir(), 'release-guard-'))
  try {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const gh = join(bin, 'gh')
    writeFileSync(gh, `#!/usr/bin/env bash\nexit ${String(ghStatus)}\n`)
    chmodSync(gh, 0o755)
    const output = join(dir, 'output')
    const summary = join(dir, 'summary.md')
    writeFileSync(output, '')
    writeFileSync(summary, '')
    const result = spawnSync('bash', ['-c', runBody(guardBlock())], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        RELEASE_TAG: 'v0.3.2',
      },
    })
    return { status: result.status, output: readFileSync(output, 'utf8'), summary: readFileSync(summary, 'utf8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a release that already exists ends the run before anything is built', () => {
  const run = runGuard(0)
  assert.equal(run.status, 0, 'the guard is a clean exit, not a failure')
  assert.match(run.output, /^published=true$/m, 'the run is marked as already published')
  assert.match(run.summary, /already|exists/i, 'the summary says why the run stopped')
})

test('a release that does not exist still publishes', () => {
  const run = runGuard(1)
  assert.equal(run.status, 0, 'a missing release is not an error')
  assert.match(run.output, /^published=false$/m, 'the run is marked as not published')
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

test('the guard reads the release state, it does not trust a local file', () => {
  const body = runBody(guardBlock())
  assert.match(body, /gh release view "\$\{?RELEASE_TAG\}?"/, 'the release state comes from the API for this tag')
  assert.match(body, /GITHUB_OUTPUT/, 'the answer is an output the publishing steps read')
  assert.equal(body.includes('${{'), false, 'no expression is spliced into the shell body')
})
