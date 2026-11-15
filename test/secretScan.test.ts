import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { RULES } from '../scripts/secret-scan.mjs'

// `npm run secret:scan` is the only thing standing between this repository and a
// committed token, so its two contracts are pinned here: a hit prints a
// recognisable fragment and never the value, and the whitelist is per line so a
// second token in the same file still fails.

const execFileAsync = promisify(execFile)
const scriptPath = fileURLToPath(new URL('../scripts/secret-scan.mjs', import.meta.url))
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-secret-scan-'))
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(join(dir, 'scripts', 'secret-scan-allowlist.json'), '[]\n')
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), content)
  }
  execFileSyncGit(dir)
  return dir
}

function execFileSyncGit(dir: string): void {
  // The fixture repository is throwaway and local; no network, no user config.
  const run = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  }
  run(['init', '-q'])
  run(['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'add', '-A'])
  run(['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-q', '-m', 'fixture'])
}

async function runScan(root: string): Promise<RunResult> {
  try {
    const result = await execFileAsync(process.execPath, [scriptPath, '--root', root], { encoding: 'utf8' })
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

test('the tracked tree of this repository is clean today', async () => {
  const result = await runScan(repoRoot)
  assert.equal(result.code, 0, `the repository must scan clean: ${result.stderr}`)
  assert.match(result.stdout, /no suspected value/)
})

test('an injected token fails the scan without printing the value', async () => {
  const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
  const dir = makeRepo({ 'src/config.ts': `export const token = '${token}'\n` })
  try {
    const result = await runScan(dir)
    assert.equal(result.code, 1, 'a token-shaped value in a tracked file must fail')
    assert.match(result.stderr, /src\/config\.ts:1/)
    assert.match(result.stderr, new RegExp(`prefix=${token.slice(0, 4)}`))
    assert.match(result.stderr, new RegExp(`length=${String(token.length)}`))
    assert.ok(!result.stderr.includes(token), 'the value itself must never reach the log')
    assert.ok(!result.stdout.includes(token), 'the value itself must never reach stdout')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the whitelist is per line: a second token in the same file still fails', async () => {
  const first = 'ghp_' + 'B1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
  const second = 'ghp_' + 'C1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
  const dir = makeRepo({ 'test/fixture.ts': `const a = '${first}'\nconst b = '${second}'\n` })
  try {
    writeFileSync(
      join(dir, 'scripts', 'secret-scan-allowlist.json'),
      JSON.stringify([{ file: 'test/fixture.ts', line: 1, reason: 'the first one is a deliberate fixture' }]),
    )
    const result = await runScan(dir)
    assert.equal(result.code, 1, 'whitelisting line 1 must not whitelist line 2')
    assert.match(result.stderr, /test\/fixture\.ts:2/)
    assert.doesNotMatch(result.stderr, /test\/fixture\.ts:1/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a tracked file the scan cannot read is a refusal, not a clean result', async () => {
  // A tracked symlink that points nowhere: git tracks it, readFileSync cannot
  // read it. Before this rule the run printed "skipped unreadable" and exited 0,
  // which is exactly the false clean an unscanned tree must never produce.
  const dir = makeRepo({ 'src/config.ts': 'export const port = 8080\n' })
  try {
    symlinkSync('../../does-not-exist', join(dir, 'linked-secret.ts'))
    execFileSyncGit(dir)
    const result = await runScan(dir)
    assert.equal(result.code, 2, 'an unscanned tracked file must not exit 0')
    assert.match(result.stderr, /could not read linked-secret\.ts \(ENOENT\)/)
    assert.match(result.stderr, /refused/)
    assert.doesNotMatch(result.stdout, /no suspected value/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a finding still exits 1 even when another file could not be read', async () => {
  const token = 'ghp_' + 'D1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
  const dir = makeRepo({ 'src/config.ts': `export const token = '${token}'\n` })
  try {
    symlinkSync('../../does-not-exist', join(dir, 'linked-secret.ts'))
    execFileSyncGit(dir)
    const result = await runScan(dir)
    assert.equal(result.code, 1, 'a real hit is the more urgent answer than the refusal')
    assert.match(result.stderr, /src\/config\.ts:1/)
    assert.match(result.stderr, /could not read linked-secret\.ts/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an interpolation or a placeholder is not a secret', async () => {
  const dir = makeRepo({
    'src/jobs/prompt.ts': [
      'const a = `Authorization: Bearer ${context.credential.secret}`',
      'const b = "Authorization: Bearer <callbackSecret>"',
      'const c = `Authorization: Bearer ${job.platform?.token}`',
      '',
    ].join('\n'),
  })
  try {
    const result = await runScan(dir)
    assert.equal(result.code, 0, `building a header from a variable must not be a finding: ${result.stderr}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a scan that cannot run fails closed instead of looking clean', async () => {
  // A real repository with a real file, so the only thing missing is the
  // allowlist: the scan cannot know what is whitelisted, so it must not report
  // success. (An empty directory without git would fail for the wrong reason.)
  const dir = makeRepo({ 'src/config.ts': 'export const port = 8080\n' })
  try {
    rmSync(join(dir, 'scripts', 'secret-scan-allowlist.json'))
    const result = await runScan(dir)
    assert.equal(result.code, 1, 'a missing allowlist must not be treated as "nothing to whitelist"')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the allowlist refuses a directory entry', async () => {
  const dir = makeRepo({ 'test/fixture.ts': 'export const value = 1\n' })
  try {
    writeFileSync(
      join(dir, 'scripts', 'secret-scan-allowlist.json'),
      JSON.stringify([{ file: 'test/', line: 1, reason: 'a directory would hide every future token in it' }]),
    )
    const result = await runScan(dir)
    assert.equal(result.code, 1, 'a directory entry must fail the scan, not silently allow a whole tree')
    assert.match(result.stderr, /directory/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('every whitelist entry is per line and still earned', () => {
  const raw = readFileSync(join(repoRoot, 'scripts', 'secret-scan-allowlist.json'), 'utf8')
  const entries = JSON.parse(raw) as Array<{ file: string; line: number; reason: string }>
  assert.ok(Array.isArray(entries))
  for (const entry of entries) {
    assert.ok(!entry.file.endsWith('/'), `${entry.file} is a directory; the whitelist is per line`)
    assert.equal(typeof entry.line, 'number', `${entry.file} needs a line number`)
    assert.ok(entry.reason.length > 20, `${entry.file}:${String(entry.line)} needs a real reason`)
    const text = readFileSync(join(repoRoot, entry.file), 'utf8').split('\n')
    const scanned = scanForTest(text[entry.line - 1] ?? '')
    assert.ok(scanned, `${entry.file}:${String(entry.line)} is whitelisted but no longer token-shaped; remove the entry`)
  }
})

// GitHub's non-provider patterns cover shapes that name no provider: a
// credential in a qualified environment variable, a credential inside a
// connection string, and HTTP Basic auth. Push protection is the pre-commit
// boundary for those and this scanner is the in-repo backstop, so a backstop
// that only knows provider prefixes is silent exactly where push protection is
// weakest. The shapes are planted here and must fail.
test('a non-provider secret shape still fails the scan', async () => {
  const value = 'Zx9' + 'Qw8Er7Ty6Ui5Op4As3Df2'
  const passwordName = ['SMTP', 'PASSWORD'].join('_')
  const accessKeyName = ['AWS', 'SECRET', 'ACCESS', 'KEY'].join('_')
  const dir = makeRepo({
    'deploy/env.example': `${passwordName}=${value}\n${accessKeyName}=${value}\n`,
    'src/db.ts': `export const url = 'postgres://fledge:${value}@db.internal:5432/fledge'\n`,
    'src/http.ts': `export const header = 'Authorization: Basic ${value}'\n`,
  })
  try {
    const result = await runScan(dir)
    assert.equal(result.code, 1, `a generic secret shape must fail the scan: ${result.stderr}`)
    assert.match(result.stderr, /deploy\/env\.example:1: qualified-secret-assignment/)
    assert.match(result.stderr, /deploy\/env\.example:2: qualified-secret-assignment/)
    assert.match(result.stderr, /src\/db\.ts:1: credential-url/)
    assert.match(result.stderr, /src\/http\.ts:1: http-basic/)
    assert.ok(!result.stderr.includes(value), 'the value itself must never reach the log')
    assert.ok(!result.stdout.includes(value), 'the value itself must never reach stdout')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a placeholder in a non-provider shape is still not a secret', async () => {
  const passwordName = ['SMTP', 'PASSWORD'].join('_')
  const dir = makeRepo({
    // Compose interpolates the value from the environment at run time.
    'docker-compose.yml': `DATABASE_URL: postgres://fledge:\${POSTGRES_PASSWORD}@db:5432/fledge\n`,
    // Documentation spells the value as a placeholder, exactly as it should.
    'docs/setup.md': 'postgres://fledge:<password>@db.internal:5432/fledge\n',
    'src/auth.ts': 'const header = `Authorization: Basic ${basicAuth}`\n',
    // An empty slot is a slot, not a value.
    'deploy/env.example': `${passwordName}=\n`,
  })
  try {
    const result = await runScan(dir)
    assert.equal(result.code, 0, `a placeholder must not be a finding: ${result.stderr}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The line is token-shaped if the module's own rules match it; importing the
// module keeps this test and the scanner from drifting apart.
function scanForTest(line: string): boolean {
  return RULES.some((rule) => {
    rule.pattern.lastIndex = 0
    return rule.pattern.test(line)
  })
}
