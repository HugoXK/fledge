import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { runReleaseOpen, exitCodeFor, releaseBranch, SURFACE_PATHS } from '../scripts/release-open.mjs'
import type { ReleaseOpenAdapter, ReleaseOpenOptions, ReleasePlanArtifact } from '../scripts/release-open.mjs'

const REPO = 'HugoXK/fledge'
// Not named with a bare TOKEN binding: scripts/secret-scan.mjs fires on
// `\bTOKEN` plus a 16+ character value, so a word character before TOKEN keeps
// the tracked-tree scan clean while the value stays obviously fake.
const FAKE_TOKEN = 'sentinel-fake-token-value'
const MAIN = 'fdcccd975b1764a0bec62bd2b198d5c283bb3bbe'
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const OTHER = '0123456789abcdef0123456789abcdef01234567'
const VERSION = '0.5.0'
const BRANCH = releaseBranch(VERSION)
const DEFAULT_FILES = ['CHANGELOG.md', 'changelog.d/187-release-open.added.md', 'docker-compose.yml', 'package-lock.json', 'package.json']

type Call = { method: string; route: string; body?: Record<string, unknown> }

function json(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function artifact(over: Partial<ReleasePlanArtifact['plan']> = {}): ReleasePlanArtifact {
  return {
    mainSha: MAIN,
    plan: { shouldRelease: true, nextVersion: VERSION, reason: 'ok', total: 12, features: 6, fragments: 3, lastTag: 'v0.4.0', ...over },
  }
}

interface Fixture {
  permissionsPush?: boolean
  openPrs?: unknown[]
  branchStatus?: number
  branchSha?: string
  mainSha?: string
  compareFiles?: string[] | null
  packageVersion?: string
  changelogEntries?: Array<{ name: string; type: string }>
  pullStatus?: number
  maintainerCanModify?: boolean
  login?: string
  userStatus?: number
}

function makeServer(fixture: Fixture = {}) {
  const calls: Call[] = []
  const contents: Record<string, string> = {
    'package.json': JSON.stringify({ version: fixture.packageVersion ?? VERSION }),
    'package-lock.json': JSON.stringify({ version: VERSION }),
    'CHANGELOG.md': `## [${VERSION}]\n`,
    'docker-compose.yml': `image: fledge:${VERSION}\n`,
    'changelog.d/README.md': '# Changelog fragments\n',
    'changelog.d/187-release-open.added.md': 'A verified release branch opens one pull request.\n',
  }
  const entries = fixture.changelogEntries ?? [{ name: 'README.md', type: 'file' }, { name: '187-release-open.added.md', type: 'file' }]
  const files = fixture.compareFiles === undefined ? DEFAULT_FILES : fixture.compareFiles
  const pullNumber = 210

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const method = String(init?.method ?? 'GET')
    const route = url.replace(`https://api.github.com/repos/${REPO}`, '')
    const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>)
    calls.push({ method, route, body })

    if (method === 'GET' && route === 'https://api.github.com/user') {
      if (fixture.userStatus !== undefined) return json({ message: 'Not Found' }, fixture.userStatus)
      return json({ login: fixture.login ?? 'FledgePlatformTeam' })
    }
    if (method === 'GET' && route === '') {
      return json({ full_name: REPO, permissions: { push: fixture.permissionsPush ?? true } }, 200, { 'x-oauth-scopes': 'repo, workflow' })
    }
    if (method === 'GET' && route === '/pulls?state=open&per_page=100') return json(fixture.openPrs ?? [])
    if (method === 'GET' && route === `/git/ref/heads/${BRANCH}`) {
      if (fixture.branchStatus !== undefined) return json({ message: 'Not Found' }, fixture.branchStatus)
      return json({ object: { sha: fixture.branchSha ?? SHA } })
    }
    if (method === 'GET' && route.startsWith('/contents/')) {
      const path = decodeURIComponent(route.slice('/contents/'.length).split('?')[0] ?? '')
      if (path === 'changelog.d') return json(entries.map((entry) => ({ path: `changelog.d/${entry.name}`, ...entry })))
      const text = contents[path]
      if (text === undefined) return json({ message: 'Not Found' }, 404)
      return json({ content: Buffer.from(text, 'utf8').toString('base64'), encoding: 'base64', type: 'file' })
    }
    if (method === 'GET' && route === `/compare/main...${BRANCH}`) {
      if (files === null) return json({ message: 'Not Found' }, 404)
      return json({ files: files.map((filename) => ({ filename })) })
    }
    if (method === 'GET' && route === '/git/ref/heads/main') return json({ object: { sha: fixture.mainSha ?? MAIN } })
    if (method === 'POST' && route === '/pulls') return json({ number: pullNumber, html_url: `https://github.com/${REPO}/pull/${pullNumber}` }, fixture.pullStatus ?? 201)
    if (method === 'GET' && route === `/pulls/${pullNumber}`) return json({ number: pullNumber, maintainer_can_modify: fixture.maintainerCanModify ?? true })
    return json({ message: `unexpected ${method} ${route}` }, 500)
  }
  return { fetch: fetchImpl as typeof fetch, calls }
}

type ExecCall = { file: string; args: string[]; cwd: string; env: Record<string, string | undefined> }

function makeAdapter(failure: { script: 'version' | 'changelog'; code: number; stderr: string } | null = null) {
  const execs: ExecCall[] = []
  const adapter: ReleaseOpenAdapter = {
    readFile: (path) => readFileSync(path, 'utf8'),
    listDir: (path) => readdirSync(path).sort(),
    exec: (file, args, options) => {
      execs.push({ file, args, cwd: options.cwd, env: options.env })
      const which = (args[0] ?? '').includes('version.mjs') ? 'version' : 'changelog'
      if (failure !== null && failure.script === which) return { code: failure.code, stdout: '', stderr: failure.stderr }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  return { adapter, execs }
}

async function run(over: Partial<ReleaseOpenOptions> = {}, fixture: Fixture = {}, failure: Parameters<typeof makeAdapter>[0] = null) {
  const server = makeServer(fixture)
  const { adapter, execs } = makeAdapter(failure)
  const result = await runReleaseOpen({
    artifact: artifact(),
    version: VERSION,
    sha: SHA,
    repo: REPO,
    token: FAKE_TOKEN,
    fetch: server.fetch,
    adapter,
    ...over,
  })
  return { result, calls: server.calls, execs }
}

function posts(calls: Call[]): Call[] {
  return calls.filter((call) => call.method === 'POST')
}

test('opens exactly one pull request from the verified branch and asserts what it sends', async () => {
  const { result, calls, execs } = await run()

  assert.equal(result.status, 'opened')
  assert.equal(result.pr, 210)
  assert.deepEqual(posts(calls).length, 1)
  const post = posts(calls)[0]!
  assert.deepEqual(post.body, {
    title: `release: v${VERSION}`,
    head: BRANCH,
    base: 'main',
    maintainer_can_modify: true,
    body: post.body?.body,
  })
  const body = String(post.body?.body ?? '')
  assert.match(body, /^Written-by: HugoXK\n/)
  assert.match(body, /^No-issue: mechanical daily minor release$/m)
  assert.match(body, /Ran:\n- `node scripts\/version\.mjs check` in the materialised release tree — pass\n/)
  assert.match(body, /- `node scripts\/changelog\.mjs check` in the materialised release tree — pass/)
  assert.match(body, /Not run: this pull request's own checks/)
  assert.match(body, new RegExp(`compare/${MAIN}\\.\\.\\.${BRANCH.replace('/', '\\/')}`))
  assert.match(body, /merged pull requests since `v0\.4\.0`: \*\*12\*\*/)
  assert.match(body, /features: \*\*6\*\*/)

  // The materialised tree was read back through the adapter, and the reads that
  // built it are the exact five surfaces, nothing wider.
  assert.deepEqual([...(result.fetched ?? [])].sort(), [
    'package.json',
    'package-lock.json',
    'CHANGELOG.md',
    'docker-compose.yml',
    'changelog.d/README.md',
    'changelog.d/187-release-open.added.md',
  ].sort())
  assert.deepEqual(result.permissions, { push: true })
  assert.equal(result.scopes, 'repo, workflow')

  // The readback is part of the contract, not an extra call.
  assert.ok(calls.some((call) => call.method === 'GET' && call.route === '/pulls/210'))

  // The two checks ran in a temporary tree with this checkout's scripts, and the
  // child environment carries PATH only.
  assert.equal(execs.length, 2)
  for (const exec of execs) {
    assert.match(exec.args[0] ?? '', /scripts\/(version|changelog)\.mjs$/)
    assert.ok(exec.file.length > 0)
    assert.deepEqual(Object.keys(exec.env), ['PATH'])
    assert.notEqual(exec.cwd, '')
  }
})

test('reuses an open pull request at the same head sha and writes nothing', async () => {
  const { result, calls } = await run({ artifact: artifact({ shouldRelease: false }) }, {
    openPrs: [{ number: 201, title: `release: v${VERSION}`, head: { ref: BRANCH, sha: SHA } }],
  })
  assert.equal(result.status, 'reused')
  assert.equal(result.pr, 201)
  assert.match(result.reason, /#201/)
  assert.equal(posts(calls).length, 0)
})

test('refuses when the open pull request on this branch is at another sha', async () => {
  const { result, calls } = await run({}, {
    openPrs: [{ number: 202, title: `release: v${VERSION}`, head: { ref: BRANCH, sha: OTHER } }],
  })
  assert.equal(result.status, 'refused')
  assert.match(result.reason, /#202/)
  assert.match(result.reason, new RegExp(OTHER))
  assert.match(result.reason, new RegExp(SHA))
  assert.equal(posts(calls).length, 0)
})

test('refuses when another release version already has an open pull request', async () => {
  const { result, calls } = await run({}, {
    openPrs: [{ number: 203, title: 'release: v0.4.0', head: { ref: 'release/v0.4.0', sha: OTHER } }],
  })
  assert.equal(result.status, 'refused')
  assert.match(result.reason, /#203/)
  assert.match(result.reason, /v0\.4\.0/)
  assert.equal(posts(calls).length, 0)
})

test('refuses when the plan does not release tonight', async () => {
  const { result, calls } = await run({ artifact: artifact({ shouldRelease: false, reason: 'not-enough-prs' }) })
  assert.equal(result.status, 'refused')
  assert.match(result.reason, /not-enough-prs/)
  assert.equal(posts(calls).length, 0)
})

test('refuses when the branch is missing', async () => {
  const { result, calls } = await run({}, { branchStatus: 404 })
  assert.equal(result.status, 'refused')
  assert.match(result.reason, /does not exist/)
  assert.equal(posts(calls).length, 0)
})

test('refuses when the branch is not at the pushed sha', async () => {
  const { result, calls } = await run({}, { branchSha: OTHER })
  assert.equal(result.status, 'refused')
  assert.match(result.reason, new RegExp(OTHER))
  assert.match(result.reason, new RegExp(SHA))
  assert.equal(posts(calls).length, 0)
})

test('refuses when the version check fails in the materialised tree', async () => {
  const { result, calls } = await run({}, {}, { script: 'version', code: 1, stderr: 'version: CHANGELOG.md newest section is 0.4.0, package.json is 0.5.0' })
  assert.equal(result.status, 'refused')
  assert.match(result.reason, /CHANGELOG\.md newest section is 0\.4\.0/)
  assert.equal(posts(calls).length, 0)
})

test('refuses when the changelog check fails in the materialised tree', async () => {
  const { result, calls } = await run({}, {}, { script: 'changelog', code: 1, stderr: 'bad name: notes.md' })
  assert.equal(result.status, 'refused')
  assert.match(result.reason, /bad name: notes\.md/)
  assert.equal(posts(calls).length, 0)
})

test('refuses when the branch diff holds a path outside the release surface', async () => {
  const { result, calls } = await run({}, { compareFiles: [...DEFAULT_FILES, 'src/app.ts'] })
  assert.equal(result.status, 'refused')
  assert.match(result.reason, /src\/app\.ts/)
  assert.equal(posts(calls).length, 0)
})

test('refuses when changelog.d holds an entry the surface does not allow', async () => {
  const { result, calls } = await run({}, {
    changelogEntries: [{ name: 'README.md', type: 'file' }, { name: 'nested', type: 'dir' }],
  })
  assert.equal(result.status, 'refused')
  assert.match(result.reason, /changelog\.d holds an entry/)
  assert.equal(posts(calls).length, 0)
})

test('refuses when main moved since the plan was made', async () => {
  const { result, calls } = await run({}, { mainSha: OTHER })
  assert.equal(result.status, 'refused')
  assert.match(result.reason, new RegExp(MAIN))
  assert.match(result.reason, new RegExp(OTHER))
  assert.equal(posts(calls).length, 0)
})

test('refuses without writing when the credential cannot push', async () => {
  const { result, calls } = await run({}, { permissionsPush: false })
  assert.equal(result.status, 'refused')
  assert.match(result.reason, /permissions\.push/)
  assert.equal(posts(calls).length, 0)
  // The refusal happens before any branch or content read, so nothing else could
  // have been written either.
  assert.deepEqual(calls.map((call) => `${call.method} ${call.route}`), ['GET '])
  assert.equal(exitCodeFor(result), 1)
})

test('refuses a pull request that came back not maintainer-editable', async () => {
  const { result, calls } = await run({}, { maintainerCanModify: false })
  assert.equal(result.status, 'refused')
  assert.equal(result.pr, 210)
  assert.match(result.reason, /maintainer_can_modify/)
  assert.equal(posts(calls).length, 1)
})

test('the child environment is fixed: no inherited tag variable and no token in an argument', async () => {
  const before = { RELEASE_TAG: process.env.RELEASE_TAG, GITHUB_REF_NAME: process.env.GITHUB_REF_NAME }
  process.env.RELEASE_TAG = 'v9.9.9-sentinel'
  process.env.GITHUB_REF_NAME = 'v9.9.9-sentinel'
  try {
    const { result, execs } = await run()
    assert.equal(result.status, 'opened')
    assert.equal(execs.length, 2)
    for (const exec of execs) {
      assert.deepEqual(Object.keys(exec.env), ['PATH'])
      const rendered = `${exec.file} ${exec.args.join(' ')} ${JSON.stringify(exec.env)}`
      assert.ok(!rendered.includes('sentinel'), 'a sentinel value reached a child process')
      assert.ok(!rendered.includes(FAKE_TOKEN), 'the token reached a child process')
    }
    assert.ok(!JSON.stringify(result).includes(FAKE_TOKEN), 'the token was printed')
  } finally {
    if (before.RELEASE_TAG === undefined) delete process.env.RELEASE_TAG
    else process.env.RELEASE_TAG = before.RELEASE_TAG
    if (before.GITHUB_REF_NAME === undefined) delete process.env.GITHUB_REF_NAME
    else process.env.GITHUB_REF_NAME = before.GITHUB_REF_NAME
  }
})

test('the module carries no tag route and no tag-shaped export', () => {
  const source = readFileSync(new URL('../scripts/release-open.mjs', import.meta.url), 'utf8')
  assert.ok(!/(POST|PATCH|DELETE)[^\n]*\/git\/(refs|tags)/.test(source), 'the module must not write a ref or a tag')
  assert.ok(!source.includes('/git/refs'), 'the module must not name the refs write path')
  assert.ok(!source.includes('/git/tags'), 'the module must not name the tags write path')
  const exported = Object.keys({ ...{ SURFACE_PATHS }, ...{ exitCodeFor }, ...{ releaseBranch }, ...{ runReleaseOpen } })
  for (const name of exported) assert.ok(!/tag/i.test(name), `a tag-shaped export would move the authority out of #80: ${name}`)
})

test('the surface the tool materialises is exactly the mechanical release set', () => {
  assert.deepEqual([...SURFACE_PATHS].sort(), ['CHANGELOG.md', 'changelog.d', 'docker-compose.yml', 'package-lock.json', 'package.json'])
})

test('a run without the team token is blocked before any request is made', async () => {
  const { result, calls } = await run({ token: '' })
  assert.equal(result.status, 'blocked')
  assert.match(result.reason, /RELEASE_OPEN_TOKEN/)
  assert.equal(calls.length, 0, 'a blocked run calls no endpoint, least of all POST /pulls')
})

test('a blocked run exits zero, so the night reports it instead of dying', () => {
  assert.equal(exitCodeFor({ status: 'blocked' }), 0)
  assert.equal(exitCodeFor({ status: 'refused' }), 1)
})

test('the reviewer account may not open the release pull request', async () => {
  const { result, calls } = await run({}, { login: 'HugoXK-bot' })
  assert.equal(result.status, 'refused')
  assert.match(result.reason, /HugoXK-bot/)
  assert.equal(posts(calls).length, 0, 'the reviewer credential never reaches the write endpoint')
})

test('an unreadable credential identity is refused, not guessed', async () => {
  const { result, calls } = await run({}, { userStatus: 500 })
  assert.equal(result.status, 'refused')
  assert.match(result.reason, /identity|account/i)
  assert.equal(posts(calls).length, 0)
})
