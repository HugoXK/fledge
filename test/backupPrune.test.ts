import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../src/db.js'
import { loadConfig } from '../src/config.js'
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

test('the admin backup card shows the same count the dry run would take', () => {
  const { dir } = makeFixture()
  const config = {
    ...testConfig(),
    backup: { dir, expectedIntervalHours: 26, keepPlaintext: 1, keepEncrypted: 30 },
  }
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
    assert.match(card[0], /Expired copies/)
    assert.match(card[0], /4 \(dry run\)/)
  } finally {
    store.close()
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
