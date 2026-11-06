import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, statSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../src/db.js'
import { makeUser } from './helpers.js'

const script = fileURLToPath(new URL('../scripts/backup.mjs', import.meta.url))

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

function runBackup(args: string[], env: Record<string, string> = {}): RunResult {
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

function seed(dbPath: string): void {
  const store = new Store(dbPath)
  try {
    const user = makeUser(store, { login: 'backup-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_backup', userId: user.id, owner: 'o', name: 'backup', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.createJob({ id: 'job_backup_1', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'h1', platformTokenHash: '' })
    store.createJob({ id: 'job_backup_2', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'h2', platformTokenHash: '' })
  } finally {
    store.close()
  }
}

function backups(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.db')) : []
}

test('a backup is verified with integrity_check before it is reported as written', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-backup-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  seed(dbPath)

  const result = runBackup(['--db', dbPath, '--backup-dir', backupDir])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /^integrity=ok$/m)
  assert.match(result.stdout, /^backup=/m)

  const files = backups(backupDir)
  assert.equal(files.length, 1)
  const copy = new Store(join(backupDir, files[0]!))
  try {
    assert.equal(copy.get<{ n: number }>('SELECT COUNT(*) AS n FROM jobs')?.n, 2)
  } finally {
    copy.close()
  }
})

test('the backup script prunes old copies down to the retention count', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-backup-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  seed(dbPath)

  for (let run = 0; run < 3; run += 1) {
    const result = runBackup(['--db', dbPath, '--backup-dir', backupDir, '--keep', '1'])
    assert.equal(result.code, 0, result.stderr)
  }
  const remaining = backups(backupDir)
  assert.equal(remaining.length, 1, `expected one retained backup, found ${remaining.join(', ')}`)
  const kept = statSync(join(backupDir, remaining[0]!)).mtimeMs
  const newest = Math.max(...readdirSync(backupDir).filter((name) => name.endsWith('.db')).map((name) => statSync(join(backupDir, name)).mtimeMs))
  assert.equal(kept, newest)
})

test('a corrupt source fails the backup with a non-zero exit and leaves no artifact behind', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-backup-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  seed(dbPath)
  truncateSync(dbPath, 1024)

  const result = runBackup(['--db', dbPath, '--backup-dir', backupDir])
  assert.notEqual(result.code, 0, 'a corrupt source must not produce a backup that looks usable')
  assert.match(result.stderr, /backup (failed|is corrupt)/i)
  assert.deepEqual(backups(backupDir), [])
})

test('a rejected retention count reports the value that was rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-backup-'))
  const dbPath = join(root, 'live', 'fledge.db')
  seed(dbPath)

  const fromFlag = runBackup(['--db', dbPath, '--backup-dir', join(root, 'flag'), '--keep', 'lots'])
  assert.equal(fromFlag.code, 2, fromFlag.stdout)
  assert.match(fromFlag.stderr, /got lots/, `stderr must echo the rejected --keep value, got: ${fromFlag.stderr}`)

  const fromEnv = runBackup(['--db', dbPath, '--backup-dir', join(root, 'env')], { BACKUP_KEEP: 'many' })
  assert.equal(fromEnv.code, 2, fromEnv.stdout)
  assert.match(fromEnv.stderr, /got many/, `stderr must echo the rejected BACKUP_KEEP value, got: ${fromEnv.stderr}`)

  assert.equal(existsSync(join(root, 'flag')), false, 'a refused run must not create the backup directory')
  assert.equal(existsSync(join(root, 'env')), false, 'a refused run must not create the backup directory')
})
