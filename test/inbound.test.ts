import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { json, makeUser, MemoryMailer, startFakeServer, testConfig } from './helpers.js'

test('an inbound email reply becomes Lead guidance', async () => {
  const received: Array<Record<string, unknown>> = []
  const bridge = await startFakeServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      const payload = JSON.parse(body || '{}') as { endpoint?: string; payload?: unknown }
      received.push(payload)
      json(response, 200, { ok: true })
    })
  })
  const config = testConfig({ inboundEmailSecret: 'mail-secret' })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'reply-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_reply', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.saveRepoInstance({
      repo_id: repo.id, user_id: user.id, container: 'c', network: 'n', data_dir: '/tmp/reply', bridge_script: '/tmp/bridge',
      dsh_port: 1, bridge_port: Number(new URL(bridge.url).port), model_port: 2, model_bind: '127.0.0.1', image: 'image',
      status: 'ready', chief_session: 'chief-1',
      team_json: JSON.stringify({ chief: 'chief-1', lead: 'lead-1', product: 'p', test: 't', security: 's', reviewer: 'r', dev1: 'd1', dev2: 'd2', reviewerScope: 'upstream', team: 'Repo' }),
      bridge_token_enc: encryptSecret('bridge-token', config.tokenEncryptionKey), bridge_pid: null, log_pid: null,
      last_error: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_health_at: null,
    })
    const token = 'replytoken'
    store.setSetting(`email_reply:${token}`, `${user.id}:${repo.id}:${Date.now()}`)
    const headers = { 'content-type': 'application/json', 'x-fledge-email-secret': 'mail-secret' }
    const accepted = await built.app.inject({
      method: 'POST',
      url: '/api/inbound/email',
      headers,
      payload: { from: user.email, to: `fledge+${token}@hugoxk.online`, text: 'Please fix the failing test.\n\n> quoted old mail' },
    })
    assert.equal(accepted.statusCode, 200)
    const send = received.find((entry) => entry.endpoint === 'send')
    assert.deepEqual(send?.payload, { sessionId: 'lead-1', text: 'Please fix the failing test.' })
    assert.equal(store.countEvents('team_intervention'), 1)

    const badSecret = await built.app.inject({ method: 'POST', url: '/api/inbound/email', headers: { ...headers, 'x-fledge-email-secret': 'bad' }, payload: { from: user.email, to: `fledge+${token}@hugoxk.online`, text: 'x' } })
    assert.equal(badSecret.statusCode, 401)
    const badSender = await built.app.inject({ method: 'POST', url: '/api/inbound/email', headers, payload: { from: 'other@example.com', to: `fledge+${token}@hugoxk.online`, text: 'x' } })
    assert.equal(badSender.statusCode, 403)
  } finally {
    await built.close()
    await bridge.close()
  }
})
