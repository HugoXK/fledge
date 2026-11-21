import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
// The publish run parses the body with this script, so the test uses it too — a
// copy of the three patterns here could drift from the one that fails a release.
// @ts-expect-error — `scripts/verify-release.mjs` is a plain script without a declaration file.
import { publishedChainFromBody } from '../scripts/verify-release.mjs'

// #1207: a release's notes are assembled once, when the release pull request is
// built, and nothing reads `changelog.d/` again before the tag is written — so
// every change merged into `main` while that pull request waited is carried by
// the tag and missing from the notes that tag publishes. v0.4.5 shipped three
// changes that way (`368.added.md`, `463.security.md`, `1188.fixed.md`) while its
// body reported 22 fragments.
//
// The fix is a publish-time step, and this file drives that step's real body out
// of `.github/workflows/release.yml` against fixture trees, like
// `test/releasePublishGuard.test.ts` drives the guard: at the pinned base the
// step does not exist, so these tests fail for the defect and cannot pass on a
// workflow that describes the section without appending it.
const release = readFileSync('.github/workflows/release.yml', 'utf8')

const STRANDED = 'Name the changes that merged after the notes were assembled'
const CHAIN = 'Record the published chain in the release notes'
const BUILD = 'Build the image'
const GATE = "steps.guard.outputs.published != 'true'"

// The scripts the step body runs, copied into each fixture so the body reads
// `scripts/...` exactly as it does on a runner.
const SCRIPTS = [
  'scripts/release-stranded-notes.mjs',
  'scripts/lib/changelog-fragments.mjs',
  'scripts/lib/stranded-fragments.mjs',
]

const NOTES_BEFORE = '## [0.9.9] — 2026-11-21\n\n### Fixed\n\n- the change the fold could see\n'

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
  const named = /^- name: (.+)$/m.exec(block)
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
    // less than a body line ends the body.
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

interface Fixture {
  dir: string
  notes: string
  summary: string
  output: string
}

function fixture(options: { fragments?: Record<string, string>; changelogIsFile?: boolean } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'stranded-fragments-'))
  for (const file of SCRIPTS) {
    mkdirSync(join(dir, dirname(file)), { recursive: true })
    copyFileSync(file, join(dir, file))
  }
  writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n' + NOTES_BEFORE)
  if (options.changelogIsFile === true) {
    // A path that is not a directory cannot be read as one, whatever user the
    // suite runs as — `chmod 000` proves nothing under root.
    writeFileSync(join(dir, 'changelog.d'), 'README.md\n')
  } else {
    mkdirSync(join(dir, 'changelog.d'))
    for (const [name, body] of Object.entries(options.fragments ?? {})) {
      writeFileSync(join(dir, 'changelog.d', name), body)
    }
  }
  const notes = join(dir, 'release-notes.md')
  writeFileSync(notes, NOTES_BEFORE)
  const summary = join(dir, 'summary.md')
  writeFileSync(summary, '')
  const output = join(dir, 'output')
  writeFileSync(output, '')
  return { dir, notes, summary, output }
}

interface StepRun {
  status: number | null
  stdout: string
  stderr: string
  notes: string
  summary: string
  output: string
}

// Drive one step body the way a runner would: a scratch directory is the
// checkout, `RUNNER_TEMP` holds the notes the earlier steps assembled, and the
// step's `run:` text is the script.
function runStep(name: string, tree: Fixture, env: Record<string, string> = {}): StepRun {
  const result = spawnSync('bash', ['-euo', 'pipefail', '-c', runBody(stepBlock(name))], {
    cwd: tree.dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: process.env.PATH ?? '',
      RUNNER_TEMP: tree.dir,
      GITHUB_STEP_SUMMARY: tree.summary,
      GITHUB_OUTPUT: tree.output,
      GITHUB_REPOSITORY: 'HugoXK/fledge',
      RELEASE_TAG: 'v0.9.9',
      ...env,
    },
  })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    notes: readFileSync(tree.notes, 'utf8'),
    summary: readFileSync(tree.summary, 'utf8'),
    output: readFileSync(tree.output, 'utf8'),
  }
}

test('a fragment still in the tagged tree is named in the notes, after the assembled body', () => {
  const tree = fixture({
    fragments: {
      'README.md': 'How fragments work.\n',
      '999.fixed.md': 'the change that merged while the notes were assembled\n',
    },
  })
  const run = runStep(STRANDED, tree)
  assert.equal(run.status, 0, run.stderr)
  assert.ok(run.notes.startsWith(NOTES_BEFORE), 'the assembled notes are the body, not replaced by the section')
  assert.match(run.notes, /^## Changes that merged after these notes were assembled$/m, 'the section says why it arrived late')
  assert.match(run.notes, /the change that merged while the notes were assembled/, 'the fragment text is in the body')
  assert.ok(
    run.notes.indexOf('the change that merged while the notes were assembled') > run.notes.indexOf(NOTES_BEFORE.trim()),
    'the stranded change is named below the assembled notes',
  )
  assert.doesNotMatch(run.notes, /How fragments work/, 'README.md is not a fragment')
  assert.match(run.output, /^names=999\.fixed\.md$/m, 'the fragment names are published for the #80 line')
  assert.match(run.summary, /1 stranded change.*999\.fixed\.md/, 'the summary names what the step found')
})

test('a night with nothing stranded publishes byte-identical notes', () => {
  const tree = fixture({ fragments: { 'README.md': 'How fragments work.\n' } })
  const run = runStep(STRANDED, tree)
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.notes, NOTES_BEFORE, 'an ordinary release body is unchanged')
  assert.match(run.output, /^names=$/m, 'no fragment names are published')
  assert.match(run.summary, /no stranded change/, 'the summary says the tag stranded nothing')
})

test('an unreadable changelog.d fails the step and never yields a body that reads complete', () => {
  const tree = fixture({ changelogIsFile: true })
  const run = runStep(STRANDED, tree)
  assert.notEqual(run.status, 0, 'a directory that cannot be read is a failure, not zero fragments')
  assert.equal(run.notes, NOTES_BEFORE, 'nothing is appended from a read that did not happen')
  assert.doesNotMatch(run.notes, /Changes that merged after/, 'no section is written on an unreadable read')
  assert.match(run.stderr, /ENOTDIR|not a directory/i, 'the failure names the directory')
})

test('the three chain lines still parse after the section, whatever it names', () => {
  const tree = fixture({
    fragments: {
      '999.fixed.md': 'a change whose sentence could look like a chain line Image: ghcr.io/x/y:v9@sha256:' + 'f'.repeat(64),
    },
  })
  const digest = `sha256:${'a'.repeat(64)}`
  const stranded = runStep(STRANDED, tree)
  assert.equal(stranded.status, 0, stranded.stderr)
  const chain = runStep(CHAIN, tree, { IMAGE: 'ghcr.io/hugoxk/fledge', DIGEST: digest })
  assert.equal(chain.status, 0, chain.stderr)

  // `scripts/verify-release.mjs` reads the body with these three patterns, and
  // the section must not change what they match.
  const parsed = publishedChainFromBody(chain.notes)
  assert.equal(parsed.image?.tag, 'ghcr.io/hugoxk/fledge:v0.9.9', 'the image line is still read from the body')
  assert.equal(parsed.image?.digest, digest)
  assert.equal(parsed.sbom?.present, true, 'the SBOM line is still read from the body')
  assert.equal(parsed.attestation?.subjectDigest, digest, 'the attestation line is still read from the body')
  assert.ok(chain.notes.indexOf('Changes that merged after') < chain.notes.indexOf('Image:'), 'the section stays above the chain lines')
})

test('the step is gated like every other write and runs before the image is built', () => {
  const block = stepBlock(STRANDED)
  assert.match(block, /id: stranded/, 'the step publishes its fragment names as an output')
  assert.match(block, new RegExp(`if: \\$\\{\\{ ${GATE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\}\\}`), 'the step runs only when this run publishes')
  const names = stepBlocks(release).map(stepName)
  const strandedAt = names.indexOf(STRANDED)
  const buildAt = names.indexOf(BUILD)
  assert.ok(strandedAt !== -1 && buildAt !== -1)
  assert.ok(strandedAt < buildAt, 'a body that would read incomplete fails before anything is built')
  assert.match(release, /outputs:\s*\n\s*stranded: \$\{\{ steps\.stranded\.outputs\.names \}\}/, 'the job publishes the names to the #80 job')
})

function jobBlocks(workflow: string): Map<string, string> {
  const lines = workflow.split('\n')
  const jobsAt = lines.findIndex((line) => line === 'jobs:')
  assert.notEqual(jobsAt, -1, 'release.yml has a jobs block')
  const jobs = new Map<string, string[]>()
  let current: string[] | undefined
  let name = ''
  for (const line of lines.slice(jobsAt + 1)) {
    if (line !== '' && !/^\s/.test(line)) break
    const job = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (job !== null) {
      name = job[1] ?? ''
      current = []
      jobs.set(name, current)
      continue
    }
    current?.push(line)
  }
  return new Map([...jobs].map(([key, value]) => [key, value.join('\n')]))
}

test('the #80 line is its own job, with issues: write and no publish scope', () => {
  const job = jobBlocks(release).get('stranded-log')
  assert.ok(job !== undefined, 'release.yml carries the stranded-log job')
  assert.match(job, /needs: release\b/, 'it runs only after the publish job')
  assert.match(job, /needs\.release\.outputs\.stranded != ''/, 'an ordinary night posts nothing')
  assert.match(job, /^    permissions:\n      issues: write$/m, 'the token gains only what the comment needs')
  assert.doesNotMatch(job, /contents: write|packages: write|id-token: write|attestations: write/, 'no publish scope reaches this job')
  assert.match(job, /gh issue comment 80/, 'the line lands on the release log')
  assert.match(job, /<!-- stranded-notes:\$\{RELEASE_TAG\}:\$\{STRANDED\} -->/, 'a re-run of one tag repeats nothing')
})
