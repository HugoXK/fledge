import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../src/db.js'
import { loadConfig, type Config } from '../src/config.js'
import { adminPage } from '../src/views/pages.js'
import { makeUser, testConfig } from './helpers.js'

// #692: the retention policy lives outside the repository today (the host
// wrapper overrides `--keep`), and the console lists every legacy copy rather
// than the number the next scan would take. The scan is a dry run: it decides,
// prints and deletes nothing, so the operator approves the counts and the
// owner runs the first real deletion once an `--apply` mode exists.
const script = fileURLToPath(new URL('../scripts/backup-prune.mjs', import.meta.url))

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

function runPrune(args: string[], env: Record<string, string> = {}): RunResult {
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

// #1188: the writer is the only program that deletes, so the agreement this
// file asserts is between the writer and the plan the console shows — not
// between two scans.
const backupScript = fileURLToPath(new URL('../scripts/backup.mjs', import.meta.url))

function runBackup(args: string[], env: Record<string, string> = {}): RunResult {
  // The key variables decide which class a run writes; a fixture that seeds one
  // class has to run with neither of them set.
  const clean: Record<string, string | undefined> = { ...process.env, ...env }
  delete clean.BACKUP_ENCRYPTION_KEY
  delete clean.BACKUP_ENCRYPTION_KEY_FILE
  delete clean.BACKUP_ENCRYPTION_REQUIRED
  try {
    const stdout = execFileSync(process.execPath, [backupScript, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: clean as NodeJS.ProcessEnv,
    })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string; stderr?: string }
    return { code: failure.status ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

/** A real SQLite file: the writer refuses a source it cannot open. */
function seedDatabase(dbPath: string): void {
  mkdirSync(dirname(dbPath), { recursive: true })
  const store = new Store(dbPath)
  store.close()
}

function copiesOf(dir: string, kind: 'plaintext' | 'encrypted'): string[] {
  return readdirSync(dir).filter((name) => (kind === 'encrypted' ? name.endsWith('.db.enc') : name.endsWith('.db')))
}

function stamp(index: number): string {
  return `2026-11-10T02-00-${String(index % 60).padStart(2, '0')}-000Z`
}

interface FixtureCopy {
  name: string
  path: string
  kind: 'plaintext' | 'encrypted'
  ageHours: number
}

/**
 * A copy is `fledge-<stamp>.db` (plaintext) or `.db.enc` (encrypted), each with
 * a manifest beside it and the two sidecars a live SQLite writer leaves. The
 * mtime carries the age the scan reports; the name only has to parse as a copy.
 */
function writeCopy(dir: string, index: number, kind: 'plaintext' | 'encrypted', ageHours: number): FixtureCopy {
  const suffix = kind === 'encrypted' ? '.db.enc' : '.db'
  const name = `fledge-${stamp(index)}${suffix}`
  const path = join(dir, name)
  const content = Buffer.from(`${kind} backup ${index}\n`)
  writeFileSync(path, content)
  const record = {
    copy: name,
    createdAt: '2026-11-10T02:00:00.000Z',
    size: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex'),
    schemaVersion: 3,
    tables: { jobs: 1 },
    ...(kind === 'encrypted' ? { encryption: { format: 'fledge-backup', version: 1, kdf: 'raw', keyId: 'k_test', keyVersion: 1 } } : {}),
  }
  writeFileSync(`${path}.json`, `${JSON.stringify(record, null, 2)}\n`)
  for (const sidecar of ['-wal', '-shm']) writeFileSync(`${path}${sidecar}`, '')
  // Ages are relative to the wall clock the scan runs with, minus two minutes so
  // a run that crosses an hour boundary still reports the age the fixture set.
  const seconds = (Date.now() - ageHours * 3_600_000 - 120_000) / 1000
  utimesSync(path, seconds, seconds)
  for (const sidecar of ['-wal', '-shm']) utimesSync(`${path}${sidecar}`, seconds, seconds)
  return { name, path, kind, ageHours }
}

/** The 3 + 32 shape the production host actually held on 2026-11-14. */
function makeFixture(): { dir: string; copies: FixtureCopy[] } {
  const root = mkdtempSync(join(tmpdir(), 'fledge-backup-prune-'))
  const dir = join(root, 'backups')
  mkdirSync(dir)
  const copies: FixtureCopy[] = []
  // Newest first: index 0 is one hour old, so with keep=1 the two oldest of the
  // three plaintext copies are beyond the count.
  for (let index = 0; index < 3; index += 1) copies.push(writeCopy(dir, index, 'plaintext', index + 1))
  for (let index = 0; index < 32; index += 1) copies.push(writeCopy(dir, index, 'encrypted', index + 1))
  return { dir, copies }
}

/** Names, sizes and mtimes: what a delete would change even when contents are equal. */
function snapshot(dir: string): string {
  return readdirSync(dir)
    .sort()
    .map((name) => {
      const stat = statSync(join(dir, name))
      return `${name} ${stat.size} ${stat.mtimeMs}`
    })
    .join('\n')
}

test('the dry run lists the copies beyond each keep count and deletes nothing', () => {
  const { dir, copies } = makeFixture()
  const before = snapshot(dir)

  const result = runPrune(['--backup-dir', dir, '--keep-plaintext', '1', '--keep-encrypted', '30'])
  assert.equal(result.code, 0, result.stderr)

  // The counts the policy asks for: 3 plaintext / 32 encrypted, keep 1 / 30.
  assert.match(result.stdout, /expired=4\b/)
  // Four copies, four manifests and two sidecars each: everything the next
  // `--apply` would name, and nothing else.
  assert.match(result.stdout, /candidates=16\b/)

  const lines = result.stdout.split('\n').filter((line) => /^(copy|manifest|sidecar) /.test(line))
  assert.equal(lines.length, 16, result.stdout)

  const expired = copies.filter((copy) => (copy.kind === 'plaintext' ? copy.ageHours > 1 : copy.ageHours > 30))
  assert.equal(expired.length, 4)
  for (const copy of expired) {
    const line = lines.find((entry) => entry.includes(copy.path))
    assert.ok(line !== undefined, `no candidate line for ${copy.name}\n${result.stdout}`)
    assert.match(line, new RegExp(`class=${copy.kind}`))
    assert.match(line, new RegExp(`age=${copy.ageHours}h`))
    assert.match(line, /reason=/)
  }

  // Dry run means dry run: the directory listing, every size and every mtime
  // are byte-identical afterwards.
  assert.equal(snapshot(dir), before)
})

test('a directory inside its keep counts exits 0 with no candidates', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-backup-prune-'))
  const dir = join(root, 'backups')
  mkdirSync(dir)
  writeCopy(dir, 0, 'plaintext', 1)
  for (let index = 0; index < 2; index += 1) writeCopy(dir, index, 'encrypted', index + 1)

  const result = runPrune(['--backup-dir', dir, '--keep-plaintext', '1', '--keep-encrypted', '30'])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /expired=0\b/)
  assert.match(result.stdout, /candidates=0\b/)
  assert.doesNotMatch(result.stdout, /^(copy|manifest|sidecar) /m)
})

test('a missing backup directory is an empty scan, not an error', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-backup-prune-'))
  const dir = join(root, 'not-created-yet')

  const result = runPrune(['--backup-dir', dir, '--keep-plaintext', '1', '--keep-encrypted', '30'])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /expired=0\b/)
  assert.match(result.stdout, /candidates=0\b/)
})

test('a path that is a regular file is refused, not scanned as zero copies', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-backup-prune-'))
  const file = join(root, 'backups')
  writeFileSync(file, 'not a directory\n')

  // Before this fix the catch swallowed ENOTDIR, so a typo'd path printed
  // `expired=0 candidates=0` and exited 0 — the one answer that says "nothing
  // to prune" while nothing was ever listed.
  const result = runPrune(['--backup-dir', file, '--keep-plaintext', '1', '--keep-encrypted', '30'])
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /ENOTDIR/)
})

test('--json carries the same decision for the console and a script', () => {
  const { dir } = makeFixture()
  const result = runPrune(['--backup-dir', dir, '--keep-plaintext', '1', '--keep-encrypted', '30', '--json'])
  assert.equal(result.code, 0, result.stderr)
  const parsed = JSON.parse(result.stdout) as {
    dryRun: boolean
    keep: { plaintext: number; encrypted: number }
    expiredCopies: number
    candidateCount: number
    candidates: { path: string; kind: string; ageHours: number; reason: string }[]
  }
  assert.equal(parsed.dryRun, true)
  assert.deepEqual(parsed.keep, { plaintext: 1, encrypted: 30 })
  assert.equal(parsed.expiredCopies, 4)
  assert.equal(parsed.candidateCount, 16)
  assert.equal(parsed.candidates.length, 16)
  for (const candidate of parsed.candidates) {
    assert.ok(candidate.path.endsWith('.db') || candidate.path.endsWith('.db.enc') || candidate.path.endsWith('-wal') || candidate.path.endsWith('-shm') || candidate.path.endsWith('.json'))
    assert.ok(['copy', 'manifest', 'sidecar'].includes(candidate.kind))
    assert.equal(typeof candidate.ageHours, 'number')
  }
})

/** The `/admin` backup card, rendered against a fixture config. */
function adminBackupCard(config: Config): string {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'backup-prune-admin', status: 'approved', superadmin: true })
    const html = adminPage({
      config,
      locale: 'en',
      viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' },
      users: [],
      jobs: [],
      jobsPage: 1,
      jobsTotal: 0,
      audit: [],
      auditPage: 1,
      auditTotal: 0,
      perPage: 10,
    })
    const card = /<section[^>]*id="backups"[\s\S]*?<\/section>/.exec(html)
    assert.ok(card !== null, 'the admin page has no backup card')
    return card[0]
  } finally {
    store.close()
  }
}

test('the admin backup card shows the same count the dry run would take', () => {
  const { dir } = makeFixture()
  const card = adminBackupCard({
    ...testConfig(),
    backup: { dir, expectedIntervalHours: 26, keepPlaintext: 1, keepEncrypted: 30 },
  })
  assert.match(card, /Expired copies/)
  assert.match(card, /4 \(dry run\)/)
})

test('an unreadable backup directory is a row on the card, not a 500', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-backup-prune-'))
  const dir = join(root, 'backups')
  mkdirSync(dir)
  writeCopy(dir, 0, 'plaintext', 1)
  chmodSync(dir, 0o000)
  try {
    // The same `/admin` request that read `200` before this slice: the strict
    // scan still throws, but the page renders the errno and the policy counts it
    // would apply instead of failing the whole request.
    const card = adminBackupCard({
      ...testConfig(),
      backup: { dir, expectedIntervalHours: 26, keepPlaintext: 1, keepEncrypted: 30 },
    })
    assert.match(card, /scan failed: EACCES/)
    assert.match(card, /keep 1 plaintext \/ 30 encrypted/)
    assert.match(card, /Copies/)
  } finally {
    chmodSync(dir, 0o755)
  }
})

test('the keep counts default to 1 plaintext / 30 encrypted and refuse zero', () => {
  const saved = { plaintext: process.env.BACKUP_KEEP_PLAINTEXT, encrypted: process.env.BACKUP_KEEP_ENCRYPTED }
  try {
    delete process.env.BACKUP_KEEP_PLAINTEXT
    delete process.env.BACKUP_KEEP_ENCRYPTED
    const defaults = loadConfig({ env: 'test', dataDir: '/tmp/fledge-test', dbPath: ':memory:' })
    assert.deepEqual(
      { plaintext: defaults.backup.keepPlaintext, encrypted: defaults.backup.keepEncrypted },
      { plaintext: 1, encrypted: 30 },
    )
    // A keep count decides what gets deleted, so an invalid one is refused
    // rather than clamped: 0 would erase every plaintext copy.
    process.env.BACKUP_KEEP_PLAINTEXT = '0'
    assert.throws(
      () => loadConfig({ env: 'test', dataDir: '/tmp/fledge-test', dbPath: ':memory:' }),
      /BACKUP_KEEP_PLAINTEXT must be a positive whole number/,
    )
  } finally {
    if (saved.plaintext === undefined) delete process.env.BACKUP_KEEP_PLAINTEXT
    else process.env.BACKUP_KEEP_PLAINTEXT = saved.plaintext
    if (saved.encrypted === undefined) delete process.env.BACKUP_KEEP_ENCRYPTED
    else process.env.BACKUP_KEEP_ENCRYPTED = saved.encrypted
  }
})

test('the writer prunes each class at the counts the console reports', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-backup-prune-'))
  const dbPath = join(root, 'live', 'fledge.db')
  seedDatabase(dbPath)

  // Encrypted half: the plan reports keep 1 plaintext / 30 encrypted, so twenty
  // encrypted copies are inside the policy and a writer run must leave twenty.
  // Before this fix the writer pruned the merged list to its own 14 and left 13 —
  // seven copies the console said were kept were deleted.
  const encryptedDir = join(root, 'encrypted')
  mkdirSync(encryptedDir)
  for (let index = 1; index <= 20; index += 1) writeCopy(encryptedDir, index, 'encrypted', index)
  const encryptedRun = runBackup(['--db', dbPath, '--backup-dir', encryptedDir])
  assert.equal(encryptedRun.code, 0, encryptedRun.stderr)
  assert.equal(copiesOf(encryptedDir, 'encrypted').length, 20, 'the writer deleted encrypted copies the reported policy keeps')
  const encryptedPlan = runPrune(['--backup-dir', encryptedDir, '--json'])
  assert.equal(encryptedPlan.code, 0, encryptedPlan.stderr)
  assert.equal(
    (JSON.parse(encryptedPlan.stdout) as { expiredCopies: number }).expiredCopies,
    0,
    'after a writer run at the reported counts the plan must be empty',
  )
  // The log line is the operator's only account of which policy ran, so it names
  // both counts; an override run adds `override=--keep` beside them.
  assert.match(encryptedRun.stdout, /^retention=keep:plaintext=1,encrypted=30 pruned=0 intermediates=0$/m)

  // Plaintext half: keep 1, so the run leaves the copy it just wrote and takes
  // the twenty fixture copies, and the plan afterwards agrees with it.
  const plaintextDir = join(root, 'plaintext')
  mkdirSync(plaintextDir)
  for (let index = 1; index <= 20; index += 1) writeCopy(plaintextDir, index, 'plaintext', index)
  const plaintextRun = runBackup(['--db', dbPath, '--backup-dir', plaintextDir])
  assert.equal(plaintextRun.code, 0, plaintextRun.stderr)
  assert.equal(copiesOf(plaintextDir, 'plaintext').length, 1, 'the write-time plaintext count is 1, not the merged 14')
  const plaintextPlan = runPrune(['--backup-dir', plaintextDir, '--json'])
  assert.equal(plaintextPlan.code, 0, plaintextPlan.stderr)
  assert.equal(
    (JSON.parse(plaintextPlan.stdout) as { expiredCopies: number }).expiredCopies,
    0,
    'a card number that no run will take is the false report this test exists to stop',
  )
  assert.match(plaintextRun.stdout, /^retention=keep:plaintext=1,encrypted=30 pruned=20 intermediates=0$/m)
})

test('a copy with a future mtime never outranks the copy the run writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-backup-prune-'))
  const dbPath = join(root, 'live', 'fledge.db')
  seedDatabase(dbPath)
  const dir = join(root, 'plaintext')
  mkdirSync(dir)

  // A clock stepped back, or a set restored with `cp -a`, leaves a copy whose
  // mtime is ahead of the copy this run writes. Sorting by mtime alone puts that
  // stale copy first and the writer prunes its own backup while printing a
  // `backup=` path that no longer exists.
  const stale = writeCopy(dir, 0, 'plaintext', 1)
  const future = (Date.now() + 3_600_000) / 1000
  utimesSync(stale.path, future, future)

  const run = runBackup(['--db', dbPath, '--backup-dir', dir])
  assert.equal(run.code, 0, run.stderr)
  const written = /^backup=(.+)$/m.exec(run.stdout)?.[1]
  assert.ok(written !== undefined, `the run printed no backup path\n${run.stdout}`)
  assert.ok(existsSync(written), `the run reported a backup it had already pruned: ${written}`)
  assert.ok(!existsSync(stale.path), 'the future-dated copy should have been the one pruned')
  assert.equal(copiesOf(dir, 'plaintext').length, 1)
  assert.match(run.stdout, /pruned=1\b/)

  const plan = runPrune(['--backup-dir', dir, '--json'])
  assert.equal(plan.code, 0, plan.stderr)
  assert.equal(
    (JSON.parse(plan.stdout) as { expiredCopies: number }).expiredCopies,
    0,
    'the plan after the run must be empty when one copy was kept',
  )
})

test('an explicitly empty keep override is refused, not treated as absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-backup-prune-'))
  const dbPath = join(root, 'live', 'fledge.db')
  seedDatabase(dbPath)
  const dir = join(root, 'plaintext')
  mkdirSync(dir)
  // Three planted plaintext copies the defaults would prune to one.
  for (let index = 1; index <= 3; index += 1) writeCopy(dir, index, 'plaintext', index)
  const before = snapshot(dir)

  // A wrapper whose variable expands empty must not fall through to the
  // defaults and delete: the value was passed, so it is validated.
  for (const run of [
    runBackup(['--db', dbPath, '--backup-dir', dir, '--keep', '']),
    runBackup(['--db', dbPath, '--backup-dir', dir], { BACKUP_KEEP: '' }),
  ]) {
    assert.equal(run.code, 2, run.stderr)
    assert.match(run.stderr, /--keep must be a positive whole number, got/)
    assert.doesNotMatch(run.stdout, /^backup=/m)
  }
  assert.equal(snapshot(dir), before, 'a refused override must delete nothing')
})

test('an accepted keep override still prints the override marker', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-backup-prune-'))
  const dbPath = join(root, 'live', 'fledge.db')
  seedDatabase(dbPath)
  const dir = join(root, 'plaintext')
  mkdirSync(dir)
  for (let index = 1; index <= 3; index += 1) writeCopy(dir, index, 'plaintext', index)

  const run = runBackup(['--db', dbPath, '--backup-dir', dir, '--keep', '2'])
  assert.equal(run.code, 0, run.stderr)
  assert.match(run.stdout, /^retention=keep:plaintext=2,encrypted=2 override=--keep pruned=2 intermediates=0$/m)
  assert.equal(copiesOf(dir, 'plaintext').length, 2)
})
