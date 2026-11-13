import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import type { RepoRow, UserRow } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { encryptSecret, randomToken, sha256Hex } from '../src/lib/secrets.js'
import { formBody, json, makeUser, MemoryMailer, readBody, sessionFor, startFakeServer, testConfig } from './helpers.js'

function captureLog(): { text: () => string; restore: () => void } {
  const lines: string[] = []
  const stdout = process.stdout.write
  const stderr = process.stderr.write
  const tap = (write: typeof process.stdout.write): typeof process.stdout.write => ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    lines.push(text)
    return (write as unknown as (value: string | Uint8Array, ...args: unknown[]) => boolean)(chunk, ...rest)
  }) as unknown as typeof process.stdout.write
  process.stdout.write = tap(stdout.bind(process.stdout))
  process.stderr.write = tap(stderr.bind(process.stderr))
  return {
    text: () => lines.join(''),
    restore: () => {
      process.stdout.write = stdout
      process.stderr.write = stderr
    },
  }
}

async function providerServer(answer: 'ok' | 'rate-limited', hits: string[]): Promise<{ url: string; close: () => Promise<void> }> {
  return startFakeServer(async (request, response) => {
    const body = JSON.parse((await readBody(request)).toString('utf8')) as { model?: string }
    hits.push(String(body.model ?? ''))
    if (answer === 'rate-limited') {
      json(response, 429, { error: { message: 'Rate limit reached for requests' } })
      return
    }
    json(response, 200, { id: 'ok', choices: [{ message: { role: 'assistant', content: 'policy-ok' } }], usage: { total_tokens: 10 } })
  })
}

interface Harness {
  app: Awaited<ReturnType<typeof buildApp>>
  store: Store
  user: UserRow
  repo: RepoRow
  jobId: string
  call: (model: string) => Promise<{ statusCode: number; body: string; json: () => unknown }>
  callBody: (payload: Record<string, unknown>) => Promise<{ statusCode: number; body: string; json: () => unknown }>
  close: () => Promise<void>
}

async function harness(input: {
  primary: { id: string; url: string; label: string; region: string; allowed?: boolean }
  fallback?: { id: string; url: string; label: string; region: string; allowed?: boolean }
  allowlist: string[]
  requiredRegion: string
  primaryModelId: string
  fallbackModelId?: string
  platformUrl?: string
  ownUrl?: string
}): Promise<Harness> {
  const config = testConfig(input.platformUrl === undefined ? {} : { llm: { baseUrl: `${input.platformUrl}/v1`, key: 'platform-key', model: 'platform-model', pricePerTokenUsd: 0.0000002 } })
  const store = new Store(':memory:')
  const app = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  const user = makeUser(store, { login: `policy-${randomToken(4)}`, status: 'approved' })
  if (input.ownUrl !== undefined) store.setUserOwnModel(user.id, `${input.ownUrl}/v1`, encryptSecret('own-key', config.tokenEncryptionKey), 'own-model')
  const repo = store.createRepo({ id: `repo_${randomToken(6)}`, userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
  const primary = store.createModelProvider({
    id: input.primary.id,
    userId: user.id,
    label: input.primary.label,
    baseUrl: `${input.primary.url}/v1`,
    keyEnc: encryptSecret('primary-key', config.tokenEncryptionKey),
    allowPrivate: true,
    region: input.primary.region,
    dataPolicyUrl: 'https://policy.example/data',
    allowed: input.primary.allowed !== false,
  })
  const primaryModel = store.createProviderModel({ id: input.primaryModelId, providerId: primary.id, model: 'allowed-model', label: 'Allowed Model' })
  const selection = [primaryModel.id]
  if (input.fallback !== undefined && input.fallbackModelId !== undefined) {
    const fallback = store.createModelProvider({
      id: input.fallback.id,
      userId: user.id,
      label: input.fallback.label,
      baseUrl: `${input.fallback.url}/v1`,
      keyEnc: encryptSecret('fallback-key', config.tokenEncryptionKey),
      allowPrivate: true,
      region: input.fallback.region,
      dataPolicyUrl: '',
      allowed: input.fallback.allowed !== false,
    })
    const fallbackModel = store.createProviderModel({ id: input.fallbackModelId, providerId: fallback.id, model: 'fallback-model', label: 'Fallback Model' })
    selection.push(fallbackModel.id)
  }
  store.setRepoModelSelection(repo.id, selection, primaryModel.id)
  store.setRepoProviderPolicy(repo.id, input.allowlist, input.requiredRegion)
  const jobId = `job_${randomToken(6)}`
  store.createJob({ id: jobId, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
  const raw = `flg_${randomToken(32)}`
  store.createApiToken({ id: `tok_${randomToken(6)}`, userId: user.id, kind: 'job', name: `job:${jobId}`, tokenHash: sha256Hex(raw), prefix: raw.slice(0, 8), repoId: repo.id, expiresAt: null })
  return {
    app,
    store,
    user,
    repo,
    jobId,
    callBody: (payload: Record<string, unknown>) => app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      payload,
    }),
    call: (model: string) => app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      payload: { model, messages: [{ role: 'user', content: 'hi' }] },
    }),
    close: async () => {
      await app.close()
    },
  }
}

test('a provider outside the repository allowlist is refused before dispatch', async () => {
  const hits: string[] = []
  const primary = await providerServer('ok', hits)
  const h = await harness({
    primary: { id: 'prv_allowed_elsewhere', url: primary.url, label: 'Allowed elsewhere', region: 'eu' },
    allowlist: ['prv_some_other_provider'],
    requiredRegion: '',
    primaryModelId: 'pvm_not_listed',
  })
  try {
    const response = await h.call('pvm_not_listed')
    assert.equal(response.statusCode, 403)
    const error = (response.json() as { error: { code: string } }).error
    assert.equal(error.code, 'FLEDGE_PROVIDER_NOT_ALLOWED')
    assert.deepEqual(hits, [], 'the upstream provider was not called')
  } finally {
    await h.close()
    await primary.close()
  }
})

test('a provider whose region does not satisfy the repository constraint is refused', async () => {
  const hits: string[] = []
  const primary = await providerServer('ok', hits)
  const h = await harness({
    primary: { id: 'prv_us', url: primary.url, label: 'US provider', region: 'us' },
    allowlist: [],
    requiredRegion: 'eu',
    primaryModelId: 'pvm_region_mismatch',
  })
  try {
    const response = await h.call('pvm_region_mismatch')
    assert.equal(response.statusCode, 403)
    const error = (response.json() as { error: { code: string } }).error
    assert.equal(error.code, 'FLEDGE_PROVIDER_REGION_NOT_ALLOWED')
    assert.deepEqual(hits, [], 'the upstream provider was not called')
  } finally {
    await h.close()
    await primary.close()
  }
})

test('an allowed provider runs and the job and audit name its provider, region and model', async () => {
  const hits: string[] = []
  const primary = await providerServer('ok', hits)
  const h = await harness({
    primary: { id: 'prv_eu', url: primary.url, label: 'EU provider', region: 'eu' },
    allowlist: ['prv_eu'],
    requiredRegion: 'eu',
    primaryModelId: 'pvm_allowed',
  })
  try {
    const response = await h.call('pvm_allowed')
    assert.equal(response.statusCode, 200)
    assert.deepEqual(hits, ['allowed-model'])
    const job = h.store.getJob(h.jobId)!
    assert.equal(job.provider_id, 'prv_eu')
    assert.equal(job.provider_label, 'EU provider')
    assert.equal(job.provider_region, 'eu')
    assert.equal(job.provider_model, 'allowed-model')
    const { cookie } = sessionFor(h.app, h.user)
    const page = await h.app.app.inject({ method: 'GET', url: `/repos/${h.repo.id}/jobs/${h.jobId}`, headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /EU provider/)
    assert.match(page.body, /eu/)
    assert.match(page.body, /allowed-model/)
  } finally {
    await h.close()
    await primary.close()
  }
})

test('a fallback to a provider outside the policy is refused, not silently used', async () => {
  const primaryHits: string[] = []
  const fallbackHits: string[] = []
  const primary = await providerServer('rate-limited', primaryHits)
  const fallback = await providerServer('ok', fallbackHits)
  const h = await harness({
    primary: { id: 'prv_primary_504', url: primary.url, label: 'Primary', region: 'eu' },
    fallback: { id: 'prv_fallback_504', url: fallback.url, label: 'Fallback outside policy', region: 'us' },
    allowlist: ['prv_primary_504'],
    requiredRegion: 'eu',
    primaryModelId: 'pvm_primary_504',
    fallbackModelId: 'pvm_fallback_504',
  })
  try {
    const response = await h.call('pvm_primary_504')
    assert.equal(response.statusCode, 403)
    const error = (response.json() as { error: { code: string } }).error
    assert.equal(error.code, 'FLEDGE_PROVIDER_NOT_ALLOWED')
    assert.deepEqual(primaryHits, ['allowed-model'], 'the allowed primary was tried once')
    assert.deepEqual(fallbackHits, [], 'the disallowed fallback was never called')
  } finally {
    await h.close()
    await primary.close()
    await fallback.close()
  }
})

test('another user cannot see or change a repository provider policy', async () => {
  const config = testConfig({})
  const store = new Store(':memory:')
  const app = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const owner = makeUser(store, { login: 'policy-owner', status: 'approved' })
    const stranger = makeUser(store, { login: 'policy-stranger', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_policy_owner', userId: owner.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const provider = store.createModelProvider({ id: 'prv_owner_only', userId: owner.id, label: 'Owner only provider', baseUrl: 'https://models.example/v1', keyEnc: encryptSecret('k', config.tokenEncryptionKey), allowPrivate: false, region: 'eu', dataPolicyUrl: 'https://policy.example', allowed: true })

    const ownerSession = sessionFor(app, owner)
    const strangerSettings = await app.app.inject({ method: 'GET', url: '/settings', headers: { cookie: sessionFor(app, stranger).cookie } })
    assert.equal(strangerSettings.statusCode, 200)
    assert.doesNotMatch(strangerSettings.body, /Owner only provider/)

    const strangerSession = sessionFor(app, stranger)
    const denied = await app.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/settings`,
      headers: { cookie: strangerSession.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: strangerSession.csrf, repoRole: 'maintainer', enabled: '1', allowedProviderIds: provider.id, providerRegion: 'eu' }),
    })
    assert.equal(denied.statusCode, 404)
    assert.equal(store.getRepo(repo.id)?.provider_allowlist, '')

    const changed = await app.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/settings`,
      headers: { cookie: ownerSession.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: ownerSession.csrf, repoRole: 'maintainer', enabled: '1', allowedProviderIds: provider.id, providerRegion: 'eu' }),
    })
    assert.equal(changed.statusCode, 302)
    const saved = store.getRepo(repo.id)!
    assert.deepEqual(store.repoProviderPolicy(repo.id), { allowlist: [provider.id], requiredRegion: 'eu' })
    assert.equal(saved.provider_allowlist, provider.id)
    assert.equal(saved.required_region, 'eu')
  } finally {
    await app.close()
  }
})

test('the provider form stores region, data-policy URL and the allowed flag', async () => {
  const config = testConfig({ allowPrivateModelUrls: true })
  const store = new Store(':memory:')
  const app = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'provider-metadata', status: 'approved' })
    const { cookie, csrf } = sessionFor(app, user)
    const response = await app.app.inject({
      method: 'POST',
      url: '/settings/providers',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, label: 'Regional', baseUrl: 'http://127.0.0.1:8081/v1', apiKey: 'metadata-key', region: 'eu', dataPolicyUrl: 'https://policy.example/data', allowed: '1', allowPrivate: '1' }),
    })
    assert.equal(response.statusCode, 302)
    const provider = store.listModelProviders(user.id)[0]!
    assert.equal(provider.region, 'eu')
    assert.equal(provider.data_policy_url, 'https://policy.example/data')
    assert.equal(provider.allowed, 1)
  } finally {
    await app.close()
  }
})

test('a gateway refusal writes no provider key or credential-bearing URL to the log or audit', async () => {
  const hits: string[] = []
  const primary = await providerServer('ok', hits)
  const secret = 'policy-test-key-not-logged'
  const config = testConfig({})
  const store = new Store(':memory:')
  const app = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  const capture = captureLog()
  try {
    const user = makeUser(store, { login: 'policy-log', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_policy_log', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const provider = store.createModelProvider({ id: 'prv_policy_log', userId: user.id, label: 'Log provider', baseUrl: `${primary.url}/v1`, keyEnc: encryptSecret(secret, config.tokenEncryptionKey), allowPrivate: true, region: 'eu', dataPolicyUrl: 'https://policy.example/data', allowed: true })
    const model = store.createProviderModel({ id: 'pvm_policy_log', providerId: provider.id, model: 'allowed-model', label: 'Allowed Model' })
    store.setRepoModelSelection(repo.id, [model.id], model.id)
    store.setRepoProviderPolicy(repo.id, [provider.id], 'eu')
    const jobId = 'job_policy_log'
    store.createJob({ id: jobId, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    const raw = `flg_${randomToken(32)}`
    store.createApiToken({ id: 'tok_policy_log', userId: user.id, kind: 'job', name: `job:${jobId}`, tokenHash: sha256Hex(raw), prefix: raw.slice(0, 8), repoId: repo.id, expiresAt: null })
    const response = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      payload: { model: model.id, messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(response.statusCode, 200)
    const logs = capture.text()
    assert.doesNotMatch(logs, new RegExp(secret))
    assert.doesNotMatch(logs, /policy-test-key-not-logged/)
    const audit = store.listAudit().map((entry) => `${entry.action} ${entry.detail ?? ''}`).join('\n')
    assert.doesNotMatch(audit, new RegExp(secret))
    assert.doesNotMatch(audit, /policy-test-key-not-logged/)
  } finally {
    capture.restore()
    await app.close()
    await primary.close()
  }
})

test('a call that names no model is refused when the repository sets a policy', async () => {
  const hits: string[] = []
  const primary = await providerServer('ok', hits)
  const platformHits: string[] = []
  const platform = await providerServer('ok', platformHits)
  const h = await harness({
    primary: { id: 'prv_no_model', url: primary.url, label: 'Policy provider', region: 'eu' },
    allowlist: ['prv_no_model'],
    requiredRegion: 'eu',
    primaryModelId: 'pvm_no_model',
    platformUrl: platform.url,
  })
  try {
    const response = await h.callBody({ messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(response.statusCode, 403)
    const error = (response.json() as { error: { type: string; code: string } }).error
    assert.equal(error.type, 'provider_policy_refused')
    assert.equal(error.code, 'FLEDGE_PROVIDER_POLICY_NO_MODEL')
    assert.deepEqual(hits, [], 'no repository provider was called')
    assert.deepEqual(platformHits, [], 'the platform model was not called either')
  } finally {
    await h.close()
    await primary.close()
    await platform.close()
  }
})

test('a call naming a model that does not resolve is refused under the same policy', async () => {
  const hits: string[] = []
  const primary = await providerServer('ok', hits)
  const platformHits: string[] = []
  const platform = await providerServer('ok', platformHits)
  const h = await harness({
    primary: { id: 'prv_unresolved', url: primary.url, label: 'Policy provider', region: 'eu' },
    allowlist: ['prv_unresolved'],
    requiredRegion: '',
    primaryModelId: 'pvm_resolved',
    platformUrl: platform.url,
  })
  try {
    const response = await h.call('pvm_missing')
    assert.equal(response.statusCode, 403)
    const error = (response.json() as { error: { code: string } }).error
    assert.equal(error.code, 'FLEDGE_PROVIDER_POLICY_NO_MODEL')
    assert.deepEqual(hits, [])
    assert.deepEqual(platformHits, [])
  } finally {
    await h.close()
    await primary.close()
    await platform.close()
  }
})

test('the policy also covers a user own model, which the allowlist does not name', async () => {
  const hits: string[] = []
  const primary = await providerServer('ok', hits)
  const ownHits: string[] = []
  const own = await providerServer('ok', ownHits)
  const h = await harness({
    primary: { id: 'prv_own_gap', url: primary.url, label: 'Policy provider', region: 'eu' },
    allowlist: ['prv_own_gap'],
    requiredRegion: 'eu',
    primaryModelId: 'pvm_own_gap',
    ownUrl: own.url,
  })
  try {
    const response = await h.callBody({ model: 'pvm_missing', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(response.statusCode, 403)
    const error = (response.json() as { error: { code: string } }).error
    assert.equal(error.code, 'FLEDGE_PROVIDER_POLICY_NO_MODEL')
    assert.deepEqual(ownHits, [], 'the user own model was not called under a repository policy')
  } finally {
    await h.close()
    await primary.close()
    await own.close()
  }
})

test('a later call with no model keeps the provider the job already recorded', async () => {
  const hits: string[] = []
  const primary = await providerServer('ok', hits)
  const platformHits: string[] = []
  const platform = await providerServer('ok', platformHits)
  const h = await harness({
    primary: { id: 'prv_keep', url: primary.url, label: 'Keep provider', region: 'eu' },
    allowlist: [],
    requiredRegion: '',
    primaryModelId: 'pvm_keep',
    platformUrl: platform.url,
  })
  try {
    const first = await h.call('pvm_keep')
    assert.equal(first.statusCode, 200)
    const recorded = h.store.getJob(h.jobId)!
    assert.equal(recorded.provider_id, 'prv_keep')
    assert.equal(recorded.provider_model, 'allowed-model')

    const second = await h.callBody({ messages: [{ role: 'user', content: 'again' }] })
    assert.equal(second.statusCode, 200)
    assert.deepEqual(platformHits, ['platform-model'], 'the model-less call ran on the platform model')
    const job = h.store.getJob(h.jobId)!
    assert.equal(job.provider_id, 'prv_keep', 'the recorded provider is kept, not cleared')
    assert.equal(job.provider_label, 'Keep provider')
    assert.equal(job.provider_region, 'eu')
    assert.equal(job.provider_model, 'allowed-model')
  } finally {
    await h.close()
    await primary.close()
    await platform.close()
  }
})

test('a disabled provider is not offered as an allowlist entry', async () => {
  const config = testConfig({})
  const store = new Store(':memory:')
  const app = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'policy-disabled-entry', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_disabled_entry', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const retired = store.createModelProvider({ id: 'prv_retired_entry', userId: user.id, label: 'Retired provider', baseUrl: 'https://models.example/v1', keyEnc: encryptSecret('k', config.tokenEncryptionKey), allowPrivate: false, region: 'eu', dataPolicyUrl: '', allowed: false })
    const page = await app.app.inject({ method: 'GET', url: `/repos/${repo.id}`, headers: { cookie: sessionFor(app, user).cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, new RegExp(`name="allowedProviderIds" value="${retired.id}" disabled`))
  } finally {
    await app.close()
  }
})

