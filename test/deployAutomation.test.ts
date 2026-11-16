import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
function host(build: 'ok' | 'fail' = 'ok'): Host {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-deploy-'))
  const origin = join(dir, 'origin.git')
  git(dir, ['init', '--bare', '--initial-branch=main', origin])
  const seed = join(dir, 'seed')
  git(dir, ['init', '--initial-branch=main', seed])
  put(join(seed, 'package.json'), '{"name":"fledge","version":"9.9.9"}\n')
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
  put(join(app, 'package.json'), '{"name":"fledge","version":"0.0.1"}\n')
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

test('the rollback restores public/ and package.json, and its report path is not predictable', () => {
  assert.match(deploy, /public\.bak-/)
  assert.match(deploy, /package\.json\.bak-/)
  assert.match(deploy, /restore_release/)
  assert.match(deploy, /--exclude "public\.bak\*"/)
  assert.doesNotMatch(deploy, /\/tmp\/fledge-rollout-\$\$/)
})
