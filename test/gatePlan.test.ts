import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { GATE_PLAN_LANES, planHash, validateGatePlan } from '../src/gates/plan.js'
import { formBody, json, makeUser, MemoryMailer, sessionFor, startFakeServer, testConfig } from './helpers.js'

// #543 first slice: the plan is validated as a closed shape, stored as a
// session, and confirmed by a maintainer. No route in this slice writes to the
// repository, so the tests drive the API and a fake GitHub that records methods.

const BASE_SHA = 'a'.repeat(40)
const CURRENT_SHA = 'b'.repeat(40)

function basePlan(): Record<string, unknown> {
  return {
    baseSha: BASE_SHA,
    mergeQueue: false,
    lanes: {
      'pr-ready': { commands: ['npm run lint', 'npm test'], observe: false, source: 'analysis', durationMs: 1200 },
      'pr-merge': { commands: ['npm run check'], observe: false, source: 'analysis' },
      daily: { commands: [], observe: true, source: 'default' },
      release: { commands: ['npm run build'], observe: false, source: 'analysis', durationMs: 3000 },
    },
    existingFiles: ['.github/workflows/ci.yml'],
    gaps: ['No benchmark command was found'],
    notes: ['Analysed at the default branch'],
  }
}

interface Harness {
  store: Store
  built: Awaited<ReturnType<typeof buildApp>>
  user: ReturnType<typeof makeUser>
  repo: ReturnType<Store['createRepo']>
  cookie: string
  csrf: string
  close: () => Promise<void>
}

async function harness(options: { repoRole?: 'maintainer' | 'developer'; apiBase?: string; token?: string; apiKey?: string } = {}): Promise<Harness> {
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: options.apiBase ?? 'https://api.github.com' } })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), startScheduler: false })
  const user = makeUser(store, { login: `gate-${Math.random().toString(36).slice(2, 8)}`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_${Math.random().toString(36).slice(2, 8)}`,
    userId: user.id,
    owner: 'owner',
    name: 'repo',
    defaultBranch: 'main',
    tokenEnc: options.token === undefined ? '' : encryptSecret(options.token, config.tokenEncryptionKey),
    permission: 'admin',
    repoRole: options.repoRole ?? 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  const session = sessionFor(built, user)
  return { store, built, user, repo, cookie: session.cookie, csrf: session.csrf, close: () => built.close() }
}

function createSession(h: Harness, plan: unknown = basePlan()): Promise<{ statusCode: number; body: string }> {
  return h.built.app.inject({
    method: 'POST',
    url: `/repos/${h.repo.id}/gate/sessions`,
    headers: { 'content-type': 'application/json', cookie: h.cookie, 'x-csrf-token': h.csrf },
    payload: JSON.stringify(plan),
  })
}

function getSession(h: Harness, id: string): Promise<{ statusCode: number; body: string }> {
  return h.built.app.inject({ method: 'GET', url: `/repos/${h.repo.id}/gate/sessions/${id}`, headers: { cookie: h.cookie } })
}

function confirm(h: Harness, id: string, form = false): Promise<{ statusCode: number; body: string; headers: Record<string, unknown> }> {
  return h.built.app.inject({
    method: 'POST',
    url: `/repos/${h.repo.id}/gate/sessions/${id}/confirm`,
    headers: form
      ? { 'content-type': 'application/x-www-form-urlencoded', cookie: h.cookie }
      : { 'content-type': 'application/json', cookie: h.cookie, 'x-csrf-token': h.csrf },
    payload: form ? formBody({ csrf: h.csrf }) : JSON.stringify({}),
  })
}

test('the plan schema accepts a complete plan and closes every lane', () => {
  const result = validateGatePlan(basePlan())
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(Object.keys(result.plan.lanes), [...GATE_PLAN_LANES])
  assert.equal(result.plan.lanes.daily.commands.length, 0)
  assert.equal(result.plan.lanes['pr-ready'].durationMs, 1200)
})

test('the plan schema refuses unknown fields, unknown lanes, empty commands, a bad SHA and oversize values', () => {
  const unknownField = validateGatePlan({ ...basePlan(), extra: true })
  assert.equal(unknownField.ok, false)
  if (!unknownField.ok) {
    assert.equal(unknownField.code, 'field_unknown')
    assert.equal(unknownField.field, 'extra')
  }

  const plan = basePlan()
  const lanes = plan.lanes as Record<string, unknown>
  lanes['pr-preview'] = { commands: ['npm test'], observe: false, source: 'analysis' }
  const unknownLane = validateGatePlan(plan)
  assert.equal(unknownLane.ok, false)
  if (!unknownLane.ok) {
    assert.equal(unknownLane.code, 'lane_unknown')
    assert.equal(unknownLane.field, 'lanes.pr-preview')
  }

  const empty = basePlan()
  ;(empty.lanes as Record<string, { commands: string[] }>)['pr-ready']!.commands = ['']
  const emptyCommand = validateGatePlan(empty)
  assert.equal(emptyCommand.ok, false)
  if (!emptyCommand.ok) assert.equal(emptyCommand.code, 'command_empty')

  const badSha = validateGatePlan({ ...basePlan(), baseSha: 'abc' })
  assert.equal(badSha.ok, false)
  if (!badSha.ok) assert.equal(badSha.code, 'base_sha_invalid')

  const longCommand = basePlan()
  ;(longCommand.lanes as Record<string, { commands: string[] }>)['release']!.commands = ['x'.repeat(5000)]
  const oversize = validateGatePlan(longCommand)
  assert.equal(oversize.ok, false)
  if (!oversize.ok) assert.equal(oversize.code, 'command_oversize')
})

test('the plan hash is stable across property order and repeated validation', () => {
  const first = validateGatePlan(basePlan())
  const reordered = {
    notes: ['Analysed at the default branch'],
    gaps: ['No benchmark command was found'],
    existingFiles: ['.github/workflows/ci.yml'],
    lanes: {
      release: { source: 'analysis', observe: false, durationMs: 3000, commands: ['npm run build'] },
      daily: { source: 'default', observe: true, commands: [] },
      'pr-merge': { commands: ['npm run check'], observe: false, source: 'analysis' },
      'pr-ready': { durationMs: 1200, source: 'analysis', observe: false, commands: ['npm run lint', 'npm test'] },
    },
    mergeQueue: false,
    baseSha: BASE_SHA.toUpperCase(),
  }
  const second = validateGatePlan(reordered)
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  if (!first.ok || !second.ok) return
  assert.equal(planHash(first.plan), planHash(second.plan))
  const repeated = validateGatePlan(basePlan())
  assert.equal(repeated.ok, true)
  if (repeated.ok) assert.equal(planHash(first.plan), planHash(repeated.plan))
})

test('a maintainer can create, read and confirm a session without a repository write', async () => {
  const h = await harness()
  try {
    const created = await createSession(h)
    assert.equal(created.statusCode, 201)
    const body = JSON.parse(created.body) as { id: string; status: string; plan: unknown; planHash: string; confirmedBy: string | null }
    assert.equal(body.status, 'proposed')
    assert.deepEqual(body.plan, basePlan())
    assert.equal(body.confirmedBy, null)

    const read = await getSession(h, body.id)
    assert.equal(read.statusCode, 200)
    const stored = JSON.parse(read.body) as { status: string; plan: unknown; planHash: string }
    assert.equal(stored.status, 'proposed')
    assert.deepEqual(stored.plan, basePlan())
    assert.equal(stored.planHash, body.planHash)

    const confirmed = await confirm(h, body.id)
    assert.equal(confirmed.statusCode, 200)
    const after = JSON.parse(confirmed.body) as { status: string; confirmedBy: string; confirmedAt: string; planHash: string }
    assert.equal(after.status, 'confirmed')
    assert.equal(after.confirmedBy, h.user.login)
    assert.ok(after.confirmedAt !== '')
    assert.equal(after.planHash, body.planHash)

    const again = await getSession(h, body.id)
    assert.equal((JSON.parse(again.body) as { status: string }).status, 'confirmed')
  } finally {
    await h.close()
  }
})

test('a missing or unknown session answers 404 on read and confirm', async () => {
  const h = await harness()
  try {
    assert.equal((await getSession(h, 'gate_missing')).statusCode, 404)
    assert.equal((await confirm(h, 'gate_missing')).statusCode, 404)
  } finally {
    await h.close()
  }
})

test('only a maintainer can confirm a proposed plan', async () => {
  const h = await harness({ repoRole: 'developer' })
  try {
    const checked = validateGatePlan(basePlan())
    assert.equal(checked.ok, true)
    if (!checked.ok) return
    const id = 'gate_developer'
    h.store.createGateSession({
      id,
      repoId: h.repo.id,
      status: 'proposed',
      baseSha: checked.plan.baseSha,
      planJson: JSON.stringify(checked.plan),
      planHash: planHash(checked.plan),
    })
    const refused = await confirm(h, id)
    assert.equal(refused.statusCode, 403)
    assert.equal((JSON.parse(refused.body) as { error: { type: string } }).error.type, 'MAINTAINER_ONLY')
    assert.equal(h.store.getGateSession(id)?.status, 'proposed')
    assert.equal(h.store.listGateSessionsForRepo(h.repo.id).length, 1)
  } finally {
    await h.close()
  }
})

test('a stale plan is refused against the resolved default-branch SHA', async () => {
  const server = await startFakeServer((request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/repos/owner/repo/branches/main')) {
      json(response, 200, { name: 'main', commit: { sha: CURRENT_SHA } })
      return
    }
    json(response, 404, { message: 'not found' })
  })
  const h = await harness({ apiBase: server.url, token: 'token' })
  try {
    const stale = await createSession(h)
    assert.equal(stale.statusCode, 409)
    const error = (JSON.parse(stale.body) as { error: { type: string; currentSha: string } }).error
    assert.equal(error.type, 'STALE_BASE_SHA')
    assert.equal(error.currentSha, CURRENT_SHA)
    assert.equal(h.store.listGateSessionsForRepo(h.repo.id).length, 0)

    const fresh = basePlan()
    fresh.baseSha = CURRENT_SHA
    const accepted = await createSession(h, fresh)
    assert.equal(accepted.statusCode, 201)
    assert.equal((JSON.parse(accepted.body) as { baseSha: string }).baseSha, CURRENT_SHA)
  } finally {
    await h.close()
    await server.close()
  }
})

test('no GitHub write is made while creating or confirming a plan', async () => {
  const methods: string[] = []
  const server = await startFakeServer((request, response) => {
    methods.push(request.method ?? '')
    if (request.method === 'GET' && request.url?.startsWith('/repos/owner/repo/branches/main')) {
      json(response, 200, { name: 'main', commit: { sha: BASE_SHA } })
      return
    }
    json(response, 404, { message: 'not found' })
  })
  const h = await harness({ apiBase: server.url, token: 'token' })
  try {
    const created = await createSession(h)
    assert.equal(created.statusCode, 201)
    const id = (JSON.parse(created.body) as { id: string }).id
    const confirmed = await confirm(h, id)
    assert.equal(confirmed.statusCode, 200)
    assert.ok(methods.length > 0, 'the branch SHA read happened')
    assert.deepEqual(methods.filter((method) => method !== 'GET'), [])
  } finally {
    await h.close()
    await server.close()
  }
})

test('when GitHub is unavailable a plan with an explicit baseSha is still stored', async () => {
  const h = await harness({ token: '' })
  try {
    const created = await createSession(h)
    assert.equal(created.statusCode, 201)
    const body = JSON.parse(created.body) as { baseSha: string }
    assert.equal(body.baseSha, BASE_SHA)
  } finally {
    await h.close()
  }
})

test('the confirm form records the decision and redirects to the gate page', async () => {
  const h = await harness()
  try {
    const created = await createSession(h)
    const id = (JSON.parse(created.body) as { id: string }).id
    const confirmed = await confirm(h, id, true)
    assert.equal(confirmed.statusCode, 302)
    assert.match(String(confirmed.headers.location ?? ''), /\/gate\?notice=/)
    assert.equal(h.store.getGateSession(id)?.status, 'confirmed')
    const page = await h.built.app.inject({ method: 'GET', url: `/repos/${h.repo.id}/gate`, headers: { cookie: `${h.cookie}; fledge_lang=en` } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, new RegExp(`data-gate-session="${id}"`))
    assert.match(page.body, /data-gate-status="confirmed"/)
  } finally {
    await h.close()
  }
})
