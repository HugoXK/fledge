import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// #348: the mechanical release tree must pass the suite it lands with. The
// routine produced package.json, package-lock.json, docker-compose.yml and
// CHANGELOG.md but left both README status lines one release behind, so every
// release pull request was red by construction (#347). This drives the writer
// the workflow runs - `node scripts/changelog.mjs release <version> --date …`
// (`scripts/changelog.mjs:127` -> `bumpVersions()`) - against a scratch tree and
// asserts what it writes into the two READMEs. It is the half a surface test
// cannot cover: widening a path list alone would pass while no status line was
// ever written.

const SCRIPT = fileURLToPath(new URL('../scripts/changelog.mjs', import.meta.url))
const PREVIOUS = '1.2.2'
const PLANNED = '1.2.3'
const PREVIOUS_DATE = '2026-11-11'
const PLANNED_DATE = '2026-12-31'

const README = `# Fixture

> **Status:** \`v${PREVIOUS}\` is the latest release (${PREVIOUS_DATE}) at <https://fledge.hugoxk.online/>.

Some prose that a release must not touch.
`

const README_ZH = `# Fixture

> **状态：** 最新发布是 \`v${PREVIOUS}\`（${PREVIOUS_DATE}）：<https://fledge.hugoxk.online/>。

一段发布不应改动的说明。
`

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-status-writer-'))
  mkdirSync(join(dir, 'changelog.d'))
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'fixture', version: PREVIOUS }, null, 2)}\n`)
  writeFileSync(
    join(dir, 'package-lock.json'),
    `${JSON.stringify({ name: 'fixture', version: PREVIOUS, packages: { '': { version: PREVIOUS } } }, null, 2)}\n`,
  )
  writeFileSync(join(dir, 'docker-compose.yml'), `services:\n  app:\n    image: fledge:${PREVIOUS}\n`)
  writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n')
  writeFileSync(join(dir, 'changelog.d', 'fixture.added.md'), 'A fixture fragment.\n')
  writeFileSync(join(dir, 'README.md'), README)
  writeFileSync(join(dir, 'README.zh.md'), README_ZH)
  return dir
}

function release(twice = false): { dir: string; stdout: string; stderr: string; code: number } {
  const dir = fixture()
  const run = () =>
    spawnSync(process.execPath, [SCRIPT, 'release', PLANNED, '--date', PLANNED_DATE], { cwd: dir, encoding: 'utf8' })
  const first = run()
  if (!twice) return { dir, code: first.status ?? 1, stdout: first.stdout ?? '', stderr: first.stderr ?? '' }
  const second = run()
  return { dir, code: second.status ?? 1, stdout: second.stdout ?? '', stderr: second.stderr ?? '' }
}

function statusLine(text: string, marker: string): { line: string; index: number } {
  const lines = text.split('\n')
  const index = lines.findIndex((line) => line.startsWith(marker))
  assert.ok(index >= 0, `the fixture README has no status line starting with ${JSON.stringify(marker)}`)
  return { line: lines[index] ?? '', index }
}

test('the release writer moves both README status lines to the planned version and date', () => {
  const { dir, code, stdout, stderr } = release()
  try {
    assert.equal(code, 0, `node scripts/changelog.mjs release ${PLANNED} exited ${code}: ${stderr === '' ? stdout : stderr}`)
    const { version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string }
    assert.equal(version, PLANNED, 'the fixture tree was not bumped, so the case cannot judge the READMEs')

    for (const [file, marker] of [
      ['README.md', '> **Status:**'],
      ['README.zh.md', '> **状态：**'],
    ] as const) {
      const { line, index } = statusLine(readFileSync(join(dir, file), 'utf8'), marker)
      assert.ok(
        line.includes(`v${PLANNED}`),
        `${file}:${index + 1} is stale after the release: it must name v${PLANNED} to match package.json.\n` +
          `The writer left it at ${JSON.stringify(line.trim())}.`,
      )
      assert.ok(
        line.includes(PLANNED_DATE),
        `${file}:${index + 1} still carries the previous release date: it must be (${PLANNED_DATE}) to match ` +
          `the date the release was assembled for.\nThe writer left it at ${JSON.stringify(line.trim())}.`,
      )
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the release writer changes only the status line in each README', () => {
  const { dir, code, stdout, stderr } = release()
  try {
    assert.equal(code, 0, `node scripts/changelog.mjs release ${PLANNED} exited ${code}: ${stderr === '' ? stdout : stderr}`)
    for (const [file, marker, before] of [
      ['README.md', '> **Status:**', README],
      ['README.zh.md', '> **状态：**', README_ZH],
    ] as const) {
      const after = readFileSync(join(dir, file), 'utf8')
      const oldLines = before.split('\n')
      const newLines = after.split('\n')
      assert.equal(
        newLines.length,
        oldLines.length,
        `${file} gained or lost a line during the release; only its status line may change`,
      )
      const changed = newLines.map((line, index) => (line === oldLines[index] ? null : index)).filter((index) => index !== null)
      assert.equal(
        changed.length,
        1,
        `${file} changed ${changed.length} line(s), not exactly its status line; a release writes the version ` +
          `and the date and nothing else in that file`,
      )
      const { index } = statusLine(before, marker)
      assert.equal(changed[0], index, `${file}:${String(changed[0]) + 1} changed, but the status line is ${index + 1}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the release writer leaves the READMEs alone when the version is already planned', () => {
  // `bumpVersions` returns early when package.json already names the version; the
  // status lines must then stay byte-identical rather than move the date.
  const dir = fixture()
  try {
    writeFileSync(
      join(dir, 'package.json'),
      `${JSON.stringify({ name: 'fixture', version: PLANNED }, null, 2)}\n`,
    )
    const result = spawnSync(process.execPath, [SCRIPT, 'release', PLANNED, '--date', PLANNED_DATE], {
      cwd: dir,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, `the release of an already-planned version exited ${result.status}: ${result.stderr}`)
    assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), README, 'README.md moved although the version did not')
    assert.equal(readFileSync(join(dir, 'README.zh.md'), 'utf8'), README_ZH, 'README.zh.md moved although the version did not')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
