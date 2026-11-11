import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isMechanicalPath } from '../scripts/lib/mechanical-release.mjs'

// #263: the READMEs are the source of the published guide, and both carry the
// released version in a status line. A release that bumps package.json without
// them publishes a guide that names an older release, which is the drift #259
// fixed by hand. This is a text assertion, not a generator: it names the file and
// the line to edit, because a generator would make the release text a second
// source of truth for the feature list.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function read(file: string): string {
  return readFileSync(`${ROOT}/${file}`, 'utf8')
}

const { version } = JSON.parse(read('package.json')) as { version: string }

// The status block is the one place each README states the release, so the check
// anchors on its first line rather than on any version-looking text elsewhere.
const STATUS_MARKERS: Record<string, string> = {
  'README.md': '> **Status:**',
  'README.zh.md': '> **状态：**',
}

function statusLine(file: string): { text: string; line: number } {
  const marker = STATUS_MARKERS[file]
  assert.ok(marker !== undefined, `${file} has no status marker in this test`)
  const lines = read(file).split('\n')
  const index = lines.findIndex((line) => line.startsWith(marker))
  assert.ok(index >= 0, `${file} has no status line starting with ${JSON.stringify(marker)}`)
  return { text: lines[index] ?? '', line: index + 1 }
}

test('package.json carries a plain x.y.z version', () => {
  assert.match(version, /^\d+\.\d+\.\d+$/, `package.json version is not a plain x.y.z: ${version}`)
})

for (const file of Object.keys(STATUS_MARKERS)) {
  test(`${file} status line names the version in package.json`, () => {
    const { text, line } = statusLine(file)
    assert.ok(
      text.includes(`v${version}`),
      `${file}:${line} is stale: it must name v${version} to match package.json.\n` +
        `Edit that line (it is ${JSON.stringify(text.trim())}); do not add a second status block.`,
    )
  })
}

test('the two status lines name the same release', () => {
  const named = Object.keys(STATUS_MARKERS).map((file) => {
    const { text, line } = statusLine(file)
    const match = /v(\d+\.\d+\.\d+)/.exec(text)
    assert.ok(match !== null, `${file}:${line} names no vX.Y.Z release`)
    return { file, line, version: match[1] }
  })
  const [first, ...rest] = named
  for (const other of rest) {
    assert.equal(
      other.version,
      first?.version,
      `${other.file}:${other.line} names v${other.version} but ${first?.file}:${first?.line} names v${first?.version}`,
    )
  }
})

// The docs site must keep building from this repository, not from a pinned copy
// of the guide: a pinned copy is a second source of truth and would drift on its
// own release cadence.
test('the deploy doc still says the docs site builds from this repository', () => {
  const text = read('docs/deploy.md').replace(/\s+/g, ' ')
  assert.ok(
    text.includes("The documentation site builds from this repository's `README.md`, `README.zh.md` and `docs/` rather than a pinned copy"),
    'docs/deploy.md no longer states that the documentation site builds from this repository rather than a pinned copy',
  )
})

// T1 keeps the READMEs out of the mechanical release surface on purpose: adding
// them there changes the release routine from "a person updates the status line"
// to "the routine writes user-facing prose", which is a separate T3 decision.
test('the READMEs are not part of the mechanical release surface', () => {
  for (const file of Object.keys(STATUS_MARKERS)) {
    assert.equal(
      isMechanicalPath(file),
      false,
      `${file} is now in the mechanical release set; that is the separate release-policy decision #263 reserves, not a test change`,
    )
  }
})
