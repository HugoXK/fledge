import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../src/db.js'
import { makeUser } from './helpers.js'

// #1217: the takeover marker is serialised by path, not by ownership. The run
// that creates it writes its pid, but the release is a bare
// `rmSync(takeoverPath, { force: true })`, so a run that no longer holds the
// marker still removes whatever is there — including the marker a later run
// holds inside the same critical section. The lock it stands in for already
// releases by identity (pid read back at exit, `sameLock` inside the section);
// this file proves the marker does not.
//
// The window is sub-millisecond, so it is widened from the test side rather than
// with SIGSTOP: a `--require` fixture patches `node:fs` before the script's
// named imports bind, and a run that is about to remove the lock while a marker
// exists signals the test and holds there. That is the same stall a suspended
// host produces, but deterministic.

const backupScript = fileURLToPath(new URL('../scripts/backup.mjs', import.meta.url))

const LOCK = '.fledge-backup.lock'
const MARKER = '.fledge-backup.lock.takeover'
// Outside the kernel's pid range: a pid that cannot be alive, i.e. the lock a
// SIGKILLed run leaves. The file is aged past the takeover grace for the same
// reason — a lock created milliseconds ago is never a takeover candidate.
const DEAD_PID = '2147483647'
const LONG_AGO = (): number => Date.now() / 1000 - 60

// Runs before `scripts/backup.mjs` imports `node:fs`, so the binding the script
// calls is this function. It holds the first time a process is about to remove
// the lock while a takeover marker exists — the critical section the marker
// guards — and never again, so the process can still release its own lock at
// exit without a second hold.
const FIXTURE = `
const fs = require('node:fs')
const { basename, dirname, join } = require('node:path')
const realRmSync = fs.rmSync
const stallMs = Number(process.env.FLEDGE_TEST_STALL_MS || 0)
let held = false
fs.rmSync = function rmSync(target, options) {
  if (!held && stallMs > 0 && typeof target === 'string' && basename(target) === '${LOCK}') {
    if (fs.existsSync(join(dirname(target), '${MARKER}'))) {
      held = true
      const signalDir = process.env.FLEDGE_TEST_SIGNAL_DIR
      if (signalDir) fs.writeFileSync(join(signalDir, 'stalled-' + process.pid), '')
      const until = Date.now() + stallMs
      while (Date.now() < until) {
        // Hold the critical section, exactly as a stopped host would.
      }
    }
  }
  return realRmSync(target, options)
}
`

function seed(dbPath: string): void {
  const store = new Store(dbPath)
  try {
    const user = makeUser(store, { login: 'marker-user', status: 'approved' })
    store.createRepo({
      id: 'repo_marker',
      userId: user.id,
      owner: 'o',
      name: 'marker',
      defaultBranch: 'main',
      tokenEnc: 'x',
      permission: 'admin',
      repoRole: 'maintainer',
      goal: '',
      autoIterate: false,
      intervalMinutes: 1440,
    })
  } finally {
    store.close()
  }
}

function copies(dir: string): string[] {
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.startsWith('fledge-') && name.endsWith('.db'))
        .sort()
    : []
}

function childEnv(env: Record<string, string>): Record<string, string> {
  const inherited: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (name === 'NODE_OPTIONS' || name.startsWith('FLEDGE_TEST_')) continue
    inherited[name] = value
  }
  return { ...inherited, ...env }
}

interface Run {
  pid: number
  child: ChildProcess
  done: Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>
}

function startBackup(dbPath: string, backupDir: string, env: Record<string, string> = {}): Run {
  const child = spawn(process.execPath, [backupScript, '--db', dbPath, '--backup-dir', backupDir, '--keep', '10'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv(env),
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  const done = new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
  return { pid: child.pid ?? -1, child, done }
}

// The fixture writes `stalled-<pid>` when it holds. A run that exits first is a
// failure of the harness, not of the code, and its stderr says why.
async function waitForSignal(dir: string, run: Run, label: string): Promise<void> {
  const path = join(dir, `stalled-${run.pid}`)
  const exited = run.done.then((result) => ({ result }))
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (existsSync(path)) return
    const early = await Promise.race([exited, new Promise<null>((resolve) => setTimeout(() => resolve(null), 5))])
    if (early !== null) {
      throw new Error(`${label} exited before reaching the section (exit ${String(early.result.code)}): ${early.result.stderr}`)
    }
  }
  throw new Error(`${label} never signalled while holding the marker`)
}

function plantDeadLock(backupDir: string, content: string = DEAD_PID): void {
  const path = join(backupDir, LOCK)
  writeFileSync(path, content, { mode: 0o600 })
  utimesSync(path, LONG_AGO(), LONG_AGO())
}

function assertRefusal(result: { code: number | null; stdout: string; stderr: string }, label: string): void {
  assert.equal(result.code, 1, `${label} must refuse, got exit ${String(result.code)}: ${result.stdout}`)
  assert.match(result.stderr, /^backup: another backup run holds /m, `${label} names the refusal: ${result.stderr}`)
  assert.doesNotMatch(result.stderr, /\n\s+at /, `${label} died with an uncaught stack: ${result.stderr}`)
}

test('a straggler that resumes must not remove the marker a live run holds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-marker-'))
  const dbPath = join(root, 'fledge.db')
  const backupDir = join(root, 'backups')
  const signals = join(root, 'signals')
  seed(dbPath)
  mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  mkdirSync(signals)
  writeFileSync(join(root, 'hook.cjs'), FIXTURE)
  plantDeadLock(backupDir)

  // A judges the dead lock stale, creates its marker and stalls inside the
  // section — the stopped host of the issue's sequence.
  const a = startBackup(dbPath, backupDir, {
    NODE_OPTIONS: `--require ${join(root, 'hook.cjs')}`,
    FLEDGE_TEST_STALL_MS: '2000',
    FLEDGE_TEST_SIGNAL_DIR: signals,
  })
  await waitForSignal(signals, a, 'run A')
  assert.ok(existsSync(join(backupDir, MARKER)), 'A holds a marker while it is stalled')

  // A stall longer than the grace is what makes A's marker abandoned; the test
  // does not wait 10 s to get there, it ages the file instead.
  utimesSync(join(backupDir, MARKER), LONG_AGO(), LONG_AGO())

  // B sweeps A's abandoned marker, takes its own and stalls in the same section,
  // holding that marker while the dead lock is still in place.
  const b = startBackup(dbPath, backupDir, {
    NODE_OPTIONS: `--require ${join(root, 'hook.cjs')}`,
    FLEDGE_TEST_STALL_MS: '15000',
    FLEDGE_TEST_SIGNAL_DIR: signals,
  })
  await waitForSignal(signals, b, 'run B')

  // A resumes and reaches its release while B is inside the section. Today it
  // removes B's marker; the release must be a no-op when the file is not A's.
  const aResult = await a.done
  assert.equal(aResult.code, 0, `A's run is honest: ${aResult.stderr}`)
  assert.equal(
    existsSync(join(backupDir, MARKER)),
    true,
    "A's release removed a marker it did not hold, so the section is now open",
  )
  // A crashed run's lock, so the third run has a stale lock to judge — the
  // ordinary reason a run reaches the marker at all.
  plantDeadLock(backupDir)
  const before = copies(backupDir)

  const c = startBackup(dbPath, backupDir)
  const cResult = await c.done

  assertRefusal(cResult, 'run C')
  assert.match(
    cResult.stderr,
    new RegExp(`\\(pid ${String(b.pid)}\\)`),
    `the refusal must name B, the live holder: ${cResult.stderr}`,
  )
  assert.deepEqual(copies(backupDir), before, 'C must not write a copy beside a live holder in the section')

  b.child.kill('SIGKILL')
  await b.done
})

test('the run that takes a dead lock over still removes its own marker', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-marker-'))
  const dbPath = join(root, 'fledge.db')
  const backupDir = join(root, 'backups')
  seed(dbPath)
  mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  plantDeadLock(backupDir)

  const run = spawnSync(process.execPath, [backupScript, '--db', dbPath, '--backup-dir', backupDir], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv({}),
  })

  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /^backup: OK$/m)
  assert.equal(existsSync(join(backupDir, MARKER)), false, 'a completed takeover leaves no marker')
  assert.equal(existsSync(join(backupDir, LOCK)), false, 'a completed run leaves no lock')
})
