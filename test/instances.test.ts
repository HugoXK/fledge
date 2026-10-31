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
    const repo = store.createRepo({ id: 'repo_playbook', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: 'x', goal: '', autoIterate: false, intervalMinutes: 1440 })
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
