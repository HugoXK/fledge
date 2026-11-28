import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { encryptSecret, randomToken, sha256Hex } from '../src/lib/secrets.js'
import { MockRunner } from '../src/jobs/mock.js'
import { json, makeUser, readBody, startFakeServer, testConfig, MemoryMailer } from './helpers.js'

// #1319: a provider host is checked when it is saved and never again. A host
// that resolved public at save time can resolve to loopback by the next call,
// so the use path must re-validate (and pin) the address it connects to.
//
// The rebinding itself needs a DNS answer that changes between two lookups, and
// `assertSafeModelUrl` binds `node:dns/promises` at import with no resolver seam.
// This test stores the state the second lookup produces -- a saved provider row
// whose destination is loopback -- and asserts the gateway refuses it instead of
// connecting.
test('a stored model base URL that resolves to loopback at use time is refused', async () => {
  const internalHits: string[] = []
  const internal = await startFakeServer(async (request, response) => {
    internalHits.push(String(request.url))
    await readBody(request)
    json(response, 200, { id: 'leak', choices: [{ message: { role: 'assistant', content: 'internal' } }], usage: { total_tokens: 1 } })
  })
  const config = testConfig({ quota: { initialCny: 1, usdCny: 7.2, comfortCny: 50 } })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'ssrf-user', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_ssrf',
      userId: user.id,
      owner: 'owner',
      name: 'repo',
      defaultBranch: 'main',
      tokenEnc: 'x',
      goal: '',
      autoIterate: false,
      intervalMinutes: 1440,
      repoRole: 'maintainer',
      permission: 'admin',
    })
    const provider = store.createModelProvider({
      id: 'prv_ssrf',
      userId: user.id,
      label: 'rebound',
      baseUrl: `${internal.url}/v1`,
      keyEnc: encryptSecret('provider-key', config.tokenEncryptionKey),
      allowPrivate: false,
      allowed: true,
    })
    const model = store.createProviderModel({ id: 'pvm_ssrf', providerId: provider.id, model: 'internal-model', label: 'Internal' })
    store.setRepoModelSelection(repo.id, [model.id], model.id)
    const raw = `flg_${randomToken(32)}`
    store.createApiToken({
      id: 'tok_ssrf',
      userId: user.id,
      kind: 'pat',
      name: 'ssrf',
      tokenHash: sha256Hex(raw),
      prefix: raw.slice(0, 8),
      repoId: repo.id,
      expiresAt: null,
    })
    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      payload: { model: model.id, messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(internalHits.length, 0, 'the gateway must not connect to a loopback destination on the use path')
    assert.equal(response.statusCode >= 400, true, `expected a refusal, got ${response.statusCode}`)
  } finally {
    await built.close()
    await internal.close()
  }
})
