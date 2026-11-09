import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../src/db.js'
import { makeUser } from './helpers.js'

// #90: the drill used to compare a point-in-time copy with the live source, so
// any write since the copy was taken turned a healthy backup into a red drill.
// These cases pin the three checks that replaced it: restored == the copy it
// came from, copy == its manifest, and the source compared as information only.

const drillScript = fileURLToPath(new URL('../scripts/restore-drill.mjs', import.meta.url))
const backupScript = fileURLToPath(new URL('../scripts/backup.mjs', import.meta.url))

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

// stderr matters on a green run too: the drill reports drift it could not read
// there while still exiting 0.
function run(script: string, args: string[], env: Record<string, string> = {}): RunResult {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  })
  return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function runDrill(args: string[], env: Record<string, string> = {}): RunResult {
  return run(drillScript, args, env)
}

function seed(dbPath: string): void {
  const store = new Store(dbPath)
  try {
    const user = makeUser(store, { login: 'drift-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_drift', userId: user.id, owner: 'o', name: 'drift', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.createJob({ id: 'job_drift_1', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'h1', platformTokenHash: '' })
    store.createJob({ id: 'job_drift_2', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'h2', platformTokenHash: '' })
  } finally {
    store.close()
  }
}

// The instance keeps serving after the copy was taken.
function addJobs(dbPath: string, ids: string[]): void {
  const store = new Store(dbPath)
  try {
    const repo = store.get<{ id: string }>('SELECT id FROM repos LIMIT 1')
    const user = store.get<{ id: string }>('SELECT id FROM users LIMIT 1')
    assert.ok(repo !== undefined && user !== undefined, 'the seeded database must hold a repo and a user')
    for (const id of ids) {
      store.createJob({ id, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: id, platformTokenHash: '' })
    }
  } finally {
    store.close()
  }
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

function manifests(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith('fledge-') && name.endsWith('.db.json')) : []
}

function onlyCopy(dir: string): string {
  const files = backups(dir)
  assert.equal(files.length, 1, `expected one copy, found ${files.join(', ')}`)
  return join(dir, files[0]!)
}

function readManifest(copyPath: string): { createdAt: string; size: number; sha256: string; schemaVersion: number; tables: Record<string, number> } {
  const path = `${copyPath}.json`
  assert.equal(existsSync(path), true, `no manifest next to ${copyPath}`)
  return JSON.parse(readFileSync(path, 'utf8')) as { createdAt: string; size: number; sha256: string; schemaVersion: number; tables: Record<string, number> }
}

function writeManifest(copyPath: string, manifest: unknown): void {
  writeFileSync(`${copyPath}.json`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
}

test('a copy taken before the latest writes passes: the drill compares the copy with its manifest and reports the drift', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-drift-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  const workDir = join(root, 'work')
  seed(dbPath)

  const backup = run(backupScript, ['--db', dbPath, '--backup-dir', backupDir])
  assert.equal(backup.code, 0, backup.stderr)
  addJobs(dbPath, ['job_drift_3', 'job_drift_4'])

  const result = runDrill(['--db', dbPath, '--backup-dir', backupDir, '--work-dir', workDir])
  assert.equal(result.code, 0, `drift since the copy is normal and must not fail the drill:\n${result.stderr}`)

  const tableLines = [...result.stdout.matchAll(/^table=(\S+) expected=(\d+) actual=(\d+)$/gm)]
  assert.ok(tableLines.length > 0, `no per-table comparison lines in:\n${result.stdout}`)
  for (const line of tableLines) assert.equal(line[2], line[3], `the copy disagrees with its manifest on table ${line[1]}`)
  const jobs = result.stdout.match(/^table=jobs expected=(\d+) actual=(\d+)$/m)
  assert.deepEqual([jobs?.[1], jobs?.[2]], ['2', '2'], `the copy holds the two jobs it was taken with:\n${result.stdout}`)

  assert.match(result.stdout, /^source_drift=\+2$/m, `the two new rows must be reported as information:\n${result.stdout}`)
  assert.match(result.stdout, /^schema_drift=none$/m, result.stdout)
  assert.match(result.stdout, /^restore-drill: OK$/m, result.stdout)
  assert.equal(existsSync(join(workDir, 'restored.db')), true)
  assert.equal(existsSync(join(workDir, 'restored.db.failed')), false, 'drift alone must never rename a healthy copy')
})

test('a copy without a manifest still passes the exact check and warns instead of comparing with the source', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-drift-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  const workDir = join(root, 'work')
  seed(dbPath)

  const backup = run(backupScript, ['--db', dbPath, '--backup-dir', backupDir])
  assert.equal(backup.code, 0, backup.stderr)
  const copy = onlyCopy(backupDir)
  // An older backup tool wrote the copy only, with no sidecar.
  rmSync(`${copy}.json`)
  addJobs(dbPath, ['job_drift_3'])

  const result = runDrill(['--db', dbPath, '--backup-dir', backupDir, '--work-dir', workDir])
  assert.equal(result.code, 0, `a copy without a manifest is a valid copy:\n${result.stderr}`)
  assert.match(result.stdout, /^manifest=missing$/m, result.stdout)
  assert.match(result.stdout, /^restore-drill: OK$/m, result.stdout)
  assert.doesNotMatch(result.stdout, /^table=/m, 'row counts are only compared against a manifest, never against the live source')
})

test('a manifest whose row count disagrees with the copy fails and names the table and both counts', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-drift-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  const workDir = join(root, 'work')
  seed(dbPath)

  const backup = run(backupScript, ['--db', dbPath, '--backup-dir', backupDir])
  assert.equal(backup.code, 0, backup.stderr)
  const copy = onlyCopy(backupDir)
  const manifest = readManifest(copy)
  manifest.tables.jobs = 3
  writeManifest(copy, manifest)

  const result = runDrill(['--db', dbPath, '--backup-dir', backupDir, '--work-dir', workDir])
  assert.equal(result.code, 1, `a copy that is not the database its manifest describes must fail:\n${result.stdout}`)
  assert.match(result.stderr, /manifest says jobs=3, restored has 2/, result.stderr)
  assert.equal(existsSync(join(workDir, 'restored.db')), false)
  assert.equal(existsSync(join(workDir, 'restored.db.failed')), true)
})

test('a manifest whose sha256 disagrees with the copy fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-drift-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  const workDir = join(root, 'work')
  seed(dbPath)

  const backup = run(backupScript, ['--db', dbPath, '--backup-dir', backupDir])
  assert.equal(backup.code, 0, backup.stderr)
  const copy = onlyCopy(backupDir)
  const manifest = readManifest(copy)
  manifest.sha256 = '0'.repeat(64)
  writeManifest(copy, manifest)

  const result = runDrill(['--db', dbPath, '--backup-dir', backupDir, '--work-dir', workDir])
  assert.equal(result.code, 1, result.stdout)
  assert.match(result.stderr, /manifest says sha256=/, result.stderr)
  assert.equal(existsSync(join(workDir, 'restored.db')), false)
})

test('a truncated copy fails and does not leave restored.db at the path the runbook copies from', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-drift-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  const workDir = join(root, 'work')
  seed(dbPath)

  const backup = run(backupScript, ['--db', dbPath, '--backup-dir', backupDir])
  assert.equal(backup.code, 0, backup.stderr)
  const copy = onlyCopy(backupDir)
  const size = statSync(copy).size
  assert.ok(size > 4096, `expected a database larger than one page, got ${size} bytes`)
  truncateSync(copy, size - 4096)

  const result = runDrill(['--db', dbPath, '--backup-dir', backupDir, '--work-dir', workDir])
  assert.equal(result.code, 1, `a truncated copy must fail:\n${result.stdout}`)
  assert.match(result.stderr, /manifest says size=/, `the manifest is what proves the file is incomplete:\n${result.stderr}`)
  assert.equal(existsSync(join(workDir, 'restored.db')), false)
  assert.equal(existsSync(join(workDir, 'restored.db.failed')), true)
})

test('drift alone never renames a healthy copy', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-drift-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  const workDir = join(root, 'work')
  seed(dbPath)

  const backup = run(backupScript, ['--db', dbPath, '--backup-dir', backupDir])
  assert.equal(backup.code, 0, backup.stderr)
  // Deletes exist (deleting a repository deletes its jobs), so a legitimate
  // older copy can hold MORE rows than the source: this drift is negative.
  addJobs(dbPath, ['job_drift_3'])
  const store = new Store(dbPath)
  try {
    store.run('DELETE FROM jobs WHERE id = ?', 'job_drift_1')
    store.run('DELETE FROM jobs WHERE id = ?', 'job_drift_2')
  } finally {
    store.close()
  }

  const result = runDrill(['--db', dbPath, '--backup-dir', backupDir, '--work-dir', workDir])
  assert.equal(result.code, 0, `a copy that holds more rows than the source is still a good copy:\n${result.stderr}`)
  assert.match(result.stdout, /^source_drift=-1$/m, result.stdout)
  assert.equal(existsSync(join(workDir, 'restored.db')), true, 'the verified copy stays where the runbook restores it from')
  assert.equal(existsSync(join(workDir, 'restored.db.failed')), false, 'drift must not mark the copy failed')
  assert.equal(mode(join(workDir, 'restored.db')), 0o600)
})

test('a copy that fails integrity_check still fails and is still renamed', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-drift-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  const workDir = join(root, 'work')
  seed(dbPath)

  mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(backupDir, 'fledge-2026-01-01T00-00-00-000Z.db'), Buffer.alloc(8192, 0x41), { mode: 0o600 })

  const result = runDrill(['--db', dbPath, '--backup-dir', backupDir, '--work-dir', workDir])
  assert.equal(result.code, 1, 'a corrupt copy must not be reported as a successful drill')
  assert.match(result.stderr, /corrupt/i, result.stderr)
  assert.equal(existsSync(join(workDir, 'restored.db')), false)
  assert.equal(existsSync(join(workDir, 'restored.db.failed')), true)
})

test('--fresh writes a manifest for the copy it takes, so the drill is exact on the first run', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-drift-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  const workDir = join(root, 'work')
  seed(dbPath)

  const result = runDrill(['--db', dbPath, '--backup-dir', backupDir, '--work-dir', workDir, '--fresh'])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /^manifest=.*\.db\.json$/m, `--fresh must record a manifest:\n${result.stdout}`)

  const copy = onlyCopy(backupDir)
  const manifest = readManifest(copy)
  assert.equal(manifest.sha256, sha256(copy), 'the manifest describes the bytes that were written')
  assert.equal(manifest.size, statSync(copy).size)
  assert.equal(manifest.tables.jobs, 2)
  assert.equal(existsSync(copy), true)
  assert.equal(mode(`${copy}.json`), 0o600, 'the manifest is owner-only like the copy it describes')

  const rpo = result.stdout.match(/^RPO=(\d+(?:\.\d+)?)s$/m)
  assert.ok(rpo !== null, result.stdout)
  assert.ok(Number(rpo[1]) < 5, `a fresh copy restores with RPO near zero, got ${rpo[1]}s`)
  assert.equal(manifests(backupDir).length, 1)
})

test('a live source that cannot be read never fails the drill, its copy or its exit status', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-drift-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  const workDir = join(root, 'work')
  seed(dbPath)

  const backup = run(backupScript, ['--db', dbPath, '--backup-dir', backupDir])
  assert.equal(backup.code, 0, backup.stderr)
  // The operator restores *because* the live database is damaged: this is the
  // disaster path, and the source must never be able to fail a good copy.
  rmSync(`${dbPath}-wal`, { force: true })
  rmSync(`${dbPath}-shm`, { force: true })
  writeFileSync(dbPath, Buffer.from('not a SQLite database, and the drill must not care', 'utf8'))

  const result = runDrill(['--db', dbPath, '--backup-dir', backupDir, '--work-dir', workDir])
  assert.equal(result.code, 0, `a damaged source must not fail a verified copy:\n${result.stderr}`)
  assert.match(result.stdout, /^schema_drift=unavailable$/m, result.stdout)
  assert.match(result.stdout, /^source_drift=unavailable$/m, result.stdout)
  assert.match(result.stdout, /^restore-drill: OK$/m, result.stdout)
  assert.match(result.stderr, /drift is not reported/, result.stderr)
  assert.equal(existsSync(join(workDir, 'restored.db')), true, 'the verified copy stays where the runbook restores it from')
  assert.equal(existsSync(join(workDir, 'restored.db.failed')), false, 'a damaged source must never mark a good copy failed')
})

test('retention deletes a copy together with its manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-drift-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  seed(dbPath)

  const first = run(backupScript, ['--db', dbPath, '--backup-dir', backupDir, '--keep', '1'])
  assert.equal(first.code, 0, first.stderr)
  const old = onlyCopy(backupDir)
  assert.equal(existsSync(`${old}.json`), true)

  const second = run(backupScript, ['--db', dbPath, '--backup-dir', backupDir, '--keep', '1'])
  assert.equal(second.code, 0, second.stderr)
  assert.equal(existsSync(old), false, 'the pruned copy is deleted')
  assert.equal(existsSync(`${old}.json`), false, 'and so is the manifest that describes it')
  assert.equal(backups(backupDir).length, 1)
  assert.equal(manifests(backupDir).length, 1)
})
