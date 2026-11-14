import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Issue #280: one end-to-end release status, and one command that answers "is
// this version actually released and deployed?".
//
// The chain is plan -> branch -> pull request -> tag -> image -> SBOM ->
// attestation -> Release -> the running instance. Each link is a fact read back
// from the API; the status names every one and the CLI exits non-zero when any
// link is missing or disagrees. Nothing here deploys, tags or merges.

const SHA = (char: string) => char.repeat(40)
const DIGEST = `sha256:${'e'.repeat(64)}`

function chain(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '0.3.2',
    packageVersion: '0.3.2',
    checkedAt: '2026-11-11T12:00:00Z',
    plan: { version: '0.3.2', mainSha: SHA('a'), plannedAt: '2026-11-11T11:00:00Z' },
    branch: { name: 'release/v0.3.2', tip: SHA('b'), deleted: false },
    pull: {
      number: 301,
      state: 'merged',
      headSha: SHA('b'),
      mergeCommitSha: SHA('c'),
      mergedAt: '2026-11-11T11:20:00Z',
      base: 'main',
    },
    tag: { name: 'v0.3.2', objectSha: SHA('d'), objectType: 'tag', targetSha: SHA('c') },
    image: { tag: 'ghcr.io/hugoxk/fledge:v0.3.2', digest: DIGEST },
    sbom: { present: true, name: 'fledge-sbom-v0.3.2' },
    attestation: { present: true, subjectDigest: DIGEST },
    release: {
      url: 'https://github.com/HugoXK/fledge/releases/tag/v0.3.2',
      tagName: 'v0.3.2',
      publishedAt: '2026-11-11T11:30:00Z',
      draft: false,
    },
    baseUrl: 'https://fledge.example',
    healthz: { version: '0.3.2', commit: SHA('c').slice(0, 12) },
    ...overrides,
  }
}

async function evaluate(input: Record<string, unknown>) {
  const module = await import('../scripts/lib/release-status.mjs')
  return module.evaluateReleaseStatus(input)
}

function linkOf(status: { links: Array<{ id: string; state: string; detail: string }> }, id: string) {
  return status.links.find((link) => link.id === id)
}

test('a complete chain is green and names the tag target, the digest and the Release URL', async () => {
  const status = await evaluate(chain())
  assert.equal(status.ok, true)
  assert.deepEqual(status.problems, [])
  const ids = status.links.map((link: { id: string }) => link.id)
  for (const id of ['version', 'plan', 'branch', 'pull', 'tag', 'image', 'sbom', 'attestation', 'release', 'healthz']) {
    assert.ok(ids.includes(id), `the status must name the ${id} link`)
  }
  assert.equal(linkOf(status, 'tag')?.state, 'ok')
  assert.match(String(linkOf(status, 'tag')?.detail), new RegExp(SHA('c')))
  assert.match(String(linkOf(status, 'image')?.detail), /sha256:e{64}/)
  assert.match(String(linkOf(status, 'release')?.detail), /releases\/tag\/v0\.3\.2/)
})

test('a missing tag is red, even when everything before it is complete', async () => {
  const status = await evaluate(chain({ tag: null }))
  assert.equal(status.ok, false)
  assert.equal(linkOf(status, 'tag')?.state, 'missing')
  assert.ok(status.problems.some((problem: string) => problem.includes('tag')))
})

test('a failed SBOM step is red, and the problem names it', async () => {
  const status = await evaluate(chain({ sbom: { present: false, name: '' } }))
  assert.equal(status.ok, false)
  assert.equal(linkOf(status, 'sbom')?.state, 'missing')
  assert.ok(status.problems.some((problem: string) => problem.includes('SBOM')))
})

test('a running /healthz that disagrees with package.json is red', async () => {
  const status = await evaluate(chain({ healthz: { version: '0.3.1', commit: SHA('c').slice(0, 12) } }))
  assert.equal(status.ok, false)
  assert.equal(linkOf(status, 'healthz')?.state, 'mismatch')
  assert.match(String(linkOf(status, 'healthz')?.detail), /0\.3\.1/)
})

test('a running commit that is not the tagged commit is red', async () => {
  const status = await evaluate(chain({ healthz: { version: '0.3.2', commit: 'ffffffffffff' } }))
  assert.equal(status.ok, false)
  assert.equal(linkOf(status, 'healthz')?.state, 'mismatch')
})

test('a tag that points at a different commit than the merged release pull request is red', async () => {
  const status = await evaluate(chain({ tag: { name: 'v0.3.2', objectSha: SHA('d'), objectType: 'tag', targetSha: SHA('f') } }))
  assert.equal(status.ok, false)
  assert.equal(linkOf(status, 'tag')?.state, 'mismatch')
})

test('an unannotated tag is red: the release tag is an annotated object', async () => {
  const status = await evaluate(chain({ tag: { name: 'v0.3.2', objectSha: SHA('c'), objectType: 'commit', targetSha: SHA('c') } }))
  assert.equal(status.ok, false)
  assert.equal(linkOf(status, 'tag')?.state, 'mismatch')
})

test('without a deployed base URL the healthz link is skipped and does not make the chain red', async () => {
  const status = await evaluate(chain({ baseUrl: '', healthz: null }))
  assert.equal(status.ok, true)
  assert.equal(linkOf(status, 'healthz')?.state, 'skipped')
})

test('a release branch deleted after the merge is not a gap: the pull request head is the record', async () => {
  const status = await evaluate(chain({ branch: { name: 'release/v0.3.2', tip: SHA('b'), deleted: true } }))
  assert.equal(linkOf(status, 'branch')?.state, 'skipped')
  assert.equal(status.ok, true)
})

test('a release pull request that is still open is red: the version is not released', async () => {
  const status = await evaluate(chain({ pull: { ...(chain().pull as Record<string, unknown>), state: 'open' } }))
  assert.equal(status.ok, false)
  assert.equal(linkOf(status, 'pull')?.state, 'mismatch')
})

function runCli(args: string[], env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['scripts/verify-release.mjs', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

function fixtureFile(input: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-release-status-'))
  const path = join(dir, 'fixture.json')
  writeFileSync(path, JSON.stringify(input))
  return path
}

test('the CLI exits zero on a complete chain and prints every link', () => {
  const run = runCli(['--fixtures', fixtureFile(chain()), '--version', '0.3.2'])
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /release-status: ok/)
  assert.match(run.stdout, /image\s+ok\s+.*sha256:e{64}/)
})

test('the CLI exits non-zero on a missing link and names it', () => {
  const run = runCli(['--fixtures', fixtureFile(chain({ tag: null })), '--version', '0.3.2'])
  assert.equal(run.status, 1)
  assert.match(run.stdout, /release-status: not released/)
  assert.match(run.stdout, /tag\s+missing/)
})

test('the CLI rejects a fixture it cannot read with exit 2, never a green verdict', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-release-status-'))
  const broken = join(dir, 'broken.json')
  writeFileSync(broken, '{not json')
  const run = runCli(['--fixtures', broken, '--version', '0.3.2'])
  assert.equal(run.status, 2)
  assert.match(run.stderr, /cannot read/)
})

test('the CLI on a fresh checkout without a token or a fixture exits 2 and never claims a release verdict', () => {
  // The command must be runnable on a fresh clone: with no input it says which
  // input is missing and exits 2. It must not print "not released" — that verdict
  // is only allowed after the API answered.
  const bare = runCli(['--version', '0.3.2'], { GITHUB_TOKEN: '', GH_TOKEN: '', GITHUB_REPOSITORY: '' })
  assert.equal(bare.status, 2, bare.stderr)
  assert.match(bare.stderr, /no repository: set GITHUB_REPOSITORY or pass --repo/)
  assert.doesNotMatch(bare.stdout, /release-status:/)

  const repoOnly = runCli(['--version', '0.3.2'], { GITHUB_TOKEN: '', GH_TOKEN: '', GITHUB_REPOSITORY: 'HugoXK/fledge' })
  assert.equal(repoOnly.status, 2, repoOnly.stderr)
  assert.match(repoOnly.stderr, /no token: set GITHUB_TOKEN or pass --fixtures/)
  assert.doesNotMatch(repoOnly.stdout, /release-status:/)
})
test('the CLI writes the snapshot the admin page reads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-release-status-'))
  const out = join(dir, 'release-status.json')
  const run = runCli(['--fixtures', fixtureFile(chain()), '--version', '0.3.2', '--write', out])
  assert.equal(run.status, 0, run.stderr)
  const snapshot = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(snapshot.schema, 1)
  assert.equal(snapshot.version, '0.3.2')
  assert.equal(snapshot.ok, true)
  assert.ok(Array.isArray(snapshot.links))
  assert.match(JSON.stringify(snapshot), /releases\/tag\/v0\.3\.2/)
})

test('a CLI-written snapshot records the tag target and the Release URL, so the running build can be compared', async () => {
  // The page's "This process" row compares the booted commit stamp with the
  // snapshot's tag target. If the snapshot carries the target only inside the
  // tag link's prose, that comparison can never do better than `unknown`.
  const { readReleaseStatus, compareRunning } = await import('../src/lib/releaseStatus.js')
  const dir = mkdtempSync(join(tmpdir(), 'fledge-release-status-'))
  const out = join(dir, 'release-status.json')
  const run = runCli(['--fixtures', fixtureFile(chain()), '--version', '0.3.2', '--write', out])
  assert.equal(run.status, 0, run.stderr)
  const snapshot = readReleaseStatus(dir)
  assert.ok(snapshot !== null)
  assert.equal(snapshot.targetSha, SHA('c'))
  assert.equal(snapshot.releaseUrl, 'https://github.com/HugoXK/fledge/releases/tag/v0.3.2')
  const atTag = compareRunning(snapshot, { version: '0.3.2', commit: SHA('c').slice(0, 12) })
  assert.equal(atTag.state, 'ok', atTag.detail)
  const elsewhere = compareRunning(snapshot, { version: '0.3.2', commit: SHA('f').slice(0, 12) })
  assert.equal(elsewhere.state, 'mismatch', elsewhere.detail)
})

test('a snapshot that claims released with no links is refused, not rendered as an empty release', async () => {
  // `{ok: true, links: []}` is a claim with no evidence: every row would be
  // absent while the header still says "released".
  const { parseReleaseStatus } = await import('../src/lib/releaseStatus.js')
  assert.equal(parseReleaseStatus({ schema: 1, version: '0.3.2', checkedAt: '', baseUrl: '', ok: true, links: [], problems: [] }), null)
  assert.equal(
    parseReleaseStatus({
      schema: 1,
      version: '0.3.2',
      checkedAt: '',
      baseUrl: '',
      ok: true,
      links: [{ id: 'tag', state: 'ok', detail: 'v0.3.2 annotated' }],
      problems: ['tag: no v0.3.2 tag'],
    }),
    null,
  )
  // An honest "not released" snapshot still parses: the refusal is about a
  // green claim nobody can check, not about a recorded failure.
  const recorded = parseReleaseStatus({
    schema: 1,
    version: '0.3.2',
    checkedAt: '',
    baseUrl: '',
    ok: false,
    links: [{ id: 'tag', state: 'missing', detail: 'no v0.3.2 tag' }],
    problems: ['tag: no v0.3.2 tag'],
    targetSha: '',
    releaseUrl: '',
  })
  assert.equal(recorded?.ok, false)
  assert.equal(recorded?.links.length, 1)
})

// The admin surface renders the recorded chain; it never calls GitHub itself.
async function adminPage(body: unknown | null): Promise<string> {
  const { buildApp } = await import('../src/app.js')
  const { Store } = await import('../src/db.js')
  const { MockRunner } = await import('../src/jobs/mock.js')
  const helpers = await import('./helpers.js')
  const dir = mkdtempSync(join(tmpdir(), 'fledge-admin-release-'))
  mkdirSync(dir, { recursive: true })
  if (body !== null) writeFileSync(join(dir, 'release-status.json'), JSON.stringify(body))
  const config = helpers.testConfig({ dataDir: dir })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new helpers.MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const admin = helpers.makeUser(store, { login: 'boss', admin: true })
    const { cookie } = helpers.sessionFor(built, admin)
    const page = await built.app.inject({ method: 'GET', url: '/admin', headers: { cookie } })
    assert.equal(page.statusCode, 200)
    return page.body
  } finally {
    await built.close()
  }
}

test('the admin page renders the recorded chain, its digest and its Release URL, without a token', async () => {
  const { evaluateReleaseStatus } = await import('../scripts/lib/release-status.mjs')
  const version = String(JSON.parse(readFileSync('package.json', 'utf8')).version)
  const status = evaluateReleaseStatus(chain({ version, packageVersion: version, healthz: null, baseUrl: '' }))
  const page = await adminPage(status)
  assert.match(page, /发布链/)
  assert.match(page, /releases\/tag\/v0\.3\.2/)
  assert.match(page, /sha256:e{64}/)
  assert.match(page, /这个进程/)
  // The snapshot's `releaseUrl` is rendered as a link: it is a field the page
  // reads, not one it merely stores.
  assert.match(page, /<a class="link" href="https:\/\/github\.com\/HugoXK\/fledge\/releases\/tag\/v0\.3\.2"/)
  assert.doesNotMatch(page, /gh[pousr]_[A-Za-z0-9]{20,}/)
})

test('the admin page does not turn an unreadable Release URL into a link', async () => {
  const body = {
    schema: 1,
    version: '0.3.2',
    checkedAt: '',
    baseUrl: '',
    ok: false,
    links: [{ id: 'tag', state: 'missing', detail: 'no v0.3.2 tag' }],
    problems: ['tag: no v0.3.2 tag'],
    targetSha: '',
    releaseUrl: 'javascript:alert(1)',
  }
  const page = await adminPage(body)
  assert.doesNotMatch(page, /javascript:alert/)
})

test('the admin page says the chain was not recorded instead of rendering a blank card', async () => {
  const page = await adminPage(null)
  assert.match(page, /这台实例还没有记录发布链/)
  assert.match(page, /scripts\/verify-release\.mjs/)
})

// Issue #462: the local image digest and the fail-closed start hook.
//
// The chain read back from the API proves what was released; it says nothing
// about the image this host is about to run. `--local-image-digest` is that one
// extra comparison, and the unit's `ExecStartPre=` is the place that makes it
// mandatory instead of advisory.

const LOCAL = `sha256:${'1'.repeat(64)}`

test('a local image digest that is the attested one is green and prints the digest', async () => {
  const status = await evaluate(chain({ localImageDigest: DIGEST }))
  assert.equal(status.ok, true, JSON.stringify(status.problems))
  const local = linkOf(status, 'local')
  assert.equal(local?.state, 'ok')
  assert.match(local.detail, new RegExp(DIGEST))
})

test('a local image digest that differs from the attested one is red and names both digests', async () => {
  const status = await evaluate(chain({ localImageDigest: LOCAL }))
  assert.equal(status.ok, false)
  const local = linkOf(status, 'local')
  assert.equal(local?.state, 'mismatch')
  assert.match(local.detail, new RegExp(LOCAL))
  assert.match(local.detail, new RegExp(DIGEST))
})

test('a chain recorded without a local digest keeps the link skipped, never red', async () => {
  const status = await evaluate(chain())
  assert.equal(status.ok, true)
  assert.equal(linkOf(status, 'local')?.state, 'skipped')
})

test('a local digest that is not a sha256 digest is red and names what it read', async () => {
  const status = await evaluate(chain({ localImageDigest: 'ghcr.io/hugoxk/fledge:v0.3.2' }))
  assert.equal(status.ok, false)
  const local = linkOf(status, 'local')
  assert.equal(local?.state, 'mismatch')
  assert.match(local.detail, /ghcr\.io\/hugoxk\/fledge:v0\.3\.2/)
})

test('a local digest with no attested digest to compare against is red, not silently green', async () => {
  const status = await evaluate(chain({ image: null, localImageDigest: DIGEST }))
  assert.equal(linkOf(status, 'local')?.state, 'missing')
})

test('the CLI compares the local digest it is given and fails on a mismatch', () => {
  const run = runCli(['--fixtures', fixtureFile(chain()), '--version', '0.3.2', '--local-image-digest', LOCAL])
  assert.equal(run.status, 1, run.stdout + run.stderr)
  assert.match(run.stdout, /local\s+mismatch/)
  assert.match(run.stdout, new RegExp(LOCAL))
  assert.match(run.stdout, new RegExp(DIGEST))
})

test('the CLI records the local digest in the snapshot, and replaying that snapshot keeps the verdict', () => {
  // The boot hook replays the recorded file with no network at all, so the file
  // the release step writes has to carry the digest it compared.
  const dir = mkdtempSync(join(tmpdir(), 'fledge-release-status-'))
  const out = join(dir, 'release-status.json')
  const written = runCli(['--fixtures', fixtureFile(chain()), '--version', '0.3.2', '--local-image-digest', DIGEST, '--write', out])
  assert.equal(written.status, 0, written.stderr)
  assert.match(written.stdout, /local\s+ok/)
  const snapshot = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(snapshot.localImageDigest, DIGEST)
  const pkg = join(dir, 'package.json')
  writeFileSync(pkg, JSON.stringify({ version: '0.3.2' }))
  const replay = runCli(['--fixtures', out, '--version', '0.3.2', '--package', pkg])
  assert.equal(replay.status, 0, replay.stderr)
  assert.match(replay.stdout, /local\s+ok/)

  // A tree that is not the release is red on the version link, so the hook
  // cannot start a host whose /opt/fledge is another version.
  const stale = join(dir, 'stale-package.json')
  writeFileSync(stale, JSON.stringify({ version: '0.3.1' }))
  const drift = runCli(['--fixtures', out, '--version', '0.3.2', '--package', stale])
  assert.equal(drift.status, 1, drift.stdout + drift.stderr)
  assert.match(drift.stdout, /version\s+mismatch/)
})

test('--local-image-digest without a value is a usage error, exit 2, not a green verdict', () => {
  const run = runCli(['--fixtures', fixtureFile(chain()), '--version', '0.3.2', '--local-image-digest'])
  assert.equal(run.status, 2, run.stdout + run.stderr)
  assert.match(run.stderr, /--local-image-digest needs a value/)
})

test('an empty --local-image-digest is a usage error, exit 2, and writes no green record', () => {
  // The documented recording command builds the digest from
  // `docker image inspect … | cut -d@ -f2`, which is empty when the image
  // carries no RepoDigests. An empty value must not read like "no comparison
  // asked for": the boot hook would then accept a record whose one new link was
  // never made (#462 review).
  const dir = mkdtempSync(join(tmpdir(), 'fledge-empty-digest-'))
  const out = join(dir, 'release-status.json')
  const run = runCli(['--fixtures', fixtureFile(chain()), '--version', '0.3.2', '--local-image-digest', '', '--write', out])
  assert.equal(run.status, 2, run.stdout + run.stderr)
  assert.match(run.stderr, /--local-image-digest/)
  assert.doesNotMatch(run.stdout, /release-status: ok/)
  assert.throws(() => readFileSync(out, 'utf8'), /ENOENT/)
})

test('the runbook writes the record for the user the unit runs the hook as', () => {
  // deploy/fledge.service runs the service and its ExecStartPre as `User=`; a
  // root:root 0600 record is unreadable to that user, so the unit would refuse
  // to start a host recorded exactly as documented (#462 review). The docs and
  // the README must hand the file to that group with group read, and the
  // permission failure must not read like the empty case.
  const unit = readFileSync('deploy/fledge.service', 'utf8')
  const user = /^User=(\S+)$/m.exec(unit)?.[1] ?? ''
  assert.ok(user !== '', 'deploy/fledge.service names no User=')
  const deploy = readFileSync('docs/deploy.md', 'utf8')
  const readme = readFileSync('deploy/README.md', 'utf8')
  const section = deploy.slice(deploy.indexOf('### Required before start'))
  assert.ok(section.includes(`chown root:${user}`), `docs/deploy.md does not hand the record to root:${user}`)
  assert.ok(section.includes('chmod 0640'), 'docs/deploy.md does not make the record group-readable')
  assert.match(section, /EACCES/, 'docs/deploy.md does not name the permission failure as its own case')
  assert.ok(readme.includes(`root:${user}`) && readme.includes('0640'), `deploy/README.md does not describe the record as root:${user} 0640`)
})

test('the check never prints the token it was given', () => {
  const token = `ghp_${'x'.repeat(36)}`
  const run = runCli(['--fixtures', fixtureFile(chain()), '--version', '0.3.2', '--local-image-digest', DIGEST], {
    GITHUB_TOKEN: token,
    METRICS_TOKEN: token,
  })
  assert.equal(run.status, 0, run.stderr)
  assert.doesNotMatch(run.stdout + run.stderr, new RegExp(token))
})

test('the unit checks the recorded release before start and refuses a host that has none', () => {
  // The card's fail-closed requirement: the sample unit gains an ExecStartPre
  // that runs the same verifier against the file the release step writes. The
  // hook is offline — a reboot must not depend on the GitHub API — so it may
  // only name `--fixtures`, and it must refuse when the file is absent.
  const unit = readFileSync('deploy/fledge.service', 'utf8')
  const line = /^ExecStartPre=(.+)$/m.exec(unit)
  assert.ok(line !== null, 'deploy/fledge.service has no ExecStartPre hook')
  const command = (line[1] ?? '').trim()
  assert.match(command, /\/opt\/fledge\/scripts\/verify-release\.mjs/)
  assert.match(command, /--fixtures \/etc\/fledge\/release-status\.json/)
  assert.match(command, /--package \/opt\/fledge\/package\.json/)
  assert.doesNotMatch(command, /--repo|--base-url|--version/, 'the start hook must not read the API')

  const dir = mkdtempSync(join(tmpdir(), 'fledge-unit-'))
  const missing = join(dir, 'absent.json')
  const pkg = join(dir, 'package.json')
  writeFileSync(pkg, JSON.stringify({ version: '0.3.2' }))
  const argv = command
    .replace(/^\/usr\/bin\/node\s+/, '')
    .replace('/opt/fledge/scripts/verify-release.mjs', 'scripts/verify-release.mjs')
    .replace('/etc/fledge/release-status.json', missing)
    .replace('/opt/fledge/package.json', pkg)
  const result = spawnSync(process.execPath, argv.split(/\s+/), { encoding: 'utf8', env: { ...process.env, GITHUB_TOKEN: '', GH_TOKEN: '', GITHUB_REPOSITORY: '' } })
  assert.equal(result.status, 2, result.stdout + result.stderr)
  assert.match(result.stderr, /cannot read/)

  // And with the file present the same command is green, so the hook is not
  // failing on principle.
  const fixture = join(dir, 'release-status.json')
  writeFileSync(fixture, JSON.stringify(chain({ localImageDigest: DIGEST })))
  const okArgv = argv.split(/\s+/).map((part) => (part === missing ? fixture : part))
  const passed = spawnSync(process.execPath, okArgv, { encoding: 'utf8', env: { ...process.env, GITHUB_TOKEN: '', GH_TOKEN: '', GITHUB_REPOSITORY: '' } })
  assert.equal(passed.status, 0, passed.stdout + passed.stderr)
  assert.match(passed.stdout, /release-status: ok/)

  // A digest that is not the attested one stops the same command, which is the
  // whole point of putting it in front of the start.
  const wrong = join(dir, 'wrong.json')
  writeFileSync(wrong, JSON.stringify(chain({ localImageDigest: LOCAL })))
  const refused = spawnSync(process.execPath, argv.split(/\s+/).map((part) => (part === missing ? wrong : part)), { encoding: 'utf8', env: { ...process.env } })
  assert.equal(refused.status, 1, refused.stdout + refused.stderr)
  assert.match(refused.stdout, /local\s+mismatch/)
})
