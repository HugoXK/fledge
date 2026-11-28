import test from 'node:test'
import assert from 'node:assert/strict'
import type { ModelAddressResolver } from '../src/gateway/modelUrl.js'
import { assertSafeModelUrl, resolveSafeModelUrl, setModelAddressResolverForTest } from '../src/gateway/modelUrl.js'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { encryptSecret, randomToken, sha256Hex } from '../src/lib/secrets.js'
import { MockRunner } from '../src/jobs/mock.js'
import { json, makeUser, readBody, startFakeServer, testConfig, MemoryMailer } from './helpers.js'

// #1319: the save-time guard is not enough. A host that resolves public when
// the provider is saved can resolve to loopback by the next call, so the gateway
// re-runs the guard on every call, pins the guard-approved address into the
// connection, and refuses the call (no retry, no fallback, no quota) when the
// destination is not allowed. Security's `test/modelUrlRebind.test.ts` keeps the
// minimal stored-loopback red case; this file covers the transition, the blocked
// set, allowPrivate parity, the 3xx boundary and the ledger.

const PROVIDER_KEY = 'provider-key'

async function chat(input: { baseUrl: string; allowPrivate: boolean }): Promise<{
  response: { statusCode: number; json: () => Record<string, unknown> }
  store: Store
  userId: string
  close: () => Promise<void>
}> {
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
      baseUrl: input.baseUrl,
      keyEnc: encryptSecret(PROVIDER_KEY, config.tokenEncryptionKey),
      allowPrivate: input.allowPrivate,
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
    return { response, store, userId: user.id, close: () => built.close() }
  } catch (error) {
    await built.close()
    throw error
  }
}

test('a host public at save and loopback at use is refused before it connects', async () => {
  let mode: 'public' | 'loopback' = 'public'
  const resolver: ModelAddressResolver = async () => (mode === 'public'
    ? [{ address: '93.184.216.34', family: 4 }]
    : [{ address: '127.0.0.1', family: 4 }])
  // The save path accepts the host while it resolves public...
  const saved = await assertSafeModelUrl('https://rebind.example/v1', false, resolver)
  assert.equal(saved, 'https://rebind.example/v1')
  // ...and the same row is refused on the next call after the address flips.
  mode = 'loopback'
  setModelAddressResolverForTest(resolver)
  const run = await chat({ baseUrl: saved, allowPrivate: false })
  try {
    assert.equal(run.response.statusCode, 502)
    const body = run.response.json() as { error?: { code?: string } }
    assert.equal(body.error?.code, 'FLEDGE_MODEL_DESTINATION_REFUSED')
    assert.equal(run.store.userById(run.userId)?.quota_used_usd, 0)
    const serialized = JSON.stringify(body)
    assert.ok(!serialized.includes(PROVIDER_KEY), 'the provider key must not leak in the refusal')
    assert.ok(!serialized.includes('127.0.0.1'), 'the resolved internal address must not leak in the refusal')
  } finally {
    await run.close()
    setModelAddressResolverForTest(null)
  }
})

test('an allowPrivate provider is pinned to the one resolved address and connects', async () => {
  const hits: string[] = []
  const upstream = await startFakeServer(async (request, response) => {
    hits.push(String(request.url ?? ''))
    await readBody(request)
    json(response, 200, { id: 'ok', choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { total_tokens: 1 } })
  })
  let resolutions = 0
  const resolver: ModelAddressResolver = async () => {
    resolutions += 1
    return [{ address: '127.0.0.1', family: 4 }]
  }
  const port = new URL(upstream.url).port
  setModelAddressResolverForTest(resolver)
  const run = await chat({ baseUrl: `http://visual-matrix.test:${port}/v1`, allowPrivate: true })
  try {
    assert.equal(run.response.statusCode, 200)
    assert.equal(hits.length, 1)
    // One resolution for the guard; the connection uses the pinned address
    // instead of asking DNS a second time.
    assert.equal(resolutions, 1)
  } finally {
    await run.close()
    await upstream.close()
    setModelAddressResolverForTest(null)
  }
})

test('a DNS failure or empty answer fails closed, with no retry and no quota', async () => {
  for (const resolver of [
    async () => { throw new Error('ENOTFOUND') },
    async () => [],
  ] as ModelAddressResolver[]) {
    setModelAddressResolverForTest(resolver)
    const run = await chat({ baseUrl: 'https://rebind.example/v1', allowPrivate: false })
    try {
      assert.equal(run.response.statusCode, 502)
      const body = run.response.json() as { error?: { code?: string } }
      assert.equal(body.error?.code, 'FLEDGE_MODEL_DESTINATION_REFUSED')
      assert.equal(run.store.userById(run.userId)?.quota_used_usd, 0)
    } finally {
      await run.close()
      setModelAddressResolverForTest(null)
    }
  }
})

test('a 3xx is returned to the caller and never followed', async () => {
  const leaked: string[] = []
  const internal = await startFakeServer(async (request, response) => {
    leaked.push(String(request.url ?? ''))
    await readBody(request)
    json(response, 200, {})
  })
  const redirect = await startFakeServer(async (request, response) => {
    await readBody(request)
    response.writeHead(302, { location: `${internal.url}/leak` })
    response.end('redirect')
  })
  const run = await chat({ baseUrl: `${redirect.url}/v1`, allowPrivate: true })
  try {
    assert.equal(run.response.statusCode, 302)
    assert.equal(leaked.length, 0, 'a redirect must not be followed to a second connection')
  } finally {
    await run.close()
    await redirect.close()
    await internal.close()
  }
})

test('the use-time guard refuses the whole blocked set, including mixed answers', async () => {
  const resolverFor = (address: string): ModelAddressResolver => async () => [{ address, family: address.includes(':') ? 6 : 4 }]
  const blocked = [
    '127.0.0.1', '127.8.9.10',
    '10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254',
    'fc00::1', 'fd12:3456:789a::1', 'fe80::1', '::',
  ]
  for (const address of blocked) {
    await assert.rejects(
      () => resolveSafeModelUrl('https://rebind.example/v1', false, resolverFor(address)),
      (error: unknown) => error instanceof Error,
      `the guard must refuse ${address}`,
    )
  }
  await assert.rejects(
    () => resolveSafeModelUrl('https://rebind.example/v1', false, async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]),
    (error: unknown) => error instanceof Error,
    'a mixed answer is refused, never narrowed to the public address',
  )
  await assert.rejects(() => resolveSafeModelUrl('https://127.0.0.1/v1', false))
  await assert.rejects(() => resolveSafeModelUrl('https://169.254.169.254/v1', false))
  await assert.rejects(() => resolveSafeModelUrl('ftp://rebind.example/v1', true))
})

test('the guard returns exactly the addresses it accepted', async () => {
  const pinned = await resolveSafeModelUrl('https://rebind.example/v1', false, async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
  ])
  assert.deepEqual(pinned.addresses, [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
  ])
})
