import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const tool = fileURLToPath(new URL('../scripts/artifact-retention.mjs', import.meta.url))
const DAY_MS = 86_400_000

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

function run(args: string[]): RunResult {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith('ARTIFACT_RETENTION_') || key === 'FLYBOT_INSTANCE_ROOT') continue
    env[key] = value
  }
  try {
    const stdout = execFileSync(process.execPath, [tool, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string; stderr?: string }
    return { code: failure.status ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

function snapshot(path: string, bytes: number, ageDays: number): void {
  mkdirSync(join(path, 'checkout'), { recursive: true })
  writeFileSync(join(path, 'checkout', 'work.txt'), 'x'.repeat(bytes))
  const when = new Date(Date.now() - ageDays * DAY_MS)
  utimesSync(path, when, when)
}

interface Seeded {
  root: string
  workspace: string
}

function seed(prefix: string): Seeded {
  const root = mkdtempSync(join(tmpdir(), `fledge-artifacts-${prefix}-`))
  const workspace = join(root, 'users', 'usr_1', 'repos', 'repo_1', 'data', 'bot', 'workspace')
  mkdirSync(workspace, { recursive: true })
  // 40 days old: the only snapshot outside both windows, so the only candidate.
  snapshot(join(workspace, 'r41'), 2048, 40)
  // 40 days old too, but named by a state file, so it must survive.
  snapshot(join(workspace, 'r50'), 1024, 40)
  snapshot(join(workspace, 'r51'), 1024, 40)
  // Inside the 3-newest window by run number, and r63/r64 also inside the age window.
  snapshot(join(workspace, 'r63'), 512, 5)
  snapshot(join(workspace, 'r64'), 512, 3)
  snapshot(join(workspace, 'r65'), 512, 0.05)
  writeFileSync(join(workspace, '..', 'state.json'), JSON.stringify({ active: 'r50', runs: [{ id: 'r50', state: 'done' }] }))
  writeFileSync(join(workspace, '..', 'inflight.json'), JSON.stringify({ workspace: 'r51' }))
  // Not a run snapshot: never a candidate, whatever its age.
  mkdirSync(join(workspace, 'scratch'), { recursive: true })
  writeFileSync(join(workspace, 'scratch', 'notes.txt'), 'not a run')
  return { root, workspace }
}

function cleanup(seeded: Seeded): void {
  rmSync(seeded.root, { recursive: true, force: true })
}

test('the dry run names the old snapshot, its bytes and the total, and removes nothing', () => {
  const seeded = seed('dry')
  try {
    const run1 = run(['--root', seeded.root, '--dry-run'])
    assert.equal(run1.code, 0, run1.stderr)
    assert.match(run1.stdout, /r41 .*bytes=2048 action=remove/)
    assert.match(run1.stdout, /candidates=1 bytes=2048 freed=0/)
    assert.match(run1.stdout, /artifact-retention: DRY-RUN/)
    for (const name of ['r41', 'r50', 'r51', 'r63', 'r64', 'r65', 'scratch']) {
      assert.ok(existsSync(join(seeded.workspace, name)), `${name} must survive a dry run`)
    }
  } finally {
    cleanup(seeded)
  }
})

test('apply removes only the candidate and leaves the referenced and recent snapshots alone', () => {
  const seeded = seed('apply')
  try {
    const applied = run(['--root', seeded.root, '--apply'])
    assert.equal(applied.code, 0, applied.stderr)
    assert.match(applied.stdout, /removed=.*r41/)
    assert.match(applied.stdout, /removed=1 failed=0 freed=2048/)
    assert.match(applied.stdout, /audit action=artifact-retention/)
    assert.match(applied.stdout, /artifact-retention: OK/)
    assert.equal(existsSync(join(seeded.workspace, 'r41')), false, 'the old snapshot is the one that goes')
    for (const name of ['r50', 'r51', 'r63', 'r64', 'r65', 'scratch']) {
      assert.ok(existsSync(join(seeded.workspace, name)), `${name} must survive an apply`)
    }
    const again = run(['--root', seeded.root, '--apply'])
    assert.equal(again.code, 0, again.stderr)
    assert.match(again.stdout, /removed=0 failed=0 freed=0/)
  } finally {
    cleanup(seeded)
  }
})

test('a workspace named by state.json or inflight.json is never removed', () => {
  const seeded = seed('state')
  try {
    const applied = run(['--root', seeded.root, '--apply', '--max-age-days', '0', '--keep', '0'])
    assert.equal(applied.code, 0, applied.stderr)
    assert.ok(existsSync(join(seeded.workspace, 'r50')), 'state.json names r50')
    assert.ok(existsSync(join(seeded.workspace, 'r51')), 'inflight.json names r51')
    assert.equal(existsSync(join(seeded.workspace, 'r41')), false)
  } finally {
    cleanup(seeded)
  }
})

test('both windows are configurable, and neither is a second copy of the other', () => {
  const seeded = seed('window')
  try {
    const narrowed = run(['--root', seeded.root, '--dry-run', '--keep', '1', '--max-age-days', '1'])
    assert.equal(narrowed.code, 0, narrowed.stderr)
    assert.match(narrowed.stdout, /candidates=3 /)
    assert.match(narrowed.stdout, /r41 .*action=remove/)
    assert.match(narrowed.stdout, /r63 .*action=remove/)
    assert.match(narrowed.stdout, /r64 .*action=remove/)
    assert.doesNotMatch(narrowed.stdout, /r65 .*action=remove/, 'the newest snapshot survives --keep 1')
    assert.doesNotMatch(narrowed.stdout, /r50 .*action=remove/)
  } finally {
    cleanup(seeded)
  }
})

test('an instance root that does not exist is refused instead of walked', () => {
  const missing = join(tmpdir(), `fledge-artifacts-missing-${String(Date.now())}`)
  const result = run(['--root', missing])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /instance root not found/)
})

test('a symlinked workspace is never followed or removed', () => {
  const seeded = seed('symlink')
  const outside = mkdtempSync(join(tmpdir(), 'fledge-artifacts-outside-'))
  try {
    writeFileSync(join(outside, 'precious.txt'), 'keep me')
    const link = join(seeded.workspace, 'r40')
    try {
      symlinkSync(outside, link, 'dir')
    } catch {
      return // a platform without symlink permission cannot carry this case
    }
    const applied = run(['--root', seeded.root, '--apply'])
    assert.equal(applied.code, 0, applied.stderr)
    assert.match(applied.stdout, /r40 action=skip reason=symlink/)
    assert.ok(existsSync(join(outside, 'precious.txt')), 'a link target outside the workspace is untouched')
    assert.ok(existsSync(link), 'the link itself is not a run snapshot this tool removes')
  } finally {
    rmSync(outside, { recursive: true, force: true })
    cleanup(seeded)
  }
})
