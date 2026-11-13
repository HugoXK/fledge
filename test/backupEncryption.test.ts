import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, scryptSync } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../src/db.js'
import { encryptBackupFile, loadBackupKey } from '../scripts/lib/backup-crypto.mjs'
import { readManifest as readManifestFile } from '../scripts/lib/backup-manifest.mjs'
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
  // spawnSync, not execFileSync: a successful run can still write a warning to
  // stderr (a key file with a mode wider than 0600), and execFileSync drops it.
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...inherited, ...env },
  })
  return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
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

  // sha256(TEST_PASSPHRASE) cut to 16 hex, which is exactly the id the old code
  // published. It is a literal on purpose: computing it here would put a fast
  // hash of a password in the suite, which is the shape
  // `js/insufficient-password-hash` exists to catch, and this test proves the
  // opposite of that finding. It moves only if TEST_PASSPHRASE moves.
  const oldFastId = 'f2a39432a180e70c'
  assert.notEqual(envelope.keyId, oldFastId, 'the published key id must not be an offline verifier for the passphrase')
  const stretched = scryptSync(TEST_PASSPHRASE, Buffer.from(String(envelope.salt), 'base64'), 32)
  assert.equal(envelope.keyId, expectedKeyId(stretched), 'the id must fingerprint the stretched key')
  assert.equal((readManifest(copy).encryption as Record<string, unknown>).keyId, envelope.keyId, 'the manifest must name the same key as the envelope')
  assert.doesNotMatch(backup.stdout, new RegExp(TEST_PASSPHRASE))

  // A second copy from the same passphrase must carry a different id: the old
  // published value was salt-independent and therefore stable across every copy
  // the passphrase ever wrote, so one id could be used to test guesses against
  // all of them.
  const secondDir = join(root, 'backups-2')
  const second = run(backupScript, ['--db', dbPath, '--backup-dir', secondDir], { BACKUP_ENCRYPTION_KEY: TEST_PASSPHRASE })
  assert.equal(second.code, 0, second.stderr)
  const secondEnvelope = readEnvelope(onlyBackup(secondDir))
  assert.notEqual(secondEnvelope.keyId, envelope.keyId, 'a per-copy id must not repeat across copies of the same passphrase')
  assert.notEqual(secondEnvelope.salt, envelope.salt, 'the salt must be fresh per copy')
  assert.equal(secondEnvelope.keyId, expectedKeyId(scryptSync(TEST_PASSPHRASE, Buffer.from(String(secondEnvelope.salt), 'base64'), 32)))

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
  assert.match(doc, /base64-shaped|not base64/i, 'the runbook must say how to declare a passphrase now that a truncated base64 key is refused')
})

test('the runbook passphrase example is one the code refuses, and the accepted example really is accepted', () => {
  // Review finding on #591: the first version of this sentence said
  // `correcthorsebatterystaple` does not work. It does — 25 characters, and
  // `decodeBase64` returns null when `length % 4 === 1` — so the one sentence an
  // operator acts on contradicted the code. The document is pinned to the
  // implementation here: the refused example must throw, the near-miss must pass.
  const doc = readFileSync(deployDoc, 'utf8')
  const refused = 'abcdefghijklmnopqrstuvwx'
  assert.ok(doc.includes(refused), `docs/deploy.md must show a value the code refuses, e.g. ${refused}`)
  assert.equal(Buffer.from(refused, 'base64').length, 18, 'the refused example must decode into the 16–31 byte window')
  assert.throws(() => loadBackupKey({ BACKUP_ENCRYPTION_KEY: refused }), /18 bytes/)

  const accepted = 'correcthorsebatterystaple'
  assert.ok(doc.includes(accepted), 'the runbook must name the near-miss it used to claim was refused')
  assert.equal(loadBackupKey({ BACKUP_ENCRYPTION_KEY: accepted })?.kind, 'passphrase')
})

test('a copy says which key derivation produced it, in the manifest and on the printed line', () => {
  // #588: the envelope records `kdf` (`backup-crypto.mjs:104`) but everything an
  // operator reads drops it, so a copy written under a passphrase and one written
  // under a raw key are indistinguishable without re-deriving the id by hand.
  const root = mkdtempSync(join(tmpdir(), 'fledge-encrypted-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const rawDir = join(root, 'raw')
  const phraseDir = join(root, 'phrase')
  seed(dbPath)

  const raw = run(backupScript, ['--db', dbPath, '--backup-dir', rawDir], { BACKUP_ENCRYPTION_KEY: TEST_KEY })
  assert.equal(raw.code, 0, raw.stderr)
  const rawCopy = onlyBackup(rawDir)
  assert.equal(readEnvelope(rawCopy).kdf, 'raw')
  assert.equal((readManifest(rawCopy).encryption as Record<string, unknown>).kdf, 'raw', 'the manifest must say how the key was derived')
  assert.match(raw.stdout, /^encryption=aes-256-gcm kdf=raw key_id=[0-9a-f]{16} key_version=1$/m)

  const phrase = run(backupScript, ['--db', dbPath, '--backup-dir', phraseDir], { BACKUP_ENCRYPTION_KEY: TEST_PASSPHRASE })
  assert.equal(phrase.code, 0, phrase.stderr)
  const phraseCopy = onlyBackup(phraseDir)
  assert.equal(readEnvelope(phraseCopy).kdf, 'scrypt')
  assert.equal((readManifest(phraseCopy).encryption as Record<string, unknown>).kdf, 'scrypt')
  assert.match(phrase.stdout, /^encryption=aes-256-gcm kdf=scrypt key_id=[0-9a-f]{16} key_version=1$/m)

  // The drill prints the same line when it decrypts an existing copy, so a
  // restore is self-describing too.
  const drill = run(drillScript, ['--db', dbPath, '--backup-dir', phraseDir, '--work-dir', join(root, 'work')], { BACKUP_ENCRYPTION_KEY: TEST_PASSPHRASE })
  assert.equal(drill.code, 0, drill.stderr)
  assert.match(drill.stdout, /^encryption=aes-256-gcm kdf=scrypt key_id=[0-9a-f]{16} key_version=1$/m)
})

test('a truncated base64 key is refused instead of silently becoming a passphrase', () => {
  // #588: a 32-byte base64 key is 44 characters. Cut to 42 or 40 it still looks
  // like base64, decodes to 31 or 30 bytes, fails the exactly-32 check and used to
  // fall through to the passphrase path: the copy is written under a key the
  // operator does not think it set, with an id that looks normal.
  const root = mkdtempSync(join(tmpdir(), 'fledge-encrypted-'))
  const dbPath = join(root, 'live', 'fledge.db')
  seed(dbPath)
  const cases = [
    { label: '31 bytes', value: TEST_KEY.slice(0, 42), bytes: 31, source: 'BACKUP_ENCRYPTION_KEY', dir: join(root, 'inline') },
    { label: '30 bytes', value: TEST_KEY.slice(0, 40), bytes: 30, source: 'BACKUP_ENCRYPTION_KEY_FILE', dir: join(root, 'file') },
  ] as const
  for (const item of cases) {
    assert.equal(Buffer.from(item.value, 'base64').length, item.bytes, `the fixture for ${item.label} must decode to ${item.bytes} bytes`)
    let env: Record<string, string>
    if (item.source === 'BACKUP_ENCRYPTION_KEY') {
      env = { BACKUP_ENCRYPTION_KEY: item.value }
    } else {
      const keyFile = join(root, 'truncated.key')
      writeFileSync(keyFile, `${item.value}\n`, { mode: 0o600 })
      chmodSync(keyFile, 0o600)
      env = { BACKUP_ENCRYPTION_KEY_FILE: keyFile }
    }
    const result = run(backupScript, ['--db', dbPath, '--backup-dir', item.dir], env)
    assert.equal(result.code, 2, `a ${item.label} base64 key must refuse, got exit ${result.code}: ${result.stdout}${result.stderr}`)
    assert.match(result.stderr, new RegExp(item.source), `the refusal must name the source it came from (${item.label})`)
    assert.match(result.stderr, new RegExp(`\\b${item.bytes}\\b`), 'the refusal must name the decoded byte count')
    assert.match(result.stderr, /32/, 'the refusal must say what a full key looks like')
    assert.ok(!result.stderr.includes(item.value), 'the refusal must never echo the value')
    assert.ok(!result.stdout.includes(item.value), 'the refusal must never echo the value')
    assert.equal(backupFiles(item.dir).length, 0, 'a refused run must not write a copy of any kind')
    assert.equal(existsSync(item.dir), false, 'a refused run must not create the backup directory')
  }
})

test('a passphrase that is not base64-shaped still encrypts and drills back', () => {
  // The refusal above must not narrow the documented fallback: a value outside the
  // base64 alphabet is the documented way to say "this is a passphrase".
  const root = mkdtempSync(join(tmpdir(), 'fledge-encrypted-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  const workDir = join(root, 'work')
  seed(dbPath)
  const passphrase = 'fladge backup, spaces and a comma'
  assert.doesNotMatch(passphrase, /^[A-Za-z0-9+/]+={0,2}$/)

  const backup = run(backupScript, ['--db', dbPath, '--backup-dir', backupDir], { BACKUP_ENCRYPTION_KEY: passphrase })
  assert.equal(backup.code, 0, backup.stderr)
  const copy = onlyBackup(backupDir)
  assert.equal(readEnvelope(copy).kdf, 'scrypt')

  const drill = run(drillScript, ['--db', dbPath, '--backup-dir', backupDir, '--work-dir', workDir], { BACKUP_ENCRYPTION_KEY: passphrase })
  assert.equal(drill.code, 0, drill.stderr)
  assert.match(drill.stdout, /^restore-drill: OK$/m)
  assertNoKeyMaterial(backup.stdout + backup.stderr + drill.stdout + drill.stderr, passphrase)
})

test('the truncated-key window is pinned on both sides: 31 bytes refuses, 32 is a key, 33 is a passphrase', () => {
  // A one-sided boundary test is how a window becomes a hole later, so all three
  // neighbours are pinned: the byte below the window, the accepted key length and
  // the byte above the window (which is not a truncated 32-byte key and stays a
  // passphrase, as docs/deploy.md has always documented).
  const root = mkdtempSync(join(tmpdir(), 'fledge-encrypted-'))
  const dbPath = join(root, 'live', 'fledge.db')
  seed(dbPath)
  // The 31-byte case is the 44-character key cut by two characters, which is what
  // a copy that lost its tail looks like; the 33-byte one is a different value that
  // happens to be a valid base64 length, so it exercises the top edge, not a cut.
  const thirtyOne = TEST_KEY.slice(0, 42)
  const thirtyTwo = TEST_KEY
  const thirtyThree = Buffer.alloc(33, 0x44).toString('base64')
  assert.equal(Buffer.from(thirtyOne, 'base64').length, 31)
  assert.equal(Buffer.from(thirtyTwo, 'base64').length, 32)
  assert.equal(Buffer.from(thirtyThree, 'base64').length, 33)

  const refusedDir = join(root, 'refused')
  const refused = run(backupScript, ['--db', dbPath, '--backup-dir', refusedDir], { BACKUP_ENCRYPTION_KEY: thirtyOne })
  assert.equal(refused.code, 2, `31 bytes must refuse, got exit ${refused.code}: ${refused.stdout}${refused.stderr}`)
  assert.match(refused.stderr, /\b31\b/, 'the refusal must name the decoded byte count')
  assert.equal(existsSync(refusedDir), false)

  const rawDir = join(root, 'raw')
  const raw = run(backupScript, ['--db', dbPath, '--backup-dir', rawDir], { BACKUP_ENCRYPTION_KEY: thirtyTwo })
  assert.equal(raw.code, 0, raw.stderr)
  const rawCopy = onlyBackup(rawDir)
  assert.equal(readEnvelope(rawCopy).kdf, 'raw')
  assert.equal((readManifest(rawCopy).encryption as Record<string, unknown>).kdf, 'raw')

  const phraseDir = join(root, 'phrase')
  const phrase = run(backupScript, ['--db', dbPath, '--backup-dir', phraseDir], { BACKUP_ENCRYPTION_KEY: thirtyThree })
  assert.equal(phrase.code, 0, phrase.stderr)
  const phraseCopy = onlyBackup(phraseDir)
  assert.equal(readEnvelope(phraseCopy).kdf, 'scrypt', '33 bytes is above the truncated-key window and stays a passphrase')
  assert.equal((readManifest(phraseCopy).encryption as Record<string, unknown>).kdf, 'scrypt')
})

test('a key file readable by others still encrypts but warns, and never refuses', () => {
  // #588: the runbook requires 0600 of the key file and nothing enforced it.
  // Warning rather than refusing on purpose: a backup that refuses at 03:00 is an
  // outage, and the operator can fix the mode themselves.
  const root = mkdtempSync(join(tmpdir(), 'fledge-encrypted-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  const workDir = join(root, 'work')
  const keyFile = join(root, 'backup.key')
  seed(dbPath)
  writeFileSync(keyFile, `${TEST_KEY}\n`, { mode: 0o600 })
  chmodSync(keyFile, 0o644)
  assert.equal(statSync(keyFile).mode & 0o777, 0o644)

  const env = { BACKUP_ENCRYPTION_KEY_FILE: keyFile }
  const backup = run(backupScript, ['--db', dbPath, '--backup-dir', backupDir], env)
  assert.equal(backup.code, 0, `a readable key file must not stop the backup: ${backup.stderr}`)
  assert.match(backup.stderr, /BACKUP_ENCRYPTION_KEY_FILE/, 'the warning must name the source')
  assert.match(backup.stderr, new RegExp(keyFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the warning must name the path')
  assert.match(backup.stderr, /0600|0644/, 'the warning must name the mode it found and the mode it wants')
  assert.match(backup.stderr, /warn/i)
  assertNoKeyMaterial(backup.stdout + backup.stderr, TEST_KEY)

  const drill = run(drillScript, ['--db', dbPath, '--backup-dir', backupDir, '--work-dir', workDir], env)
  assert.equal(drill.code, 0, drill.stderr)
  assert.match(drill.stdout, /^restore-drill: OK$/m)
})

test('a manifest written before kdf was recorded still validates', () => {
  // Copies written by an earlier tip have no `kdf` in `manifest.encryption`; the
  // field is new information, never a requirement to read the copy.
  const root = mkdtempSync(join(tmpdir(), 'fledge-encrypted-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  seed(dbPath)

  const backup = run(backupScript, ['--db', dbPath, '--backup-dir', backupDir], { BACKUP_ENCRYPTION_KEY: TEST_KEY })
  assert.equal(backup.code, 0, backup.stderr)
  const copy = onlyBackup(backupDir)
  const manifestPath = `${copy}.json`
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { encryption: Record<string, unknown> }
  delete manifest.encryption.kdf
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  const read = readManifestFile(copy)
  assert.ok(read !== null)
  assert.equal(read.encryption?.kdf, undefined)
})

test('a copy written under a base64-shaped passphrase still restores, while the write path keeps refusing it', async () => {
  // Review finding on #591: the 16–31 byte window lived in `loadBackupKey`, which
  // the restore drill shares through `encryptionKeyForDrill`. A copy written at
  // 3d4b1a6b under a value like this — `backup: OK`, restorable there — became
  // unrestorable at the tip, refused before decryption with a message telling the
  // operator to supply a key that cannot exist for a copy that already does.
  // The guard is a write-side one: on restore the value only has to reproduce the
  // derivation the envelope names, and GCM authentication proves whether it did.
  const root = mkdtempSync(join(tmpdir(), 'fledge-encrypted-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  const workDir = join(root, 'work')
  seed(dbPath)
  const value = 'abcdefghijklmnopqrstuvwx'
  assert.equal(Buffer.from(value, 'base64').length, 18, 'the fixture must be the refused 18-byte shape')

  mkdirSync(backupDir, { mode: 0o700 })
  const copy = join(backupDir, 'fledge-2026-01-01T00-00-00-000Z.db.enc')
  // Exactly what the previous tip wrote for this value: the passphrase path, so the
  // envelope says `scrypt` and the drill must derive the same key to authenticate.
  await encryptBackupFile(dbPath, copy, { kind: 'passphrase', secret: value })

  const drill = run(drillScript, ['--db', dbPath, '--backup-dir', backupDir, '--work-dir', workDir], { BACKUP_ENCRYPTION_KEY: value })
  assert.equal(drill.code, 0, `an existing copy must stay restorable, got exit ${drill.code}: ${drill.stderr}`)
  assert.match(drill.stdout, /^restore-drill: OK$/m)
  assert.match(drill.stdout, /^encryption=aes-256-gcm kdf=scrypt key_id=[0-9a-f]{16} key_version=1$/m)
  assertNoKeyMaterial(drill.stdout + drill.stderr, value)

  // Writing a new copy is where a truncated key would be misread, so it still refuses.
  const freshDir = join(root, 'fresh')
  const write = run(backupScript, ['--db', dbPath, '--backup-dir', freshDir], { BACKUP_ENCRYPTION_KEY: value })
  assert.equal(write.code, 2, `writing a new copy under this value must still refuse, got exit ${write.code}: ${write.stdout}${write.stderr}`)
  assert.equal(existsSync(freshDir), false, 'a refused run must not create the backup directory')
})

test('a manifest naming a key derivation the code does not implement is refused', () => {
  // Review finding on #591: the validator accepted any string for `kdf` while the
  // type says 'raw' | 'scrypt'. The envelope stays authoritative at decrypt time,
  // so nothing breaks, but a manifest should not vouch for a derivation the code
  // cannot produce.
  const root = mkdtempSync(join(tmpdir(), 'fledge-encrypted-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  seed(dbPath)

  const backup = run(backupScript, ['--db', dbPath, '--backup-dir', backupDir], { BACKUP_ENCRYPTION_KEY: TEST_KEY })
  assert.equal(backup.code, 0, backup.stderr)
  const copy = onlyBackup(backupDir)
  const manifestPath = `${copy}.json`
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { encryption: Record<string, unknown> }
  manifest.encryption.kdf = 'bogus'
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  assert.throws(() => readManifestFile(copy), /not a backup manifest/)
})
