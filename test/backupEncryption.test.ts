import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, scryptSync } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../src/db.js'
import { makeTerminalJob, makeUser } from './helpers.js'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => { close(): void; prepare(sql: string): { all(): unknown[] } } }

const backupScript = fileURLToPath(new URL('../scripts/backup.mjs', import.meta.url))
const drillScript = fileURLToPath(new URL('../scripts/restore-drill.mjs', import.meta.url))
const deployDoc = fileURLToPath(new URL('../docs/deploy.md', import.meta.url))

const TEST_KEY = Buffer.alloc(32, 0x42).toString('base64')
const WRONG_KEY = Buffer.alloc(32, 0x43).toString('base64')
const TEST_PASSPHRASE = 'fledge backup test passphrase, not a real secret'

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

// The three variables are deleted rather than set to '': an empty value is a
// configured-but-empty source since #553, so `''` would mean "broken expansion"
// here instead of "no key". A case that wants that shape passes `''` itself.
const KEY_VARIABLES = ['BACKUP_ENCRYPTION_KEY', 'BACKUP_ENCRYPTION_KEY_FILE', 'BACKUP_ENCRYPTION_REQUIRED'] as const

function run(script: string, args: string[], env: Record<string, string> = {}): RunResult {
  const inherited: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !(KEY_VARIABLES as readonly string[]).includes(name)) inherited[name] = value
  }
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...inherited, ...env },
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
    const user = makeUser(store, { login: 'encryption-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_encryption', userId: user.id, owner: 'o', name: 'encryption', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    makeTerminalJob(store, { id: 'job_encryption_1', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'h1', platformTokenHash: '' })
    makeTerminalJob(store, { id: 'job_encryption_2', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'h2', platformTokenHash: '' })
  } finally {
    store.close()
  }
}

function backupFiles(dir: string): string[] {
  return existsSync(dir)
    ? readdirSync(dir).filter((name) => name.startsWith('fledge-') && (name.endsWith('.db') || name.endsWith('.db.enc')))
    : []
}

function onlyBackup(dir: string): string {
  const files = backupFiles(dir)
  assert.equal(files.length, 1, `expected one backup, found ${files.join(', ')}`)
  return join(dir, files[0]!)
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function expectedKeyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

function readManifest(copyPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${copyPath}.json`, 'utf8')) as Record<string, unknown>
}

function readEnvelope(copyPath: string): Record<string, unknown> {
  const bytes = readFileSync(copyPath)
  const newline = bytes.indexOf(0x0a)
  assert.ok(newline > 0, 'an encrypted backup must start with a JSON header line')
  return JSON.parse(bytes.subarray(0, newline).toString('utf8')) as Record<string, unknown>
}

function assertNoKeyMaterial(text: string, key: string): void {
  assert.ok(!text.includes(key), 'the configured key must never be printed or stored')
  assert.ok(!text.includes(Buffer.from(key, 'base64').toString('hex')), 'the decoded key must never be printed or stored')
}

test('an encrypted backup is not a SQLite file, and its manifest records ciphertext and key id but no key', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-encrypted-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  seed(dbPath)

  const result = run(backupScript, ['--db', dbPath, '--backup-dir', backupDir], { BACKUP_ENCRYPTION_KEY: TEST_KEY })
  assert.equal(result.code, 0, result.stderr)
  assert.doesNotMatch(result.stdout, new RegExp(TEST_KEY), 'the backup must not echo the key')

  const copy = onlyBackup(backupDir)
  assert.match(basename(copy), /\.db\.enc$/)
  assert.equal(existsSync(copy.replace(/\.enc$/, '')), false, 'no plaintext copy may be left next to the encrypted one')
  assert.notEqual(readFileSync(copy).subarray(0, 16).toString('binary'), 'SQLite format 3\0')
  assert.throws(() => {
    const db = new DatabaseSync(copy, { readOnly: true })
    try {
      db.prepare('SELECT name FROM sqlite_master').all()
    } finally {
      db.close()
    }
  }, /not a database|SQLITE_NOTADB|file is not a database/i, 'an encrypted copy must not open as SQLite without the key')

  const envelope = readEnvelope(copy)
  const manifest = readManifest(copy)
  const encryption = manifest.encryption as Record<string, unknown>
  assert.equal(envelope.format, 'fledge-backup')
  assert.equal(envelope.version, 1)
  assert.equal(envelope.algorithm, 'aes-256-gcm')
  assert.match(String(envelope.iv), /^[A-Za-z0-9+/]+={0,2}$/)
  assert.match(String(envelope.tag), /^[A-Za-z0-9+/]+={0,2}$/)
  assert.equal(manifest.copy, basename(copy))
  assert.equal(manifest.size, statSync(copy).size)
  assert.equal(manifest.sha256, sha256File(copy))
  assert.equal(encryption.keyId, envelope.keyId)
  assert.equal(encryption.keyVersion, envelope.keyVersion)
  assert.equal(encryption.salt, undefined, 'the manifest carries the key id, never the envelope salt')
  assert.equal(encryption.iv, undefined, 'the manifest carries the ciphertext checksum, not the envelope fields')
  assert.equal(encryption.ciphertext, undefined)

  const manifestText = readFileSync(`${copy}.json`, 'utf8')
  assertNoKeyMaterial(manifestText, TEST_KEY)
  assertNoKeyMaterial(result.stdout + result.stderr, TEST_KEY)
})

test('restoring an encrypted backup with the configured key works', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-encrypted-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  const workDir = join(root, 'work')
  seed(dbPath)

  const backup = run(backupScript, ['--db', dbPath, '--backup-dir', backupDir], { BACKUP_ENCRYPTION_KEY: TEST_KEY })
  assert.equal(backup.code, 0, backup.stderr)
  assert.match(basename(onlyBackup(backupDir)), /\.db\.enc$/)

  const drill = run(drillScript, ['--db', dbPath, '--backup-dir', backupDir, '--work-dir', workDir], { BACKUP_ENCRYPTION_KEY: TEST_KEY })
  assert.equal(drill.code, 0, drill.stderr)
  assert.match(drill.stdout, /^restore-drill: OK$/m)
  assert.doesNotMatch(drill.stdout + drill.stderr, new RegExp(TEST_KEY))

  const restored = new Store(join(workDir, 'restored.db'))
  try {
    assert.equal(restored.get<{ n: number }>('SELECT COUNT(*) AS n FROM jobs')?.n, 2)
  } finally {
    restored.close()
  }
  assert.equal(statSync(join(workDir, 'restored.db')).mode & 0o777, 0o600)
})

test('a missing key fails closed with a lost-key message and no restore result', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-encrypted-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  const workDir = join(root, 'work')
  seed(dbPath)

  const backup = run(backupScript, ['--db', dbPath, '--backup-dir', backupDir], { BACKUP_ENCRYPTION_KEY: TEST_KEY })
  assert.equal(backup.code, 0, backup.stderr)

  const drill = run(drillScript, ['--db', dbPath, '--backup-dir', backupDir, '--work-dir', workDir])
  assert.equal(drill.code, 1, drill.stdout)
  assert.match(drill.stderr, /encrypted/i)
  assert.match(drill.stderr, /lost[ -]?key|no .*key/i, `stderr must explain the lost key, got: ${drill.stderr}`)
  assert.match(drill.stderr, /BACKUP_ENCRYPTION_KEY/, 'the failure must name the missing configuration')
  assert.doesNotMatch(drill.stdout, /^restore-drill: OK$/m)
  assert.equal(existsSync(join(workDir, 'restored.db')), false)
  assert.equal(existsSync(join(workDir, 'restored.db.failed')), false)
})

test('a wrong key fails closed and never produces a restored database', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-encrypted-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  const workDir = join(root, 'work')
  seed(dbPath)

  const backup = run(backupScript, ['--db', dbPath, '--backup-dir', backupDir], { BACKUP_ENCRYPTION_KEY: TEST_KEY })
  assert.equal(backup.code, 0, backup.stderr)

  const drill = run(drillScript, ['--db', dbPath, '--backup-dir', backupDir, '--work-dir', workDir], { BACKUP_ENCRYPTION_KEY: WRONG_KEY })
  assert.equal(drill.code, 1, drill.stdout)
  assert.match(drill.stderr, /wrong key|lost[ -]?key|key id/i, `stderr must distinguish a wrong key, got: ${drill.stderr}`)
  assert.doesNotMatch(drill.stdout, /^restore-drill: OK$/m)
  assert.equal(existsSync(join(workDir, 'restored.db')), false)
  assert.equal(existsSync(join(workDir, 'restored.db.failed')), false)
})

test('a passphrase is derived with scrypt and a random salt kept in the envelope', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-encrypted-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  const workDir = join(root, 'work')
  seed(dbPath)

  const backup = run(backupScript, ['--db', dbPath, '--backup-dir', backupDir], { BACKUP_ENCRYPTION_KEY: TEST_PASSPHRASE })
  assert.equal(backup.code, 0, backup.stderr)
  const copy = onlyBackup(backupDir)
  const envelope = readEnvelope(copy)
  assert.equal(envelope.kdf, 'scrypt')
  assert.match(String(envelope.salt), /^[A-Za-z0-9+/]+={0,2}$/)
  assertNoKeyMaterial(readFileSync(`${copy}.json`, 'utf8'), TEST_PASSPHRASE)

  const drill = run(drillScript, ['--db', dbPath, '--backup-dir', backupDir, '--work-dir', workDir], { BACKUP_ENCRYPTION_KEY: TEST_PASSPHRASE })
  assert.equal(drill.code, 0, drill.stderr)
  assert.match(drill.stdout, /^restore-drill: OK$/m)

  const wrong = run(drillScript, ['--db', dbPath, '--backup-dir', backupDir, '--work-dir', join(root, 'wrong')], { BACKUP_ENCRYPTION_KEY: `${TEST_PASSPHRASE}!` })
  assert.equal(wrong.code, 1, wrong.stdout)
  assert.match(wrong.stderr, /wrong key|lost[ -]?key|key id/i)
})

test('a passphrase copy records an id derived from the stretched key, not a fast hash of the passphrase', () => {
  // #553 review: the id is published (envelope header, manifest, every log line
  // that prints `key_id`), so sha256(passphrase)[:16] would be an offline verifier
  // that tests guesses at one sha256 each and skips the scrypt cost the rest of
  // the file depends on. The id must be a fingerprint of the key the copy was
  // actually encrypted with, which for a passphrase is the stretched key.
  const root = mkdtempSync(join(tmpdir(), 'fledge-encrypted-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  const workDir = join(root, 'work')
  seed(dbPath)

  const backup = run(backupScript, ['--db', dbPath, '--backup-dir', backupDir], { BACKUP_ENCRYPTION_KEY: TEST_PASSPHRASE })
  assert.equal(backup.code, 0, backup.stderr)
  const copy = onlyBackup(backupDir)
  const envelope = readEnvelope(copy)
  assert.equal(envelope.kdf, 'scrypt')

  const fastHash = createHash('sha256').update(TEST_PASSPHRASE).digest('hex').slice(0, 16)
  assert.notEqual(envelope.keyId, fastHash, 'the published key id must not be an offline verifier for the passphrase')
  const stretched = scryptSync(TEST_PASSPHRASE, Buffer.from(String(envelope.salt), 'base64'), 32)
  assert.equal(envelope.keyId, expectedKeyId(stretched), 'the id must fingerprint the stretched key')
  assert.equal((readManifest(copy).encryption as Record<string, unknown>).keyId, envelope.keyId, 'the manifest must name the same key as the envelope')
  assert.doesNotMatch(backup.stdout, new RegExp(TEST_PASSPHRASE))

  // The copy the id names must still open with the passphrase that wrote it.
  const drill = run(drillScript, ['--db', dbPath, '--backup-dir', backupDir, '--work-dir', workDir], { BACKUP_ENCRYPTION_KEY: TEST_PASSPHRASE })
  assert.equal(drill.code, 0, drill.stderr)
  assert.match(drill.stdout, /^restore-drill: OK$/m)
})

test('an empty inline key is refused instead of silently writing a plaintext backup', () => {
  // #553 review: `BACKUP_ENCRYPTION_KEY=` is present but empty, which is what a
  // secret that expands to "" looks like. The empty-key guard only covered the
  // file source, so this shape fell through to `key === null` and wrote an
  // unencrypted copy with exit 0.
  const root = mkdtempSync(join(tmpdir(), 'fledge-encrypted-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  seed(dbPath)

  const result = run(backupScript, ['--db', dbPath, '--backup-dir', backupDir], { BACKUP_ENCRYPTION_KEY: '' })
  assert.equal(result.code, 2, `an empty inline key must refuse, got exit ${result.code}: ${result.stdout}${result.stderr}`)
  assert.match(result.stderr, /BACKUP_ENCRYPTION_KEY/, 'the refusal must name the empty source')
  assert.match(result.stderr, /empty/i)
  assert.equal(backupFiles(backupDir).length, 0, 'a refused run must not write a copy of any kind')
  assert.equal(existsSync(backupDir), false, 'a refused run must not create the backup directory')
})

test('the key file is supported and the key is still never printed', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-encrypted-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  const workDir = join(root, 'work')
  const keyFile = join(root, 'backup.key')
  seed(dbPath)
  writeFileSync(keyFile, `${TEST_KEY}\n`, { mode: 0o600 })
  chmodSync(keyFile, 0o600)

  const env = { BACKUP_ENCRYPTION_KEY_FILE: keyFile }
  const backup = run(backupScript, ['--db', dbPath, '--backup-dir', backupDir], env)
  assert.equal(backup.code, 0, backup.stderr)
  assert.match(basename(onlyBackup(backupDir)), /\.db\.enc$/)
  assertNoKeyMaterial(backup.stdout + backup.stderr, TEST_KEY)

  const drill = run(drillScript, ['--db', dbPath, '--backup-dir', backupDir, '--work-dir', workDir], env)
  assert.equal(drill.code, 0, drill.stderr)
  assert.match(drill.stdout, /^restore-drill: OK$/m)
  assertNoKeyMaterial(drill.stdout + drill.stderr, TEST_KEY)
})

test('required mode refuses a run without a key and succeeds with one', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-encrypted-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const refusedDir = join(root, 'refused')
  const encryptedDir = join(root, 'encrypted')
  seed(dbPath)

  const refused = run(backupScript, ['--db', dbPath, '--backup-dir', refusedDir], { BACKUP_ENCRYPTION_REQUIRED: 'true' })
  assert.equal(refused.code, 2, refused.stdout)
  assert.match(refused.stderr, /BACKUP_ENCRYPTION_REQUIRED|required|no .*key/i)
  assert.equal(existsSync(refusedDir), false, 'a refused run must not create the backup directory')

  const accepted = run(backupScript, ['--db', dbPath, '--backup-dir', encryptedDir], { BACKUP_ENCRYPTION_KEY: TEST_KEY, BACKUP_ENCRYPTION_REQUIRED: 'true' })
  assert.equal(accepted.code, 0, accepted.stderr)
  assert.match(basename(onlyBackup(encryptedDir)), /\.db\.enc$/)
})

test('plaintext remains the default and existing backups keep restoring without a key', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-encrypted-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  const workDir = join(root, 'work')
  seed(dbPath)

  const backup = run(backupScript, ['--db', dbPath, '--backup-dir', backupDir])
  assert.equal(backup.code, 0, backup.stderr)
  const copy = onlyBackup(backupDir)
  assert.match(basename(copy), /\.db$/)
  assert.equal(readManifest(copy).encryption, undefined)

  const drill = run(drillScript, ['--db', dbPath, '--backup-dir', backupDir, '--work-dir', workDir])
  assert.equal(drill.code, 0, drill.stderr)
  assert.match(drill.stdout, /^restore-drill: OK$/m)
})

test('setting both key sources is refused instead of guessing which key to use', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-encrypted-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const keyFile = join(root, 'backup.key')
  seed(dbPath)
  writeFileSync(keyFile, TEST_KEY, { mode: 0o600 })

  const result = run(backupScript, ['--db', dbPath, '--backup-dir', join(root, 'backups')], {
    BACKUP_ENCRYPTION_KEY: TEST_KEY,
    BACKUP_ENCRYPTION_KEY_FILE: keyFile,
  })
  assert.equal(result.code, 2, result.stdout)
  assert.match(result.stderr, /only one|both|ambiguous/i)
  assert.equal(existsSync(join(root, 'backups')), false)
})

test('the drill --fresh path encrypts the copy it takes instead of writing plaintext', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-encrypted-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  const workDir = join(root, 'work')
  seed(dbPath)

  const drill = run(drillScript, ['--db', dbPath, '--backup-dir', backupDir, '--work-dir', workDir, '--fresh'], { BACKUP_ENCRYPTION_KEY: TEST_KEY })
  assert.equal(drill.code, 0, drill.stderr)
  assert.match(drill.stdout, /^restore-drill: OK$/m)

  const copy = onlyBackup(backupDir)
  assert.match(basename(copy), /\.db\.enc$/)
  assert.equal(existsSync(copy.replace(/\.enc$/, '')), false, 'the drill must not leave a plaintext copy behind')
  assert.equal((readManifest(copy).encryption as Record<string, unknown>).keyId, readEnvelope(copy).keyId)
  assert.equal(existsSync(join(workDir, 'restored.db')), true)
})

test('the deploy runbook documents encryption, key custody, decryption and the lost-key failure', () => {
  const doc = readFileSync(deployDoc, 'utf8')
  for (const name of ['BACKUP_ENCRYPTION_KEY', 'BACKUP_ENCRYPTION_KEY_FILE', 'BACKUP_ENCRYPTION_REQUIRED']) {
    assert.ok(doc.includes(name), `docs/deploy.md must name ${name}`)
  }
  assert.match(doc, /plaintext/i, 'the runbook must state the default')
  assert.match(doc, /\.db\.enc/, 'the runbook must name the encrypted copy extension')
  assert.match(doc, /lost[ -]?key/i, 'the runbook must cover the lost-key failure')
  assert.match(doc, /decrypt/i, 'the runbook must cover decryption')
  assert.match(doc, /key custody|keep the key|custody/i, 'the runbook must cover key custody')
})
