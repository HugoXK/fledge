import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// #868: an install lifecycle script runs inside the job that installs the
// dependency, and every gate that follows it trusts the tree it produced. Only
// `lint` was pinned to `npm ci --ignore-scripts` by #646, so a compromised
// dependency could still rewrite the source, the coverage report or the build
// output before `typecheck`, `test`, `coverage`, `build`, `visual` and `audit`
// read them. This test reads the files the way CI does and fails on the next
// unguarded install instead of waiting for a reviewer to notice it.
//
// #925: the sweep used to match one spelling (`npm ci`), so the next unguarded
// install needed only a different verb (`npm install`, `yarn add`, `npx pkg`) to
// be invisible. It now matches the install-command family, and the two `npx`
// lines that run a local devDependency binary are named exclusions rather than
// a wider waiver.

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

// #925: two `npx` lines run a binary this repository already has in
// `devDependencies`, so they install nothing from the registry: `playwright install`
// downloads browsers into the runner cache and `tsx` runs a script from the
// checkout. They are named by their exact command text instead of widening the
// installer matcher or adding a file waiver, and a test below fails when either
// line changes, so an exclusion can never silently cover a new command.
const LOCAL_BINARIES = new Map<string, string>([
  ['npx playwright install --with-deps chromium', 'playwright is a devDependency already installed by `npm ci --ignore-scripts`; `install` here is its browser-download subcommand, not an npm install, and the `visual` job runs with `contents: read`'],
  ['npx tsx scripts/isolation-check.ts --image fledge:ci', 'tsx is a devDependency already installed, and the command is a script in this checkout, so `npx` resolves the local binary instead of fetching a package'],
])

interface InstallLine {
  file: string
  line: number
  text: string
}

// #925: the install-command family. `npm run` / `npm test` execute a script and
// install nothing, so they stay out; every verb below reaches the registry and
// runs the dependency lifecycle scripts unless the line says otherwise. The
// matcher is deliberately conservative: it names an install even mid-line
// (`echo npm ci && …`), because a false positive costs a human one look and a
// false negative costs the gate its purpose.
const INSTALL_FAMILY = /\b(?:npm\s+(?:ci|install|i|add|exec)|yarn\s+(?:install|add)|pnpm\s+(?:install|add|i|exec))\b/
const NPX_PACKAGE = /\bnpx\s+(?:--?[A-Za-z][\w-]*\s+)*[A-Za-z@]/

function isInstallCommand(trimmed: string): boolean {
  if (INSTALL_FAMILY.test(trimmed)) return true
  if (!NPX_PACKAGE.test(trimmed)) return false
  // An `npx` that runs a binary this checkout already has installs nothing; the
  // exclusion is the exact reviewed line, never a package-name pattern.
  for (const command of LOCAL_BINARIES.keys()) {
    if (trimmed === command || trimmed === `- run: ${command}` || trimmed === `run: ${command}`) return false
  }
  return true
}

function installs(file: string, text: string): InstallLine[] {
  const found: InstallLine[] = []
  const lines = text.split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    // A mention in a comment is documentation, not an install.
    if (trimmed.startsWith('#')) continue
    if (isInstallCommand(trimmed)) found.push({ file, line: index + 1, text: trimmed })
  }
  return found
}

function guarded(entry: InstallLine): boolean {
  return entry.text.includes('--ignore-scripts')
}

// The sweep over a directory of workflow files, factored out of the repository
// test so a fixture directory can drive the same code (#925).
function sweep(dir: string, waivers: Map<string, string> = WAIVERS): string[] {
  const files = readdirSync(dir).filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  const offenders: string[] = []
  for (const name of files) {
    // A waiver names the workflow path the repository uses; a fixture directory
    // may key the same map by bare file name.
    if (waivers.has(`.github/workflows/${name}`) || waivers.has(name)) continue
    const text = readFileSync(join(dir, name), 'utf8')
    for (const entry of installs(name, text)) {
      if (!guarded(entry)) offenders.push(`${name}:${String(entry.line)} ${entry.text}`)
    }
  }
  return offenders
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
  const offenders = sweep(workflowsDir)
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

// #925: the family, not one spelling. Each line here is one a workflow step can
// carry today; `npm run` and `npm test` run a script and install nothing.
test('the sweep sees the install-command family, not one spelling of it', () => {
  const family = [
    'npm ci',
    'npm ci --ignore-scripts',
    'npm install',
    'npm install --omit=dev',
    'npm i --omit=dev',
    'npm add left-pad',
    'npm exec -- some-cli',
    'yarn install',
    'yarn add left-pad',
    'pnpm install',
    'pnpm add left-pad',
    'npx --yes some-pkg',
    'npx some-pkg@1.2.3',
  ]
  for (const line of family) {
    const found = installs('fixture.yml', `      - run: ${line}`)
    assert.equal(found.length, 1, `"${line}" installs dependencies and must be seen by the sweep`)
  }

  const notInstalls = ['npm run build', 'npm test', 'npm run lint', 'node --test test/app.test.ts', 'echo deploy']
  for (const line of notInstalls) {
    assert.deepEqual(installs('fixture.yml', `      - run: ${line}`), [], `"${line}" installs nothing and must not be reported`)
  }

  assert.deepEqual(installs('fixture.yml', '# npm install'), [], 'a comment that mentions an install is documentation')
})

// The part that fails today: a workflow file whose install uses a verb the old
// matcher could not see must be reported by the same sweep the repository uses.
test('a workflow with a different install verb is reported by the sweep', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-install-sweep-'))
  try {
    writeFileSync(join(dir, 'unguarded.yml'), ['jobs:', '  build:', '    steps:', '      - run: npm install', ''].join('\n'))
    assert.deepEqual(
      sweep(dir),
      ['unguarded.yml:4 - run: npm install'],
      'an unguarded `npm install` in any workflow is an offender the sweep names',
    )

    rmSync(join(dir, 'unguarded.yml'))
    writeFileSync(join(dir, 'guarded.yml'), ['jobs:', '  build:', '    steps:', '      - run: npm ci --ignore-scripts', ''].join('\n'))
    assert.deepEqual(sweep(dir), [], 'the same step with `--ignore-scripts` is not an offender')

    rmSync(join(dir, 'guarded.yml'))
    writeFileSync(join(dir, 'yarn.yml'), ['jobs:', '  build:', '    steps:', '      - run: yarn install --frozen-lockfile', ''].join('\n'))
    assert.deepEqual(sweep(dir), ['yarn.yml:4 - run: yarn install --frozen-lockfile'], 'the sweep is not limited to npm')

    rmSync(join(dir, 'yarn.yml'))
    writeFileSync(join(dir, 'npx.yml'), ['jobs:', '  build:', '    steps:', '      - run: npx --yes some-pkg', ''].join('\n'))
    assert.deepEqual(sweep(dir), ['npx.yml:4 - run: npx --yes some-pkg'], 'an `npx` that resolves a package from the registry is an install')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The exclusion is a named literal, not a pattern: it must still describe a real
// line in ci.yml, and it must name exactly the two local-binary calls.
test('each local-binary npx exclusion names a line that still exists', () => {
  const lines = readFileSync(`${workflowsDir}ci.yml`, 'utf8').split(/\r?\n/).map((line) => line.trim())
  for (const [command, reason] of LOCAL_BINARIES) {
    assert.ok(reason.length >= 40, `the exclusion for "${command}" carries a real reason`)
    assert.ok(
      lines.some((line) => line === `- run: ${command}` || line === `run: ${command}`),
      `"${command}" no longer appears in ci.yml; drop or update its exclusion`,
    )
  }
  assert.deepEqual(
    [...LOCAL_BINARIES.keys()],
    ['npx playwright install --with-deps chromium', 'npx tsx scripts/isolation-check.ts --image fledge:ci'],
    'the exclusions are the two reviewed local-binary lines, not a growing list',
  )
})
