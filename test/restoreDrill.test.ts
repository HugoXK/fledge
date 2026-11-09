import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../src/db.js'
import { makeUser } from './helpers.js'

const drillScript = fileURLToPath(new URL('../scripts/restore-drill.mjs', import.meta.url))
const backupScript = fileURLToPath(new URL('../scripts/backup.mjs', import.meta.url))

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

function run(script: string, args: string[], env: Record<string, string> = {}): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string; stderr?: string }
    return { code: failure.status ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

function runDrill(args: string[], env: Record<string, string> = {}): RunResult {
  return run(drillScript, args, env)
}

function seed(dbPath: string): void {
  const store = new Store(dbPath)
  try {
    const user = makeUser(store, { login: 'drill-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_drill', userId: user.id, owner: 'o', name: 'drill', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.createJob({ id: 'job_drill_1', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'h1', platformTokenHash: '' })
    store.createJob({ id: 'job_drill_2', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'h2', platformTokenHash: '' })
  } finally {
    store.close()
  }
}

function rows(result: RunResult, table: string): { expected: number; actual: number } | undefined {
  const match = result.stdout.match(new RegExp(`^table=${table} expected=(\\d+) actual=(\\d+)$`, 'm'))
  if (match === null) return undefined
  return { expected: Number(match[1]), actual: Number(match[2]) }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function mode(path: string): number {
  return statSync(path).mode & 0o777
}

function backups(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith('fledge-') && name.endsWith('.db')) : []
}

test('the drill restores the newest backup into a temp path, compares every table and reports RTO and RPO', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-drill-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  const workDir = join(root, 'work')
  seed(dbPath)

  const result = runDrill(['--db', dbPath, '--backup-dir', backupDir, '--work-dir', workDir])
  assert.equal(result.code, 0, result.stderr)

  const tableLines = [...result.stdout.matchAll(/^table=(\S+) expected=(\d+) actual=(\d+)$/gm)]
  assert.ok(tableLines.length > 0, `no per-table comparison lines in:\n${result.stdout}`)
  for (const line of tableLines) assert.equal(line[2], line[3], `row count mismatch for table ${line[1]}`)
  assert.deepEqual(rows(result, 'jobs'), { expected: 2, actual: 2 })
  assert.match(result.stdout, /^RTO=\d+(\.\d{3})?s$/m)
  assert.match(result.stdout, /^RPO=\d+(\.\d{3})?s$/m)

  const restored = join(workDir, 'restored.db')
  const source = new Store(dbPath)
  const copy = new Store(restored)
  try {
    const sourceJobs = source.get<{ n: number }>('SELECT COUNT(*) AS n FROM jobs')?.n
    const copyJobs = copy.get<{ n: number }>('SELECT COUNT(*) AS n FROM jobs')?.n
    assert.equal(Number(copyJobs), Number(sourceJobs))
    assert.equal(Number(copyJobs), 2)
  } finally {
    source.close()
    copy.close()
  }
})

test('a corrupt backup exits non-zero instead of reporting a successful drill', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-drill-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  const scratch = join(root, 'tmp')
  mkdirSync(scratch, { recursive: true })
  seed(dbPath)

  const first = runDrill(['--db', dbPath, '--backup-dir', backupDir], { TMPDIR: scratch })
  assert.equal(first.code, 0, first.stderr)
  const files = backups(backupDir)
  assert.equal(files.length, 1, `expected one backup, found ${files.join(', ')}`)
  const backup = join(backupDir, files[0]!)
  truncateSync(backup, Math.max(1024, Math.floor(statSync(backup).size / 3)))

  const second = runDrill(['--db', dbPath, '--backup-dir', backupDir], { TMPDIR: scratch })
  assert.notEqual(second.code, 0, 'a corrupt backup must not be reported as a successful drill')
  assert.match(second.stderr, /corrupt|mismatch/i, `stderr must say why, got: ${second.stderr}`)
  assert.ok(second.stderr.includes(files[0]!), `stderr must name the corrupt file, got: ${second.stderr}`)
  assert.deepEqual(readdirSync(scratch), [], 'a failed drill must remove its temp directory and the copy of production data inside it')
})

test('a manifest-less copy that holds no schema is refused instead of reporting a successful drill', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-drill-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  const workDir = join(root, 'work')
  seed(dbPath)

  const fresh = runDrill(['--db', dbPath, '--backup-dir', backupDir, '--work-dir', workDir, '--fresh'])
  assert.equal(fresh.code, 0, fresh.stderr)
  const files = backups(backupDir)
  assert.equal(files.length, 1, `expected one backup, found ${files.join(', ')}`)
  // Remove the two ways a truncation is normally caught: the manifest bytes and
  // the schema itself. What is left is a 0-byte file that compares equal to
  // itself and whose `PRAGMA integrity_check` answers `ok`.
  for (const name of readdirSync(backupDir).filter((entry) => entry.endsWith('.json'))) rmSync(join(backupDir, name))
  truncateSync(join(backupDir, files[0]!), 0)
  rmSync(join(workDir, 'restored.db'), { force: true })

  const result = runDrill(['--db', dbPath, '--backup-dir', backupDir, '--work-dir', workDir])
  assert.notEqual(result.code, 0, 'a manifest-less copy with no schema must not be reported as a successful drill')
  assert.doesNotMatch(result.stdout, /^restore-drill: OK$/m, 'a copy that holds no tables must never be reported as OK')
  assert.match(result.stderr, /no tables|no schema/i, `stderr must say the copy holds no tables, got: ${result.stderr}`)
  assert.match(result.stderr, /size|sha256|user_version|per-table/i, `stderr must name the checks that were skipped, got: ${result.stderr}`)
  assert.equal(existsSync(join(workDir, 'restored.db')), false,
    'a refused copy must not be left at the path docs/deploy.md restores from')
  assert.equal(existsSync(join(workDir, 'restored.db.failed')), true,
    'the refused copy is kept under a name no restore step picks up')
})

test('a manifest-less copy that still carries its schema keeps passing', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-drill-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  const workDir = join(root, 'work')
  seed(dbPath)

  const fresh = runDrill(['--db', dbPath, '--backup-dir', backupDir, '--work-dir', workDir, '--fresh'])
  assert.equal(fresh.code, 0, fresh.stderr)
  for (const name of readdirSync(backupDir).filter((entry) => entry.endsWith('.json'))) rmSync(join(backupDir, name))
  rmSync(join(workDir, 'restored.db'), { force: true })

  // A copy written before manifests existed is still a backup. Refusing it would
  // turn every legacy copy into a red drill, so this path must stay green.
  const result = runDrill(['--db', dbPath, '--backup-dir', backupDir, '--work-dir', workDir])
  assert.equal(result.code, 0, `a manifest-less copy that holds its schema must keep passing: ${result.stderr}`)
  assert.match(result.stdout, /^manifest=missing$/m)
  assert.match(result.stdout, /^restore-drill: OK$/m)
  assert.equal(existsSync(join(workDir, 'restored.db')), true)
})

test('a failed drill leaves no copy at the path the restore instructions copy over the live database', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-drill-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  const workDir = join(root, 'work')
  seed(dbPath)

  const first = runDrill(['--db', dbPath, '--backup-dir', backupDir, '--work-dir', workDir])
  assert.equal(first.code, 0, first.stderr)
  assert.equal(existsSync(join(workDir, 'restored.db')), true)

  const files = backups(backupDir)
  assert.equal(files.length, 1)
  truncateSync(join(backupDir, files[0]!), Math.max(1024, Math.floor(statSync(join(backupDir, files[0]!)).size / 3)))

  const failed = runDrill(['--db', dbPath, '--backup-dir', backupDir, '--work-dir', workDir])
  assert.notEqual(failed.code, 0, 'a corrupt backup must not be reported as a successful drill')
  assert.equal(existsSync(join(workDir, 'restored.db')), false,
    'a failed drill must not leave restored.db, which docs/deploy.md copies over $DB_PATH')
  const failedCopy = join(workDir, 'restored.db.failed')
  assert.equal(existsSync(failedCopy), true, 'the copy that failed verification is kept under a name no restore step picks up')
  assert.equal(mode(failedCopy), 0o600, 'the kept copy is still owner-only')
})

test('a backup directory that holds the source database is refused before anything is opened', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-drill-'))
  const dbPath = join(root, 'fledge.db')
  seed(dbPath)
  const before = new Set(readdirSync(root))

  const result = runDrill(['--db', dbPath, '--backup-dir', root])
  assert.equal(result.code, 2, result.stdout)
  assert.match(result.stderr, /refus/i)
  for (const name of readdirSync(root)) {
    if (!before.has(name)) assert.fail(`a refused drill must not write anything, found ${name}`)
  }
})

test('the drill never writes the source database', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-drill-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  seed(dbPath)
  const before = sha256(dbPath)
  const sizeBefore = statSync(dbPath).size

  const result = runDrill(['--db', dbPath, '--backup-dir', backupDir])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(sha256(dbPath), before, 'the source database changed during the drill')
  assert.equal(statSync(dbPath).size, sizeBefore)
})

test('the backup directory is 0700 and every artifact is 0600', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-drill-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  const workDir = join(root, 'work')
  seed(dbPath)

  const drill = runDrill(['--db', dbPath, '--backup-dir', backupDir, '--work-dir', workDir])
  assert.equal(drill.code, 0, drill.stderr)
  assert.equal(mode(backupDir), 0o700, 'the backup directory must be private')
  const files = backups(backupDir)
  assert.equal(files.length, 1)
  assert.equal(mode(join(backupDir, files[0]!)), 0o600, 'a backup copy must be owner-only')
  assert.equal(mode(workDir), 0o700, 'the drill work directory must be private')
  assert.equal(mode(join(workDir, 'restored.db')), 0o600, 'the restored copy must be owner-only')

  const standalone = join(root, 'standalone')
  const backup = run(backupScript, ['--db', dbPath, '--backup-dir', standalone])
  assert.equal(backup.code, 0, backup.stderr)
  assert.equal(mode(standalone), 0o700, 'backup.mjs must create its directory private')
  const standaloneFiles = backups(standalone)
  assert.equal(standaloneFiles.length, 1)
  assert.equal(mode(join(standalone, standaloneFiles[0]!)), 0o600, 'backup.mjs must write owner-only copies')
})

test('a drill target inside DATA_DIR is refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-drill-'))
  const dataDir = join(root, 'data')
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  seed(dbPath)

  const insideDataDir = runDrill(['--db', dbPath, '--backup-dir', backupDir, '--work-dir', join(dataDir, 'work')], { DATA_DIR: dataDir })
  assert.equal(insideDataDir.code, 2, insideDataDir.stdout)
  assert.match(insideDataDir.stderr, /DATA_DIR|live/i)
  assert.equal(existsSync(join(dataDir, 'work')), false, 'a refused target must not be created')

  const equalsDbDir = runDrill(['--db', dbPath, '--backup-dir', backupDir, '--work-dir', join(root, 'live')])
  assert.equal(equalsDbDir.code, 2, equalsDbDir.stdout)
  assert.match(equalsDbDir.stderr, /refus/i)
})

test('a work directory whose parent is missing fails without creating it', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-drill-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  seed(dbPath)

  const missing = join(root, 'absent', 'nested')
  const result = runDrill(['--db', dbPath, '--backup-dir', backupDir, '--work-dir', missing])
  assert.notEqual(result.code, 0, 'a missing parent must fail the drill')
  assert.match(result.stderr, /parent|不存在|missing/i)
  assert.equal(existsSync(join(root, 'absent')), false, 'the drill must not mkdir its target parent')
  assert.equal(existsSync(join(missing, 'restored.db')), false, 'a refused drill must not leave a restore result')
})

test('a work directory inside the source database directory is refused without DATA_DIR being set', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-drill-'))
  const dbPath = join(root, 'srv', 'fledge.db')
  const backupDir = join(root, 'backups')
  const workDir = join(root, 'srv', 'work')
  seed(dbPath)

  // No DATA_DIR: the source database's own directory is the live area either way.
  const result = runDrill(['--db', dbPath, '--backup-dir', backupDir, '--work-dir', workDir], { DATA_DIR: '' })
  assert.equal(result.code, 2, `expected a refusal, got exit ${result.code}: ${result.stderr}`)
  assert.match(result.stderr, /refus/i)
  assert.equal(existsSync(workDir), false, 'a refused target must not be created')
})

test('a work directory that is a symlink into DATA_DIR is refused and leaves the mode alone', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-drill-'))
  const dataDir = join(root, 'data')
  const dbPath = join(dataDir, 'fledge.db')
  const backupDir = join(root, 'backups')
  seed(dbPath)
  chmodSync(dataDir, 0o755)
  const before = mode(dataDir)
  const link = join(root, 'link-data')
  symlinkSync(dataDir, link, 'dir')

  const result = runDrill(['--db', dbPath, '--backup-dir', backupDir, '--work-dir', join(link, 'work')], { DATA_DIR: dataDir })
  assert.equal(result.code, 2, `expected a refusal through the symlink, got exit ${result.code}: ${result.stderr}`)
  assert.match(result.stderr, /DATA_DIR|refus/i)
  assert.equal(existsSync(join(dataDir, 'work')), false, 'a refused target must not be created inside the live data directory')
  assert.equal(mode(dataDir), before, 'a refused drill must not chmod the live data directory')
})
