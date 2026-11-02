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
          rooms: {},
          questions: {
            'lead-1': {
              id: 'q1',
              question: 'Which path should the next job take?',
              detail: 'Pick one.',
              options: [{ label: 'Fix the bug' }, { label: 'Write docs' }],
              multiSelect: false,
            },
          },
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
    assert.match(page.body, /未启用/)
    assert.doesNotMatch(page.body, /已创建 · 上游全部 PR/)
    assert.match(page.body, /Which path should the next job take\?/)
    assert.match(page.body, /data-team-events/)
    assert.match(page.body, /data-team-stop/)

    const api = await built.app.inject({ method: 'GET', url: `/api/repos/${repo.id}/team`, headers: { cookie } })
    assert.equal(api.statusCode, 200)
    const data = api.json() as { bots: Array<{ role: string; activity: string; calls: number; disabled: boolean }>; questions: Array<{ id: string; sessionId: string; detail: string; multiSelect: boolean }> }
    assert.equal(data.bots.find((bot) => bot.role === 'lead')?.activity, 'thinking')
    assert.equal(data.bots.find((bot) => bot.role === 'lead')?.calls, 3)
    assert.equal(data.bots.find((bot) => bot.role === 'reviewer')?.disabled, true)
    assert.deepEqual(data.questions[0], { id: 'q1', sessionId: 'lead-1', question: 'Which path should the next job take?', detail: 'Pick one.', options: ['Fix the bug', 'Write docs'], multiSelect: false })

    const sent = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/team/guidance`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, target: 'lead', text: 'Report status first.' }),
    })
    assert.equal(sent.statusCode, 302)
    assert.equal(received.some((entry) => entry.endpoint === 'send' && (entry.payload as { text?: string })?.text === 'Report status first.'), true)

    const answered = await built.app.inject({
      method: 'POST',
      url: `/api/repos/${repo.id}/team/answer`,
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload: { sessionId: 'lead-1', questionId: 'q1', selected: ['Fix the bug'], custom: '' },
    })
    assert.equal(answered.statusCode, 200)
    const answerCall = received.find((entry) => entry.endpoint === 'answer-question')
    assert.deepEqual(answerCall?.payload, { sessionId: 'lead-1', questionId: 'q1', answer: { selected: ['Fix the bug'] } })

    const stopped = await built.app.inject({
      method: 'POST',
      url: `/api/repos/${repo.id}/team/stop`,
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload: { target: '' },
    })
    assert.equal(stopped.statusCode, 200)
    const stoppedBody = stopped.json() as { requested: string[] }
    assert.deepEqual(stoppedBody.requested, ['lead-1'])
    const stopCall = received.filter((entry) => entry.endpoint === 'send').at(-1)
    assert.match(String((stopCall?.payload as { text?: string })?.text), /Human stop request/)
  } finally {
    await built.close()
    await bridge.close()
  }
})

test('team events stream pushes a live snapshot', async () => {
  const bridge = await startFakeServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      const payload = JSON.parse(body || '{}') as { endpoint?: string }
      if (payload.endpoint === 'state') {
        json(response, 200, { value: {
          bots: [{ name: 'DigitalMate Lead', sessionId: 'lead-1', role: 'Lead' }],
          activity: { 'lead-1': 'working' },
          work: { bots: { 'lead-1': { calls: 7, since: Date.now() } } },
          rooms: {},
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
    const user = makeUser(store, { login: 'stream-team-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_stream', userId: user.id, owner: 'openJiuwen-ai', name: 'DigitalMate', defaultBranch: 'main', tokenEnc: 'x', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.saveRepoInstance({
      repo_id: repo.id, user_id: user.id, container: 'c', network: 'n', data_dir: '/tmp/stream', bridge_script: '/tmp/bridge',
      dsh_port: 1, bridge_port: Number(new URL(bridge.url).port), model_port: 2, model_bind: '127.0.0.1', image: 'image',
      status: 'ready', chief_session: 'chief-1',
      team_json: JSON.stringify({ chief: 'chief-1', lead: 'lead-1', product: 'p', test: 't', security: 's', reviewer: 'r', dev1: 'd1', dev2: 'd2', reviewerScope: 'upstream', team: 'DigitalMate' }),
      bridge_token_enc: encryptSecret('bridge-token', config.tokenEncryptionKey), bridge_pid: null, log_pid: null,
      last_error: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_health_at: null,
    })
    await built.app.listen({ port: 0, host: '127.0.0.1' })
    const address = built.app.server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const { cookie } = sessionFor(built, user)
    const controller = new AbortController()
    const response = await fetch(`http://127.0.0.1:${port}/api/repos/${repo.id}/team/events`, { headers: { cookie }, signal: controller.signal })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (!text.includes('event: snapshot') && text.length < 16_384) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
    controller.abort()
    await reader.cancel().catch(() => {})
    assert.match(text, /event: snapshot/)
    const line = text.split('\n').find((entry) => entry.startsWith('data: '))
    const snapshot = JSON.parse(line!.slice(6)) as { bots: Array<{ role: string; activity: string; calls: number }> }
    assert.equal(snapshot.bots.find((bot) => bot.role === 'lead')?.activity, 'working')
    assert.equal(snapshot.bots.find((bot) => bot.role === 'lead')?.calls, 7)
  } finally {
    await built.close()
    await bridge.close()
  }
})
