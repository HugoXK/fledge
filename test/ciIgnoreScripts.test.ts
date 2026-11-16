import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// `npm ci` runs the lifecycle scripts of every dependency, so a compromised
// package gets code execution on the runner before any of our code runs (#646).
// The lint job is the first to install with `--ignore-scripts`. The test reads
// the command out of the workflow instead of hardcoding it: before the change
// it runs plain `npm ci` against the fixture below, the fixture's postinstall
// marker appears, and the test fails — so the red case is the real command, not
// an assertion about intent.
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const WORKFLOW = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
const FIXTURE = join(ROOT, 'test', 'fixtures', 'ignore-scripts')

function jobSection(name: string): string {
  const start = WORKFLOW.indexOf(`\n  ${name}:`)
  assert.notEqual(start, -1, `ci.yml has no \`${name}\` job`)
  const next = WORKFLOW.slice(start + 1).search(/\n {2}[a-zA-Z0-9_-]+:\n/)
  return next === -1 ? WORKFLOW.slice(start) : WORKFLOW.slice(start, start + 1 + next)
}

// Every install step the job runs, in order and as written. A second `npm ci`
// without the flag would execute scripts too, so all of them are judged.
function installCommands(): string[] {
  return [...jobSection('lint').matchAll(/^\s+- run: (npm (?:ci|install)\b.*)$/gm)].map((match) =>
    (match[1] ?? '').trim(),
  )
}

test('the lint job installs dependencies with lifecycle scripts disabled', () => {
  assert.deepEqual(
    installCommands(),
    ['npm ci --ignore-scripts'],
    'lint must install with --ignore-scripts and no other install step',
  )
  assert.match(jobSection('lint'), /^\s+- run: npm run lint$/m, 'lint no longer runs the linter')
})

test("a dependency postinstall never executes under the lint job's install command", () => {
  const commands = installCommands()
  assert.deepEqual(commands.length, 1, 'expected exactly one install step to judge')
  const command = commands[0]
  assert.ok(command, 'the lint job has no install step to judge')
  const parts = command.split(/\s+/)
  const tool = parts[0]
  assert.ok(tool, 'the install command is empty')
  const args = parts.slice(1)

  // The temp copy matters: if this test ever sees scripts run, the marker must
  // land in its own directory, never in the checked-in fixture.
  const dir = mkdtempSync(join(tmpdir(), 'fledge-ignore-scripts-'))
  try {
    cpSync(FIXTURE, dir, { recursive: true })
    const marker = join(dir, 'postinstall-ran.txt')
    const install = spawnSync(tool, args, {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        MARKER_PATH: marker,
        npm_config_cache: join(dir, '.npm-cache'),
      },
    })
    assert.equal(install.status, 0, `fixture install failed: ${install.stderr}`)
    assert.equal(
      existsSync(marker),
      false,
      "a dependency's postinstall ran under the lint job's install command",
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
