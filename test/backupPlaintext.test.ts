import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../src/db.js'
import { makeUser } from './helpers.js'

// #580: an encrypted backup copies the live database to a plaintext file first.
// That file is a second copy of everything the encryption protects, so it may
// never sit in the backup directory - the one artifact an operator copies
// off-host - and a crash must not leave it there for `prune` to ignore.

const backupScript = fileURLToPath(new URL('../scripts/backup.mjs', import.meta.url))
const drillScript = fileURLToPath(new URL('../scripts/restore-drill.mjs', import.meta.url))

const KEY_VARIABLES = ['BACKUP_ENCRYPTION_KEY', 'BACKUP_ENCRYPTION_KEY_FILE', 'BACKUP_ENCRYPTION_REQUIRED', 'BACKUP_WORK_DIR'] as const
// A passphrase is stretched with scrypt before the ciphertext is written, which
// keeps the intermediate on disk for long enough that a 2 ms poll cannot miss it.
const TEST_PASSPHRASE = 'fledge backup plaintext test passphrase'

const SQLITE_MAGIC = 'SQLite format 3\u0000'

interface ChildResult {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
}

function childEnv(env: Record<string, string>): Record<string, string> {
  const inherited: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !(KEY_VARIABLES as readonly string[]).includes(name)) inherited[name] = value
  }
  return { ...inherited, ...env }
}

function seed(dbPath: string): void {
  const store = new Store(dbPath)
  try {
    const user = makeUser(store, { login: 'plaintext-user', status: 'approved' })
    store.createRepo({ id: 'repo_plaintext', userId: user.id, owner: 'o', name: 'plaintext', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
  } finally {
    store.close()
  }
}

// A backup of a seeded database finishes in a couple of milliseconds, which lets
// a losing run start again after the winner released its lock and look like a
// second writer. A round of this test seeds a database with this many megabytes of
// rows so the holder keeps the directory long enough for every other run in the
// round to reach the lock while it is held.
function grow(dbPath: string, megabytes: number): void {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('CREATE TABLE IF NOT EXISTS filler (id INTEGER PRIMARY KEY, blob BLOB)')
    const insert = db.prepare('INSERT INTO filler (blob) VALUES (?)')
    const chunk = Buffer.alloc(1024 * 1024, 7)
    for (let index = 0; index < megabytes; index += 1) insert.run(chunk)
  } finally {
    db.close()
  }
}

function names(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : []
}

function plaintextNames(dir: string): string[] {
  return names(dir).filter((name) => name.endsWith('.plaintext.tmp'))
}

// The copy may sit one level down, in a `fledge-backup-*` work directory, so the
// watch has to look there too: an intermediate missing from this walk would make
// the crash test prove nothing.
function intermediatePaths(dir: string): string[] {
  const found: string[] = []
  const walk = (current: string, depth: number): void => {
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      return
    }
    for (const name of entries) {
      const path = join(current, name)
      if (name.endsWith('.plaintext.tmp')) {
        found.push(path)
        continue
      }
      if (depth >= 2 || !name.startsWith('fledge-')) continue
      // Walk without a stat first: a file throws ENOTDIR into the readdir guard
      // above, and check-then-use on the same path is what js/file-system-race
      // reports.
      walk(path, depth + 1)
    }
  }
  walk(dir, 0)
  return found
}

// A leftover is only a leak if the bytes are the database, so the assertion is
// on content: a file that opens as SQLite in the backup directory is the bug.
function sqliteNames(dir: string): string[] {
  return names(dir).filter((name) => {
    // One read decides it: stat-then-read is a check-then-use on the same path
    // (js/file-system-race), and a directory throws EISDIR into this catch.
    try {
      return readFileSync(join(dir, name), { encoding: 'latin1' }).startsWith(SQLITE_MAGIC)
    } catch {
      return false
    }
  })
}

function runToCompletionSync(script: string, args: string[], env: Record<string, string>): ChildResult {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(env) })
  return { code: result.status, signal: result.signal, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

// Watches every directory the backup may write to and kills the child the
// moment a plaintext intermediate appears, which is the crash the issue
// measured: the process dies with the copy already on disk.
async function runUntilIntermediateAppears(script: string, args: string[], env: Record<string, string>, watched: string[]): Promise<{ result: ChildResult; observed: string[] }> {
  const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(env) })
  const observed: string[] = []
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  const poll = setInterval(() => {
    for (const dir of watched) {
      for (const path of intermediatePaths(dir)) {
        if (!observed.includes(path)) observed.push(path)
      }
    }
    if (observed.length > 0 && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, 2)
  const result = await new Promise<ChildResult>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
  clearInterval(poll)
  return { result, observed }
}

// The same watch without the kill, for the assertion that the intermediate is
// absent from the backup directory for the whole run rather than only at exit.
async function runWatchingDirectory(script: string, args: string[], env: Record<string, string>, watched: string[]): Promise<{ result: ChildResult; observed: string[] }> {
  const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(env) })
  const observed: string[] = []
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  const poll = setInterval(() => {
    for (const dir of watched) {
      for (const path of intermediatePaths(dir)) {
        if (!observed.includes(path)) observed.push(path)
      }
    }
  }, 2)
  const result = await new Promise<ChildResult>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
  clearInterval(poll)
  return { result, observed }
}

test('an encrypted backup never puts the plaintext copy in the backup directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-plaintext-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  seed(dbPath)

  const { result, observed } = await runWatchingDirectory(backupScript, ['--db', dbPath, '--backup-dir', backupDir], { BACKUP_ENCRYPTION_KEY: TEST_PASSPHRASE }, [backupDir])
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(observed, [], `the backup directory held a plaintext intermediate at ${observed.join(', ')}`)
  assert.deepEqual(plaintextNames(backupDir), [], 'the finished run must leave no intermediate behind')
  assert.deepEqual(sqliteNames(backupDir), [], 'nothing in the backup directory may open as SQLite')
})

test('a backup killed while it holds the plaintext copy leaves nothing readable in the backup directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-plaintext-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  const workRoot = join(root, 'work')
  mkdirSync(workRoot, { mode: 0o700 })
  seed(dbPath)

  const { observed } = await runUntilIntermediateAppears(backupScript, ['--db', dbPath, '--backup-dir', backupDir], { BACKUP_ENCRYPTION_KEY: TEST_PASSPHRASE, BACKUP_WORK_DIR: workRoot }, [backupDir, workRoot])
  assert.ok(observed.length > 0, 'the harness must catch the plaintext intermediate somewhere, or it proves nothing')

  // The crash is real from here on: whatever the run left is on disk.
  assert.deepEqual(plaintextNames(backupDir), [], `a crash left ${plaintextNames(backupDir).join(', ')} in the backup directory`)
  assert.deepEqual(sqliteNames(backupDir), [], 'the backup directory must not hold a readable database after a crash')
  // The intermediate may survive in the work directory, and that is the one
  // place it is allowed to: the directory is owner-only, so no other account
  // can read it through a path.
  for (const path of observed.filter((candidate) => dirname(candidate) !== backupDir)) {
    assert.equal(statSync(dirname(path)).mode & 0o077, 0, `the work directory holding ${path} must be owner-only`)
  }
})

test('prune collects a plaintext intermediate a crash left in the backup directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-plaintext-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  seed(dbPath)
  mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  const stale = join(backupDir, 'fledge-2026-01-01T00-00-00-000Z.db.enc.plaintext.tmp')
  writeFileSync(stale, `${SQLITE_MAGIC}stale crash leftover`, { mode: 0o600 })
  const twoHoursAgo = Date.now() / 1000 - 2 * 60 * 60
  utimesSync(stale, twoHoursAgo, twoHoursAgo)
  // A file this young may belong to a backup still running under the previous
  // version, so prune's grace window must leave it alone.
  const young = join(backupDir, 'fledge-2026-01-01T00-00-01-000Z.db.enc.plaintext.tmp')
  writeFileSync(young, `${SQLITE_MAGIC}young leftover`, { mode: 0o600 })

  const result = runToCompletionSync(backupScript, ['--db', dbPath, '--backup-dir', backupDir, '--keep', '5'], { BACKUP_ENCRYPTION_KEY: TEST_PASSPHRASE })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(existsSync(stale), false, 'a stale intermediate is uncollected garbage that is a readable database')
  assert.equal(existsSync(young), true, 'a young intermediate may be an in-flight backup and must survive prune')
  assert.equal(plaintextNames(backupDir).length, 1, 'exactly the young intermediate must remain')
})

test('BACKUP_WORK_DIR holds the intermediate and a crash leftover there is swept', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-plaintext-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  const workRoot = join(root, 'work')
  mkdirSync(workRoot, { mode: 0o700 })
  seed(dbPath)
  const staleWorkDir = join(workRoot, 'fledge-backup-20260101-000000')
  mkdirSync(staleWorkDir, { mode: 0o700 })
  writeFileSync(join(staleWorkDir, 'fledge.db'), `${SQLITE_MAGIC}crash leftover`, { mode: 0o600 })
  const twoHoursAgo = Date.now() / 1000 - 2 * 60 * 60
  utimesSync(staleWorkDir, twoHoursAgo, twoHoursAgo)

  const result = runToCompletionSync(backupScript, ['--db', dbPath, '--backup-dir', backupDir], { BACKUP_ENCRYPTION_KEY: TEST_PASSPHRASE, BACKUP_WORK_DIR: workRoot })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(existsSync(staleWorkDir), false, 'a crash leftover in the work root must not survive the next backup')
  const remaining = names(workRoot)
  assert.deepEqual(remaining, [], `the run must clean its own work directory, found ${remaining.join(', ')}`)
  assert.deepEqual(plaintextNames(backupDir), [])
})

test('the drill --fresh path keeps the plaintext copy out of the backup directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-plaintext-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  const workDir = join(root, 'drill')
  seed(dbPath)

  const { result, observed } = await runWatchingDirectory(drillScript, ['--db', dbPath, '--backup-dir', backupDir, '--work-dir', workDir, '--fresh'], { BACKUP_ENCRYPTION_KEY: TEST_PASSPHRASE }, [backupDir])
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(observed, [], `the drill held a plaintext intermediate in the backup directory at ${observed.join(', ')}`)
  assert.deepEqual(sqliteNames(backupDir), [], 'the drill must not leave a readable database in the backup directory')
})

// #1196 symptom A: two runs in one backup directory. The writer assumed it was
// the only writer, so each run pruned the other's copy and each could die on a
// `statSync`, `chmodSync` or `writeManifest` against a copy the other had just
// deleted. A run that exits 0 must leave the file it printed; a run that cannot
// must refuse on one `backup: ` line — never an uncaught stack.
interface CheckedRun extends ChildResult {
  reported: string | null
  existedAtExit: boolean | null
}

function runWriter(args: string[], env: Record<string, string>, onClose?: (path: string) => void): Promise<CheckedRun> {
  const child = spawn(process.execPath, [backupScript, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(env) })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  return new Promise((resolve) => {
    child.on('close', (code, signal) => {
      const reported = /^backup=(.+)$/m.exec(stdout)?.[1] ?? null
      // Read at the moment this run ends, not after both end: a later run
      // pruning an older copy is the retention policy working, not this defect.
      const existedAtExit = reported === null ? null : existsSync(reported)
      if (reported !== null) onClose?.(reported)
      resolve({ code, signal, stdout, stderr, reported, existedAtExit })
    })
  })
}

// The barrier the other suites use: the first writer exists once its copy is on
// disk, which is the point from which the second one can prune it.
async function waitForCopy(dir: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (names(dir).some((name) => name.startsWith('fledge-') && name.endsWith('.db'))) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error('the first writer never put a copy in the directory')
}

function assertHonestRun(label: string, result: CheckedRun): void {
  assert.doesNotMatch(result.stderr, /\n\s+at /, `${label} died with an uncaught stack instead of a backup: line: ${result.stderr}`)
  if (result.code === 0) {
    assert.ok(result.reported, `${label} exited 0 without a backup= line: ${result.stdout}`)
    assert.equal(result.existedAtExit, true, `${label} reported a copy that no longer exists: ${result.reported ?? ''}`)
  } else {
    assert.match(result.stderr, /^backup: /m, `${label} exited ${String(result.code)} without a backup: line: ${result.stderr}`)
    assert.ok(result.code === 1 || result.code === 2, `${label} exited ${String(result.code)}; a refusal is exit 1 or 2`)
  }
}

test('a backup refuses to share the directory with a run that holds it', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-plaintext-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  seed(dbPath)
  mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  // This process is alive, so its lock is live: a second run must refuse instead
  // of pruning beside it.
  writeFileSync(join(backupDir, '.fledge-backup.lock'), String(process.pid), { mode: 0o600 })

  const run = runToCompletionSync(backupScript, ['--db', dbPath, '--backup-dir', backupDir, '--keep', '1'], {})

  assert.equal(run.code, 1, `a locked directory must refuse, got exit ${String(run.code)}: ${run.stdout}`)
  assert.match(run.stderr, /^backup: another backup run holds /m, `the refusal must name the reason, got: ${run.stderr}`)
  assert.doesNotMatch(run.stderr, /\n\s+at /, `a refusal must not carry an uncaught stack: ${run.stderr}`)
  assert.deepEqual(names(backupDir).filter((name) => name.startsWith('fledge-')), [], 'a refused run must not write a copy')
  assert.equal(existsSync(join(backupDir, '.fledge-backup.lock')), true, 'a refused run must not remove the holder\'s lock')
})

test('a lock left by a run that is gone does not block the next backup', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-plaintext-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  seed(dbPath)
  mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  // 2147483647 is outside the kernel's pid range on Linux, so it is a pid that
  // cannot be alive: the shape a SIGKILLed run leaves. The file is also aged:
  // a lock is takeable only once its mtime is older than the takeover grace, so
  // a file created milliseconds ago is never mistaken for this one (#1196
  // review).
  writeFileSync(join(backupDir, '.fledge-backup.lock'), '2147483647', { mode: 0o600 })
  const longAgo = Date.now() / 1000 - 60
  utimesSync(join(backupDir, '.fledge-backup.lock'), longAgo, longAgo)

  const run = runToCompletionSync(backupScript, ['--db', dbPath, '--backup-dir', backupDir, '--keep', '1'], {})

  assert.equal(run.code, 0, run.stderr)
  assert.match(run.stdout, /^backup=/m)
  assert.equal(names(backupDir).includes('.fledge-backup.lock'), false, 'the run must release the lock it took over')
})

// #1196 review: the takeover is guarded, and this is the case that proves it.
// Every run that judges one dead lock stale used to delete it and create its own,
// so a second run could delete the fresh `O_EXCL` lock the first had just
// created and both wrote in the directory. Four runs on one planted dead lock,
// several rounds: exactly one may report a copy, and every other run must refuse
// on one `backup: ` line.
test('runs that judge the same dead lock produce exactly one writer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-plaintext-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  seed(dbPath)
  grow(dbPath, 40)
  mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  const args = ['--db', dbPath, '--backup-dir', backupDir, '--keep', '10']
  const longAgo = Date.now() / 1000 - 60

  for (let round = 1; round <= 6; round += 1) {
    // Plant the lock inside the round: the first round's winner released its own.
    const lockPath = join(backupDir, '.fledge-backup.lock')
    writeFileSync(lockPath, '2147483647', { mode: 0o600 })
    utimesSync(lockPath, longAgo, longAgo)

    const runs = await Promise.all([1, 2, 3, 4].map(() => runWriter(args, {})))
    const writers = runs.filter((run) => run.reported !== null)
    assert.equal(
      writers.length,
      1,
      `round ${round}: ${String(writers.length)} runs wrote a copy into one directory: ${runs
        .map((run) => `exit ${String(run.code)} ${run.reported ?? run.stderr.trim().split('\n')[0] ?? ''}`)
        .join(' | ')}`,
    )
    for (const run of runs) assertHonestRun(`round ${round}`, run)
    for (const run of runs.filter((candidate) => candidate.reported === null)) {
      assert.equal(run.code, 1, `round ${round}: a non-writer is a refusal, got exit ${String(run.code)}: ${run.stderr}`)
      assert.match(run.stderr, /^backup: another backup run holds /m, `round ${round}: the refusal names the holder: ${run.stderr}`)
    }

    // Reset the directory for the next round: only the lock and the copies.
    rmSync(lockPath, { force: true })
    for (const name of names(backupDir).filter((candidate) => candidate.startsWith('fledge-'))) {
      rmSync(join(backupDir, name), { force: true })
    }
  }
})

test('two overlapping writers never report a copy that is gone and never crash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-plaintext-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  seed(dbPath)
  const args = ['--db', dbPath, '--backup-dir', backupDir, '--keep', '1']

  for (let round = 1; round <= 10; round += 1) {
    const first = runWriter(args, {})
    await waitForCopy(backupDir)
    const second = runWriter(args, {})
    const [a, b] = await Promise.all([first, second])
    assertHonestRun(`round ${round}: the first writer`, a)
    assertHonestRun(`round ${round}: the second writer`, b)
  }
})
