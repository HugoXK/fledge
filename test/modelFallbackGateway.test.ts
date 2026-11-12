import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { encryptSecret, randomToken, sha256Hex } from '../src/lib/secrets.js'
import { parseModelRun } from '../src/lib/modelRun.js'
import { MockRunner } from '../src/jobs/mock.js'
import { json, makeUser, readBody, startFakeServer, testConfig, MemoryMailer } from './helpers.js'

// #358: the gateway is the one place that knows which provider model actually
// answered, so the fallback is decided there: one chat call, at most one job, and
// the job row names the model that replied. These cases drive that seam with two
// fake providers instead of a live model.

function answer(status: number, payload: unknown) {
  return async (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => {
    await readBody(request)
    json(response, status, payload)
  }
}

test('a rate-limited primary finishes the job on the next repository model', async () => {
  const primaryHits: string[] = []
  const primary = await startFakeServer(async (request, response) => {
    const body = JSON.parse((await readBody(request)).toString('utf8')) as { model?: string }
    primaryHits.push(String(body.model ?? ''))
    json(response, 429, { error: { message: 'Rate limit reached for requests' } })
  })
  const fallbackHits: string[] = []
  const fallback = await startFakeServer(async (request, response) => {
    const body = JSON.parse((await readBody(request)).toString('utf8')) as { model?: string }
    fallbackHits.push(String(body.model ?? ''))
    json(response, 200, { id: 'ok', choices: [{ message: { role: 'assistant', content: 'from the fallback' } }], usage: { total_tokens: 10 } })
  })

  const config = testConfig({})
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'fallback-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_fallback', userId: user.id, owner: 'o', name: 'f', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const primaryProvider = store.createModelProvider({ id: 'prv_primary', userId: user.id, label: 'Primary', baseUrl: `${primary.url}/v1`, keyEnc: encryptSecret('primary-key', config.tokenEncryptionKey), allowPrivate: true })
    const fallbackProvider = store.createModelProvider({ id: 'prv_fallback', userId: user.id, label: 'Fallback', baseUrl: `${fallback.url}/v1`, keyEnc: encryptSecret('fallback-key', config.tokenEncryptionKey), allowPrivate: true })
    const primaryModel = store.createProviderModel({ id: 'pvm_primary', providerId: primaryProvider.id, model: 'primary-model', label: 'Primary Model' })
    const fallbackModel = store.createProviderModel({ id: 'pvm_fallback', providerId: fallbackProvider.id, model: 'fallback-model', label: 'Fallback Model' })
    // The default is the head; the second model is the fallback the query order
    // already returns. No order column is invented for this.
    store.setRepoModelSelection(repo.id, [primaryModel.id, fallbackModel.id], primaryModel.id)
    store.createJob({ id: 'job_fallback', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    const raw = `flg_${randomToken(32)}`
    store.createApiToken({ id: 'tok_fallback', userId: user.id, kind: 'job', name: 'job:job_fallback', tokenHash: sha256Hex(raw), prefix: raw.slice(0, 8), repoId: repo.id, expiresAt: null })

    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      payload: { model: primaryModel.id, messages: [{ role: 'user', content: 'hi' }] },
    })

    assert.equal(response.statusCode, 200, 'the job finishes on the fallback instead of failing the call')
    assert.match(response.body, /from the fallback/)
    assert.deepEqual(primaryHits, ['primary-model'], 'the primary was asked first, for its own model')
    assert.deepEqual(fallbackHits, ['fallback-model'], 'the fallback answered with its own model, not a replay of the primary')

    const run = parseModelRun(store.getJob('job_fallback')?.model_json ?? null)
    assert.notEqual(run, null, 'the job records which model ran')
    assert.equal(run?.model?.label, 'Fallback Model', 'the saved job names the model that actually ran')
    assert.deepEqual(run?.attempts.map((entry) => [entry.modelId, entry.status, entry.retryable]), [['pvm_primary', 429, true]])

    // One call, one job: the fallback is not a second dispatch.
    assert.equal(store.listJobs(user.id).length, 1)
    // The failed attempt is not billed; the job carries no charge for a user model.
    assert.equal(store.getJob('job_fallback')?.cost_usd, 0)
  } finally {
    await built.close()
    await primary.close()
    await fallback.close()
  }
})

test('an authorization failure never tries the next model', async () => {
  let fallbackHits = 0
  const primary = await startFakeServer(answer(401, { error: { message: 'invalid api key' } }))
  const fallback = await startFakeServer(async (request, response) => {
    await readBody(request)
    fallbackHits += 1
    json(response, 200, { id: 'ok', choices: [{ message: { role: 'assistant', content: 'must not happen' } }] })
  })

  const config = testConfig({})
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'auth-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_auth', userId: user.id, owner: 'o', name: 'a', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const primaryProvider = store.createModelProvider({ id: 'prv_auth', userId: user.id, label: 'Primary', baseUrl: `${primary.url}/v1`, keyEnc: encryptSecret('k', config.tokenEncryptionKey), allowPrivate: true })
    const fallbackProvider = store.createModelProvider({ id: 'prv_auth2', userId: user.id, label: 'Fallback', baseUrl: `${fallback.url}/v1`, keyEnc: encryptSecret('k2', config.tokenEncryptionKey), allowPrivate: true })
    const primaryModel = store.createProviderModel({ id: 'pvm_auth', providerId: primaryProvider.id, model: 'primary', label: 'Primary' })
    const fallbackModel = store.createProviderModel({ id: 'pvm_auth2', providerId: fallbackProvider.id, model: 'fallback', label: 'Fallback' })
    store.setRepoModelSelection(repo.id, [primaryModel.id, fallbackModel.id], primaryModel.id)
    store.createJob({ id: 'job_auth', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    const raw = `flg_${randomToken(32)}`
    store.createApiToken({ id: 'tok_auth', userId: user.id, kind: 'job', name: 'job:job_auth', tokenHash: sha256Hex(raw), prefix: raw.slice(0, 8), repoId: repo.id, expiresAt: null })

    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      payload: { model: primaryModel.id, messages: [{ role: 'user', content: 'hi' }] },
    })

    assert.equal(response.statusCode, 401, 'the credential failure is returned, not masked by another model')
    assert.equal(fallbackHits, 0, 'no second model was called')
    const run = parseModelRun(store.getJob('job_auth')?.model_json ?? null)
    assert.equal(run?.model, null)
    assert.deepEqual(run?.attempts.map((entry) => [entry.modelId, entry.status, entry.retryable]), [['pvm_auth', 401, false]])
  } finally {
    await built.close()
    await primary.close()
    await fallback.close()
  }
})

test('when every model refuses, one failure is reported, not two jobs', async () => {
  const primary = await startFakeServer(answer(429, { error: { message: 'Rate limit reached for requests' } }))
  const fallback = await startFakeServer(answer(503, { error: { message: 'The model is overloaded' } }))

  const config = testConfig({})
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'both-fail', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_both', userId: user.id, owner: 'o', name: 'b', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const one = store.createModelProvider({ id: 'prv_both1', userId: user.id, label: 'One', baseUrl: `${primary.url}/v1`, keyEnc: encryptSecret('k', config.tokenEncryptionKey), allowPrivate: true })
    const two = store.createModelProvider({ id: 'prv_both2', userId: user.id, label: 'Two', baseUrl: `${fallback.url}/v1`, keyEnc: encryptSecret('k2', config.tokenEncryptionKey), allowPrivate: true })
    const first = store.createProviderModel({ id: 'pvm_both1', providerId: one.id, model: 'one', label: 'One' })
    const second = store.createProviderModel({ id: 'pvm_both2', providerId: two.id, model: 'two', label: 'Two' })
    store.setRepoModelSelection(repo.id, [first.id, second.id], first.id)
    store.createJob({ id: 'job_both', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    const raw = `flg_${randomToken(32)}`
    store.createApiToken({ id: 'tok_both', userId: user.id, kind: 'job', name: 'job:job_both', tokenHash: sha256Hex(raw), prefix: raw.slice(0, 8), repoId: repo.id, expiresAt: null })

    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      payload: { model: first.id, messages: [{ role: 'user', content: 'hi' }] },
    })

    assert.equal(response.statusCode, 503, 'the last refusal is the answer, so the caller sees a real provider status')
    assert.equal(store.listJobs(user.id).length, 1, 'one job, not one per model attempt')
    const run = parseModelRun(store.getJob('job_both')?.model_json ?? null)
    assert.equal(run?.model, null)
    assert.deepEqual(run?.attempts.map((entry) => [entry.modelId, entry.status]), [['pvm_both1', 429], ['pvm_both2', 503]])
    assert.equal(store.getJob('job_both')?.cost_usd, 0, 'a failed attempt is not billed')
  } finally {
    await built.close()
    await primary.close()
    await fallback.close()
  }
})
