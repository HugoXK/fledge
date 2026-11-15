import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// `restore-drill` used to `npm ci` and `npm run build` after `build` had already
// done both. Reusing the artifact is only safe if the consumer can prove it was
// built from the commit under test: an artifact that is stale, partial or from
// another run must fail loudly, never run in place of this tree (#643).
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(ROOT, 'scripts', 'dist-manifest.mjs')
const WORKFLOW = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')

function jobSection(name: string): string {
  const start = WORKFLOW.indexOf(`\n  ${name}:`)
  assert.notEqual(start, -1, `ci.yml has no \`${name}\` job`)
  const next = WORKFLOW.slice(start + 1).search(/\n {2}[a-zA-Z0-9_-]+:\n/)
  return next === -1 ? WORKFLOW.slice(start) : WORKFLOW.slice(start, start + 1 + next)
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function fakeDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-dist-manifest-'))
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'app.js'), 'console.log("app")\n')
  writeFileSync(join(dir, 'lib', 'db.js'), 'export const name = "db"\n')
  return dir
}

function cli(cwd: string, ...args: string[]) {
  // A negative assertion would pass on a tree where the checker does not exist,
  // so every case first proves the checker it is judging is there.
  assert.ok(existsSync(CLI), 'scripts/dist-manifest.mjs is missing')
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' })
}

test('the drill reuses the build artifact instead of installing and building again', () => {
  const drill = jobSection('restore-drill')
  assert.match(drill, /needs: \[changes, build\]/)
  assert.match(drill, /uses: actions\/download-artifact@[0-9a-f]{40}/)
  assert.match(drill, /name: fledge-dist/)
  assert.doesNotMatch(drill, /npm ci/, 'restore-drill still installs dependencies')
  assert.doesNotMatch(drill, /npm run build/, 'restore-drill still builds a second time')
  assert.match(drill, /node scripts\/dist-manifest\.mjs verify/, 'the drill does not verify the artifact it runs')
  assert.match(drill, /--commit "\$GITHUB_SHA"/)
})

test('the build job publishes the commit its artifact was built from', () => {
  const build = jobSection('build')
  assert.match(build, /node scripts\/dist-manifest\.mjs write/, 'build does not write the provenance manifest')
  assert.match(build, /--commit "\$GITHUB_SHA"/)
  assert.match(build, /name: fledge-dist/)
})

test('the artifact is downloaded, then verified, then used', () => {
  const drill = jobSection('restore-drill')
  const download = drill.indexOf('actions/download-artifact@')
  const verify = drill.indexOf('node scripts/dist-manifest.mjs verify')
  const run = drill.indexOf('node scripts/restore-drill-ci.mjs')
  assert.ok(download !== -1 && verify !== -1 && run !== -1)
  assert.ok(download < verify, 'the drill verifies before downloading')
  assert.ok(verify < run, 'the drill runs before the artifact is verified')
})

test('a manifest names the commit and hashes every file in dist', () => {
  const dir = fakeDist()
  try {
    const written = cli(dir, 'write', '--dir', dir, '--commit', 'a'.repeat(40))
    assert.equal(written.status, 0, written.stderr)
    const manifest = readJson(join(dir, 'build-manifest.json'))
    assert.equal(manifest.commit, 'a'.repeat(40))
    const files = manifest.files as Record<string, string>
    assert.deepEqual(Object.keys(files).sort(), ['app.js', 'lib/db.js'])
    assert.match(files['app.js'] ?? '', /^[0-9a-f]{64}$/)
    const ok = cli(dir, 'verify', '--dir', dir, '--commit', 'a'.repeat(40))
    assert.equal(ok.status, 0, ok.stderr)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an artifact from another commit is refused, not run', () => {
  const dir = fakeDist()
  try {
    assert.equal(cli(dir, 'write', '--dir', dir, '--commit', 'a'.repeat(40)).status, 0)
    const wrong = cli(dir, 'verify', '--dir', dir, '--commit', 'b'.repeat(40))
    assert.notEqual(wrong.status, 0)
    assert.match(wrong.stderr, /commit/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an edited or partial artifact is refused, not run', () => {
  const dir = fakeDist()
  try {
    assert.equal(cli(dir, 'write', '--dir', dir, '--commit', 'a'.repeat(40)).status, 0)
    writeFileSync(join(dir, 'lib', 'db.js'), 'export const name = "tampered"\n')
    const tampered = cli(dir, 'verify', '--dir', dir, '--commit', 'a'.repeat(40))
    assert.notEqual(tampered.status, 0)
    assert.match(tampered.stderr, /sha256|hash|changed/i)

    assert.equal(cli(dir, 'write', '--dir', dir, '--commit', 'a'.repeat(40)).status, 0)
    rmSync(join(dir, 'app.js'))
    const partial = cli(dir, 'verify', '--dir', dir, '--commit', 'a'.repeat(40))
    assert.notEqual(partial.status, 0)
    assert.match(partial.stderr, /missing/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an artifact with no manifest, or an empty one, is refused', () => {
  const dir = fakeDist()
  try {
    const noManifest = cli(dir, 'verify', '--dir', dir, '--commit', 'a'.repeat(40))
    assert.notEqual(noManifest.status, 0)
    assert.match(noManifest.stderr, /manifest/i)

    writeFileSync(join(dir, 'build-manifest.json'), '{}\n')
    const malformed = cli(dir, 'verify', '--dir', dir, '--commit', 'a'.repeat(40))
    assert.notEqual(malformed.status, 0)
    assert.match(malformed.stderr, /manifest/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a file the build never emitted is refused', () => {
  const dir = fakeDist()
  try {
    assert.equal(cli(dir, 'write', '--dir', dir, '--commit', 'a'.repeat(40)).status, 0)
    writeFileSync(join(dir, 'injected.js'), 'export {}\n')
    const extra = cli(dir, 'verify', '--dir', dir, '--commit', 'a'.repeat(40))
    assert.notEqual(extra.status, 0)
    assert.match(extra.stderr, /not in the manifest|unexpected/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
