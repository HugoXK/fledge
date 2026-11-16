import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// #868: an install lifecycle script runs inside the job that installs the
// dependency, and every gate that follows it trusts the tree it produced. Only
// `lint` was pinned to `npm ci --ignore-scripts` by #646, so a compromised
// dependency could still rewrite the source, the coverage report or the build
// output before `typecheck`, `test`, `coverage`, `build`, `visual` and `audit`
// read them. This test reads the files the way CI does and fails on the next
// unguarded `npm ci` instead of waiting for a reviewer to notice it.

const root = fileURLToPath(new URL('..', import.meta.url))
const workflowsDir = fileURLToPath(new URL('../.github/workflows/', import.meta.url))
const DOCKERFILE = 'Dockerfile'

// The release job installs with a write token and a narrower boundary: its own
// card (#648) owns that line and this change must not be smuggled into it. The
// waiver is a file name with a reason, and a test below keeps it honest — an
// entry here is never a silent wildcard.
const WAIVERS = new Map<string, string>([
  ['.github/workflows/release.yml', '#648 owns the release job install (write token, tag provenance); #868 covers the gates and the image'],
])

interface InstallLine {
  file: string
  line: number
  text: string
}

function installs(file: string, text: string): InstallLine[] {
  const found: InstallLine[] = []
  const lines = text.split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    // A mention in a comment is documentation, not an install.
    if (trimmed.startsWith('#')) continue
    if (/\bnpm ci\b/.test(trimmed)) found.push({ file, line: index + 1, text: trimmed })
  }
  return found
}

function guarded(entry: InstallLine): boolean {
  return entry.text.includes('--ignore-scripts')
}

test('every gate install in ci.yml disables dependency lifecycle scripts', () => {
  const text = readFileSync(`${workflowsDir}ci.yml`, 'utf8')
  const unguarded = installs('.github/workflows/ci.yml', text).filter((entry) => !guarded(entry))
  assert.deepEqual(
    unguarded.map((entry) => `ci.yml:${String(entry.line)} ${entry.text}`),
    [],
    'a gate job installs with `npm ci --ignore-scripts`; a dependency script must not run before the gates read the tree',
  )
  // The other half of the property: the guards did not delete the installs.
  const guardedCount = installs('.github/workflows/ci.yml', text).filter(guarded).length
  assert.ok(guardedCount >= 7, `ci.yml keeps every gate install, with scripts disabled (found ${String(guardedCount)})`)
})

test('the image installs without lifecycle scripts in both stages', () => {
  const text = readFileSync(`${root}${DOCKERFILE}`, 'utf8')
  const lines = installs(DOCKERFILE, text)
  assert.ok(lines.length >= 2, 'both the build and the runtime stage install dependencies')
  assert.deepEqual(
    lines.filter((entry) => !guarded(entry)).map((entry) => `${DOCKERFILE}:${String(entry.line)} ${entry.text}`),
    [],
    'the Dockerfile installs with `--ignore-scripts`; the runtime stage also keeps `--omit=dev`',
  )
  assert.ok(lines.some((entry) => entry.text.includes('--omit=dev')), 'the runtime stage still omits dev dependencies')
})

test('no other workflow adds an unguarded install without a named waiver', () => {
  const files = readdirSync(workflowsDir).filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  const offenders: string[] = []
  for (const name of files) {
    const path = `.github/workflows/${name}`
    if (WAIVERS.has(path)) continue
    const text = readFileSync(`${workflowsDir}${name}`, 'utf8')
    for (const entry of installs(path, text)) {
      if (!guarded(entry)) offenders.push(`${path}:${String(entry.line)} ${entry.text}`)
    }
  }
  assert.deepEqual(offenders, [], 'a new unguarded install needs `--ignore-scripts` or a reasoned entry in WAIVERS')
})

test('each waiver names a file and a reason, and the release job is the only one', () => {
  for (const [path, reason] of WAIVERS) {
    assert.match(path, /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/, 'a waiver is one workflow file, never a directory or a pattern')
    assert.ok(reason.length >= 40, `the waiver for ${path} carries a real reason`)
  }
  assert.deepEqual([...WAIVERS.keys()], ['.github/workflows/release.yml'])
  // The waived file must actually contain the install the waiver covers: a
  // waiver for a file that no longer runs `npm ci` is a hole nobody can see.
  const release = readFileSync(`${workflowsDir}release.yml`, 'utf8')
  assert.ok(installs('.github/workflows/release.yml', release).some((entry) => !guarded(entry)), 'the waiver still describes the release install')
})
