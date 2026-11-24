import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  'scripts/changelog.mjs',
  'scripts/lib/changelog-fragments.mjs',
  'scripts/lib/mechanical-release.mjs',
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

function fixture(options: { fragments?: Record<string, string>; changelogIsFile?: boolean; missingDir?: boolean } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'stranded-fragments-'))
  for (const file of SCRIPTS) {
    mkdirSync(join(dir, dirname(file)), { recursive: true })
    copyFileSync(file, join(dir, file))
  }
  writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n' + NOTES_BEFORE)
  if (options.missingDir === true) {
    // A tag cut before `changelog.d` existed: the directory is absent, which is
    // a tag that predates fragments rather than a read that failed.
  } else if (options.changelogIsFile === true) {
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

// #1218 secondary: a tag cut before `changelog.d` existed carries no fragments,
// so the step reports zero stranded changes instead of failing a publish for a
// directory that tag never had (`v0.1.0` is one). The rule is narrow on purpose:
// `ENOENT` means absence, and every other read failure still throws — the test
// above is the arm that must keep failing at both tips, so a broad `catch {}`
// cannot pass this pair.
test('a tag with no changelog.d reports zero stranded changes instead of failing', () => {
  const tree = fixture({ missingDir: true })
  const run = runStep(STRANDED, tree)
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.notes, NOTES_BEFORE, 'a tag that predates fragments appends nothing')
  assert.doesNotMatch(run.notes, /Changes that merged after/, 'no section is written for an absent directory')
  assert.match(run.output, /^names=$/m, 'no fragment names are published')
  assert.match(run.summary, /no stranded change/, 'the summary says the tag stranded nothing')
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

// #1218: a fragment body is contributor-written free text, and both render sites
// put it into the body as `- ${body}` — which keeps every line after an inner
// break at column 0. The release verifier reads `/^Image:/m`, so a body that
// carries its own break and its own `Image:` line supplies the digest the
// release is judged against. `/m` treats `\r`, `\u2028` and `\u2029` as line
// ends exactly as it treats `\n`, so a fold written for `\n` alone closes one of
// four entrances.
const FORGED = `sha256:${'a'.repeat(64)}`
const REAL = `sha256:${'b'.repeat(64)}`

function forgedBody(separator: string): string {
  return ['a change', `Image: ghcr.io/evil/not-fledge:v0.9.9@${FORGED}`, `Attestation: ${FORGED}`].join(separator)
}

function chainLines(): string {
  return [
    `Image: ghcr.io/hugoxk/fledge:v0.9.9@${REAL}`,
    'SBOM: https://github.com/HugoXK/fledge/releases/download/v0.9.9/sbom.spdx.json',
    `Attestation: ${REAL}`,
  ].join('\n')
}

function columnZero(text: string, prefix: string): string[] {
  return text.split(/\r\n|\r|\n|\u2028|\u2029/).filter((line) => line.startsWith(prefix))
}

function runChangelog(dir: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['scripts/changelog.mjs', ...args], { cwd: dir, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

// The #1207 section is one render site; `scripts/changelog.mjs` is the other, and
// it needs no stranded section at all. Both have to be driven, because a fold
// that only covers one leaves the release forgeable through the other.
test('a fragment body cannot forge the chain line on the stranded path', () => {
  const tree = fixture({ fragments: { '999.fixed.md': forgedBody('\n') } })
  const stranded = runStep(STRANDED, tree)
  assert.equal(stranded.status, 0, stranded.stderr)
  const chain = runStep(CHAIN, tree, { IMAGE: 'ghcr.io/hugoxk/fledge', DIGEST: REAL })
  assert.equal(chain.status, 0, chain.stderr)

  const parsed = publishedChainFromBody(chain.notes)
  assert.equal(parsed.image?.digest, REAL, 'the forged Image: line must not be read as the chain')
  assert.equal(parsed.attestation?.subjectDigest, REAL, 'the attested subject is the digest this run published')
  assert.equal(columnZero(chain.notes, 'Image:').length, 1, 'exactly one column-0 Image: line reaches the body')
})

test('a fragment body cannot forge the chain through the ordinary assembly path, under any line terminator', () => {
  const separators: Array<[string, string]> = [
    ['LF', '\n'],
    ['CR', '\r'],
    ['LS', '\u2028'],
    ['PS', '\u2029'],
  ]
  for (const [label, separator] of separators) {
    const tree = fixture({ fragments: { '999.fixed.md': forgedBody(separator) } })
    const released = runChangelog(tree.dir, ['release', '0.9.9', '--date', '2026-11-21', '--dry-run'])
    assert.equal(released.status, 0, `${label}: ${released.stderr}`)
    writeFileSync(join(tree.dir, 'CHANGELOG.md'), released.stdout)
    const notes = runChangelog(tree.dir, ['notes', '0.9.9'])
    assert.equal(notes.status, 0, `${label}: ${notes.stderr}`)

    const body = `${notes.stdout.trimEnd()}\n\n${chainLines()}\n`
    const parsed = publishedChainFromBody(body)
    assert.equal(parsed.image?.digest, REAL, `${label}: the forged line must not win without a stranded section`)
    assert.equal(parsed.attestation?.subjectDigest, REAL, `${label}: the attested subject is the digest this run published`)
    assert.equal(columnZero(body, 'Image:').length, 1, `${label}: no forged column-0 Image: line survives`)
  }
})

test('changelog check refuses a fragment that is not one paragraph', () => {
  const tree = fixture({ fragments: { '999.fixed.md': forgedBody('\r') } })
  const run = runChangelog(tree.dir, ['check'])
  assert.notEqual(run.status, 0, 'a fragment that can forge a chain line must fail where it is added, not in the tag run')
  assert.match(run.stderr, /999\.fixed\.md/, 'the failure names the file')
})

test('changelog check still admits a one-paragraph fragment that merely mentions the shape', () => {
  const tree = fixture({ fragments: { '999.fixed.md': 'a change whose sentence mentions Image: ghcr.io/x/y:v9 as prose\n' } })
  const run = runChangelog(tree.dir, ['check'])
  assert.equal(run.status, 0, run.stdout + run.stderr)
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

// The #80 job has no checkout, and `gh` resolves the repository for `gh issue
// comment` from `GH_REPO` or a git remote — `GITHUB_REPOSITORY` is not something
// gh reads; the body only uses it to build the API path. The review at
// `7557fb61` found the job failing on the one night it exists for: notes right,
// no line on #80, red run. These tests drive the step body with a stub `gh` that
// refuses an `issue comment` it cannot place, the way the client does, so the
// job's own env decides whether the line can post — a job that names no
// repository fails here instead of in production.
const COMMENT_STEP = 'Comment on #80'

const ENV_FIXTURES: Record<string, string> = {
  '${{ inputs.tag || github.ref_name }}': 'v0.3.2',
  '${{ needs.release.outputs.stranded }}': '999.fixed.md',
  '${{ github.repository }}': 'HugoXK/fledge',
  '${{ secrets.GITHUB_TOKEN }}': 'stub-token',
}

// Env is the thing under test, so it is read out of the workflow and handed to
// the body as a runner would: job keys sit at six spaces, step keys at ten, and a
// value the test cannot stand in for is a failure, not a literal passed through.
function workflowEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const entry = /^ {6}(?: {4})?([A-Z][A-Z0-9_]*): (.+)$/.exec(line)
    if (entry === null) continue
    const value = (entry[2] ?? '').trim()
    const fixture = ENV_FIXTURES[value]
    assert.ok(fixture !== undefined, `the test knows what "${value}" stands for`)
    env[entry[1] ?? ''] = fixture
  }
  return env
}

function commentBlock(job: string): string {
  const at = job.indexOf(`      - name: ${COMMENT_STEP}`)
  assert.notEqual(at, -1, `the stranded-log job declares the step "${COMMENT_STEP}"`)
  return job.slice(at)
}

interface CommentRun {
  status: number | null
  commands: string
  repoSeen: string
  summary: string
  stderr: string
}

function runCommentStep(apiJson: string): CommentRun {
  const dir = mkdtempSync(join(tmpdir(), 'stranded-log-'))
  try {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const commands = join(dir, 'commands')
    writeFileSync(commands, '')
    const repoSeen = join(dir, 'repo')
    writeFileSync(repoSeen, '')
    const api = join(dir, 'comments.json')
    writeFileSync(api, apiJson)
    // The stub answers as `gh` does: an API path needs no repository, and an
    // `issue comment` without `GH_REPO`, `--repo` or a token is the failure this
    // job hit in production.
    const stub = [
      '#!/usr/bin/env bash',
      'printf "%s\\n" "$*" >> "$STUB_LOG"',
      'printf "%s\\n" "${GH_REPO:-<unset>}" > "$STUB_REPO"',
      'case "$1 $2" in',
      '  "api --paginate") cat "$STUB_API"; exit 0 ;;',
      '  "issue comment")',
      '    case " $* " in *" --repo "*|*" -R "*) exit 0 ;; esac',
      '    if [ -z "${GH_REPO:-}" ]; then',
      '      echo "gh: could not determine base repo; set GH_REPO or --repo" >&2',
      '      exit 1',
      '    fi',
      '    if [ -z "${GH_TOKEN:-}" ]; then',
      '      echo "gh: no authentication token; set GH_TOKEN" >&2',
      '      exit 4',
      '    fi',
      '    exit 0 ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n')
    const ghPath = join(bin, 'gh')
    writeFileSync(ghPath, stub)
    chmodSync(ghPath, 0o755)
    const job = jobBlocks(release).get('stranded-log')
    assert.ok(job !== undefined, 'release.yml carries the stranded-log job')
    const block = commentBlock(job)
    const summary = join(dir, 'summary.md')
    writeFileSync(summary, '')
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', runBody(block)], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...workflowEnv(job),
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_REPOSITORY: 'HugoXK/fledge',
        STUB_LOG: commands,
        STUB_REPO: repoSeen,
        STUB_API: api,
      },
    })
    return {
      status: result.status,
      commands: readFileSync(commands, 'utf8'),
      repoSeen: readFileSync(repoSeen, 'utf8'),
      summary: readFileSync(summary, 'utf8'),
      stderr: result.stderr,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the #80 job hands gh a repository, so its line can post after the release', () => {
  // The behaviour first: the body is driven with the job's own env, so a job
  // that names no repository fails here — on `gh: could not determine base repo`
  // — instead of on the text assertion below.
  const run = runCommentStep('[]')
  assert.equal(run.status, 0, `the step body could not post with the job's own env: ${run.stderr}`)
  assert.match(run.commands, /^issue comment 80 --body /m, 'the line is posted')
  assert.equal(
    run.repoSeen.trim(),
    'HugoXK/fledge',
    'gh received GH_REPO — the API path carries the repository in its URL, the comment call does not',
  )
  assert.match(run.summary, /^commented <!-- stranded-notes:v0\.3\.2:999\.fixed\.md -->/m, 'the summary names what landed')
  const job = jobBlocks(release).get('stranded-log')
  assert.ok(job !== undefined, 'release.yml carries the stranded-log job')
  assert.match(job, /^      GH_REPO: \$\{\{ github\.repository \}\}$/m, 'the job names the repository gh must use')
})

test('a re-run of one tag posts no second line on #80', () => {
  const run = runCommentStep('[{"body":"<!-- stranded-notes:v0.3.2:999.fixed.md -->\\n\\nearlier"}]')
  assert.equal(run.status, 0, `the step body failed on an existing marker: ${run.stderr}`)
  assert.doesNotMatch(run.commands, /^issue comment /m, 'no comment when the marker is the last line on the issue')
  assert.match(run.summary, /already commented/, 'the summary says why nothing was posted')
})
