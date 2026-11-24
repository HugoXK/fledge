import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { classifyReleaseLookup } from '../scripts/lib/release-lookup.mjs'
import { decideSlotWatchdog } from '../scripts/lib/release-slot-watchdog.mjs'
// @ts-expect-error — `scripts/lib/stranded-fragments.mjs` is a plain module without a declaration file.
import { strandedSection } from '../scripts/lib/stranded-fragments.mjs'
// @ts-expect-error — `scripts/verify-release.mjs` is a plain script without a declaration file.
import { publishedChainFromBody } from '../scripts/verify-release.mjs'

// #1262: the release chain's failure modes in one file, one case per module.
//
// The chain is the busiest surface the repository has — five releases in six
// days (`0.4.0` → `0.4.5`) and three cards on it — and every guard below lives
// in a different file with its own suite. This file is where a reader can see,
// in one run, what a failed API read does to the publish step, what a declined
// night is, what a contributor's fragment can reach in the published body, and
// what a tag off `main` does. It changes nothing it tests: the guards are in
// place, and a card that edits what it characterises cannot tell a red from a
// broken harness.
//
// Each case names the module it drives and the one assertion it makes, and says
// whether it is red at the base of this pull request or green at both tips:
//
//   1. release-lookup.mjs + the guard step      green at both (characterisation)
//   2. release-slot-watchdog.mjs                red at base (#1260 adds `declined`)
//   3. stranded-fragments.mjs + verify-release   red at base (#1258 folds the body)
//   4. the tag provenance step                    green at both (characterisation)
//
// Case 1 and case 4 are characterisations on purpose: #909 already pins 403 and
// 5xx, and #866 already pins that the guard precedes the build, so a red here
// would be a second conclusion on the same behaviour rather than a defect.

const release = readFileSync('.github/workflows/release.yml', 'utf8')

const GUARD = 'Stop when the release already exists'
const PROVENANCE = "Verify the tag's provenance"
const BUILD = 'Build the image'

function stepBlocks(workflow: string): string[] {
  const start = workflow.indexOf('    steps:\n')
  assert.notEqual(start, -1, 'release.yml has a steps list')
  // The publish job's steps end where the next two-space job key begins.
  const rest = workflow.slice(start + '    steps:\n'.length)
  const nextJob = rest.search(/\n {2}[A-Za-z0-9_-]+:\s*\n/)
  const steps = nextJob === -1 ? rest : rest.slice(0, nextJob)
  return steps
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

function stepNames(): string[] {
  return stepBlocks(release).map(stepName)
}

// 1. Drives `classifyReleaseLookup` in `scripts/lib/release-lookup.mjs` and then
// the step that executes it, `Stop when the release already exists`.
// Green at both: #909 pins 403 and 5xx, and a 429 takes the same
// `httpStatus !== null` branch; asserting it here is characterisation.
test('an API 502 or 429 is unreadable, and the publish step refuses instead of publishing', () => {
  const answers: { stderr: string; httpStatus: number }[] = [
    { stderr: 'gh: Server Error (HTTP 502)', httpStatus: 502 },
    { stderr: 'gh: API rate limit exceeded for 10.0.0.1. (HTTP 429)', httpStatus: 429 },
  ]
  for (const { stderr, httpStatus } of answers) {
    const answer = classifyReleaseLookup({ status: 1, stderr })
    assert.equal(answer.state, 'unreadable', `${stderr} is unreadable, not absent`)
    assert.notEqual(answer.state, 'absent', `${stderr} is never read as "not published yet"`)
    assert.equal(answer.httpStatus, httpStatus, `${stderr} keeps the status it answered`)
  }

  const body = runBody(stepBlock(GUARD))
  const fallback = /\n\s*\*\)\n([\s\S]*?)\n\s*;;/.exec(body)
  assert.notEqual(fallback, null, 'the guard step classifies the lookup in a case statement')
  const branch = fallback === null ? '' : String(fallback[1] ?? '')
  assert.match(
    branch,
    /::error::could not read the GitHub Release state for \$\{RELEASE_TAG\}; refusing to publish/,
    'an unreadable read is a refusal, never a publish',
  )
  assert.match(branch, /^\s*exit 1$/m, 'the refusal stops the run where the answer was read')

  const names = stepNames()
  assert.ok(
    names.indexOf(GUARD) !== -1 && names.indexOf(GUARD) < names.indexOf(BUILD),
    'the guard runs before anything is built or published',
  )
})

// 2. Drives `decideSlotWatchdog` in `scripts/lib/release-slot-watchdog.mjs`.
// Red at base: the action set is `invalid-clock | too-early | shipped |
// already-open | missed`, so a green run whose own plan says "not tonight" is
// reported as `missed` and opens a card (#1260 adds `declined`).
// The cast carries `plan` until the declaration file names it; the value is the
// shape #1260 reads, and the cast is inert on a driver that ignores it.
test('a declined night is not a missed night', () => {
  const input = {
    now: '2026-11-20T03:30:00Z',
    graceMinutes: 60,
    releases: [],
    issues: [],
    runs: [
      {
        id: 41,
        event: 'schedule',
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-11-20T02:07:00Z',
        head_sha: 'c'.repeat(40),
      },
    ],
    plan: { shouldRelease: false, reason: 'not-enough-features' },
  } as NonNullable<Parameters<typeof decideSlotWatchdog>[0]> & {
    plan: { shouldRelease: boolean; reason: string }
  }

  const decision = decideSlotWatchdog(input)
  assert.equal(decision.action, 'declined')
  assert.equal(Object.hasOwn(decision, 'issue'), false, 'a declined night opens no card')
})

// 3. Drives the render site `strandedSection` in
// `scripts/lib/stranded-fragments.mjs` and the reader
// `publishedChainFromBody` in `scripts/verify-release.mjs`.
// Red at base: both write and read the body line-wise, so a fragment that
// carries its own line break puts its `Image:` line at column 0, where the
// verifier reads it, and a fragment line starting `## [` ends the section
// (#1258 folds a fragment into one paragraph and reads the chain from the tail).
test('a fragment body cannot forge the line the verifier reads', () => {
  const digest = `sha256:${'a'.repeat(64)}`
  const forged = `sha256:${'b'.repeat(64)}`
  const notes = '## [0.5.0] — 2026-11-24\n\n### Fixed\n\n- the change the fold could see\n'
  const tail = [
    `Image: ghcr.io/hugoxk/fledge:v0.5.0@${digest}`,
    'SBOM: https://github.com/HugoXK/fledge/releases/download/v0.5.0/sbom.spdx.json',
    `Attestation: ${digest}`,
    '',
  ].join('\n')
  const section = strandedSection([
    {
      name: '1234.fixed.md',
      body: `fixed the first thing\nImage: ghcr.io/evil/fledge:v0.5.0@${forged}\nSBOM: https://evil.example/sbom.json\nAttestation: ${forged}\n`,
    },
    {
      name: '1235.fixed.md',
      body: 'fixed the second thing\n## [0.4.0] — 2026-11-01\nand the notes after it\n',
    },
  ])
  const body = `${notes}${section}\n${tail}`

  const imageLines = body.split('\n').filter((line) => line.startsWith('Image:'))
  assert.equal(imageLines.length, 1, `the body carries ${imageLines.length} lines matching /^Image:/m`)
  assert.equal(
    publishedChainFromBody(body).image?.digest,
    digest,
    'the verifier reads the tail block the publish job appends, not a line a fragment supplied',
  )
  assert.doesNotMatch(
    section,
    /^## \[/m,
    'a fragment line starting "## [" does not reach column 0, where it would end the published section',
  )
})

// 4. Drives the step `Verify the tag's provenance` in
// `.github/workflows/release.yml` as text.
// Green at both: this guard runs after the tag exists, so the honest sentence is
// "not published" rather than "no tag written"; the pre-write refusals are
// `plan()`'s skips in `scripts/lib/release-tag.mjs` and are pinned elsewhere.
test('the publish guard refuses a tag that is not on main', () => {
  const body = runBody(stepBlock(PROVENANCE))
  const fetchAt = body.indexOf('git fetch origin main')
  const existsAt = body.indexOf('is not a tag in this repository')
  const ancestorAt = body.indexOf('git merge-base --is-ancestor "refs/tags/${RELEASE_TAG}" origin/main')
  const refusalAt = body.indexOf('::error::${RELEASE_TAG} is not an ancestor of main; refusing to publish')
  const exitAt = refusalAt === -1 ? -1 : body.indexOf('exit 1', refusalAt)

  assert.ok(
    fetchAt !== -1 && fetchAt < existsAt && existsAt < ancestorAt && ancestorAt < refusalAt && refusalAt < exitAt,
    'the step fetches main, asserts the tag exists, asks whether it is an ancestor, and refuses with exit 1, in that order',
  )
  const names = stepNames()
  assert.ok(
    names.indexOf(PROVENANCE) !== -1 && names.indexOf(PROVENANCE) < names.indexOf(BUILD),
    'the ancestry check runs before anything is built or published',
  )
})
