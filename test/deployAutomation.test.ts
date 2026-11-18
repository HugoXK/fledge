import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const deploy = readFileSync(new URL('deploy/fledge-deploy-tag.sh', root), 'utf8')
const verify = readFileSync(new URL('deploy/fledge-verify-release.sh', root), 'utf8')
const doc = readFileSync(new URL('docs/deploy.md', root), 'utf8')

for (const name of ['deploy/fledge-deploy-tag.sh', 'deploy/fledge-verify-release.sh']) {
  test(`${name} is valid POSIX shell`, () => {
    assert.doesNotThrow(() => execFileSync('sh', ['-n', fileURLToPath(new URL(name, root))], { stdio: 'pipe' }))
  })
}

test('the tag deployer only moves forward and never pushes or bypasses a gate', () => {
  assert.match(deploy, /sort -V/)
  assert.match(deploy, /at or ahead of/)
  assert.match(deploy, /flock -n/)
  assert.match(deploy, /healthz/)
  assert.match(deploy, /dist\.bak-/)
  assert.match(deploy, /fledge-verify-release\.sh/)
  assert.doesNotMatch(deploy, /git push/)
  assert.doesNotMatch(deploy, /--admin/)
  assert.doesNotMatch(deploy, /gh pr merge/)
})

test('the verifier writes a temporary status and never prints a token', () => {
  assert.match(verify, /--write "\$TMP"/)
  assert.match(verify, /mv "\$TMP" "\$STATUS"/)
  assert.match(verify, /FLEDGE_SECRETS_FILE/)
  assert.match(verify, /GITHUB_TOKEN/)
  assert.doesNotMatch(verify, /echo[^\n]*GITHUB_TOKEN/)
  assert.doesNotMatch(verify, /echo[^\n]*\$TOKEN/)
})

test('the deploy runbook names both tracked scripts and their cron cadence', () => {
  assert.match(doc, /fledge-deploy-tag\.sh/)
  assert.match(doc, /fledge-verify-release\.sh/)
  assert.match(doc, /\*\/10 \* \* \* \*/)
  assert.match(doc, /\*\/30 \* \* \* \*/)
})

// #658: a version string in /healthz is not proof of a rollout. Production
// answered 0.3.2 while the page and the asset directory were another tree, so
// the deploy has to be gated on the release artifact it built.
test('the deploy gates the rollout on the release it built, not on a version string', () => {
  assert.match(deploy, /scripts\/rollout-check\.mjs/)
  assert.match(deploy, /--release-dir "\$DEPLOY"/)
  assert.match(deploy, /--public-dir "\$APP\/public"/)
  assert.match(deploy, /rollout refused for \$TAG/)
  assert.match(deploy, /FLEDGE_ROLLOUT_URL/)
  // The old gate: read /healthz and shell out to grep for the version.
  assert.doesNotMatch(deploy, /grep -q "\\"version\\"/)
})

test('a red release-status snapshot is logged by name, not swallowed', () => {
  assert.match(deploy, /release-status: not released for \$TAG/)
  assert.doesNotMatch(deploy, /\[ -x "\$VERIFY" \] && "\$VERIFY"[^\n]*\|\| true/)
})

test('the runbook names the gate, its expected line and the skipped-restart drill', () => {
  assert.match(doc, /scripts\/rollout-check\.mjs/)
  assert.match(doc, /rollout-check: ok v0\.3\.5 commit/)
  assert.match(doc, /rollout-check: refused/)
  assert.match(doc, /--expect-css-sha256/)
  assert.match(doc, /59,354 bytes/)
})

// #658: the source copy replaces `public/` and `package.json` before the build,
// so a refusal that restores only `dist` leaves the old process serving the new
// assets and reporting the new version. The version check at the top then reads
// the target version, logs "at or ahead" and exits 0: the tag is never deployed
// and never gated again. These two tests run the real script on a stubbed host.
const deployScript = fileURLToPath(new URL('deploy/fledge-deploy-tag.sh', root))
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fledge-test',
  GIT_AUTHOR_EMAIL: 'test@fledge.invalid',
  GIT_COMMITTER_NAME: 'fledge-test',
  GIT_COMMITTER_EMAIL: 'test@fledge.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
}
const OLD_COMMIT = 'a'.repeat(40)
const OLD_CSS = 'body{color:#111}\n'
const NEW_CSS = 'body{color:#222}\n'
// The two fixtures are the same byte count across the version bump, which is
// what makes the copy gap below reachable: rsync's quick check cannot tell the
// old file from the new one by size.
const OLD_PACKAGE = '{"name":"fledge","version":"0.0.1"}\n'
const NEW_PACKAGE = '{"name":"fledge","version":"9.9.9"}\n'
// One whole second, chosen rather than observed: both sides of the copy are
// stamped to it, so the case never races the clock.
const STAMP_SECONDS = Math.floor(Date.parse('2026-01-01T00:00:00Z') / 1000)

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
}

function put(path: string, body: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body, { mode })
}

interface Host {
  app: string
  data: string
  log: string
  env: NodeJS.ProcessEnv
}

// A host in the two states that matter: a release tag on the origin, and an app
// directory running an older one. `npm` is a stub (the host build is not what
// this test is about) and the rollout gate is the fixture's, because the point
// is what the deploy does when the gate refuses, not how the gate decides.
// `stampSeconds` puts both sides of the source copy on one whole second, which
// is the state #944 is about; see the case that uses it.
function host(build: 'ok' | 'fail' = 'ok', options: { stampSeconds?: number } = {}): Host {
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  const dir = mkdtempSync(join(tmpdir(), 'fledge-deploy-'))
  const origin = join(dir, 'origin.git')
  git(dir, ['init', '--bare', '--initial-branch=main', origin])
  const seed = join(dir, 'seed')
  git(dir, ['init', '--initial-branch=main', seed])
  put(join(seed, 'package.json'), NEW_PACKAGE)
  put(join(seed, 'public', 'app.css'), NEW_CSS)
  put(join(seed, 'public', 'only-new.css'), '.new{}\n')
  put(join(seed, 'scripts', 'rollout-check.mjs'), "process.exit(process.env.FAKE_ROLLOUT_PASS === '1' ? 0 : 1)\n")
  git(seed, ['add', '-A'])
  git(seed, ['commit', '-qm', 'release'])
  git(seed, ['tag', 'v9.9.9'])
  git(seed, ['remote', 'add', 'origin', origin])
  git(seed, ['push', '-q', 'origin', 'main', 'v9.9.9'])

  const src = join(dir, 'src')
  git(dir, ['clone', '-q', origin, src])

  const app = join(dir, 'app')
  put(join(app, 'package.json'), OLD_PACKAGE)
  put(join(app, 'dist', 'marker.txt'), 'old dist\n')
  put(join(app, '.build-identity'), `GIT_SHA=${OLD_COMMIT}\nBUILD_TIME=2026-01-01T00:00:00Z\n`)
  put(join(app, 'public', 'app.css'), OLD_CSS)
  put(join(app, 'public', 'keep.css'), '.keep{}\n')
  put(join(app, 'stop.sh'), '#!/bin/sh\nexit 0\n', 0o755)
  put(join(app, 'start.sh'), '#!/bin/sh\nexit 0\n', 0o755)
  const bin = join(dir, 'bin')
  put(join(bin, 'npm'), build === 'ok' ? '#!/bin/sh\nexit 0\n' : '#!/bin/sh\nprintf "stub: build failed\\n" >&2\nexit 1\n', 0o755)
  // The retry loop sleeps between attempts; wall time buys nothing here.
  put(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', 0o755)
  if (options.stampSeconds !== undefined) {
    const seconds = options.stampSeconds
    utimesSync(join(app, 'package.json'), seconds, seconds)
    utimesSync(join(app, 'public', 'app.css'), seconds, seconds)
    // The other half of the collision is the release checkout: `git worktree
    // add` writes every file at the current second. Stamping the checkout from
    // the fixture — never from the deploy script, and never by sleeping — is
    // what makes the case fixed rather than racy.
    const stamp = join(bin, 'stamp-mtimes.cjs')
    writeFileSync(stamp, [
      "const { readdirSync, utimesSync } = require('node:fs')",
      "const { join } = require('node:path')",
      'const seconds = Number(process.argv[2])',
      'const walk = (dir) => {',
      '  for (const entry of readdirSync(dir, { withFileTypes: true })) {',
      '    const path = join(dir, entry.name)',
      '    if (entry.isDirectory()) walk(path)',
      '    else if (entry.isFile()) utimesSync(path, seconds, seconds)',
      '  }',
      '}',
      'walk(process.argv[3])',
      '',
    ].join('\n'), { mode: 0o644 })
    writeFileSync(join(bin, 'git'), [
      '#!/bin/sh',
      `"${realGit}" "$@"`,
      'code=$?',
      'if [ "$code" -eq 0 ]; then',
      '  for arg in "$@"; do',
      `    if [ -d "$arg" ]; then "${process.execPath}" "${stamp}" "${seconds}" "$arg"; fi`,
      '  done',
      'fi',
      'exit "$code"',
      '',
    ].join('\n'), { mode: 0o755 })
  }
  const data = join(dir, 'data')
  mkdirSync(data, { recursive: true })
  return {
    app,
    data,
    log: join(dir, 'deploy.log'),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      TMPDIR: dir,
      FLEDGE_APP_DIR: app,
      FLEDGE_SOURCE_DIR: src,
      FLEDGE_DEPLOY_DIR: join(dir, 'release'),
      FLEDGE_DEPLOY_LOG: join(dir, 'deploy.log'),
      FLEDGE_STOP_CMD: join(app, 'stop.sh'),
      FLEDGE_START_CMD: join(app, 'start.sh'),
      FLEDGE_ROLLOUT_URL: 'http://127.0.0.1:9',
      // #943: the deploy lock is the one path the script does not derive from
      // FLEDGE_APP_DIR, so a case that shares the production path is decided by
      // whatever else on the machine holds it. Each fixture owns its own lock.
      FLEDGE_DEPLOY_LOCK: join(dir, 'deploy.lock'),
      FLEDGE_DATA_DIR: data,
      FLEDGE_VERIFY_SCRIPT: join(dir, 'no-verifier.sh'),
    },
  }
}

function tick(h: Host, extra: NodeJS.ProcessEnv = {}): { code: number; log: string } {
  const before = existsSync(h.log) ? readFileSync(h.log, 'utf8').length : 0
  const result = spawnSync('sh', [deployScript], {
    encoding: 'utf8',
    env: { ...h.env, ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const log = existsSync(h.log) ? readFileSync(h.log, 'utf8') : ''
  return { code: result.status ?? -1, log: log.slice(before) }
}

function runningVersion(app: string): string {
  return (JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as { version: string }).version
}

// The four pieces the host was running, each of which the source copy replaces.
function releaseIsBack(h: Host): void {
  assert.equal(runningVersion(h.app), '0.0.1', 'package.json still claims the new release: the next tick reads the target version')
  assert.equal(readFileSync(join(h.app, 'public', 'app.css'), 'utf8'), OLD_CSS)
  assert.equal(existsSync(join(h.app, 'public', 'only-new.css')), false, 'the new release left an asset behind in public/')
  assert.match(readFileSync(join(h.app, '.build-identity'), 'utf8'), new RegExp(OLD_COMMIT))
  assert.equal(readFileSync(join(h.app, 'dist', 'marker.txt'), 'utf8'), 'old dist\n')
}

test('a refused rollout restores the release it replaced, and the next tick retries', () => {
  const h = host()
  const refused = tick(h)
  assert.equal(refused.code, 3, `a refused rollout must exit 3, got ${refused.code}: ${refused.log}`)
  assert.match(refused.log, /rollout refused for v9\.9\.9/)
  releaseIsBack(h)

  const retried = tick(h, { FAKE_ROLLOUT_PASS: '1' })
  assert.equal(retried.code, 0, `the next tick must deploy the same tag, got ${retried.code}: ${retried.log}`)
  assert.match(retried.log, /deploying v9\.9\.9/)
  assert.doesNotMatch(retried.log, /at or ahead of/)
  assert.equal(runningVersion(h.app), '9.9.9')
  assert.equal(readFileSync(join(h.app, 'public', 'app.css'), 'utf8'), NEW_CSS)
  assert.match(readFileSync(join(h.data, 'deployed-tag'), 'utf8'), /^v9\.9\.9 /)
})

test('a failed build restores the release the source copy already replaced', () => {
  const h = host('fail')
  const failed = tick(h)
  assert.equal(failed.code, 3, `a failed build must exit 3, got ${failed.code}: ${failed.log}`)
  assert.match(failed.log, /build failed/)
  releaseIsBack(h)
})

// #943: the deploy lock is the one path the script does not derive from
// FLEDGE_APP_DIR, so a tick that could not take it exited 0 without doing
// anything, and the cases above read that as "the rollout was refused" or as a
// restore that never ran. A host now owns its lock; production keeps the fixed
// path, where that guard is the point.
test('a host owns its deploy lock, so another tick cannot silence the case', () => {
  assert.match(deploy, /LOCK=\$\{FLEDGE_DEPLOY_LOCK:-\/tmp\/fledge-deploy-tag\.lock\}/)
  const first = host()
  const second = host()
  assert.equal(first.env.FLEDGE_DEPLOY_LOCK, join(dirname(first.app), 'deploy.lock'))
  assert.ok(first.env.FLEDGE_DEPLOY_LOCK !== second.env.FLEDGE_DEPLOY_LOCK, 'two hosts must not share one lock')

  // Hold the first host's lock the way a second cron tick on that host would,
  // and only then run anything: no sleeping to reach the state. The path stays
  // an argument to `flock` and never enters a shell string, so nothing
  // interprets it, and "the lock is held" is read from a non-blocking attempt
  // of our own rather than from a marker the holder writes.
  const lock = String(first.env.FLEDGE_DEPLOY_LOCK)
  const holder = spawn('flock', ['-n', lock, 'sleep', '30'], { stdio: 'ignore' })
  try {
    const deadline = Date.now() + 5_000
    for (;;) {
      const probe = spawnSync('flock', ['-n', lock, 'true'], { stdio: 'ignore' })
      if (probe.status === 1) break // refused: the holder owns the lock
      if (probe.status !== 0) throw new Error(`the lock probe exited ${String(probe.status)}`)
      if (holder.exitCode !== null) throw new Error(`the lock holder exited ${String(holder.exitCode)} without taking the lock`)
      if (Date.now() > deadline) throw new Error('the lock holder never took the lock')
      execFileSync('sleep', ['0.05'])
    }

    // The host whose lock is held is silenced, and that is the failure the
    // flake produced: exit 0, nothing logged, nothing done.
    const silenced = tick(first)
    assert.equal(silenced.code, 0, 'a tick that cannot take its lock exits 0 without running')
    assert.equal(silenced.log, '', 'a tick that cannot take its lock logs nothing')

    // The other host runs to its own refusal, because the lock it could not
    // take is not the one it uses.
    const unaffected = tick(second)
    assert.equal(
      unaffected.code,
      3,
      `another host's lock must not silence this one, got ${unaffected.code}: ${unaffected.log}`,
    )
    assert.match(unaffected.log, /rollout refused for v9\.9\.9/)
  } finally {
    holder.kill()
  }
})

test('the rollback restores public/ and package.json, and its report path is not predictable', () => {
  assert.match(deploy, /public\.bak-/)
  assert.match(deploy, /package\.json\.bak-/)
  assert.match(deploy, /restore_release/)
  assert.match(deploy, /--exclude "public\.bak\*"/)
  assert.doesNotMatch(deploy, /\/tmp\/fledge-rollout-\$\$/)
})

// #944: the copy must not trust size and mtime. The fixtures below are the
// state the deploy meets by accident in production: a release that changes a
// file's content without changing its byte count, copied in the same whole
// second the old file was written. `rsync -a`'s default quick check skips that
// file and replaces the rest, so the host ends up half new and half old while
// the copy reports success. Both sides are stamped to one second here, so the
// case is the collision itself rather than a race that reaches it.
test('the source copy replaces a changed file whose size and mtime match', () => {
  const h = host('ok', { stampSeconds: STAMP_SECONDS })
  const before = tick(h, { FAKE_ROLLOUT_PASS: '1' })
  assert.equal(before.code, 0, `the tick must deploy, got ${before.code}: ${before.log}`)
  assert.match(before.log, /deploying v9\.9\.9/)
  assert.match(before.log, /healthy v9\.9\.9/)

  // The copy did run: the file only the release carries landed, and the file
  // only the old host carried is gone. So a surviving old file is not a copy
  // that never happened, it is a file the check skipped.
  assert.equal(existsSync(join(h.app, 'public', 'only-new.css')), true, 'the release asset the host did not have must land')
  assert.equal(existsSync(join(h.app, 'public', 'keep.css')), false, 'the asset the release does not have must be deleted')

  assert.equal(readFileSync(join(h.app, 'public', 'app.css'), 'utf8'), NEW_CSS, 'the same-size asset carries the release content')
  assert.equal(runningVersion(h.app), '9.9.9', 'the same-size package.json carries the release version')
  assert.equal(readFileSync(join(h.app, 'package.json'), 'utf8'), NEW_PACKAGE)
})

test('the deploy docs say why the copy ignores size and mtime', () => {
  assert.match(deploy, /rsync -a --ignore-times --delete/)
  assert.match(doc, /--ignore-times/)
})
