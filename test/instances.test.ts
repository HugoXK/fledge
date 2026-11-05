import test from 'node:test'
import assert from 'node:assert/strict'
import { InstanceManager, parseTeam } from '../src/flybot/instances.js'
import { PLAYBOOK_VERSION, playbookFingerprint, playbookFor } from '../src/flybot/playbook.js'
import { Store } from '../src/db.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { json, makeUser, readBody, startFakeServer, testConfig } from './helpers.js'

test('parseTeam accepts a complete repository team and rejects malformed JSON', () => {
  const team = parseTeam(JSON.stringify({ chief: 'c', lead: 'l', product: 'p', test: 't', security: 's', reviewer: 'r', dev1: 'd1', dev2: 'd2', reviewerScope: 'upstream', team: 'Repo', playbook: 2, playbookHash: 'abc' }))
  assert.deepEqual(team, { chief: 'c', lead: 'l', product: 'p', test: 't', security: 's', reviewer: 'r', dev1: 'd1', dev2: 'd2', reviewerScope: 'upstream', team: 'Repo', playbook: 2, playbookHash: 'abc' })
  assert.equal(parseTeam('not json'), null)
  assert.equal(parseTeam(null), null)
  assert.equal(parseTeam('{"chief":"c"}'), null)
})

test('every role playbook explains the hierarchy, ownership, heartbeat and repo goal', () => {
  for (const role of ['chief', 'lead', 'product', 'test', 'security', 'reviewer', 'dev1', 'dev2'] as const) {
    const text = playbookFor(role, 'Repo', 'Ship one evidence-backed product improvement.')
    assert.match(text, new RegExp(`playbook v${PLAYBOOK_VERSION}`))
    assert.match(text, /Chief -> Lead/)
    assert.match(text, /heartbeat/)
    assert.match(text, /status":"running/)
    assert.match(text, /Ship one evidence-backed product improvement/)
    assert.match(text, /How your role serves this goal/)
    assert.match(text, new RegExp(`Role: Repo ${role === 'dev1' ? 'Dev-1' : role === 'dev2' ? 'Dev-2' : role.charAt(0).toUpperCase() + role.slice(1)}`))
  }
  assert.match(playbookFor('lead', 'Repo'), /single owner of every Fledge job/)
  assert.match(playbookFor('chief', 'Repo'), /never writes code/)
  assert.notEqual(playbookFingerprint('goal A'), playbookFingerprint('goal B'))
  assert.equal(playbookFingerprint('goal A'), playbookFingerprint(' goal A '))
})

test('ensurePlaybook updates every existing role once and records the version', async () => {
  const updates: Array<Record<string, unknown>> = []
  const teams: Record<string, string> = { chief: 'c', lead: 'l', product: 'p', test: 't', security: 's', reviewer: 'r', dev1: 'd1', dev2: 'd2' }
  const bots: Array<Record<string, unknown>> = Object.entries(teams).map(([role, id]) => ({ id, name: `Repo ${role}`, role, sessionId: role === 'lead' || role === 'reviewer' ? `live-${role}` : id }))
  const bridge = await startFakeServer(async (request, response) => {
    const body = JSON.parse((await readBody(request)).toString('utf8')) as { endpoint: string; payload: Record<string, unknown> }
    if (body.endpoint === 'state') {
      json(response, 200, { value: { bots } })
      return
    }
    updates.push(body.payload)
    const bot = bots.find((entry) => entry.id === body.payload.id)
    if (bot !== undefined) bot.instructions = body.payload.instructions
    json(response, 200, { ok: true })
  })
  const config = testConfig({ flybot: { ...testConfig().flybot, instanceImage: 'image' } })
  const store = new Store(':memory:')
  const manager = new InstanceManager(store, config)
  try {
    const user = makeUser(store, { login: 'playbook-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_playbook', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.saveRepoInstance({
      repo_id: repo.id, user_id: user.id, container: 'c', network: 'n', data_dir: '/tmp/playbook', bridge_script: '/tmp/bridge',
      dsh_port: 1, bridge_port: Number(new URL(bridge.url).port), model_port: 2, model_bind: '127.0.0.1', image: 'image',
      status: 'ready', chief_session: 'c', team_json: JSON.stringify({ ...teams, reviewerScope: 'upstream', team: 'Repo' }),
      bridge_token_enc: encryptSecret('bridge-token', config.tokenEncryptionKey), bridge_pid: null, log_pid: null,
      last_error: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_health_at: null,
    })
    await manager.ensurePlaybook(repo.id)
    assert.equal(updates.length, 8)
    assert.equal(updates.every((update) => typeof update.instructions === 'string' && String(update.instructions).includes('Fledge team playbook')), true)
    assert.equal(parseTeam(store.getRepoInstance(repo.id)?.team_json ?? null)?.playbook, PLAYBOOK_VERSION)
    assert.equal(parseTeam(store.getRepoInstance(repo.id)?.team_json ?? null)?.playbookHash, playbookFingerprint(''))
    await manager.ensurePlaybook(repo.id)
    assert.equal(updates.length, 8)

    store.updateRepo(repo.id, { goal: 'New product goal: memory transparency first.' })
    await manager.ensurePlaybook(repo.id)
    assert.equal(updates.length, 16)
    const last = updates.at(-1)
    assert.equal(typeof last?.instructions === 'string' && last.instructions.includes('New product goal: memory transparency first.'), true)
    assert.equal(parseTeam(store.getRepoInstance(repo.id)?.team_json ?? null)?.playbookHash, playbookFingerprint('New product goal: memory transparency first.'))
  } finally {
    await bridge.close()
    store.close()
  }
})

test('clearJobToken tells the per-repo bridge to drop the job model token', async () => {
  const hits: Array<{ path?: string; body: string; auth: string }> = []
  const bridge = await startFakeServer(async (request, response) => {
    hits.push({ path: request.url, body: (await readBody(request)).toString('utf8'), auth: String(request.headers.authorization ?? '') })
    json(response, 200, { ok: true })
  })
  const config = testConfig({ flybot: { ...testConfig().flybot, instanceImage: 'image' } })
  const store = new Store(':memory:')
  const manager = new InstanceManager(store, config)
  try {
    const user = makeUser(store, { login: 'clear-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_clear', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.saveRepoInstance({
      repo_id: repo.id, user_id: user.id, container: 'c', network: 'n', data_dir: '/tmp/clear', bridge_script: '/tmp/bridge',
      dsh_port: 1, bridge_port: Number(new URL(bridge.url).port), model_port: 2, model_bind: '127.0.0.1', image: 'image',
      status: 'ready', chief_session: 'chief-1', team_json: null,
      bridge_token_enc: encryptSecret('bridge-token', config.tokenEncryptionKey), bridge_pid: null, log_pid: null,
      last_error: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_health_at: null,
    })
    await manager.clearJobToken(repo.id, 'job_1')
    assert.equal(hits.length, 1)
    assert.equal(hits[0]?.path, '/job-done')
    assert.deepEqual(JSON.parse(hits[0]!.body), { jobId: 'job_1' })
    assert.match(hits[0]!.auth, /^Bearer /)
  } finally {
    store.close()
    await bridge.close()
  }
})

test('healthSweep records live bridges and marks a dead bridge failed', async () => {
  const bridge = await startFakeServer((request, response) => {
    if (request.url === '/healthz') {
      json(response, 200, { ok: true })
      return
    }
    json(response, 404, { message: 'Not Found' })
  })
  const config = testConfig()
  const store = new Store(':memory:')
  const manager = new InstanceManager(store, config)
  let closed = false
  try {
    const user = makeUser(store, { login: 'health-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_health', userId: user.id, owner: 'o', name: 'health', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.saveRepoInstance({
      repo_id: repo.id, user_id: user.id, container: 'c', network: 'n', data_dir: '/tmp/health', bridge_script: '/tmp/bridge',
      dsh_port: 1, bridge_port: Number(new URL(bridge.url).port), model_port: 2, model_bind: '127.0.0.1', image: 'image',
      status: 'ready', chief_session: 'chief-1', team_json: null,
      bridge_token_enc: encryptSecret('bridge-token', config.tokenEncryptionKey), bridge_pid: null, log_pid: null,
      last_error: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_health_at: null,
    })
    const live = await manager.healthSweep()
    assert.equal(live.ready, 1)
    assert.equal(live.failed, 0)
    assert.notEqual(store.getRepoInstance(repo.id)?.last_health_at, null)
    await bridge.close()
    closed = true
    const dead = await manager.healthSweep()
    assert.equal(dead.failed, 1)
    assert.equal(store.getRepoInstance(repo.id)?.status, 'failed')
  } finally {
    store.close()
    if (!closed) await bridge.close()
  }
})

test('the instance patch groups selected models under their providers', () => {
  const store = new Store(':memory:')
  const manager = new InstanceManager(store, testConfig())
  try {
    const user = makeUser(store, { login: 'patch-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_patch', userId: user.id, owner: 'o', name: 'patch', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const providerA = store.createModelProvider({ id: 'prv_a', userId: user.id, label: 'Provider A', baseUrl: 'https://a.example/v1', keyEnc: 'enc', allowPrivate: false })
    const providerB = store.createModelProvider({ id: 'prv_b', userId: user.id, label: 'Provider B', baseUrl: 'https://b.example/v1', keyEnc: 'enc', allowPrivate: false })
    const a1 = store.createProviderModel({ id: 'pvm_a1', providerId: providerA.id, model: 'a-1', label: 'A1' })
    const a2 = store.createProviderModel({ id: 'pvm_a2', providerId: providerA.id, model: 'a-2', label: 'A2' })
    const b1 = store.createProviderModel({ id: 'pvm_b1', providerId: providerB.id, model: 'b-1', label: 'B1' })
    store.setRepoModelSelection(repo.id, [a1.id, a2.id, b1.id], b1.id)
    const patch = manager.modelPatch(repo.id, '127.0.0.1', 4100)
    assert.match(patch, /fledge-prv_a:/)
    assert.match(patch, /fledge-prv_b:/)
    assert.match(patch, /pvm_a1/)
    assert.match(patch, /pvm_a2/)
    assert.match(patch, /pvm_b1/)
    assert.match(patch, /provider: fledge-prv_b/)
  } finally {
    store.close()
  }
})

test('applyBotModels updates each configured bot through the bridge', async () => {
  const updates: Array<Record<string, unknown>> = []
  const bridge = await startFakeServer(async (request, response) => {
    const body = JSON.parse((await readBody(request)).toString('utf8')) as { endpoint: string; payload: Record<string, unknown> }
    if (body.endpoint === 'state') {
      json(response, 200, { value: { bots: [{ id: 'lead-id', name: 'Repo Lead' }, { id: 'product-id', name: 'Repo Product' }] } })
      return
    }
    updates.push({ ...body.payload, endpoint: body.endpoint })
    json(response, 200, { ok: true })
  })
  const config = testConfig()
  const store = new Store(':memory:')
  const manager = new InstanceManager(store, config)
  try {
    const user = makeUser(store, { login: 'bot-apply-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_bot_apply', userId: user.id, owner: 'o', name: 'b', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const provider = store.createModelProvider({ id: 'prv_apply', userId: user.id, label: 'Provider', baseUrl: 'https://p.example/v1', keyEnc: 'enc', allowPrivate: false })
    const model = store.createProviderModel({ id: 'pvm_apply', providerId: provider.id, model: 'm', label: 'M' })
    store.setRepoModelSelection(repo.id, [model.id], model.id)
    store.setRepoBotModel(repo.id, 'lead', model.id)
    store.setRepoBotModel(repo.id, 'product', model.id)
    store.saveRepoInstance({
      repo_id: repo.id, user_id: user.id, container: 'c', network: 'n', data_dir: '/tmp/bot-apply', bridge_script: '/tmp/bridge',
      dsh_port: 1, bridge_port: Number(new URL(bridge.url).port), model_port: 2, model_bind: '127.0.0.1', image: 'image',
      status: 'ready', chief_session: 'c', team_json: null,
      bridge_token_enc: encryptSecret('bridge-token', config.tokenEncryptionKey), bridge_pid: null, log_pid: null,
      last_error: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_health_at: null,
    })
    const result = await manager.applyBotModels(repo.id)
    assert.equal(result.updated, 2)
    assert.deepEqual(result.skipped, [])
    assert.equal(updates.length, 2)
    assert.equal(updates[0]?.model, 'fledge-prv_apply/pvm_apply')
    assert.equal(updates[0]?.endpoint, 'update-bot')
  } finally {
    store.close()
    await bridge.close()
  }
})
