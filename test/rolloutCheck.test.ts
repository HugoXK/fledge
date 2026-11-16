import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// #658: a rollout must be refused when the process, the page and the served
// asset are not the release that was built. Every case here is a recorded
// incident shape: the skipped restart leaves `/healthz` on the old version, the
// hand-copied `public/` serves bytes that match no tag (59,354 in the report),
// and the footer is rendered from the old process.
//
// The check runs as a command against fixtures, not as an imported module: the
// test has to survive on the tip before the script exists so the red half is
// "a stale rollout is not refused" rather than a module-load crash.

const script = fileURLToPath(new URL('../scripts/rollout-check.mjs', import.meta.url))
const VERSION = '0.3.5'
const COMMIT = '2f55afd54cf4b68066dadf54efaf814bd7af0d29'
const OLD_COMMIT = 'a'.repeat(40)
const RELEASE_CSS = 'body{color:#111}\n'.repeat(40)
const STALE_CSS = 'body{color:#111}\n'.repeat(40) + '/* a pre-release palette */\n'

interface Fixture {
  dir: string
  release: string
  served: string
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function page(input: { version?: string; token?: string }): string {
  const version = input.version ?? VERSION
  const token = input.token ?? sha256(RELEASE_CSS).slice(0, 12)
  return `<!doctype html><html lang="en" data-density="comfortable"><head>
<link rel="stylesheet" href="/assets/app.css?v=${token}" /></head>
<body><footer class="foot"><div>Fledge · hosted repositories that grow themselves · powered by FlyBot
 · <span class="foot-release">v${version}</span></div></footer></body></html>`
}

function fixture(input: {
  healthzVersion?: string
  healthzCommit?: string
  footerVersion?: string
  pageToken?: string
  servedCss?: string
  releaseCss?: string
} = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'rollout-'))
  const release = join(dir, 'release')
  const served = join(dir, 'served')
  mkdirSync(join(release, 'public'), { recursive: true })
  mkdirSync(join(served, 'assets'), { recursive: true })
  const releaseCss = input.releaseCss ?? RELEASE_CSS
  writeFileSync(join(release, 'public', 'app.css'), releaseCss)
  writeFileSync(join(release, 'public', 'app.js'), 'console.log("release")\n')
  writeFileSync(
    join(served, 'healthz.json'),
    `${JSON.stringify({ ok: true, service: 'fledge', version: input.healthzVersion ?? VERSION, commit: input.healthzCommit ?? COMMIT })}\n`,
  )
  writeFileSync(
    join(served, 'index.html'),
    page({ version: input.footerVersion, token: input.pageToken ?? createHash('sha256').update(releaseCss).digest('hex').slice(0, 12) }),
  )
  writeFileSync(join(served, 'assets', 'app.css'), input.servedCss ?? releaseCss)
  return { dir, release, served }
}

function run(args: string[]): { code: number; out: string; err: string } {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
  return { code: result.status ?? -1, out: String(result.stdout ?? ''), err: String(result.stderr ?? '') }
}

function check(f: Fixture, extra: string[] = []): { code: number; out: string; err: string } {
  return run(['--fixtures', f.served, '--release-dir', f.release, '--version', VERSION, '--commit', COMMIT, ...extra])
}

test('a rollout that serves its release passes every link', () => {
  const result = check(fixture())
  assert.equal(result.code, 0, `expected exit 0, got ${result.code}: ${result.out}${result.err}`)
  assert.match(result.out, new RegExp(`rollout-check: ok v${VERSION} commit ${COMMIT} app\\.css [0-9a-f]{12}`))
  for (const link of ['healthz version', 'healthz commit', 'footer version', 'served asset', 'page asset']) {
    assert.match(result.out, new RegExp(`${link}\\s+ok`), `the ok output does not carry the ${link} link`)
  }
})

test('a skipped restart leaves the process on the old version and is refused', () => {
  const result = check(fixture({ healthzVersion: '0.3.2' }))
  assert.equal(result.code, 1, `a stale /healthz must exit 1, got ${result.code}: ${result.out}`)
  assert.match(result.out, /rollout-check: refused/)
  assert.match(result.out, /healthz version\s+mismatch/)
  assert.match(result.out, /0\.3\.2/)
  assert.match(result.out, new RegExp(VERSION))
})

test('a process running a different commit is refused even when the version matches', () => {
  const result = check(fixture({ healthzCommit: OLD_COMMIT }))
  assert.equal(result.code, 1, `a stale commit must exit 1, got ${result.code}: ${result.out}`)
  assert.match(result.out, /healthz commit\s+mismatch/)
  assert.match(result.out, new RegExp(OLD_COMMIT))
})

test('served bytes that match no release are refused and the hash is named', () => {
  const result = check(fixture({ servedCss: STALE_CSS, pageToken: sha256(STALE_CSS).slice(0, 12) }))
  assert.equal(result.code, 1, `a replaced public tree must exit 1, got ${result.code}: ${result.out}`)
  assert.match(result.out, /served asset\s+mismatch/)
  assert.match(result.out, new RegExp(sha256(STALE_CSS).slice(0, 12)))
  assert.match(result.out, new RegExp(sha256(RELEASE_CSS).slice(0, 12)))
})

test('a page rendered by the old process is refused on its footer version', () => {
  const result = check(fixture({ footerVersion: '0.3.2' }))
  assert.equal(result.code, 1, `a stale footer must exit 1, got ${result.code}: ${result.out}`)
  assert.match(result.out, /footer version\s+mismatch/)
})

test('a page that versions an asset it does not serve is refused', () => {
  const result = check(fixture({ pageToken: 'deadbeefcafe' }))
  assert.equal(result.code, 1, `a page/asset pair must exit 1, got ${result.code}: ${result.out}`)
  assert.match(result.out, /page asset\s+mismatch/)
})

test('a deployed public tree that differs from the release is refused', () => {
  const f = fixture()
  // The running tree carries a file the tag does not: the hand-copied case.
  writeFileSync(join(f.served, 'dist.txt'), 'x')
  const running = join(f.dir, 'running')
  mkdirSync(join(running, 'public'), { recursive: true })
  writeFileSync(join(running, 'public', 'app.css'), RELEASE_CSS)
  writeFileSync(join(running, 'public', 'app.js'), 'console.log("release")\n')
  // --public-dir names the public tree itself (…/public), the same root the
  // release is hashed from.
  const aligned = check(f, ['--public-dir', join(running, 'public')])
  assert.equal(aligned.code, 0, `an aligned public tree must pass: ${aligned.out}`)
  writeFileSync(join(running, 'public', 'app-old.css'), 'body{}\n')
  const result = check(f, ['--public-dir', join(running, 'public')])
  assert.equal(result.code, 1, `a public tree with an extra file must exit 1, got ${result.code}: ${result.out}`)
  assert.match(result.out, /public tree\s+mismatch/)
})

test('a missing release artifact is unreadable input, never a green verdict', () => {
  const f = fixture()
  const result = run(['--fixtures', f.served, '--release-dir', join(f.dir, 'absent'), '--version', VERSION, '--commit', COMMIT])
  assert.equal(result.code, 2, `a missing release tree must exit 2, got ${result.code}: ${result.out}`)
  assert.match(result.err, /rollout-check:/)
})

test('a version or commit that is not in the release shape is a usage error', () => {
  const f = fixture()
  const badVersion = run(['--fixtures', f.served, '--release-dir', f.release, '--version', 'latest', '--commit', COMMIT])
  assert.equal(badVersion.code, 2, `"latest" must exit 2, got ${badVersion.code}: ${badVersion.out}`)
  const badCommit = run(['--fixtures', f.served, '--release-dir', f.release, '--version', VERSION, '--commit', 'HEAD'])
  assert.equal(badCommit.code, 2, `"HEAD" must exit 2, got ${badCommit.code}: ${badCommit.out}`)
})
