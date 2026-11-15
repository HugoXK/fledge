import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { planHash, validateGatePlan, type GatePlan } from '../src/gates/plan.js'
import { laneContract, laneResult } from '../src/gates/lanes.js'
import {
  composeGatePullRequest,
  GATE_CONTRACT_PATH,
  GATE_SCRIPT_PATH,
  GATE_WORKFLOW_PATH,
  RELEASE_WORKFLOW_PATH,
} from '../src/gates/compose.js'
import { json, makeUser, MemoryMailer, readBody, sessionFor, startFakeServer, testConfig } from './helpers.js'

// #543 second slice: the confirmed plan becomes one gate pull request. These
// tests drive the real route against a fake GitHub that records every write, so
// "exactly one branch, one set of files, one PR" is a fact about the requests
// rather than a claim about the code.

const BASE_SHA = 'a'.repeat(40)
const MOVED_SHA = 'b'.repeat(40)

function basePlan(overrides: Partial<GatePlan> = {}): GatePlan {
  const checked = validateGatePlan({
    baseSha: BASE_SHA,
    mergeQueue: false,
    lanes: {
      'pr-ready': { commands: ['npm run lint', 'npm test'], observe: false, source: 'analysis', durationMs: 1200 },
      'pr-merge': { commands: ['npm run check'], observe: false, source: 'analysis' },
      daily: { commands: [], observe: true, source: 'default' },
      release: { commands: ['npm run build'], observe: false, source: 'analysis' },
    },
    existingFiles: ['.github/workflows/ci.yml'],
    gaps: ['No benchmark command was found'],
    notes: ['Analysed at the default branch'],
    ...overrides,
  })
  if (!checked.ok) throw new Error(`the fixture plan must validate: ${checked.message}`)
  return checked.plan
}

interface FakeGithub {
  url: string
  mainSha: string
  files: Map<string, string>
  requests: Array<{ method: string; path: string; body: Record<string, unknown> }>
  pulls: Array<Record<string, unknown>>
  branchExists: boolean
  close: () => Promise<void>
}

async function fakeGithub(options: { mainSha?: string; files?: Record<string, string> } = {}): Promise<FakeGithub> {
  const files = new Map(Object.entries(options.files ?? {}))
  const requests: FakeGithub['requests'] = []
  const pulls: FakeGithub['pulls'] = []
  const state = {
    mainSha: options.mainSha ?? BASE_SHA,
    files,
    requests,
    pulls,
    branchExists: false,
    url: '',
    close: async (): Promise<void> => {},
  }
  const prefix = '/repos/owner/repo'
  const server = await startFakeServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake')
    const body = request.method === 'GET' ? {} : JSON.parse((await readBody(request)).toString('utf8') || '{}') as Record<string, unknown>
    requests.push({ method: request.method ?? '', path: url.pathname, body })

    if (request.method === 'GET' && url.pathname === `${prefix}/branches/main`) {
      json(response, 200, { name: 'main', commit: { sha: state.mainSha } })
      return
    }
    if (request.method === 'GET' && url.pathname.startsWith(`${prefix}/branches/`)) {
      const branch = decodeURIComponent(url.pathname.slice(`${prefix}/branches/`.length))
      if (state.branchExists && branch.startsWith('fledge/gate-')) {
        json(response, 200, { name: branch, commit: { sha: 'branchsha' } })
        return
      }
      json(response, 404, { message: 'Branch not found' })
      return
    }
    if (request.method === 'GET' && url.pathname.startsWith(`${prefix}/contents/`)) {
      const path = decodeURIComponent(url.pathname.slice(`${prefix}/contents/`.length))
      const content = state.files.get(path)
      if (content === undefined) {
        json(response, 404, { message: 'Not Found' })
        return
      }
      json(response, 200, {
        type: 'file',
        sha: `blob-${path}`,
        size: Buffer.byteLength(content),
        content: Buffer.from(content, 'utf8').toString('base64'),
        encoding: 'base64',
      })
      return
    }
    if (request.method === 'POST' && url.pathname === `${prefix}/git/refs`) {
      json(response, 201, { ref: String(body.ref ?? ''), object: { sha: String(body.sha ?? '') } })
      return
    }
    if (request.method === 'PUT' && url.pathname.startsWith(`${prefix}/contents/`)) {
      const path = decodeURIComponent(url.pathname.slice(`${prefix}/contents/`.length))
      state.files.set(path, String(body.content ?? ''))
      json(response, 200, { content: { path, sha: `blob-new-${path}` }, commit: { sha: 'commit-new' } })
      return
    }
    if (request.method === 'POST' && url.pathname === `${prefix}/pulls`) {
      pulls.push(body)
      json(response, 201, {
        number: 7,
        html_url: 'https://github.com/owner/repo/pull/7',
        title: String(body.title ?? ''),
        state: 'open',
        head: { ref: String(body.head ?? ''), sha: 'branchsha' },
        base: { ref: String(body.base ?? '') },
        mergeable: true,
        mergeable_state: 'blocked',
        draft: false,
        merged: false,
        changed_files: 4,
        body: String(body.body ?? ''),
      })
      return
    }
    json(response, 404, { message: `unexpected ${request.method ?? ''} ${url.pathname}` })
  })
  state.url = server.url
  state.close = server.close
  return state
}

interface Harness {
  store: Store
  built: Awaited<ReturnType<typeof buildApp>>
  repo: ReturnType<Store['createRepo']>
  cookie: string
  csrf: string
  close: () => Promise<void>
}

async function harness(apiBase: string): Promise<Harness> {
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase } })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), startScheduler: false })
  const user = makeUser(store, { login: `gate-${Math.random().toString(36).slice(2, 8)}`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_${Math.random().toString(36).slice(2, 8)}`,
    userId: user.id,
    owner: 'owner',
    name: 'repo',
    defaultBranch: 'main',
    tokenEnc: encryptSecret('token', config.tokenEncryptionKey),
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  const session = sessionFor(built, user)
  return { store, built, repo, cookie: session.cookie, csrf: session.csrf, close: () => built.close() }
}

function post(h: Harness, url: string, payload: unknown): Promise<{ statusCode: number; body: string; headers: Record<string, unknown> }> {
  return h.built.app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', cookie: h.cookie, 'x-csrf-token': h.csrf },
    payload: JSON.stringify(payload),
  })
}

async function proposedSession(h: Harness, plan: GatePlan): Promise<string> {
  const created = await post(h, `/repos/${h.repo.id}/gate/sessions`, plan)
  assert.equal(created.statusCode, 201, created.body)
  return (JSON.parse(created.body) as { id: string }).id
}

function writes(state: FakeGithub): Array<{ method: string; path: string; body: Record<string, unknown> }> {
  return state.requests.filter((request) => request.method !== 'GET')
}

test('a confirmed plan creates one branch, the gate files and exactly one pull request', async () => {
  const fake = await fakeGithub()
  const h = await harness(fake.url)
  try {
    const id = await proposedSession(h, basePlan())
    assert.deepEqual(writes(fake), [], 'planning writes nothing to the repository')
    assert.equal((await post(h, `/repos/${h.repo.id}/gate/sessions/${id}/confirm`, {})).statusCode, 200)

    const created = await post(h, `/repos/${h.repo.id}/gate/sessions/${id}/create`, {})
    assert.equal(created.statusCode, 201, created.body)
    const body = JSON.parse(created.body) as { status: string; prUrl: string; branch: string }
    assert.equal(body.status, 'created')
    assert.equal(body.prUrl, 'https://github.com/owner/repo/pull/7')
    assert.match(body.branch, /^fledge\/gate-[0-9a-f]{8}$/)

    const refs = fake.requests.filter((request) => request.method === 'POST' && request.path === '/repos/owner/repo/git/refs')
    assert.equal(refs.length, 1)
    assert.equal(refs[0]!.body.sha, BASE_SHA, 'the branch is created from the reviewed SHA')
    assert.equal(refs[0]!.body.ref, `refs/heads/${body.branch}`)

    const puts = fake.requests.filter((request) => request.method === 'PUT')
    const paths = puts.map((request) => request.path).sort()
    assert.deepEqual(paths, [
      `/repos/owner/repo/contents/${GATE_CONTRACT_PATH}`,
      `/repos/owner/repo/contents/${GATE_SCRIPT_PATH}`,
      `/repos/owner/repo/contents/${GATE_WORKFLOW_PATH}`,
      `/repos/owner/repo/contents/${RELEASE_WORKFLOW_PATH}`,
    ].sort())
    for (const put of puts) assert.equal(put.body.branch, body.branch)

    assert.equal(fake.pulls.length, 1)
    const pull = fake.pulls[0]!
    assert.equal(pull.head, body.branch)
    assert.equal(pull.base, 'main')
    assert.match(String(pull.body), /Gate-plan-hash:/)
    assert.match(String(pull.body), /`pr-ready`/)

    const again = await post(h, `/repos/${h.repo.id}/gate/sessions/${id}/create`, {})
    assert.equal(again.statusCode, 409)
    assert.equal((JSON.parse(again.body) as { error: { type: string } }).error.type, 'GATE_PR_ALREADY_CREATED')
    assert.equal(fake.pulls.length, 1, 'a second click cannot open a second pull request')
    assert.equal(h.store.getGateSession(id)?.status, 'created')
  } finally {
    await h.close()
    await fake.close()
  }
})

test('a plan whose base branch moved is refused before any write', async () => {
  const fake = await fakeGithub()
  const h = await harness(fake.url)
  try {
    const id = await proposedSession(h, basePlan())
    assert.equal((await post(h, `/repos/${h.repo.id}/gate/sessions/${id}/confirm`, {})).statusCode, 200)
    fake.mainSha = MOVED_SHA

    const refused = await post(h, `/repos/${h.repo.id}/gate/sessions/${id}/create`, {})
    assert.equal(refused.statusCode, 409)
    assert.equal((JSON.parse(refused.body) as { error: { type: string } }).error.type, 'stale_base_sha')
    assert.deepEqual(writes(fake), [], 'a stale plan writes no branch, file or pull request')
    assert.equal(h.store.getGateSession(id)?.status, 'refused')
    assert.equal(h.store.getGateSession(id)?.error_code, 'stale_base_sha')
  } finally {
    await h.close()
    await fake.close()
  }
})

test('an existing ci.yml keeps its unrelated jobs and triggers and gains only the pr-ready job', () => {
  const plan = basePlan()
  const existingCi = [
    'name: CI',
    'on:',
    '  push:',
    '    branches: [main]',
    '  workflow_dispatch:',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: npm test',
    '',
  ].join('\n')
  const result = composeGatePullRequest({
    plan,
    planHash: planHash(plan),
    baseBranch: 'main',
    existing: [{ path: '.github/workflows/ci.yml', content: existingCi, sha: 'blob-ci' }],
  })
  assert.equal(result.ok, true)
  if (!result.ok) return

  const ci = result.files.find((file) => file.path === '.github/workflows/ci.yml')
  assert.ok(ci !== undefined)
  assert.equal(ci.mode, 'update')
  assert.equal(ci.sha, 'blob-ci', 'an update names the blob it replaces')
  assert.match(ci.content, /^  build:$/m, 'the unrelated job is preserved')
  assert.match(ci.content, /^  push:$/m, 'the unrelated trigger is preserved')
  assert.match(ci.content, /^  workflow_dispatch:$/m)
  assert.match(ci.content, /^  pull_request:$/m, 'the gate trigger is added')
  assert.match(ci.content, /^  fledge-gate:$/m, 'the gate job is added')
  assert.equal((ci.content.match(/^  pull_request:$/gm) ?? []).length, 1)
  assert.doesNotMatch(ci.content, /^  schedule:$/m, 'no schedule trigger lands on the unrelated workflow')

  const dedicated = result.files.find((file) => file.path === GATE_WORKFLOW_PATH)
  assert.ok(dedicated !== undefined)
  assert.match(dedicated.content, /^  schedule:$/m)
  assert.match(dedicated.content, /fledge-gate-pr-merge/)
  assert.doesNotMatch(dedicated.content, /fledge-gate-pr-ready/)
})

test('a flow-style trigger list gains pull_request without rewriting the file shape', () => {
  const plan = basePlan()
  const existingCi = 'name: CI\non: [push, workflow_dispatch]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n'
  const result = composeGatePullRequest({
    plan,
    planHash: planHash(plan),
    baseBranch: 'main',
    existing: [{ path: '.github/workflows/ci.yml', content: existingCi, sha: 'blob-ci' }],
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const ci = result.files.find((file) => file.path === '.github/workflows/ci.yml')!
  assert.match(ci.content, /^on: \[push, workflow_dispatch, pull_request\]$/m)
  assert.match(ci.content, /^  build:$/m)
})

test('an empty lane is not_applicable, an observe failure is observe_fail, and the contract and script say so', () => {
  assert.equal(laneResult({ commands: [], observe: false, exitCode: 0 }), 'not_applicable')
  assert.equal(laneResult({ commands: [], observe: true, exitCode: 1 }), 'not_applicable')
  assert.equal(laneResult({ commands: ['npm test'], observe: false, exitCode: 0 }), 'pass')
  assert.equal(laneResult({ commands: ['npm test'], observe: false, exitCode: 1 }), 'fail')
  assert.equal(laneResult({ commands: ['npm test'], observe: true, exitCode: 1 }), 'observe_fail')
  assert.equal(laneResult({ commands: ['npm test'], observe: false, exitCode: null }), 'fail', 'a lane that never produced an exit code is not green')

  const plan = basePlan()
  const contract = laneContract({ plan, planHash: planHash(plan), baseBranch: 'main' })
  assert.deepEqual(contract.lanes.daily.commands, [])
  assert.equal(contract.lanes.daily.observe, true)

  const result = composeGatePullRequest({ plan, planHash: planHash(plan), baseBranch: 'main', existing: [] })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const script = result.files.find((file) => file.path === GATE_SCRIPT_PATH)!
  assert.match(script.content, /not_applicable/)
  assert.match(script.content, /observe_fail/)
  const stored = JSON.parse(result.files.find((file) => file.path === GATE_CONTRACT_PATH)!.content) as { lanes: Record<string, { commands: string[]; trigger: string }> }
  assert.deepEqual(stored.lanes.daily!.commands, [])
  assert.equal(stored.lanes['pr-ready']!.trigger, 'pull_request')
})

test('a merge queue gets merge_group and no merge-preview gap', () => {
  const plan = basePlan({ mergeQueue: true })
  const result = composeGatePullRequest({ plan, planHash: planHash(plan), baseBranch: 'main', existing: [] })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const dedicated = result.files.find((file) => file.path === GATE_WORKFLOW_PATH)!
  assert.match(dedicated.content, /^  merge_group:$/m)
  assert.doesNotMatch(dedicated.content, /branches: \['main'\]/)
  const contract = JSON.parse(result.files.find((file) => file.path === GATE_CONTRACT_PATH)!.content) as { lanes: Record<string, { trigger: string }>; gaps: string[] }
  assert.equal(contract.lanes['pr-merge']!.trigger, 'merge_group')
  assert.ok(!contract.gaps.some((gap) => /merge preview/.test(gap)))
})

test('without a merge queue pr-merge runs after merge and the merge-preview gap is recorded', () => {
  const plan = basePlan({ mergeQueue: false })
  const result = composeGatePullRequest({ plan, planHash: planHash(plan), baseBranch: 'main', existing: [] })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const dedicated = result.files.find((file) => file.path === GATE_WORKFLOW_PATH)!
  assert.match(dedicated.content, /^  push:$/m)
  assert.match(dedicated.content, /branches: \['main'\]/)
  assert.doesNotMatch(dedicated.content, /merge_group/)
  const contract = JSON.parse(result.files.find((file) => file.path === GATE_CONTRACT_PATH)!.content) as { lanes: Record<string, { trigger: string }>; gaps: string[] }
  assert.equal(contract.lanes['pr-merge']!.trigger, 'after_merge')
  assert.ok(contract.gaps.some((gap) => /merge preview/.test(gap)), 'a check that only sees the merged tree is a gap')
})

test('a branch that already exists is refused before any file write', async () => {
  const fake = await fakeGithub()
  fake.branchExists = true
  const h = await harness(fake.url)
  try {
    const id = await proposedSession(h, basePlan())
    assert.equal((await post(h, `/repos/${h.repo.id}/gate/sessions/${id}/confirm`, {})).statusCode, 200)
    const refused = await post(h, `/repos/${h.repo.id}/gate/sessions/${id}/create`, {})
    assert.equal(refused.statusCode, 409)
    assert.equal((JSON.parse(refused.body) as { error: { type: string } }).error.type, 'branch_exists')
    assert.equal(fake.requests.filter((request) => request.method === 'PUT').length, 0)
    assert.equal(fake.pulls.length, 0)
  } finally {
    await h.close()
    await fake.close()
  }
})

test('the create form redirects to the gate page and the page links the pull request', async () => {
  const fake = await fakeGithub()
  const h = await harness(fake.url)
  try {
    const id = await proposedSession(h, basePlan())
    h.store.updateGateSession(id, { status: 'confirmed', confirmed_by: 'maintainer' })
    const response = await h.built.app.inject({
      method: 'POST',
      url: `/repos/${h.repo.id}/gate/sessions/${id}/create`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `${h.cookie}; fledge_lang=en` },
      payload: `csrf=${encodeURIComponent(h.csrf)}`,
    })
    assert.equal(response.statusCode, 302)
    assert.equal(response.headers.location, `/repos/${h.repo.id}/gate`)
    const page = await h.built.app.inject({ method: 'GET', url: `/repos/${h.repo.id}/gate`, headers: { cookie: `${h.cookie}; fledge_lang=en` } })
    assert.match(page.body, /https:\/\/github\.com\/owner\/repo\/pull\/7/)
  } finally {
    await h.close()
    await fake.close()
  }
})
