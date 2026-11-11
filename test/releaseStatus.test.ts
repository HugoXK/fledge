import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
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

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['scripts/verify-release.mjs', ...args], { encoding: 'utf8' })
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
  assert.doesNotMatch(page, /gh[pousr]_[A-Za-z0-9]{20,}/)
})

test('the admin page says the chain was not recorded instead of rendering a blank card', async () => {
  const page = await adminPage(null)
  assert.match(page, /这台实例还没有记录发布链/)
  assert.match(page, /scripts\/verify-release\.mjs/)
})
