import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { encryptSecret, randomToken, sha256Hex } from '../src/lib/secrets.js'
import { parseModelRun } from '../src/lib/modelRun.js'
import { MockRunner } from '../src/jobs/mock.js'
import { flashOf, json, makeUser, readBody, sessionFor, startFakeServer, testConfig, MemoryMailer } from './helpers.js'

// #852: a provider that stops offering a model it used to serve answers 404 with
// a "model not found" body. The gateway already treats that as retryable so the
// job can finish elsewhere; what it never did was write the fact down. These
// cases drive the seam with fake providers: the row and the pages must say the
// model is retired, a transient failure must never say it, and an apply must not
// restart a workspace onto a model its provider no longer serves.

type Fake = (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>

function chatHit(models: string[], answer: (model: string) => { status: number; payload: unknown }): Fake {
  return async (request, response) => {
    const body = JSON.parse((await readBody(request)).toString('utf8')) as { model?: string }
    const model = String(body.model ?? '')
    models.push(model)
    const { status, payload } = answer(model)
    json(response, status, payload)
  }
}

const OK = { status: 200, payload: { id: 'ok', choices: [{ message: { role: 'assistant', content: 'answered' } }], usage: { total_tokens: 4 } } }
const RETIRED = { status: 404, payload: { error: { code: 'model_not_found', message: 'The model gpt-4o does not exist' } } }

async function fixture(primaryAnswer: Fake, fallbackAnswer: Fake) {
  const primaryHits: string[] = []
  const fallbackHits: string[] = []
  const primary = await startFakeServer(primaryAnswer)
  const fallback = await startFakeServer(fallbackAnswer)
  const config = testConfig({})
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  const user = makeUser(store, { login: 'retire-user', status: 'approved' })
  const repo = store.createRepo({ id: 'repo_retire', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
  const providerA = store.createModelProvider({ id: 'prv_a', userId: user.id, label: 'Provider A', baseUrl: `${primary.url}/v1`, keyEnc: encryptSecret('key-a', config.tokenEncryptionKey), allowPrivate: true })
  const providerB = store.createModelProvider({ id: 'prv_b', userId: user.id, label: 'Provider B', baseUrl: `${fallback.url}/v1`, keyEnc: encryptSecret('key-b', config.tokenEncryptionKey), allowPrivate: true })
  const modelA = store.createProviderModel({ id: 'pvm_a', providerId: providerA.id, model: 'gpt-4o', label: 'GPT 4o' })
  const modelB = store.createProviderModel({ id: 'pvm_b', providerId: providerB.id, model: 'backup-model', label: 'Backup Model' })
  store.setRepoModelSelection(repo.id, [modelA.id, modelB.id], modelA.id)
  const job = store.createJob({ id: 'job_retire', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
  const raw = `flg_${randomToken(32)}`
  store.createApiToken({ id: 'tok_retire', userId: user.id, kind: 'job', name: 'job:job_retire', tokenHash: sha256Hex(raw), prefix: raw.slice(0, 8), repoId: repo.id, expiresAt: null })
  const call = () => built.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
    payload: { model: modelA.id, messages: [{ role: 'user', content: 'hi' }] },
  })
  const close = async () => {
    await built.close()
    await primary.close()
    await fallback.close()
  }
  return { store, built, user, repo, job, modelA, modelB, providerA, providerB, call, close, primaryHits, fallbackHits }
}

async function page(built: Awaited<ReturnType<typeof fixture>>['built'], user: Parameters<typeof sessionFor>[1], url: string): Promise<string> {
  const { cookie } = sessionFor(built, user)
  const response = await built.app.inject({ method: 'GET', url, headers: { cookie } })
  assert.equal(response.statusCode, 200, `${url} answered ${response.statusCode}`)
  return response.body
}

test('a provider 404 marks the model retired, every page says so, and a second 404 does not move the date', async () => {
  const created: string[] = []
  const fake = await fixture(
    chatHit(created, () => RETIRED),
    chatHit(created, () => OK),
  )
  try {
    const response = await fake.call()
    assert.equal(response.statusCode, 200, 'the job still finishes on the repository second model')

    // The attempt carries the reason: the word retired, beside the status.
    const run = parseModelRun(fake.store.getJob(fake.job.id)?.model_json ?? null)
    assert.deepEqual(run?.attempts.map((entry) => [entry.modelId, entry.status, entry.retired]), [['pvm_a', 404, true]])
    assert.equal(run?.model?.label, 'Backup Model', 'the job still names the model that actually answered')

    // The row is the record the pages read.
    const rows = fake.store.listProviderModels(fake.providerA.id)
    const rowA = rows.find((row) => row.id === fake.modelA.id)
    assert.notEqual(rowA?.retired_at, null, 'the retired model records the date it was retired')
    assert.notEqual(rowA?.retired_at, undefined, 'the retired model records the date it was retired')
    const retiredAt = String(rowA?.retired_at)
    const date = retiredAt.slice(0, 10)
    assert.deepEqual(fake.store.listProviderModels(fake.providerB.id).map((row) => row.retired_at), [null], 'a model that answered is not retired')

    // Settings: the model is still listed, now labelled with the date.
    const settings = await page(fake.built, fake.user, '/settings')
    assert.match(settings, new RegExp(`data-retired="${date}"`), 'Settings carries the retired date for the model')
    assert.equal(settings.split('data-retired=').length - 1, 1, 'only the retired model carries the marker')

    // Repository page: the retired default is marked.
    const repoPage = await page(fake.built, fake.user, `/repos/${fake.repo.id}`)
    assert.match(repoPage, /data-retired-model="pvm_a"/, 'the repository default marks the retired model')
    assert.doesNotMatch(repoPage, /data-retired-model="pvm_b"/, 'a live model is not marked')

    // Job page: the model line names the reason.
    const jobPage = await page(fake.built, fake.user, `/repos/${fake.repo.id}/jobs/${fake.job.id}`)
    assert.match(jobPage, /data-retired-attempt="pvm_a"/, 'the job model line names the retired attempt')

    // One retirement, one date: a second call that gets the same 404 must not move it.
    const second = await fake.call()
    assert.equal(second.statusCode, 200)
    const after = fake.store.listProviderModels(fake.providerA.id).find((row) => row.id === fake.modelA.id)
    assert.equal(after?.retired_at, retiredAt, 'a second 404 does not move the retirement date')
  } finally {
    await fake.close()
  }
})

test('a rate limit or a provider error never retires a model, and the fallback still works', async () => {
  let fallbackStatus = 200
  const fake = await fixture(
    chatHit([], () => ({ status: 429, payload: { error: { message: 'Rate limit reached for requests' } } })),
    chatHit([], () => (fallbackStatus === 200 ? OK : { status: 500, payload: { error: { message: 'upstream exploded' } } })),
  )
  try {
    const response = await fake.call()
    assert.equal(response.statusCode, 200, 'a rate-limited primary still finishes on the fallback')

    let run = parseModelRun(fake.store.getJob(fake.job.id)?.model_json ?? null)
    assert.deepEqual(run?.attempts.map((entry) => [entry.status, entry.retryable, entry.retired]), [[429, true, undefined]])
    assert.deepEqual(fake.store.listProviderModels(fake.providerA.id).map((row) => row.retired_at), [null], 'a 429 is not a retirement')
    assert.deepEqual(fake.store.listProviderModels(fake.providerB.id).map((row) => row.retired_at), [null], 'an answering model is not retired')

    fallbackStatus = 500
    const failed = await fake.call()
    assert.equal(failed.statusCode, 500, 'a 500 on the last model fails the call as before')
    run = parseModelRun(fake.store.getJob(fake.job.id)?.model_json ?? null)
    assert.deepEqual(run?.attempts.map((entry) => [entry.status, entry.retired]), [[429, undefined], [500, undefined]], 'neither transient status records a retirement')
    assert.deepEqual(fake.store.listProviderModels(fake.providerA.id).map((row) => row.retired_at), [null], 'a 500 is not a retirement either')

    const settings = await page(fake.built, fake.user, '/settings')
    assert.doesNotMatch(settings, /data-retired=/, 'no model is labelled retired')
  } finally {
    await fake.close()
  }
})

test('an apply with a retired model selected is refused by name, and a live selection passes it', async () => {
  const fake = await fixture(
    chatHit([], () => RETIRED),
    chatHit([], () => OK),
  )
  try {
    assert.equal((await fake.call()).statusCode, 200)
    const { cookie, csrf } = sessionFor(fake.built, fake.user)
    const headers = { cookie, 'content-type': 'application/x-www-form-urlencoded' }
    const rejected = await fake.built.app.inject({ method: 'POST', url: `/repos/${fake.repo.id}/models/apply`, headers, payload: `csrf=${encodeURIComponent(csrf)}` })
    assert.equal(rejected.statusCode, 302, 'the route answers with its existing redirect')
    // #472 slice 2: the message rides a one-shot cookie, not the Location query.
    const refused = flashOf(rejected)?.error?.text ?? ''
    assert.match(refused, /GPT 4o/, 'the refusal names the retired model')
    assert.match(refused, /(下架|retired)/, 'the refusal says why')
    assert.equal(fake.store.listAudit(100).filter((entry) => entry.action === 'repo.models.applied').length, 0, 'nothing was applied or restarted')

    // The maintainer picks the live model; the same route is no longer refused for retirement.
    fake.store.setRepoModelSelection(fake.repo.id, [fake.modelB.id], fake.modelB.id)
    const allowed = await fake.built.app.inject({ method: 'POST', url: `/repos/${fake.repo.id}/models/apply`, headers, payload: `csrf=${encodeURIComponent(csrf)}` })
    assert.equal(allowed.statusCode, 302)
    assert.doesNotMatch(flashOf(allowed)?.error?.text ?? '', /(下架|retired)/, 'a live selection is not refused for retirement')
  } finally {
    await fake.close()
  }
})
