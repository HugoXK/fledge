import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { formBody, json, makeUser, MemoryMailer, sessionFor, startFakeServer, testConfig } from './helpers.js'

test('team console reads live state and sends guidance', async () => {
  const received: Array<Record<string, unknown>> = []
  const bridge = await startFakeServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      const payload = JSON.parse(body || '{}') as { endpoint?: string; payload?: unknown }
      received.push(payload)
      if (payload.endpoint === 'state') {
        json(response, 200, { value: {
          bots: [{ name: 'DigitalMate Lead', sessionId: 'lead-1', role: 'Lead' }],
          activity: { 'lead-1': 'thinking' },
          work: { bots: { 'lead-1': { calls: 3, since: Date.now() } } },
          questions: {},
        } })
        return
      }
      json(response, 200, { ok: true })
    })
  })
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'team-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_team', userId: user.id, owner: 'openJiuwen-ai', name: 'DigitalMate', defaultBranch: 'main', tokenEnc: 'x', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.saveRepoInstance({
      repo_id: repo.id,
      user_id: user.id,
      container: 'c',
      network: 'n',
      data_dir: '/tmp/team',
      bridge_script: '/tmp/bridge',
      dsh_port: 1,
      bridge_port: Number(new URL(bridge.url).port),
      model_port: 2,
      model_bind: '127.0.0.1',
      image: 'image',
      status: 'ready',
      chief_session: 'chief-1',
      team_json: JSON.stringify({ chief: 'chief-1', lead: 'lead-1', product: 'p', test: 't', security: 's', reviewer: 'r', dev1: 'd1', dev2: 'd2', reviewerScope: 'upstream', team: 'DigitalMate' }),
      bridge_token_enc: encryptSecret('bridge-token', config.tokenEncryptionKey),
      bridge_pid: null,
      log_pid: null,
      last_error: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_health_at: null,
    })
    const { cookie, csrf } = sessionFor(built, user)
    const page = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/team`, headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /团队状态/)
    assert.match(page.body, /思考中/)
    assert.match(page.body, /发送给团队/)

    const api = await built.app.inject({ method: 'GET', url: `/api/repos/${repo.id}/team`, headers: { cookie } })
    assert.equal(api.statusCode, 200)
    const data = api.json() as { bots: Array<{ role: string; activity: string; calls: number }> }
    assert.equal(data.bots.find((bot) => bot.role === 'lead')?.activity, 'thinking')
    assert.equal(data.bots.find((bot) => bot.role === 'lead')?.calls, 3)

    const sent = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/team/guidance`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, target: 'lead', text: 'Report status first.' }),
    })
    assert.equal(sent.statusCode, 302)
    assert.equal(received.some((entry) => entry.endpoint === 'send' && (entry.payload as { text?: string })?.text === 'Report status first.'), true)
  } finally {
    await built.close()
    await bridge.close()
  }
})
