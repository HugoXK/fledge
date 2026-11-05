import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { formBody, json, makeUser, MemoryMailer, readBody, sessionFor, startFakeServer, testConfig } from './helpers.js'

test('a provider model is only saved after Fledge tests the connection', async () => {
  const modelServer = await startFakeServer(async (request, response) => {
    const body = JSON.parse((await readBody(request)).toString('utf8')) as { model?: string }
    if (body.model === 'bad-model') {
      json(response, 401, { error: { message: 'bad key' } })
      return
    }
    json(response, 200, { id: 'x', choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { total_tokens: 1 } })
  })
  const config = testConfig({ allowPrivateModelUrls: true })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'provider-route-user', status: 'approved' })
    const { cookie, csrf } = sessionFor(built, user)
    const headers = { cookie, 'content-type': 'application/x-www-form-urlencoded' }
    const added = await built.app.inject({ method: 'POST', url: '/settings/providers', headers, payload: formBody({ csrf, label: 'Local', baseUrl: `${modelServer.url}/v1`, apiKey: 'secret' }) })
    assert.equal(added.statusCode, 302)
    const provider = store.listModelProviders(user.id)[0]
    assert.ok(provider)
    const good = await built.app.inject({ method: 'POST', url: `/settings/providers/${provider.id}/models`, headers, payload: formBody({ csrf, model: 'good-model', label: 'Good' }) })
    assert.equal(good.statusCode, 302)
    assert.equal(store.listProviderModels(provider.id).length, 1)
    const bad = await built.app.inject({ method: 'POST', url: `/settings/providers/${provider.id}/models`, headers, payload: formBody({ csrf, model: 'bad-model', label: 'Bad' }) })
    assert.equal(bad.statusCode, 302)
    assert.match(String(bad.headers.location), /error=/)
    assert.equal(store.listProviderModels(provider.id).length, 1)
  } finally {
    await built.close()
    await modelServer.close()
  }
})

test('a normal user needs the per-user private-model permission', async () => {
  const modelServer = await startFakeServer(async (_request, response) => {
    json(response, 200, { id: 'x', choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { total_tokens: 1 } })
  })
  const config = testConfig({ allowPrivateModelUrls: false })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'private-model-user', status: 'approved' })
    const { cookie, csrf } = sessionFor(built, user)
    const headers = { cookie, 'content-type': 'application/x-www-form-urlencoded' }
    const payload = formBody({ csrf, label: 'Local', baseUrl: `${modelServer.url}/v1`, apiKey: 'secret', allowPrivate: '1' })
    const denied = await built.app.inject({ method: 'POST', url: '/settings/providers', headers, payload })
    assert.equal(denied.statusCode, 302)
    assert.equal(store.listModelProviders(user.id).length, 0)
    store.setUserAllowPrivateModels(user.id, true)
    const allowed = await built.app.inject({ method: 'POST', url: '/settings/providers', headers, payload })
    assert.equal(allowed.statusCode, 302)
    const provider = store.listModelProviders(user.id)[0]
    assert.ok(provider)
    assert.equal(provider.allow_private, 1)
    const model = await built.app.inject({ method: 'POST', url: `/settings/providers/${provider.id}/models`, headers, payload: formBody({ csrf, model: 'local-model', label: 'Local' }) })
    assert.equal(model.statusCode, 302)
    assert.equal(store.listProviderModels(provider.id).length, 1)
  } finally {
    await built.close()
    await modelServer.close()
  }
})
